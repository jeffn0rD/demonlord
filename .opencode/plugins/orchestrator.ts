import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Session } from "@opencode-ai/sdk";
import { execFile } from "child_process";
import { resolve } from "path";
import { promisify } from "util";
import { resolveTaskRoute, type RouteResult } from "../tools/matchmaker";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "pending" | "in_progress" | "completed" | "blocked";

interface RoutingContext {
  skillID: string;
  reason: string;
  mode: RouteResult["mode"];
}

interface WorktreeContext {
  taskID: string;
  worktreePath: string;
  branchName: string;
}

interface ErrorContext {
  inProgress: boolean;
  attempts: number;
  lastSignature?: string;
}

interface SessionPipelineState {
  stage: PipelineStage;
  parentSessionID?: string;
  sessionDirectory?: string;
  transition: TransitionState;
  nextSessionID?: string;
  routing?: RoutingContext;
  worktree?: WorktreeContext;
  terminalNotified: boolean;
  error: ErrorContext;
}

const execFileAsync = promisify(execFile);

const OrchestratorPlugin: Plugin = async ({ client, worktree }) => {
  const pipelineBySession = new Map<string, SessionPipelineState>();
  const idleInFlight = new Set<string>();
  const spawnScriptPath = resolve(worktree, "agents", "tools", "spawn_worktree.sh");

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const session = event.properties.info;
        ensureSessionState(session.id, inferStageFromTitle(session.title), session.parentID, session.directory);
        return;
      }

      if (event.type === "session.idle") {
        await handleSessionIdle(event);
        return;
      }

      if (event.type === "session.error") {
        await handleSessionError(event);
      }
    },
  };

  async function handleSessionIdle(event: Extract<Event, { type: "session.idle" }>): Promise<void> {
    const sessionID = event.properties.sessionID;
    if (idleInFlight.has(sessionID)) {
      return;
    }

    idleInFlight.add(sessionID);

    try {
      const state = await resolveState(sessionID);

      if (state.stage === "triage") {
        await handleTriageIdle(sessionID, state);
        return;
      }

      if (state.stage === "implementation") {
        await handleImplementationIdle(sessionID, state);
        return;
      }

      await handleReviewIdle(sessionID, state);
    } finally {
      idleInFlight.delete(sessionID);
    }
  }

  async function handleSessionError(event: Extract<Event, { type: "session.error" }>): Promise<void> {
    const sessionID = event.properties.sessionID;
    if (!sessionID) {
      return;
    }

    const state = await resolveState(sessionID);
    if (state.error.inProgress) {
      return;
    }

    const errorSummary = formatError(event.properties.error);
    const signature = `${state.stage}:${errorSummary}`;
    if (state.error.lastSignature === signature) {
      return;
    }

    state.error.inProgress = true;
    state.error.lastSignature = signature;
    state.error.attempts += 1;

    if (state.transition === "in_progress") {
      state.transition = "blocked";
    }

    const recoveryPrompt = [
      `Pipeline stage '${state.stage}' reported an error: ${errorSummary}`,
      `Recovery attempt ${state.error.attempts}. Keep state deterministic and do not respawn child sessions.`,
      "Summarize the blocker, list one concrete next action, and wait for explicit operator input.",
    ].join("\n");

    try {
      await promptSession(sessionID, recoveryPrompt, "orchestrator", true, state.sessionDirectory);

      if (state.parentSessionID) {
        const parentDirectory = resolveSessionDirectory(state.parentSessionID, worktree);
        await promptSession(
          state.parentSessionID,
          `Child session ${sessionID} in stage '${state.stage}' encountered an error and is now blocked.`,
          "orchestrator",
          true,
          parentDirectory,
        );
      }
    } finally {
      state.error.inProgress = false;
    }
  }

  async function handleTriageIdle(sessionID: string, state: SessionPipelineState): Promise<void> {
    if (state.transition === "completed" || state.transition === "in_progress") {
      return;
    }

    state.transition = "in_progress";

    try {
      const session = await getSession(sessionID, state.sessionDirectory);
      const taskDescription = extractTaskDescription(session?.title ?? sessionID);

      const routing = await resolveTaskRoute({
        taskDescription,
        directory: worktree,
        worktree,
        mode: "llm",
      });

      state.routing = {
        skillID: routing.skill_id,
        reason: routing.reason,
        mode: routing.mode,
      };

      const taskID = buildTaskID(sessionID, routing.skill_id, taskDescription);
      const worktreeContext = await provisionImplementationWorktree({
        taskID,
        skillID: routing.skill_id,
        parentSessionID: sessionID,
      });

      state.worktree = worktreeContext;

      const childSession = await createChildSession({
        parentSessionID: sessionID,
        stage: "implementation",
        directory: worktreeContext.worktreePath,
        titleSuffix: `${taskID}:${routing.skill_id}`,
      });

      if (!childSession?.id) {
        throw new Error("Failed to create implementation session.");
      }

      const childState = ensureSessionState(
        childSession.id,
        "implementation",
        sessionID,
        childSession.directory ?? worktreeContext.worktreePath,
      );
      childState.routing = state.routing;
      childState.worktree = worktreeContext;
      state.nextSessionID = childSession.id;
      state.transition = "completed";

      await promptSession(
        childSession.id,
        buildImplementationPrompt(taskDescription, state, childSession.id),
        "minion",
        false,
        worktreeContext.worktreePath,
      );
      await promptSession(
        sessionID,
        [
          `Implementation session ${childSession.id} created in ${worktreeContext.worktreePath}.`,
          `Matchmaker selected skill ${routing.skill_id} via ${routing.mode} mode.`,
        ].join("\n"),
        "orchestrator",
        true,
        state.sessionDirectory,
      );
    } catch (error) {
      state.transition = "blocked";
      await promptSession(
        sessionID,
        [
          "Implementation handoff is blocked.",
          `Reason: ${formatError(error)}`,
          "Do not retry automatically. Wait for operator instructions.",
        ].join("\n"),
        "orchestrator",
        true,
        state.sessionDirectory,
      );
    }
  }

  async function handleImplementationIdle(sessionID: string, state: SessionPipelineState): Promise<void> {
    if (state.transition === "completed" || state.transition === "in_progress") {
      return;
    }

    state.transition = "in_progress";

    try {
      const implementationSession = await getSession(sessionID, state.sessionDirectory);
      const reviewDirectory = state.worktree?.worktreePath ?? implementationSession?.directory ?? worktree;
      const titleSuffix = state.worktree?.taskID ?? implementationSession?.id ?? sessionID;

      const childSession = await createChildSession({
        parentSessionID: sessionID,
        stage: "review",
        directory: reviewDirectory,
        titleSuffix,
      });

      if (!childSession?.id) {
        throw new Error("Failed to create review session.");
      }

      const childState = ensureSessionState(
        childSession.id,
        "review",
        sessionID,
        childSession.directory ?? reviewDirectory,
      );
      childState.routing = state.routing;
      childState.worktree = state.worktree;
      state.nextSessionID = childSession.id;
      state.transition = "completed";

      await promptSession(childSession.id, buildReviewPrompt(state), "reviewer", false, reviewDirectory);
      await promptSession(
        sessionID,
        `Review session ${childSession.id} created. Awaiting deterministic review handoff.`,
        "orchestrator",
        true,
        state.sessionDirectory,
      );
    } catch (error) {
      state.transition = "blocked";
      await promptSession(
        sessionID,
        [
          "Review handoff is blocked.",
          `Reason: ${formatError(error)}`,
          "Do not retry automatically. Wait for operator instructions.",
        ].join("\n"),
        "orchestrator",
        true,
        state.sessionDirectory,
      );
    }
  }

  async function handleReviewIdle(sessionID: string, state: SessionPipelineState): Promise<void> {
    if (state.terminalNotified) {
      return;
    }

    state.terminalNotified = true;
    state.transition = "completed";

    const parentSessionID = state.parentSessionID ?? (await getSession(sessionID, state.sessionDirectory))?.parentID;
    const completionNote = [
      `Review stage completed for session ${sessionID}.`,
      state.worktree ? `Worktree: ${state.worktree.worktreePath}` : null,
      state.routing ? `Skill: ${state.routing.skillID} (${state.routing.mode})` : null,
      "Pipeline terminal state reached. Await human approval for next action.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    if (parentSessionID) {
      await promptSession(
        parentSessionID,
        completionNote,
        "orchestrator",
        true,
        resolveSessionDirectory(parentSessionID, state.sessionDirectory ?? worktree),
      );
      return;
    }

    await promptSession(sessionID, completionNote, "orchestrator", true, state.sessionDirectory);
  }

  async function createChildSession(input: {
    parentSessionID: string;
    stage: PipelineStage;
    directory: string;
    titleSuffix: string;
  }): Promise<Session | null> {
    const parentSession = await getSession(input.parentSessionID, resolveSessionDirectory(input.parentSessionID, worktree));
    const titleStem = parentSession?.title ?? input.parentSessionID;
    const childTitle = `${input.stage}:${sanitizeTitleSegment(input.titleSuffix || titleStem)}`;

    const created = await client.session.create({
      body: {
        parentID: input.parentSessionID,
        title: childTitle,
      },
      query: {
        directory: input.directory,
      },
    });

    return created.data ?? null;
  }

  async function resolveState(sessionID: string): Promise<SessionPipelineState> {
    const cached = pipelineBySession.get(sessionID);
    if (cached) {
      return cached;
    }

    const session = await getSession(sessionID, resolveSessionDirectory(sessionID, worktree));
    const stage = inferStageFromTitle(session?.title ?? "implementation");
    return ensureSessionState(sessionID, stage, session?.parentID, session?.directory);
  }

  function ensureSessionState(
    sessionID: string,
    stage: PipelineStage,
    parentSessionID?: string,
    sessionDirectory?: string,
  ): SessionPipelineState {
    const existing = pipelineBySession.get(sessionID);
    if (existing) {
      if (!existing.parentSessionID && parentSessionID) {
        existing.parentSessionID = parentSessionID;
      }
      if (!existing.sessionDirectory && sessionDirectory) {
        existing.sessionDirectory = sessionDirectory;
      }
      return existing;
    }

    const created: SessionPipelineState = {
      stage,
      parentSessionID,
      sessionDirectory,
      transition: "pending",
      terminalNotified: false,
      error: {
        inProgress: false,
        attempts: 0,
      },
    };

    pipelineBySession.set(sessionID, created);
    return created;
  }

  async function getSession(sessionID: string, directory?: string): Promise<Session | null> {
    const response = await client.session.get({
      path: { id: sessionID },
      query: {
        directory: directory ?? worktree,
      },
    });

    return response.data ?? null;
  }

  function resolveSessionDirectory(sessionID: string, fallback: string): string {
    return pipelineBySession.get(sessionID)?.sessionDirectory ?? fallback;
  }

  async function provisionImplementationWorktree(input: {
    taskID: string;
    skillID: string;
    parentSessionID: string;
  }): Promise<WorktreeContext> {
    const purpose = `implementation:${input.skillID}`;
    const { stdout } = await execFileAsync(
      "bash",
      [spawnScriptPath, input.taskID, "minion", purpose, input.parentSessionID, input.skillID],
      { cwd: worktree },
    );

    const worktreePath = extractScriptValue(stdout, "Created worktree");
    const branchName = extractScriptValue(stdout, "Branch");

    return {
      taskID: input.taskID,
      worktreePath,
      branchName,
    };
  }

  function buildImplementationPrompt(
    taskDescription: string,
    state: SessionPipelineState,
    childSessionID: string,
  ): string {
    const taskID = state.worktree?.taskID ?? "unknown-task";
    const skillID = state.routing?.skillID ?? "unrouted";
    const skillMode = state.routing?.mode ?? "heuristic";
    const skillReason = state.routing?.reason ?? "No routing reason available.";
    const worktreePath = state.worktree?.worktreePath ?? "unknown-worktree";

    return [
      "Triage session is complete.",
      "Execute the next implementation unit and report completion details.",
      "",
      "Orchestration metadata:",
      `- Parent Session: ${state.parentSessionID ?? "unknown"}`,
      `- Implementation Session: ${childSessionID}`,
      `- Task ID: ${taskID}`,
      `- Skill: ${skillID}`,
      `- Routing Mode: ${skillMode}`,
      `- Routing Reason: ${skillReason}`,
      `- Worktree: ${worktreePath}`,
      `- Task Description: ${taskDescription}`,
    ].join("\n");
  }

  function buildReviewPrompt(state: SessionPipelineState): string {
    return [
      "Implementation session is now idle.",
      "Review the completed changes, identify risks, and prepare a deterministic human-in-the-loop handoff.",
      "",
      "Implementation metadata:",
      `- Parent Session: ${state.parentSessionID ?? "unknown"}`,
      `- Task ID: ${state.worktree?.taskID ?? "unknown-task"}`,
      `- Skill: ${state.routing?.skillID ?? "unrouted"}`,
      `- Routing Mode: ${state.routing?.mode ?? "heuristic"}`,
      `- Worktree: ${state.worktree?.worktreePath ?? "unknown-worktree"}`,
      `- Branch: ${state.worktree?.branchName ?? "unknown-branch"}`,
    ].join("\n");
  }

  async function promptSession(
    sessionID: string,
    text: string,
    agent: string,
    noReply = false,
    directory?: string,
  ): Promise<void> {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent,
        noReply,
        parts: [{ type: "text", text }],
      },
      query: {
        directory: directory ?? worktree,
      },
    });
  }

  function extractScriptValue(stdout: string, label: string): string {
    const pattern = new RegExp(`^${label}:\\s*(.+)$`, "m");
    const match = stdout.match(pattern);
    if (!match || !match[1]) {
      throw new Error(`spawn_worktree.sh did not return '${label}'.`);
    }

    return match[1].trim();
  }
};

function inferStageFromTitle(title: string): PipelineStage {
  const normalized = title.toLowerCase();
  if (normalized.startsWith("triage:")) {
    return "triage";
  }

  if (normalized.startsWith("review:")) {
    return "review";
  }

  if (normalized.includes("triage")) {
    return "triage";
  }

  if (normalized.includes("review")) {
    return "review";
  }

  return "implementation";
}

function formatError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object") {
    const candidate = error as { message?: unknown; name?: unknown };
    const message = typeof candidate.message === "string" ? candidate.message : null;
    const name = typeof candidate.name === "string" ? candidate.name : null;

    if (message && name) {
      return `${name}: ${message}`;
    }

    if (message) {
      return message;
    }

    if (name) {
      return name;
    }
  }

  return "unknown error";
}

function extractTaskDescription(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    return "general task";
  }

  const withoutPrefix = normalized.replace(/^(triage|implementation|review):/i, "").trim();
  return withoutPrefix.length > 0 ? withoutPrefix : normalized;
}

function buildTaskID(sessionID: string, skillID: string, taskDescription: string): string {
  const normalizedSkill = sanitizeTitleSegment(skillID);
  const normalizedDescription = sanitizeTitleSegment(taskDescription).slice(0, 24);
  const shortSessionID = sanitizeTitleSegment(sessionID).slice(0, 8) || "session";

  const pieces = [normalizedSkill, normalizedDescription, shortSessionID].filter((part) => part.length > 0);
  return pieces.join("-").slice(0, 64);
}

function sanitizeTitleSegment(value: string): string {
  const lowered = value.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
  const compact = dashed.replace(/-+/g, "-").replace(/^-/, "").replace(/-$/, "");
  return compact.length > 0 ? compact : "session";
}

export default OrchestratorPlugin;
