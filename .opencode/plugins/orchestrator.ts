import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Session } from "@opencode-ai/sdk";
import { execFile } from "child_process";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { promisify } from "util";
import { resolveTaskRoute, type RouteResult } from "../tools/matchmaker";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "idle" | "awaiting_approval" | "in_progress" | "blocked" | "completed" | "stopped";
type SessionStatus = "active" | "completed" | "blocked" | "stopped";
type OrchestrationMode = "off" | "manual" | "auto";
type StopReason = "manual" | "global_off" | "completed";

interface OrchestrationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
  requireApprovalBeforeSpawn: boolean;
  ignoreAbortedMessages: boolean;
  verboseEvents: boolean;
}

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

interface PipelineSessionState {
  sessionID: string;
  stage: PipelineStage;
  parentSessionID?: string;
  directory?: string;
  children: string[];
  status: SessionStatus;
}

interface PendingTransition {
  from: PipelineStage;
  to: PipelineStage;
  requestedBySessionID: string;
  approvalRequired: boolean;
  approved: boolean;
  requestedAt: number;
  approvedAt?: number;
  taskDescription?: string;
}

interface ErrorContext {
  inProgress: boolean;
  attempts: number;
  lastSignature?: string;
  handledSignatures: string[];
}

interface OrchestrationEventEntry {
  at: string;
  type: string;
  rootSessionID: string;
  sessionID: string;
  stage: PipelineStage;
  details?: Record<string, string>;
}

type OrchestrationEventInput = Omit<OrchestrationEventEntry, "at">;

interface PipelineState {
  rootSessionID: string;
  currentStage: PipelineStage;
  transition: TransitionState;
  sessions: Record<string, PipelineSessionState>;
  pendingTransition?: PendingTransition;
  nextSessionID?: string;
  routing?: RoutingContext;
  worktree?: WorktreeContext;
  terminalNotified: boolean;
  stopped: boolean;
  stopReason?: StopReason;
  error: ErrorContext;
  events: OrchestrationEventEntry[];
  createdAt: number;
  updatedAt: number;
}

interface PersistedOrchestrationState {
  version: 1;
  runtime: {
    off: boolean;
  };
  sessionToRoot: Record<string, string>;
  pipelines: Record<string, PipelineState>;
}

interface PipelineReference {
  rootSessionID: string;
  pipeline: PipelineState;
  session: PipelineSessionState;
}

interface PipelineCommandInput {
  name: string;
  sessionID: string;
  arguments: string;
}

const execFileAsync = promisify(execFile);

const defaultOrchestrationSettings: OrchestrationSettings = {
  enabled: true,
  mode: "manual",
  requireApprovalBeforeSpawn: true,
  ignoreAbortedMessages: true,
  verboseEvents: true,
};

const OrchestratorPlugin: Plugin = async ({ client, worktree }) => {
  const settings = await loadOrchestrationSettings(worktree);
  if (!settings.enabled) {
    return {};
  }

  const statePath = resolve(worktree, "_bmad-output", "orchestration-state.json");
  const eventLogPath = resolve(worktree, "_bmad-output", "orchestration-events.ndjson");
  const spawnScriptPath = resolve(worktree, "agents", "tools", "spawn_worktree.sh");
  const idleInFlight = new Set<string>();
  const preHandledCommands = new Map<string, number>();
  const state = await loadPersistedState(statePath);
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    "command.execute.before": async (input, output) => {
      const commandName = normalizeCommandName(input.command);
      if (commandName !== "pipeline") {
        return;
      }

      const commandInput: PipelineCommandInput = {
        name: commandName,
        sessionID: input.sessionID,
        arguments: input.arguments,
      };

      rememberPreHandledCommand(preHandledCommands, commandInput);
      await handlePipelineCommand(commandInput);

      output.parts = [];
    },
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await registerSession(event.properties.info);
        return;
      }

      if (event.type === "command.executed") {
        const commandInput: PipelineCommandInput = {
          name: event.properties.name,
          sessionID: event.properties.sessionID,
          arguments: event.properties.arguments,
        };

        if (wasPreHandled(preHandledCommands, commandInput)) {
          return;
        }

        await handlePipelineCommand(commandInput);
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
      const resolved = await resolvePipelineReference(sessionID);
      if (!resolved) {
        return;
      }

      const { rootSessionID, pipeline, session } = resolved;

      if (isPipelineDisabled(pipeline)) {
        return;
      }

      if (session.stage === "review") {
        await handleReviewIdle(rootSessionID, pipeline, session);
        return;
      }

      if (settings.mode === "manual") {
        if (pipeline.transition !== "awaiting_approval") {
          pipeline.transition = "idle";
          pipeline.updatedAt = Date.now();
          await persistState();
        }
        return;
      }

      if (pipeline.pendingTransition) {
        return;
      }

      const to = getNextStage(session.stage);
      if (!to) {
        return;
      }

      await requestTransition({
        rootSessionID,
        pipeline,
        from: session.stage,
        to,
        requestedBySessionID: session.sessionID,
        source: "auto-idle",
      });
    } finally {
      idleInFlight.delete(sessionID);
    }
  }

  async function handleSessionError(event: Extract<Event, { type: "session.error" }>): Promise<void> {
    const sessionID = event.properties.sessionID;
    if (!sessionID) {
      return;
    }

    const resolved = await resolvePipelineReference(sessionID);
    if (!resolved) {
      return;
    }

    const { pipeline, session } = resolved;
    if (pipeline.error.inProgress) {
      return;
    }

    if (shouldIgnoreError(event.properties.error, settings)) {
      await recordEvent(pipeline, {
        type: "error_ignored",
        rootSessionID: pipeline.rootSessionID,
        sessionID,
        stage: session.stage,
        details: {
          reason: "MessageAbortedError ignored in manual mode",
        },
      });
      return;
    }

    const signature = normalizeErrorSignature(event.properties.error, session.stage);
    if (pipeline.error.handledSignatures.includes(signature)) {
      return;
    }

    pipeline.error.inProgress = true;
    pipeline.error.lastSignature = signature;
    pipeline.error.attempts += 1;
    pipeline.error.handledSignatures.push(signature);

    if (pipeline.error.handledSignatures.length > 50) {
      pipeline.error.handledSignatures = pipeline.error.handledSignatures.slice(-50);
    }

    if (pipeline.transition === "in_progress") {
      pipeline.transition = "blocked";
    }

    pipeline.updatedAt = Date.now();
    await persistState();

    const errorSummary = formatError(event.properties.error);
    await recordEvent(pipeline, {
      type: "error",
      rootSessionID: pipeline.rootSessionID,
      sessionID,
      stage: session.stage,
      details: {
        summary: errorSummary,
      },
    });

    const recoveryPrompt = [
      `Pipeline stage '${session.stage}' reported an error: ${errorSummary}`,
      `Recovery attempt ${pipeline.error.attempts}. Keep state deterministic and do not respawn child sessions.`,
      "Summarize the blocker, list one concrete next action, and wait for explicit operator input.",
    ].join("\n");

    try {
      await promptSession(sessionID, recoveryPrompt, true, session.directory);
    } finally {
      pipeline.error.inProgress = false;
      pipeline.updatedAt = Date.now();
      await persistState();
    }
  }

  async function handleReviewIdle(
    rootSessionID: string,
    pipeline: PipelineState,
    session: PipelineSessionState,
  ): Promise<void> {
    if (pipeline.terminalNotified) {
      return;
    }

    pipeline.terminalNotified = true;
    pipeline.transition = "completed";
    pipeline.currentStage = "review";
    pipeline.stopped = true;
    pipeline.stopReason = "completed";
    session.status = "completed";
    pipeline.updatedAt = Date.now();
    await persistState();

    await recordEvent(pipeline, {
      type: "pipeline_completed",
      rootSessionID,
      sessionID: session.sessionID,
      stage: "review",
    });

    const completionNote = [
      `Review stage completed for session ${session.sessionID}.`,
      pipeline.worktree ? `Worktree: ${pipeline.worktree.worktreePath}` : null,
      pipeline.routing ? `Skill: ${pipeline.routing.skillID} (${pipeline.routing.mode})` : null,
      "Pipeline terminal state reached. Await human approval for next action.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    await promptSession(rootSessionID, completionNote, true, pipeline.sessions[rootSessionID]?.directory);
  }

  async function handlePipelineCommand(commandInput: PipelineCommandInput): Promise<void> {
    if (normalizeCommandName(commandInput.name) !== "pipeline") {
      return;
    }

    const sessionID = commandInput.sessionID;
    const args = tokenizeCommandArguments(commandInput.arguments);
    const action = (args[0] ?? "status").toLowerCase();

    if (action === "off") {
      state.runtime.off = true;
      for (const pipeline of Object.values(state.pipelines)) {
        if (pipeline.terminalNotified) {
          pipeline.stopped = true;
          pipeline.stopReason = "completed";
          pipeline.transition = "completed";
          pipeline.updatedAt = Date.now();
          continue;
        }

        if (pipeline.stopReason === "manual") {
          pipeline.updatedAt = Date.now();
          continue;
        }

        pipeline.stopped = true;
        pipeline.stopReason = "global_off";
        pipeline.transition = "stopped";
        pipeline.updatedAt = Date.now();
      }

      await persistState();
      await promptSession(sessionID, "Global orchestration mode is now OFF for this worktree.", true);
      return;
    }

    if (action === "on") {
      state.runtime.off = false;

      let resumed = 0;
      for (const pipeline of Object.values(state.pipelines)) {
        if (pipeline.stopReason !== "global_off") {
          continue;
        }

        if (pipeline.terminalNotified) {
          pipeline.stopReason = "completed";
          pipeline.stopped = true;
          pipeline.transition = "completed";
          pipeline.updatedAt = Date.now();
          continue;
        }

        pipeline.stopped = false;
        pipeline.stopReason = undefined;
        pipeline.transition = pipeline.pendingTransition
          ? pipeline.pendingTransition.approvalRequired && !pipeline.pendingTransition.approved
            ? "awaiting_approval"
            : "idle"
          : "idle";
        pipeline.updatedAt = Date.now();
        resumed += 1;
      }

      await persistState();
      await promptSession(
        sessionID,
        resumed > 0
          ? `Global orchestration mode is now ON. Resumed ${resumed} pipeline${resumed === 1 ? "" : "s"}.`
          : "Global orchestration mode is now ON.",
        true,
      );
      return;
    }

    const targetSession = getTargetSessionArgument(action, args);
    const resolved = await resolvePipelineForCommand(sessionID, targetSession);
    if (!resolved) {
      await promptSession(sessionID, "No pipeline state found for the requested session.", true);
      return;
    }

    const { rootSessionID, pipeline } = resolved;

    switch (action) {
      case "status": {
        const snapshot = renderStatusSnapshot(pipeline);
        await recordEvent(pipeline, {
          type: "status_snapshot",
          rootSessionID,
          sessionID,
          stage: pipeline.currentStage,
          details: {
            transition: pipeline.transition,
          },
        });
        await promptSession(sessionID, snapshot, true, pipeline.sessions[sessionID]?.directory);
        return;
      }

      case "stop": {
        pipeline.stopped = true;
        pipeline.stopReason = "manual";
        pipeline.transition = "stopped";
        pipeline.pendingTransition = undefined;
        pipeline.updatedAt = Date.now();

        await persistState();
        await recordEvent(pipeline, {
          type: "pipeline_stopped",
          rootSessionID,
          sessionID,
          stage: pipeline.currentStage,
        });
        await promptSession(sessionID, `Pipeline ${rootSessionID} is now stopped.`, true);
        return;
      }

      case "advance": {
        if (isPipelineDisabled(pipeline)) {
          await promptSession(sessionID, "Orchestration is currently OFF; cannot advance pipeline stages.", true);
          return;
        }

        const stageCandidate = args[1]?.toLowerCase();
        const targetStage = normalizeStage(stageCandidate);
        if (!targetStage) {
          await promptSession(sessionID, "Usage: /pipeline advance <triage|implementation|review> [session_id]", true);
          return;
        }

        const activeSession = getActiveSessionForStage(pipeline, pipeline.currentStage);
        if (!activeSession) {
          await promptSession(sessionID, "Cannot advance: active stage session is missing.", true);
          return;
        }

        await requestTransition({
          rootSessionID,
          pipeline,
          from: pipeline.currentStage,
          to: targetStage,
          requestedBySessionID: activeSession.sessionID,
          source: "manual-command",
          notifySessionID: sessionID,
        });
        return;
      }

      case "approve": {
        if (!pipeline.pendingTransition) {
          await promptSession(sessionID, "No pending transition requires approval.", true);
          return;
        }

        if (!pipeline.pendingTransition.approvalRequired) {
          await promptSession(sessionID, "Pending transition does not require approval.", true);
          return;
        }

        pipeline.pendingTransition.approved = true;
        pipeline.pendingTransition.approvedAt = Date.now();
        pipeline.transition = "in_progress";
        pipeline.updatedAt = Date.now();
        await persistState();

        await recordEvent(pipeline, {
          type: "spawn_approved",
          rootSessionID,
          sessionID,
          stage: pipeline.pendingTransition.from,
          details: {
            to: pipeline.pendingTransition.to,
          },
        });

        await executePendingTransition(rootSessionID, pipeline, sessionID);
        return;
      }

      default: {
        await promptSession(
          sessionID,
          "Usage: /pipeline <status|advance|approve|stop|off|on> [args]",
          true,
        );
      }
    }
  }

  async function requestTransition(input: {
    rootSessionID: string;
    pipeline: PipelineState;
    from: PipelineStage;
    to: PipelineStage;
    requestedBySessionID: string;
    source: "manual-command" | "auto-idle";
    notifySessionID?: string;
  }): Promise<void> {
    const { rootSessionID, pipeline, from, to, requestedBySessionID, source, notifySessionID } = input;
    if (pipeline.stopped) {
      if (notifySessionID) {
        await promptSession(notifySessionID, `Pipeline ${rootSessionID} is stopped.`, true);
      }
      return;
    }

    if (pipeline.pendingTransition) {
      if (notifySessionID) {
        await promptSession(notifySessionID, "A transition is already pending for this pipeline.", true);
      }
      return;
    }

    const expected = getNextStage(from);
    if (!expected || expected !== to) {
      if (notifySessionID) {
        await promptSession(
          notifySessionID,
          `Invalid transition ${from} -> ${to}. Expected next stage: ${expected ?? "none"}.`,
          true,
        );
      }
      return;
    }

    pipeline.pendingTransition = {
      from,
      to,
      requestedBySessionID,
      approvalRequired: settings.requireApprovalBeforeSpawn,
      approved: !settings.requireApprovalBeforeSpawn,
      requestedAt: Date.now(),
    };
    pipeline.transition = settings.requireApprovalBeforeSpawn ? "awaiting_approval" : "in_progress";
    pipeline.updatedAt = Date.now();
    await persistState();

    await recordEvent(pipeline, {
      type: "spawn_requested",
      rootSessionID,
      sessionID: requestedBySessionID,
      stage: from,
      details: {
        to,
        source,
      },
    });

    if (settings.requireApprovalBeforeSpawn) {
      await recordEvent(pipeline, {
        type: "spawn_blocked",
        rootSessionID,
        sessionID: requestedBySessionID,
        stage: from,
        details: {
          reason: "approval_required",
          command: "/pipeline approve",
        },
      });

      const message = [
        `Transition ${from} -> ${to} is pending approval.`,
        "Run `/pipeline approve` (optionally with a session ID) to continue.",
      ].join("\n");

      const notifyTarget = notifySessionID ?? requestedBySessionID;
      await promptSession(notifyTarget, message, true, pipeline.sessions[notifyTarget]?.directory);
      return;
    }

    await executePendingTransition(rootSessionID, pipeline, notifySessionID ?? requestedBySessionID);
  }

  async function executePendingTransition(
    rootSessionID: string,
    pipeline: PipelineState,
    notifySessionID: string,
  ): Promise<void> {
    const pending = pipeline.pendingTransition;
    if (!pending) {
      return;
    }

    if (pending.approvalRequired && !pending.approved) {
      return;
    }

    pipeline.transition = "in_progress";
    pipeline.updatedAt = Date.now();
    await persistState();

    try {
      if (pending.from === "triage" && pending.to === "implementation") {
        await executeTriageToImplementation(rootSessionID, pipeline, pending);
      } else if (pending.from === "implementation" && pending.to === "review") {
        await executeImplementationToReview(rootSessionID, pipeline, pending);
      } else {
        throw new Error(`Unsupported transition ${pending.from} -> ${pending.to}`);
      }

      await recordEvent(pipeline, {
        type: "spawn_completed",
        rootSessionID,
        sessionID: pending.requestedBySessionID,
        stage: pending.to,
      });
    } catch (error) {
      pipeline.transition = "blocked";
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "spawn_error",
        rootSessionID,
        sessionID: pending.requestedBySessionID,
        stage: pending.from,
        details: {
          summary: formatError(error),
        },
      });

      await promptSession(
        notifySessionID,
        [
          `Pipeline transition failed: ${pending.from} -> ${pending.to}`,
          `Reason: ${formatError(error)}`,
          "State remains blocked until operator intervention.",
        ].join("\n"),
        true,
      );
    }
  }

  async function executeTriageToImplementation(
    rootSessionID: string,
    pipeline: PipelineState,
    pending: PendingTransition,
  ): Promise<void> {
    const triageSession = pipeline.sessions[pending.requestedBySessionID];
    if (!triageSession) {
      throw new Error("Triage session metadata missing.");
    }

    const session = await getSession(triageSession.sessionID, triageSession.directory);
    const taskDescription = extractTaskDescription(session?.title ?? triageSession.sessionID);

    const routing = await resolveTaskRoute({
      taskDescription,
      directory: worktree,
      worktree,
      mode: "llm",
    });

    pipeline.routing = {
      skillID: routing.skill_id,
      reason: routing.reason,
      mode: routing.mode,
    };

    const taskID = buildTaskID(rootSessionID, routing.skill_id, taskDescription);
    const worktreeContext = await provisionImplementationWorktree({
      taskID,
      skillID: routing.skill_id,
      parentSessionID: triageSession.sessionID,
    });
    pipeline.worktree = worktreeContext;

    const childSession = await createChildSession({
      parentSessionID: triageSession.sessionID,
      stage: "implementation",
      directory: worktreeContext.worktreePath,
      titleSuffix: `${taskID}:${routing.skill_id}`,
    });

    if (!childSession?.id) {
      throw new Error("Failed to create implementation session.");
    }

    registerKnownSession(
      childSession,
      rootSessionID,
      "implementation",
      triageSession.sessionID,
      childSession.directory ?? worktreeContext.worktreePath,
    );

    triageSession.status = "completed";
    pipeline.currentStage = "implementation";
    pipeline.transition = "completed";
    pipeline.pendingTransition = undefined;
    pipeline.nextSessionID = childSession.id;
    pipeline.updatedAt = Date.now();
    await persistState();

    await promptSession(
      childSession.id,
      buildImplementationPrompt(taskDescription, pipeline, childSession.id),
      false,
      worktreeContext.worktreePath,
      "minion",
    );

    await promptSession(
      rootSessionID,
      [
        `Implementation session ${childSession.id} created in ${worktreeContext.worktreePath}.`,
        `Matchmaker selected skill ${routing.skill_id} via ${routing.mode} mode.`,
      ].join("\n"),
      true,
      pipeline.sessions[rootSessionID]?.directory,
    );
  }

  async function executeImplementationToReview(
    rootSessionID: string,
    pipeline: PipelineState,
    pending: PendingTransition,
  ): Promise<void> {
    const implementationSession = pipeline.sessions[pending.requestedBySessionID];
    if (!implementationSession) {
      throw new Error("Implementation session metadata missing.");
    }

    const reviewDirectory = pipeline.worktree?.worktreePath ?? implementationSession.directory ?? worktree;
    const titleSuffix = pipeline.worktree?.taskID ?? implementationSession.sessionID;

    const childSession = await createChildSession({
      parentSessionID: implementationSession.sessionID,
      stage: "review",
      directory: reviewDirectory,
      titleSuffix,
    });

    if (!childSession?.id) {
      throw new Error("Failed to create review session.");
    }

    registerKnownSession(
      childSession,
      rootSessionID,
      "review",
      implementationSession.sessionID,
      childSession.directory ?? reviewDirectory,
    );

    implementationSession.status = "completed";
    pipeline.currentStage = "review";
    pipeline.transition = "completed";
    pipeline.pendingTransition = undefined;
    pipeline.nextSessionID = childSession.id;
    pipeline.updatedAt = Date.now();
    await persistState();

    await promptSession(
      childSession.id,
      buildReviewPrompt(pipeline),
      false,
      reviewDirectory,
      "reviewer",
    );

    await promptSession(
      rootSessionID,
      `Review session ${childSession.id} created. Awaiting deterministic review handoff.`,
      true,
      pipeline.sessions[rootSessionID]?.directory,
    );
  }

  async function registerSession(session: Session): Promise<void> {
    const rootSessionID = resolveRootSessionID(session.id, session.parentID);
    const pipeline = ensurePipeline(rootSessionID);

    let stage: PipelineStage = "triage";
    if (session.parentID && pipeline.sessions[session.parentID]) {
      stage = deriveChildStage(pipeline, pipeline.sessions[session.parentID]);
    } else if (session.id !== rootSessionID && pipeline.currentStage) {
      stage = pipeline.currentStage;
    }

    registerKnownSession(session, rootSessionID, stage, session.parentID, session.directory);
    await persistState();
  }

  function registerKnownSession(
    session: Pick<Session, "id" | "directory" | "parentID">,
    rootSessionID: string,
    stage: PipelineStage,
    parentSessionID?: string,
    directory?: string,
  ): PipelineSessionState {
    const pipeline = ensurePipeline(rootSessionID);
    const existing = pipeline.sessions[session.id];
    if (existing) {
      if (!existing.parentSessionID && parentSessionID) {
        existing.parentSessionID = parentSessionID;
      }
      if (!existing.directory && (directory ?? session.directory)) {
        existing.directory = directory ?? session.directory;
      }
      if (existing.stage !== stage && existing.status === "active") {
        existing.stage = stage;
      }
      return existing;
    }

    const created: PipelineSessionState = {
      sessionID: session.id,
      stage,
      parentSessionID,
      directory: directory ?? session.directory,
      children: [],
      status: "active",
    };

    pipeline.sessions[session.id] = created;
    state.sessionToRoot[session.id] = rootSessionID;

    if (parentSessionID && pipeline.sessions[parentSessionID]) {
      const parent = pipeline.sessions[parentSessionID];
      if (!parent.children.includes(session.id)) {
        parent.children.push(session.id);
      }
    }

    pipeline.updatedAt = Date.now();
    return created;
  }

  async function resolvePipelineReference(sessionID: string): Promise<PipelineReference | null> {
    const rootSessionID = state.sessionToRoot[sessionID];
    if (rootSessionID) {
      const pipeline = state.pipelines[rootSessionID];
      const session = pipeline?.sessions[sessionID];
      if (pipeline && session) {
        return { rootSessionID, pipeline, session };
      }
    }

    const session = await getSession(sessionID);
    if (!session) {
      return null;
    }

    const resolvedRoot = resolveRootSessionID(session.id, session.parentID);
    const pipeline = ensurePipeline(resolvedRoot);
    const parent = session.parentID ? pipeline.sessions[session.parentID] : undefined;
    const stage = parent ? deriveChildStage(pipeline, parent) : pipeline.currentStage;
    const ensured = registerKnownSession(session, resolvedRoot, stage, session.parentID, session.directory);
    await persistState();

    return {
      rootSessionID: resolvedRoot,
      pipeline,
      session: ensured,
    };
  }

  async function resolvePipelineForCommand(
    sessionID: string,
    targetSessionID?: string,
  ): Promise<{ rootSessionID: string; pipeline: PipelineState } | null> {
    if (targetSessionID) {
      const targetRoot = state.sessionToRoot[targetSessionID] ?? targetSessionID;
      const targetPipeline = state.pipelines[targetRoot];
      if (targetPipeline) {
        return { rootSessionID: targetRoot, pipeline: targetPipeline };
      }
    }

    const currentRoot = state.sessionToRoot[sessionID] ?? sessionID;
    const currentPipeline = state.pipelines[currentRoot];
    if (currentPipeline) {
      return { rootSessionID: currentRoot, pipeline: currentPipeline };
    }

    const resolved = await resolvePipelineReference(sessionID);
    if (!resolved) {
      return null;
    }

    return { rootSessionID: resolved.rootSessionID, pipeline: resolved.pipeline };
  }

  function ensurePipeline(rootSessionID: string): PipelineState {
    const existing = state.pipelines[rootSessionID];
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const pipeline: PipelineState = {
      rootSessionID,
      currentStage: "triage",
      transition: "idle",
      sessions: {
        [rootSessionID]: {
          sessionID: rootSessionID,
          stage: "triage",
          children: [],
          status: "active",
        },
      },
      terminalNotified: false,
      stopped: false,
      error: {
        inProgress: false,
        attempts: 0,
        handledSignatures: [],
      },
      events: [],
      createdAt: now,
      updatedAt: now,
    };

    state.sessionToRoot[rootSessionID] = rootSessionID;
    state.pipelines[rootSessionID] = pipeline;
    return pipeline;
  }

  function deriveChildStage(pipeline: PipelineState, parent: PipelineSessionState): PipelineStage {
    const pending = pipeline.pendingTransition;
    if (pending && pending.requestedBySessionID === parent.sessionID) {
      return pending.to;
    }

    const next = getNextStage(parent.stage);
    return next ?? parent.stage;
  }

  function getActiveSessionForStage(
    pipeline: PipelineState,
    stage: PipelineStage,
  ): PipelineSessionState | undefined {
    if (pipeline.nextSessionID) {
      const next = pipeline.sessions[pipeline.nextSessionID];
      if (next && next.stage === stage && next.status === "active") {
        return next;
      }
    }

    return Object.values(pipeline.sessions)
      .filter((session) => session.stage === stage)
      .sort((a, b) => a.sessionID.localeCompare(b.sessionID))
      .find((session) => session.status === "active");
  }

  async function createChildSession(input: {
    parentSessionID: string;
    stage: PipelineStage;
    directory: string;
    titleSuffix: string;
  }): Promise<Session | null> {
    const parentSession = await getSession(input.parentSessionID, input.directory);
    const titleStem = parentSession?.id ?? input.parentSessionID;
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

  async function promptSession(
    sessionID: string,
    text: string,
    noReply = false,
    directory?: string,
    agent = "orchestrator",
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

  async function getSession(sessionID: string, directory?: string): Promise<Session | null> {
    try {
      const response = await client.session.get({
        path: { id: sessionID },
        query: {
          directory: directory ?? worktree,
        },
      });

      return response.data ?? null;
    } catch {
      return null;
    }
  }

  function resolveRootSessionID(sessionID: string, parentSessionID?: string): string {
    if (state.sessionToRoot[sessionID]) {
      return state.sessionToRoot[sessionID];
    }

    if (parentSessionID && state.sessionToRoot[parentSessionID]) {
      return state.sessionToRoot[parentSessionID];
    }

    return sessionID;
  }

  function isPipelineDisabled(pipeline: PipelineState): boolean {
    return settings.mode === "off" || state.runtime.off || pipeline.stopped;
  }

  function renderStatusSnapshot(pipeline: PipelineState): string {
    const pending = pipeline.pendingTransition
      ? `${pipeline.pendingTransition.from} -> ${pipeline.pendingTransition.to}`
      : "none";
    const statusLines = [
      `Pipeline: ${pipeline.rootSessionID}`,
      `Mode: ${state.runtime.off ? "off" : settings.mode}`,
      `Stage: ${pipeline.currentStage}`,
      `Transition: ${pipeline.transition}`,
      `Stopped: ${pipeline.stopped ? `yes (${pipeline.stopReason ?? "unknown"})` : "no"}`,
      `Pending: ${pending}`,
      `Worktree: ${pipeline.worktree?.worktreePath ?? "n/a"}`,
      `Routing: ${pipeline.routing ? `${pipeline.routing.skillID} (${pipeline.routing.mode})` : "n/a"}`,
      "Session Tree:",
      ...renderSessionTree(pipeline, pipeline.rootSessionID, 0),
    ];

    return statusLines.join("\n");
  }

  function renderSessionTree(pipeline: PipelineState, sessionID: string, depth: number): string[] {
    const session = pipeline.sessions[sessionID];
    if (!session) {
      return [];
    }

    const indent = "  ".repeat(depth);
    const currentMarker = session.stage === pipeline.currentStage && session.status === "active" ? " *" : "";
    const line = `${indent}- ${session.sessionID} [${session.stage}] {${session.status}}${currentMarker}`;
    const childLines = session.children.flatMap((childID) => renderSessionTree(pipeline, childID, depth + 1));
    return [line, ...childLines];
  }

  async function recordEvent(pipeline: PipelineState, entry: OrchestrationEventInput): Promise<void> {
    const normalized: OrchestrationEventEntry = {
      ...entry,
      at: new Date().toISOString(),
    };

    pipeline.events.push(normalized);
    if (pipeline.events.length > 40) {
      pipeline.events = pipeline.events.slice(-40);
    }

    pipeline.updatedAt = Date.now();
    const serialized = `${JSON.stringify(normalized)}\n`;

    await scheduleWrite(async () => {
      await mkdir(dirname(eventLogPath), { recursive: true });
      await appendFile(eventLogPath, serialized, "utf-8");
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    });

    if (settings.verboseEvents && normalized.type !== "status_snapshot") {
      const targetSessionID = pipeline.rootSessionID;
      const message = [
        `[orchestration event] ${normalized.type}`,
        `stage=${normalized.stage}`,
        normalized.details ? `details=${JSON.stringify(normalized.details)}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");

      await promptSession(targetSessionID, message, true, pipeline.sessions[targetSessionID]?.directory);
    }
  }

  async function persistState(): Promise<void> {
    await scheduleWrite(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    });
  }

  async function scheduleWrite(operation: () => Promise<void>): Promise<void> {
    writeQueue = writeQueue.then(operation, operation);
    await writeQueue;
  }
};

async function loadOrchestrationSettings(worktree: string): Promise<OrchestrationSettings> {
  try {
    const configPath = resolve(worktree, "demonlord.config.json");
    const configRaw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(configRaw) as {
      orchestration?: {
        enabled?: unknown;
        mode?: unknown;
        require_approval_before_spawn?: unknown;
        ignore_aborted_messages?: unknown;
        verbose_events?: unknown;
      };
    };

    const config = parsed.orchestration ?? {};
    const modeCandidate = config.mode;

    return {
      enabled:
        typeof config.enabled === "boolean"
          ? config.enabled
          : defaultOrchestrationSettings.enabled,
      mode:
        modeCandidate === "off" || modeCandidate === "manual" || modeCandidate === "auto"
          ? modeCandidate
          : defaultOrchestrationSettings.mode,
      requireApprovalBeforeSpawn:
        typeof config.require_approval_before_spawn === "boolean"
          ? config.require_approval_before_spawn
          : defaultOrchestrationSettings.requireApprovalBeforeSpawn,
      ignoreAbortedMessages:
        typeof config.ignore_aborted_messages === "boolean"
          ? config.ignore_aborted_messages
          : defaultOrchestrationSettings.ignoreAbortedMessages,
      verboseEvents:
        typeof config.verbose_events === "boolean"
          ? config.verbose_events
          : defaultOrchestrationSettings.verboseEvents,
    };
  } catch {
    return defaultOrchestrationSettings;
  }
}

async function loadPersistedState(filePath: string): Promise<PersistedOrchestrationState> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedOrchestrationState>;
    if (parsed.version !== 1) {
      throw new Error("Unsupported orchestration state version");
    }

    return {
      version: 1,
      runtime: {
        off: parsed.runtime?.off === true,
      },
      sessionToRoot: parsed.sessionToRoot ?? {},
      pipelines: parsed.pipelines ?? {},
    };
  } catch {
    return {
      version: 1,
      runtime: {
        off: false,
      },
      sessionToRoot: {},
      pipelines: {},
    };
  }
}

function shouldIgnoreError(error: unknown, settings: OrchestrationSettings): boolean {
  if (!settings.ignoreAbortedMessages || settings.mode !== "manual") {
    return false;
  }

  return extractErrorName(error) === "MessageAbortedError";
}

function normalizeErrorSignature(error: unknown, stage: PipelineStage): string {
  const name = extractErrorName(error) ?? "UnknownError";
  const message = extractErrorMessage(error)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .trim();
  return `${stage}:${name}:${message}`;
}

function extractErrorName(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown };
    if (typeof candidate.name === "string") {
      return candidate.name;
    }
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return null;
}

function extractErrorMessage(error: unknown): string {
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
    const candidate = error as { message?: unknown; data?: unknown };
    if (typeof candidate.message === "string") {
      return candidate.message;
    }

    if (candidate.data && typeof candidate.data === "object") {
      const data = candidate.data as { message?: unknown };
      if (typeof data.message === "string") {
        return data.message;
      }
    }
  }

  return "unknown error";
}

function formatError(error: unknown): string {
  const name = extractErrorName(error);
  const message = extractErrorMessage(error);
  return name ? `${name}: ${message}` : message;
}

function extractTaskDescription(title: string): string {
  const normalized = title.trim();
  if (!normalized) {
    return "general task";
  }

  const withoutPrefix = normalized.replace(/^(triage|implementation|review):/i, "").trim();
  return withoutPrefix || normalized;
}

function normalizeCommandName(name: string): string {
  return name.replace(/^\//, "").toLowerCase();
}

function buildCommandDedupKey(command: PipelineCommandInput): string {
  const normalizedArgs = command.arguments.trim();
  return `${command.sessionID}:${normalizeCommandName(command.name)}:${normalizedArgs}`;
}

function rememberPreHandledCommand(cache: Map<string, number>, command: PipelineCommandInput): void {
  const now = Date.now();
  cache.set(buildCommandDedupKey(command), now + 30_000);

  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function wasPreHandled(cache: Map<string, number>, command: PipelineCommandInput): boolean {
  const now = Date.now();
  const key = buildCommandDedupKey(command);
  const expiresAt = cache.get(key);

  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= now) {
    cache.delete(key);
    return false;
  }

  cache.delete(key);
  return true;
}

function getTargetSessionArgument(action: string, args: string[]): string | undefined {
  if (action === "advance") {
    return args.length >= 3 ? args[2] : undefined;
  }

  if (action === "status" || action === "stop" || action === "approve") {
    return args.length >= 2 ? args[1] : undefined;
  }

  return undefined;
}

function tokenizeCommandArguments(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function normalizeStage(value: string | undefined): PipelineStage | null {
  if (value === "triage" || value === "implementation" || value === "review") {
    return value;
  }
  return null;
}

function getNextStage(stage: PipelineStage): PipelineStage | null {
  if (stage === "triage") {
    return "implementation";
  }

  if (stage === "implementation") {
    return "review";
  }

  return null;
}

function buildImplementationPrompt(taskDescription: string, pipeline: PipelineState, childSessionID: string): string {
  const taskID = pipeline.worktree?.taskID ?? "unknown-task";
  const skillID = pipeline.routing?.skillID ?? "unrouted";
  const skillMode = pipeline.routing?.mode ?? "heuristic";
  const skillReason = pipeline.routing?.reason ?? "No routing reason available.";
  const worktreePath = pipeline.worktree?.worktreePath ?? "unknown-worktree";

  return [
    "Triage session is complete.",
    "Execute the next implementation unit and report completion details.",
    "",
    "Orchestration metadata:",
    `- Parent Session: ${pipeline.rootSessionID}`,
    `- Implementation Session: ${childSessionID}`,
    `- Task ID: ${taskID}`,
    `- Skill: ${skillID}`,
    `- Routing Mode: ${skillMode}`,
    `- Routing Reason: ${skillReason}`,
    `- Worktree: ${worktreePath}`,
    `- Task Description: ${taskDescription}`,
  ].join("\n");
}

function buildReviewPrompt(pipeline: PipelineState): string {
  return [
    "Implementation session is now idle.",
    "Review the completed changes, identify risks, and prepare a deterministic human-in-the-loop handoff.",
    "",
    "Implementation metadata:",
    `- Parent Session: ${pipeline.rootSessionID}`,
    `- Task ID: ${pipeline.worktree?.taskID ?? "unknown-task"}`,
    `- Skill: ${pipeline.routing?.skillID ?? "unrouted"}`,
    `- Routing Mode: ${pipeline.routing?.mode ?? "heuristic"}`,
    `- Worktree: ${pipeline.worktree?.worktreePath ?? "unknown-worktree"}`,
    `- Branch: ${pipeline.worktree?.branchName ?? "unknown-branch"}`,
  ].join("\n");
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

function extractScriptValue(stdout: string, label: string): string {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "m");
  const match = stdout.match(pattern);
  if (!match || !match[1]) {
    throw new Error(`spawn_worktree.sh did not return '${label}'.`);
  }

  return match[1].trim();
}

export default OrchestratorPlugin;
