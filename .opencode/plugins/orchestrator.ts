import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Session } from "@opencode-ai/sdk";
import { execFile } from "child_process";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "fs/promises";
import { delimiter, dirname, resolve } from "path";
import { promisify } from "util";
import { parse as parseJsoncDocument, printParseErrorCode, type ParseError } from "jsonc-parser";
import { loadSkillDefinitions, resolveTaskRoute, type RouteResult } from "../tools/matchmaker.ts";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "idle" | "awaiting_approval" | "in_progress" | "blocked" | "completed" | "stopped";
type SessionStatus = "active" | "completed" | "blocked" | "stopped";
type OrchestrationMode = "off" | "manual" | "auto";
type StopReason = "manual" | "global_off" | "completed";
type ExecutionRole = "planning" | "implementation" | "review";
type ExecutionTier = "lite" | "standard" | "pro";

interface TaskRoutingSettings {
  source: "tasklist_explicit";
  defaultTier: ExecutionTier;
}

type AgentPools = Record<ExecutionRole, Record<ExecutionTier, string[]>>;

interface OrchestrationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
  requireApprovalBeforeSpawn: boolean;
  ignoreAbortedMessages: boolean;
  verboseEvents: boolean;
  taskRouting: TaskRoutingSettings;
  agentPools: AgentPools;
  parallelism: ParallelismSettings;
}

interface ParallelismSettings {
  maxParallelTotal: number;
  maxParallelByRole: Record<ExecutionRole, number>;
  maxParallelByTier: Record<ExecutionTier, number>;
}

interface RoutingContext {
  skillID: string;
  reason: string;
  mode: RouteResult["mode"];
  agentID?: string;
  role?: ExecutionRole;
  tier?: ExecutionTier;
  taskRef?: string;
  parallelGroup?: string;
  dependsOn?: string[];
  metadataSource?: "tasklist" | "legacy";
}

interface TaskTraversalContext {
  taskDescription?: string;
  taskRef?: string;
  tasklistPath?: string;
}

interface TaskExecutionMetadata {
  taskRef: string;
  role: ExecutionRole;
  tier: ExecutionTier;
  skillID?: string;
  parallelGroup?: string;
  dependsOn: string[];
  taskIndex: number;
  tasklistPath: string;
}

interface TaskExecutionLookup {
  metadata?: TaskExecutionMetadata;
  warning?: string;
}

interface AgentResolution {
  ok: boolean;
  agentID?: string;
  tier?: ExecutionTier;
  fallbackUsed?: "requested_tier" | "default_tier" | "legacy_singleton";
  reason: string;
}

interface ExecutionGraphEventEntry {
  seq: number;
  ts: string;
  rootSessionID: string;
  eventType: string;
  sessionID: string;
  parentSessionID: string;
  stage: PipelineStage;
  taskRef: string;
  agentID: string;
  tier: string;
  skillID: string;
  parallelGroup: string;
  slot: string;
  status: string;
  reason?: string;
}

type ExecutionGraphEventInput = Omit<ExecutionGraphEventEntry, "seq" | "ts" | "rootSessionID">;

interface DispatchQueueItem {
  stage: PipelineStage;
  taskRef: string;
  role: ExecutionRole;
  tier: ExecutionTier;
  skillID: string;
  parallelGroup: string;
  dependsOn: string[];
  taskIndex: number;
  queuedAt: number;
  requestedBySessionID: string;
  parentSessionID: string;
  slot: string;
}

interface DispatchInFlightItem {
  stage: PipelineStage;
  taskRef: string;
  role: ExecutionRole;
  tier: ExecutionTier;
  parallelGroup: string;
  slot: string;
  startedAt: number;
  startedBySessionID: string;
}

interface ParallelDispatchUsage {
  total: number;
  byRole: Record<ExecutionRole, number>;
  byTier: Record<ExecutionTier, number>;
}

interface WorktreeContext {
  taskID: string;
  worktreePath: string;
  branchName: string;
}

interface SpecHandoffState {
  required: boolean;
  completed: boolean;
  markerPath: string;
  markerSessionID?: string;
  targetSkillID: string;
  targetRoutingMode: RouteResult["mode"];
  targetReason: string;
  targetExecution?: {
    agentID: string;
    role: ExecutionRole;
    tier: ExecutionTier;
    taskRef?: string;
    parallelGroup?: string;
    dependsOn?: string[];
    metadataSource: "tasklist" | "legacy";
  };
  completedAt?: number;
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
  taskTraversal?: TaskTraversalContext;
  worktree?: WorktreeContext;
  specHandoff?: SpecHandoffState;
  terminalNotified: boolean;
  stopped: boolean;
  stopReason?: StopReason;
  error: ErrorContext;
  events: OrchestrationEventEntry[];
  executionSeq?: number;
  executionDedupes?: Record<string, number>;
  dispatchQueue?: DispatchQueueItem[];
  dispatchInFlight?: DispatchInFlightItem[];
  completedTaskRefs?: string[];
  createdAt: number;
  updatedAt: number;
}

interface PersistedOrchestrationState {
  version: 2;
  updatedAt: string;
  runtime: {
    off: boolean;
    enabled: boolean;
    configuredMode: OrchestrationMode;
    effectiveMode: OrchestrationMode;
  };
  sessionToRoot: Record<string, string>;
  pipelines: Record<string, PipelineState>;
  pipelineSummaries: Record<string, PipelineSummary>;
  commandQueue: CommandQueueState;
}

interface PipelineSummary {
  rootSessionID: string;
  currentStage: PipelineStage;
  transition: TransitionState;
  stopped: boolean;
  stopReason?: StopReason;
  updatedAt: number;
  pendingTransition?: PendingTransition;
  nextSessionID?: string;
  routing?: RoutingContext;
  taskTraversal?: TaskTraversalContext;
  worktree?: WorktreeContext;
  specHandoff?: SpecHandoffState;
}

interface CommandQueueState {
  path: string;
  lastProcessedLine: number;
  lastProcessedAt?: string;
  processedDedupes: Record<string, number>;
}

interface ConfiguredAgentCatalog {
  ids: Set<string>;
  sourcePath: string;
  loadError?: string;
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

interface PipelineControlQueueCommand {
  version: 1;
  id: string;
  source: "pipelinectl";
  action: "off" | "on" | "advance" | "approve" | "stop";
  sessionID: string;
  targetSessionID?: string;
  stage?: PipelineStage;
  dedupeKey: string;
  requestedAt: string;
  expectation?: {
    rootSessionID?: string;
    stage?: PipelineStage;
    transition?: TransitionState;
    pipelineUpdatedAt?: number;
    pendingRequired?: boolean;
  };
}

type StageTransitionOutcome = "spawned" | "queued" | "blocked";

const execFileAsync = promisify(execFile);

const defaultOrchestrationSettings: OrchestrationSettings = {
  enabled: true,
  mode: "manual",
  requireApprovalBeforeSpawn: true,
  ignoreAbortedMessages: true,
  verboseEvents: true,
  taskRouting: {
    source: "tasklist_explicit",
    defaultTier: "standard",
  },
  agentPools: {
    planning: {
      lite: ["planner-lite", "planner"],
      standard: ["planner", "planner-lite"],
      pro: ["planner-pro", "planner"],
    },
    implementation: {
      lite: ["minion-lite", "minion"],
      standard: ["minion-standard", "minion"],
      pro: ["minion-pro", "minion"],
    },
    review: {
      lite: ["reviewer-lite", "reviewer"],
      standard: ["reviewer", "reviewer-lite"],
      pro: ["reviewer-pro", "reviewer"],
    },
  },
  parallelism: {
    maxParallelTotal: 1,
    maxParallelByRole: {
      planning: 1,
      implementation: 1,
      review: 1,
    },
    maxParallelByTier: {
      lite: 1,
      standard: 1,
      pro: 1,
    },
  },
};

const LEGACY_ROLE_AGENT: Record<ExecutionRole, string> = {
  planning: "planner",
  implementation: "minion",
  review: "reviewer",
};

const SPEC_EXPERT_SKILL_ID = "spec-expert";
const SPEC_HANDOFF_READY_MARKER = "<!-- DEMONLORD_SPEC_HANDOFF_READY -->";
const SPEC_HANDOFF_REQUIRED_HEADINGS = ["## Scope", "## Constraints"];
const TASK_REF_PATTERN = /\bT-\d+(?:\.\d+)+\b/i;

const AMBIGUITY_HINT_PATTERN = /(not sure|unsure|unclear|ambiguous|conflict|recommend|recommendation)/;

const SPEC_DISCOVERY_TOKENS = new Set([
  "spec",
  "specs",
  "requirement",
  "requirements",
  "acceptance",
  "tasklist",
  "plan",
  "codename",
  "constraint",
  "constraints",
  "docs",
  "documentation",
]);

const OrchestratorPlugin: Plugin = async ({ client, worktree }) => {
  const settings = await loadOrchestrationSettings(worktree);
  if (!settings.enabled) {
    return {};
  }

  const statePath = resolve(worktree, "_bmad-output", "orchestration-state.json");
  const eventLogPath = resolve(worktree, "_bmad-output", "orchestration-events.ndjson");
  const executionGraphPath = resolve(worktree, "_bmad-output", "execution-graph.ndjson");
  const commandQueuePath = resolve(worktree, "_bmad-output", "orchestration-commands.ndjson");
  const shellBootstrapPath = resolve(worktree, "_bmad-output", "pipelinectl-shell.env.sh");
  const spawnScriptPath = resolve(worktree, "agents", "tools", "spawn_worktree.sh");
  const configuredAgentCatalog = await loadConfiguredAgentIDs(worktree);
  const idleInFlight = new Set<string>();
  const preHandledCommands = new Map<string, number>();
  const state = await loadPersistedState(statePath, commandQueuePath, settings);
  for (const pipeline of Object.values(state.pipelines)) {
    normalizePipelineRuntimeState(pipeline);
  }
  state.commandQueue.path = commandQueuePath;
  state.updatedAt = new Date().toISOString();
  let writeQueue: Promise<void> = Promise.resolve();
  let commandQueueInFlight = false;

  await ensureShellBootstrapFile(shellBootstrapPath, worktree);
  await persistState();

  return {
    "command.execute.before": async (input, output) => {
      const commandName = normalizeCommandName(input.command);
      if (commandName !== "pipeline") {
        return;
      }

      await processQueuedCommands();

      const commandInput: PipelineCommandInput = {
        name: commandName,
        sessionID: input.sessionID,
        arguments: input.arguments,
      };

      rememberPreHandledCommand(preHandledCommands, commandInput);
      await handlePipelineCommand(commandInput);

      output.parts = [];
      setNoReplyIfSupported(output);
    },
    "shell.env": async (input, output) => {
      const toolsPath = resolve(worktree, "agents", "tools");
      const cwdRoot = resolve(input.cwd);
      const parentWorktree = resolve(worktree, "..");
      const pathPrefixes = dedupePathEntries([
        cwdRoot,
        resolve(cwdRoot, "agents", "tools"),
        worktree,
        toolsPath,
        parentWorktree,
        resolve(parentWorktree, "agents", "tools"),
      ]);
      const inheritedPath = output.env.PATH ?? process.env.PATH ?? "";
      output.env.PATH =
        pathPrefixes.length > 0
          ? `${pathPrefixes.join(delimiter)}${inheritedPath ? `${delimiter}${inheritedPath}` : ""}`
          : inheritedPath;
      output.env.BASH_ENV = shellBootstrapPath;
      output.env.OPENCODE_PIPELINECTL = resolve(worktree, "agents", "tools", "pipelinectl.sh");
      output.env.OPENCODE_WORKTREE = worktree;
      output.env.OPENCODE_ORCHESTRATION_STATE = statePath;
      output.env.OPENCODE_ORCHESTRATION_COMMAND_QUEUE = commandQueuePath;
      output.env.OPENCODE_ORCHESTRATION_MODE = getEffectiveMode();

      const sessionID = input.sessionID;
      if (!sessionID) {
        return;
      }

      output.env.OPENCODE_SESSION_ID = sessionID;
      const resolved = await resolvePipelineReference(sessionID);
      if (!resolved) {
        return;
      }

      output.env.OPENCODE_PIPELINE_ROOT_SESSION_ID = resolved.rootSessionID;
      output.env.OPENCODE_PIPELINE_STAGE = resolved.pipeline.currentStage;
      output.env.OPENCODE_PIPELINE_TRANSITION = resolved.pipeline.transition;
      if (resolved.pipeline.worktree?.worktreePath) {
        output.env.OPENCODE_PIPELINE_WORKTREE = resolved.pipeline.worktree.worktreePath;
      }
    },
    event: async ({ event }) => {
      await processQueuedCommands();

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

      if (pipeline.transition === "blocked" && (pipeline.dispatchQueue?.length ?? 0) > 0) {
        const queuedHead = peekDispatchQueue(pipeline);
        if (queuedHead) {
          const dependencyStatus = await resolveTaskDependencyStatus({
            dependsOn: queuedHead.dependsOn,
            pipeline,
            tasklistPath: pipeline.taskTraversal?.tasklistPath,
          });
          if (dependencyStatus.missing.length === 0) {
            pipeline.transition = "idle";
            pipeline.updatedAt = Date.now();
            await persistState();
            await promptSession(
              session.sessionID,
              `Dependencies resolved for queued task ${queuedHead.taskRef}. Dispatch is unblocked and ready for the next transition.`,
              true,
              session.directory,
            );
          }
        }
      }

      if (session.stage === "review") {
        await handleReviewIdle(rootSessionID, pipeline, session);
        return;
      }

      if (session.stage === "implementation") {
        const handoffHandled = await maybeHandleSpecHandoffIdle(rootSessionID, pipeline, session);
        if (handoffHandled) {
          return;
        }
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

    await writeExecutionGraphEvent(pipeline, {
      eventType: "pipeline_completed",
      sessionID: session.sessionID,
      parentSessionID: session.parentSessionID ?? rootSessionID,
      stage: "review",
      taskRef: pipeline.routing?.taskRef ?? "n/a",
      agentID: pipeline.routing?.agentID ?? "n/a",
      tier: pipeline.routing?.tier ?? settings.taskRouting.defaultTier,
      skillID: pipeline.routing?.skillID ?? "n/a",
      parallelGroup: normalizeParallelGroup(pipeline.routing?.parallelGroup),
      slot: "review:terminal",
      status: "completed",
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

  async function maybeHandleSpecHandoffIdle(
    rootSessionID: string,
    pipeline: PipelineState,
    session: PipelineSessionState,
  ): Promise<boolean> {
    const handoff = pipeline.specHandoff;
    if (!handoff || !handoff.required || handoff.completed) {
      return false;
    }

    if (handoff.markerSessionID && handoff.markerSessionID !== session.sessionID) {
      return false;
    }

    const validation = await validateSpecHandoffMarkerFile(handoff.markerPath);
    if (!validation.ok) {
      pipeline.transition = "blocked";
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "spec_handoff_missing",
        rootSessionID,
        sessionID: session.sessionID,
        stage: "implementation",
        details: {
          markerPath: handoff.markerPath,
          missing: validation.missing.join(", "),
        },
      });

      const reminder = [
        "Spec-first policy requires a handoff artifact before implementation can start.",
        `Write this file: ${handoff.markerPath}`,
        `Required marker token: ${SPEC_HANDOFF_READY_MARKER}`,
        `Required headings: ${SPEC_HANDOFF_REQUIRED_HEADINGS.join(", ")}`,
        "After writing the file, return to idle to continue pipeline progression.",
      ].join("\n");

      await promptSession(session.sessionID, reminder, false, session.directory, pipeline.routing?.agentID ?? "minion");
      return true;
    }

    handoff.completed = true;
    handoff.completedAt = Date.now();
    handoff.markerSessionID = session.sessionID;
    session.status = "completed";

    const preservedTarget = handoff.targetExecution ?? {
      agentID: pipeline.routing?.agentID ?? LEGACY_ROLE_AGENT.implementation,
      role: pipeline.routing?.role ?? "implementation",
      tier: pipeline.routing?.tier ?? defaultOrchestrationSettings.taskRouting.defaultTier,
      taskRef: pipeline.routing?.taskRef,
      parallelGroup: pipeline.routing?.parallelGroup,
      dependsOn: pipeline.routing?.dependsOn,
      metadataSource: pipeline.routing?.metadataSource ?? "legacy",
    };

    const taskID = pipeline.worktree?.taskID ?? sanitizeTitleSegment(rootSessionID);
    const implementationDirectory = pipeline.worktree?.worktreePath ?? session.directory ?? worktree;

    try {
      const childSession = await createChildSession({
        parentSessionID: session.sessionID,
        stage: "implementation",
        directory: implementationDirectory,
        titleSuffix: `${taskID}:${handoff.targetSkillID}`,
      });

      if (!childSession?.id) {
        throw new Error("Failed to create implementation session after spec handoff.");
      }

      registerKnownSession(
        childSession,
        rootSessionID,
        "implementation",
        session.sessionID,
        childSession.directory ?? implementationDirectory,
      );

      pipeline.routing = {
        skillID: handoff.targetSkillID,
        mode: handoff.targetRoutingMode,
        reason: `Spec handoff marker verified at ${handoff.markerPath}. ${handoff.targetReason}`,
        agentID: preservedTarget.agentID,
        role: preservedTarget.role,
        tier: preservedTarget.tier,
        taskRef: preservedTarget.taskRef,
        parallelGroup: preservedTarget.parallelGroup,
        dependsOn: preservedTarget.dependsOn,
        metadataSource: preservedTarget.metadataSource,
      };
      pipeline.nextSessionID = childSession.id;
      pipeline.transition = "idle";
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "spec_handoff_completed",
        rootSessionID,
        sessionID: session.sessionID,
        stage: "implementation",
        details: {
          markerPath: handoff.markerPath,
          targetSkill: handoff.targetSkillID,
        },
      });

      const rootSession = await getSession(rootSessionID, pipeline.sessions[rootSessionID]?.directory);
      const taskDescription = extractTaskDescription(rootSession?.title ?? pipeline.worktree?.taskID ?? rootSessionID);

      await promptSession(
        childSession.id,
        buildImplementationPrompt(taskDescription, pipeline, childSession.id),
        false,
        implementationDirectory,
        preservedTarget.agentID,
      );

      await promptSession(
        rootSessionID,
        [
          `Spec handoff verified at ${handoff.markerPath}.`,
          `Implementation session ${childSession.id} started with skill ${handoff.targetSkillID}.`,
        ].join("\n"),
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
    } catch (error) {
      pipeline.transition = "blocked";
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "spec_handoff_error",
        rootSessionID,
        sessionID: session.sessionID,
        stage: "implementation",
        details: {
          summary: formatError(error),
        },
      });

      await promptSession(
        rootSessionID,
        [
          "Spec handoff was verified but follow-up implementation session spawn failed.",
          `Reason: ${formatError(error)}`,
          "Pipeline is blocked until operator intervention.",
        ].join("\n"),
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
    }

    return true;
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
      applyGlobalOffToPipelines(state.pipelines);

      await persistState();
      await promptSession(sessionID, "Global orchestration mode is now OFF for this worktree.", true);
      return;
    }

    if (action === "on") {
      state.runtime.off = false;
      const resumed = applyGlobalOnToPipelines(state.pipelines);

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
        const snapshot = await renderStatusSnapshot(pipeline);
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

        const disabledReason = getPipelineDisabledReason(pipeline);
        if (disabledReason) {
          await promptSession(sessionID, `Cannot approve transition: ${disabledReason}`, true);
          return;
        }

        pipeline.pendingTransition.approved = true;
        pipeline.pendingTransition.approvedAt = Date.now();
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

  async function processQueuedCommands(): Promise<void> {
    if (commandQueueInFlight) {
      return;
    }

    commandQueueInFlight = true;
    try {
      const lines = await readCommandQueueLines(commandQueuePath);
      if (state.commandQueue.lastProcessedLine > lines.length) {
        state.commandQueue.lastProcessedLine = lines.length;
      }

      let changed = false;
      const startIndex = Math.max(0, state.commandQueue.lastProcessedLine);
      for (let index = startIndex; index < lines.length; index += 1) {
        state.commandQueue.lastProcessedLine = index + 1;
        changed = true;

        const rawLine = lines[index]?.trim();
        if (!rawLine) {
          continue;
        }

        const queued = parseQueuedCommand(rawLine);
        if (!queued) {
          continue;
        }

        pruneProcessedCommandDedupes(state.commandQueue.processedDedupes);
        const dedupeExpiry = state.commandQueue.processedDedupes[queued.dedupeKey];
        if (typeof dedupeExpiry === "number" && dedupeExpiry > Date.now()) {
          await promptSession(
            queued.sessionID,
            `Command '${queued.action}' ignored because dedupe key '${queued.dedupeKey}' is already in-flight.`,
            true,
          );
          continue;
        }

        state.commandQueue.processedDedupes[queued.dedupeKey] = Date.now() + 300_000;
        const validated = await validateQueuedCommand(queued);
        if (!validated.ok) {
          await promptSession(queued.sessionID, validated.reason, true);
          continue;
        }

        await handlePipelineCommand({
          name: "pipeline",
          sessionID: queued.sessionID,
          arguments: validated.commandArguments,
        });
      }

      if (changed) {
        state.commandQueue.lastProcessedAt = new Date().toISOString();
        state.updatedAt = new Date().toISOString();
        await persistState();
      }
    } finally {
      commandQueueInFlight = false;
    }
  }

  async function validateQueuedCommand(
    command: PipelineControlQueueCommand,
  ): Promise<{ ok: true; commandArguments: string } | { ok: false; reason: string }> {
    if (command.action === "off" || command.action === "on") {
      return {
        ok: true,
        commandArguments: command.action,
      };
    }

    const resolved = await resolvePipelineForCommand(command.sessionID, command.targetSessionID);
    if (!resolved) {
      return {
        ok: false,
        reason: `Rejected '${command.action}': no pipeline found for '${command.targetSessionID ?? command.sessionID}'.`,
      };
    }

    const { rootSessionID, pipeline } = resolved;
    const expected = command.expectation;

    if (expected?.rootSessionID && expected.rootSessionID !== rootSessionID) {
      return {
        ok: false,
        reason: [
          `Rejected '${command.action}': pipeline root changed (${expected.rootSessionID} -> ${rootSessionID}).`,
          "Refresh with `pipelinectl status` and retry.",
        ].join("\n"),
      };
    }

    if (typeof expected?.pipelineUpdatedAt === "number" && pipeline.updatedAt !== expected.pipelineUpdatedAt) {
      return {
        ok: false,
        reason: [
          `Rejected '${command.action}': pipeline state is stale (expected updatedAt=${expected.pipelineUpdatedAt}, current=${pipeline.updatedAt}).`,
          "Refresh with `pipelinectl status` and retry.",
        ].join("\n"),
      };
    }

    if (expected?.stage && pipeline.currentStage !== expected.stage) {
      return {
        ok: false,
        reason: [
          `Rejected '${command.action}': stage changed (expected ${expected.stage}, current ${pipeline.currentStage}).`,
          "Refresh with `pipelinectl status` and retry.",
        ].join("\n"),
      };
    }

    if (expected?.transition && pipeline.transition !== expected.transition) {
      return {
        ok: false,
        reason: [
          `Rejected '${command.action}': transition changed (expected ${expected.transition}, current ${pipeline.transition}).`,
          "Refresh with `pipelinectl status` and retry.",
        ].join("\n"),
      };
    }

    if (command.action === "advance") {
      if (!command.stage) {
        return {
          ok: false,
          reason: "Rejected 'advance': missing target stage. Use `pipelinectl advance <triage|implementation|review>`.",
        };
      }

      if (pipeline.currentStage === "implementation" && command.stage === "review" && pipeline.specHandoff && !pipeline.specHandoff.completed) {
        return {
          ok: false,
          reason: [
            "Rejected 'advance': spec handoff is incomplete.",
            `Expected marker file: ${pipeline.specHandoff.markerPath}`,
          ].join("\n"),
        };
      }

      const expectedNext = getNextStage(pipeline.currentStage);
      if (expectedNext !== command.stage) {
        return {
          ok: false,
          reason: `Rejected 'advance': invalid transition from ${pipeline.currentStage} to ${command.stage}; expected ${expectedNext ?? "none"}.`,
        };
      }

      const targetSuffix = command.targetSessionID ? ` ${command.targetSessionID}` : "";
      return {
        ok: true,
        commandArguments: `advance ${command.stage}${targetSuffix}`,
      };
    }

    if (command.action === "approve") {
      if (!pipeline.pendingTransition) {
        return {
          ok: false,
          reason: "Rejected 'approve': no pending transition requires approval.",
        };
      }

      if (expected?.pendingRequired && !pipeline.pendingTransition.approvalRequired) {
        return {
          ok: false,
          reason: "Rejected 'approve': pending transition no longer requires approval.",
        };
      }

      const targetSuffix = command.targetSessionID ? ` ${command.targetSessionID}` : "";
      return {
        ok: true,
        commandArguments: `approve${targetSuffix}`,
      };
    }

    if (command.action === "stop") {
      if (pipeline.stopped) {
        return {
          ok: false,
          reason: `Rejected 'stop': pipeline ${rootSessionID} is already stopped (${pipeline.stopReason ?? "unknown"}).`,
        };
      }

      const targetSuffix = command.targetSessionID ? ` ${command.targetSessionID}` : "";
      return {
        ok: true,
        commandArguments: `stop${targetSuffix}`,
      };
    }

    return {
      ok: false,
      reason: `Rejected command '${command.action}': unsupported action.`,
    };
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

    if (from === "implementation" && to === "review" && pipeline.specHandoff && !pipeline.specHandoff.completed) {
      if (notifySessionID) {
        await promptSession(
          notifySessionID,
          [
            "Cannot advance to review: spec handoff is incomplete.",
            `Expected marker file: ${pipeline.specHandoff.markerPath}`,
            `Required token: ${SPEC_HANDOFF_READY_MARKER}`,
          ].join("\n"),
          true,
        );
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

    const disabledReason = getPipelineDisabledReason(pipeline);
    if (disabledReason) {
      await promptSession(notifySessionID, `Pending transition not executed: ${disabledReason}`, true);
      return;
    }

    pipeline.transition = "in_progress";
    pipeline.updatedAt = Date.now();
    await persistState();

    try {
      let outcome: StageTransitionOutcome;
      if (pending.from === "triage" && pending.to === "implementation") {
        outcome = await executeTriageToImplementation(rootSessionID, pipeline, pending);
      } else if (pending.from === "implementation" && pending.to === "review") {
        outcome = await executeImplementationToReview(rootSessionID, pipeline, pending);
      } else {
        throw new Error(`Unsupported transition ${pending.from} -> ${pending.to}`);
      }

      if (outcome === "spawned") {
        await recordEvent(pipeline, {
          type: "spawn_completed",
          rootSessionID,
          sessionID: pending.requestedBySessionID,
          stage: pending.to,
        });
      }
    } catch (error) {
      if (pending.to === "implementation" && pipeline.routing?.taskRef) {
        clearDispatchInFlightTask(pipeline, pipeline.routing.taskRef);
      }
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
  ): Promise<StageTransitionOutcome> {
    const triageSession = pipeline.sessions[pending.requestedBySessionID];
    if (!triageSession) {
      throw new Error("Triage session metadata missing.");
    }

    const session = await getSession(triageSession.sessionID, triageSession.directory);
    const fallbackTaskDescription = extractTaskDescription(session?.title ?? triageSession.sessionID);
    const traversalContext = await resolveTaskTraversalContext(worktree, {
      taskDescription: fallbackTaskDescription,
      existing: pipeline.taskTraversal,
    });
    pipeline.taskTraversal = traversalContext;

    const taskDescription = traversalContext.taskDescription ?? fallbackTaskDescription;
    const executionLookup = await resolveTaskExecutionMetadata(traversalContext);
    const executionMetadata = executionLookup.metadata;
    const taskRef = executionMetadata?.taskRef ?? traversalContext.taskRef;

    if (executionLookup.warning) {
      await recordEvent(pipeline, {
        type: "routing_warning",
        rootSessionID,
        sessionID: triageSession.sessionID,
        stage: "triage",
        details: {
          reason: executionLookup.warning,
        },
      });

      await writeExecutionGraphEvent(pipeline, {
        eventType: "routing_warning",
        sessionID: triageSession.sessionID,
        parentSessionID: triageSession.parentSessionID ?? rootSessionID,
        stage: "triage",
        taskRef: taskRef ?? "n/a",
        agentID: "n/a",
        tier: executionMetadata?.tier ?? settings.taskRouting.defaultTier,
        skillID: executionMetadata?.skillID ?? "n/a",
        parallelGroup: executionMetadata?.parallelGroup ?? "",
        slot: "triage:0",
        status: "warning",
        reason: executionLookup.warning,
      });
    }

    const requestedRole = executionMetadata?.role ?? "implementation";
    const requestedTier = executionMetadata?.tier ?? settings.taskRouting.defaultTier;
    const agentResolution = resolveAgentFromPools({
      role: requestedRole,
      requestedTier,
      defaultTier: settings.taskRouting.defaultTier,
      agentPools: settings.agentPools,
      configuredAgentIDs: configuredAgentCatalog.ids,
      configuredAgentSourceError: configuredAgentCatalog.loadError,
      configuredAgentSourcePath: configuredAgentCatalog.sourcePath,
    });

    if (!agentResolution.ok || !agentResolution.agentID || !agentResolution.tier) {
      const blockedReason = agentResolution.reason;
      pipeline.transition = "blocked";
      pipeline.pendingTransition = undefined;
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "task_blocked",
        rootSessionID,
        sessionID: triageSession.sessionID,
        stage: "triage",
        details: {
          reason: blockedReason,
          role: requestedRole,
          tier: requestedTier,
          taskRef: taskRef ?? "unknown",
        },
      });

      await writeExecutionGraphEvent(pipeline, {
        eventType: "task_blocked",
        sessionID: triageSession.sessionID,
        parentSessionID: triageSession.parentSessionID ?? rootSessionID,
        stage: "triage",
        taskRef: taskRef ?? "n/a",
        agentID: "unresolved",
        tier: requestedTier,
        skillID: executionMetadata?.skillID ?? "n/a",
        parallelGroup: executionMetadata?.parallelGroup ?? "",
        slot: "triage:0",
        status: "blocked",
        reason: blockedReason,
      });

      await promptSession(
        rootSessionID,
        [
          "Pipeline is blocked before implementation spawn.",
          blockedReason,
          "Update orchestration.agent_pools or add the required agent IDs in .opencode/opencode.jsonc.",
        ].join("\n"),
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
      return "blocked";
    }

    if (agentResolution.fallbackUsed && agentResolution.fallbackUsed !== "requested_tier") {
      await recordEvent(pipeline, {
        type: "routing_fallback",
        rootSessionID,
        sessionID: triageSession.sessionID,
        stage: "triage",
        details: {
          role: requestedRole,
          requestedTier,
          resolvedTier: agentResolution.tier,
          agentID: agentResolution.agentID,
          reason: agentResolution.reason,
        },
      });

      await writeExecutionGraphEvent(pipeline, {
        eventType: "routing_fallback",
        sessionID: triageSession.sessionID,
        parentSessionID: triageSession.parentSessionID ?? rootSessionID,
        stage: "triage",
        taskRef: taskRef ?? "n/a",
        agentID: agentResolution.agentID,
        tier: agentResolution.tier,
        skillID: executionMetadata?.skillID ?? "n/a",
        parallelGroup: executionMetadata?.parallelGroup ?? "",
        slot: "triage:0",
        status: "resolved",
        reason: agentResolution.reason,
      });
    }

    const availableSkills = await loadSkillDefinitions(worktree);
    const hasSpecExpertSkill = availableSkills.some((skill) => skill.id === SPEC_EXPERT_SKILL_ID);
    const preferSpecExpert = !executionMetadata?.skillID && hasSpecExpertSkill && shouldPreferSpecExpertFirst(taskDescription);

    const implementationRouting = preferSpecExpert
      ? await resolveTaskRoute({
          taskDescription,
          directory: worktree,
          worktree,
          mode: "llm",
          excludeSkillIDs: [SPEC_EXPERT_SKILL_ID],
        })
      : null;

    let routing: RouteResult;
    if (executionMetadata?.skillID) {
      routing = {
        skill_id: executionMetadata.skillID,
        mode: "heuristic",
        reason: `Tasklist EXECUTION metadata selected skill ${executionMetadata.skillID}.`,
      };
    } else {
      routing = await resolveTaskRoute({
        taskDescription,
        directory: worktree,
        worktree,
        mode: preferSpecExpert ? "heuristic" : "llm",
      });

      if (preferSpecExpert) {
        routing = applySpecExpertFirstPolicy(routing);
      }
    }

    const metadataSource: "tasklist" | "legacy" = executionMetadata ? "tasklist" : "legacy";
    const preservedExecutionTarget = {
      agentID: agentResolution.agentID,
      role: requestedRole,
      tier: agentResolution.tier,
      taskRef,
      parallelGroup: executionMetadata?.parallelGroup,
      dependsOn: executionMetadata?.dependsOn,
      metadataSource,
    };

    pipeline.routing = {
      skillID: routing.skill_id,
      reason: `${routing.reason} Agent resolver: ${agentResolution.reason}`,
      mode: routing.mode,
      agentID: preservedExecutionTarget.agentID,
      role: preservedExecutionTarget.role,
      tier: preservedExecutionTarget.tier,
      taskRef: preservedExecutionTarget.taskRef,
      parallelGroup: preservedExecutionTarget.parallelGroup,
      dependsOn: preservedExecutionTarget.dependsOn,
      metadataSource: preservedExecutionTarget.metadataSource,
    };

    const dispatchTaskRef = taskRef ?? `TASK-${sanitizeTitleSegment(rootSessionID)}`;
    const dispatchParallelGroup = normalizeParallelGroup(executionMetadata?.parallelGroup);
    const dispatchItem = buildDispatchQueueItem({
      stage: "implementation",
      taskRef: dispatchTaskRef,
      role: requestedRole,
      tier: agentResolution.tier,
      skillID: routing.skill_id,
      parallelGroup: dispatchParallelGroup,
      dependsOn: executionMetadata?.dependsOn ?? [],
      taskIndex: executionMetadata?.taskIndex ?? Number.MAX_SAFE_INTEGER,
      requestedBySessionID: triageSession.sessionID,
      parentSessionID: triageSession.parentSessionID ?? rootSessionID,
    });
    const queued = enqueueDispatchTask(pipeline, dispatchItem);

    if (queued.inserted) {
      await writeExecutionGraphEvent(pipeline, {
        eventType: "task_queued",
        sessionID: triageSession.sessionID,
        parentSessionID: triageSession.parentSessionID ?? rootSessionID,
        stage: "implementation",
        taskRef: dispatchItem.taskRef,
        agentID: agentResolution.agentID,
        tier: dispatchItem.tier,
        skillID: dispatchItem.skillID,
        parallelGroup: dispatchItem.parallelGroup,
        slot: dispatchItem.slot,
        status: "queued",
        reason: "queued_for_dispatch",
      });
    }

    const queueHead = peekDispatchQueue(pipeline);
    if (!queueHead || queueHead.taskRef !== dispatchItem.taskRef) {
      pipeline.transition = "idle";
      pipeline.pendingTransition = undefined;
      pipeline.updatedAt = Date.now();
      await persistState();
      await promptSession(
        rootSessionID,
        `Task ${dispatchItem.taskRef} is queued behind an earlier dispatch item and will run in FIFO order.`,
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
      return "queued";
    }

    const dependencyStatus = await resolveTaskDependencyStatus({
      dependsOn: dispatchItem.dependsOn,
      pipeline,
      tasklistPath: traversalContext.tasklistPath,
    });
    if (dependencyStatus.missing.length > 0) {
      const dependencyReason = `depends_on unresolved: ${dependencyStatus.missing.join(", ")}`;
      pipeline.transition = "blocked";
      pipeline.pendingTransition = undefined;
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "task_blocked",
        rootSessionID,
        sessionID: triageSession.sessionID,
        stage: "triage",
        details: {
          reason: dependencyReason,
          taskRef: dispatchItem.taskRef,
        },
      });

      await writeExecutionGraphEvent(pipeline, {
        eventType: "task_blocked",
        sessionID: triageSession.sessionID,
        parentSessionID: triageSession.parentSessionID ?? rootSessionID,
        stage: "implementation",
        taskRef: dispatchItem.taskRef,
        agentID: agentResolution.agentID,
        tier: dispatchItem.tier,
        skillID: dispatchItem.skillID,
        parallelGroup: dispatchItem.parallelGroup,
        slot: dispatchItem.slot,
        status: "blocked",
        reason: dependencyReason,
      });

      await promptSession(
        rootSessionID,
        `Dispatch blocked for ${dispatchItem.taskRef}: ${dependencyReason}`,
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
      return "blocked";
    }

    const usage = computeParallelDispatchUsage(state.pipelines);
    const capacity = evaluateParallelCapacity(dispatchItem, usage, settings.parallelism);
    if (!capacity.ok) {
      pipeline.transition = "idle";
      pipeline.pendingTransition = undefined;
      pipeline.updatedAt = Date.now();
      await persistState();
      await promptSession(
        rootSessionID,
        `Task ${dispatchItem.taskRef} remains queued: ${capacity.reason}`,
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
      return "queued";
    }

    dequeueDispatchTask(pipeline, dispatchItem.taskRef);

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_requested",
      sessionID: triageSession.sessionID,
      parentSessionID: triageSession.parentSessionID ?? rootSessionID,
      stage: "implementation",
      taskRef: dispatchItem.taskRef,
      agentID: agentResolution.agentID,
      tier: dispatchItem.tier,
      skillID: dispatchItem.skillID,
      parallelGroup: dispatchItem.parallelGroup,
      slot: dispatchItem.slot,
      status: "requested",
    });

    markDispatchInFlight(pipeline, dispatchItem, triageSession.sessionID);

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_started",
      sessionID: triageSession.sessionID,
      parentSessionID: triageSession.parentSessionID ?? rootSessionID,
      stage: "implementation",
      taskRef: dispatchItem.taskRef,
      agentID: agentResolution.agentID,
      tier: dispatchItem.tier,
      skillID: dispatchItem.skillID,
      parallelGroup: dispatchItem.parallelGroup,
      slot: dispatchItem.slot,
      status: "in_progress",
    });

    const taskID = taskRef
      ? sanitizeTitleSegment(taskRef)
      : buildTaskID(rootSessionID, routing.skill_id, taskDescription);
    const worktreeContext = await provisionImplementationWorktree({
      taskID,
      skillID: routing.skill_id,
      parentSessionID: triageSession.sessionID,
    });
    pipeline.worktree = worktreeContext;

    const specHandoff = preferSpecExpert && implementationRouting
      ? {
          required: true,
          completed: false,
          markerPath: resolve(worktreeContext.worktreePath, "_bmad-output", `spec-handoff-${taskID}.md`),
          targetSkillID: implementationRouting.skill_id,
          targetRoutingMode: implementationRouting.mode,
          targetReason: implementationRouting.reason,
          targetExecution: preservedExecutionTarget,
        }
      : undefined;
    pipeline.specHandoff = specHandoff;

    const childSession = await createChildSession({
      parentSessionID: triageSession.sessionID,
      stage: "implementation",
      directory: worktreeContext.worktreePath,
      titleSuffix: `${taskID}:${routing.skill_id}`,
    });

    if (!childSession?.id) {
      throw new Error("Failed to create implementation session.");
    }

    if (pipeline.specHandoff) {
      pipeline.specHandoff.markerSessionID = childSession.id;
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

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_completed",
      sessionID: childSession.id,
      parentSessionID: triageSession.sessionID,
      stage: "implementation",
      taskRef: dispatchItem.taskRef,
      agentID: agentResolution.agentID,
      tier: dispatchItem.tier,
      skillID: dispatchItem.skillID,
      parallelGroup: dispatchItem.parallelGroup,
      slot: dispatchItem.slot,
      status: "completed",
    });

    await promptSession(
      childSession.id,
      pipeline.specHandoff
        ? buildSpecHandoffPrompt(taskDescription, pipeline, childSession.id, pipeline.specHandoff)
        : buildImplementationPrompt(taskDescription, pipeline, childSession.id),
      false,
      worktreeContext.worktreePath,
      agentResolution.agentID,
    );

    await promptSession(
      rootSessionID,
      [
        `Implementation session ${childSession.id} created in ${worktreeContext.worktreePath}.`,
        `Routing selected skill ${routing.skill_id} via ${routing.mode} mode.`,
        `Execution agent: ${agentResolution.agentID} (role=${requestedRole}, tier=${agentResolution.tier}, source=${executionMetadata ? "tasklist" : "legacy"}).`,
        pipeline.specHandoff
          ? `Spec handoff required before coding session starts. Marker: ${pipeline.specHandoff.markerPath}`
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      true,
      pipeline.sessions[rootSessionID]?.directory,
    );

    return "spawned";
  }

  async function executeImplementationToReview(
    rootSessionID: string,
    pipeline: PipelineState,
    pending: PendingTransition,
  ): Promise<StageTransitionOutcome> {
    const implementationSession = pipeline.sessions[pending.requestedBySessionID];
    if (!implementationSession) {
      throw new Error("Implementation session metadata missing.");
    }

    const reviewDirectory = pipeline.worktree?.worktreePath ?? implementationSession.directory ?? worktree;
    const titleSuffix = pipeline.worktree?.taskID ?? implementationSession.sessionID;

    const reviewAgentResolution = resolveAgentFromPools({
      role: "review",
      requestedTier: settings.taskRouting.defaultTier,
      defaultTier: settings.taskRouting.defaultTier,
      agentPools: settings.agentPools,
      configuredAgentIDs: configuredAgentCatalog.ids,
      configuredAgentSourceError: configuredAgentCatalog.loadError,
      configuredAgentSourcePath: configuredAgentCatalog.sourcePath,
    });

    if (!reviewAgentResolution.ok || !reviewAgentResolution.agentID || !reviewAgentResolution.tier) {
      const blockedReason = reviewAgentResolution.reason;
      pipeline.transition = "blocked";
      pipeline.pendingTransition = undefined;
      pipeline.updatedAt = Date.now();
      await persistState();

      await recordEvent(pipeline, {
        type: "task_blocked",
        rootSessionID,
        sessionID: implementationSession.sessionID,
        stage: "implementation",
        details: {
          reason: blockedReason,
          role: "review",
          tier: settings.taskRouting.defaultTier,
          taskRef: pipeline.routing?.taskRef ?? "unknown",
        },
      });

      await writeExecutionGraphEvent(pipeline, {
        eventType: "task_blocked",
        sessionID: implementationSession.sessionID,
        parentSessionID: implementationSession.parentSessionID ?? rootSessionID,
        stage: "implementation",
        taskRef: pipeline.routing?.taskRef ?? "n/a",
        agentID: "unresolved",
        tier: settings.taskRouting.defaultTier,
        skillID: pipeline.routing?.skillID ?? "n/a",
        parallelGroup: pipeline.routing?.parallelGroup ?? "",
        slot: "review:0",
        status: "blocked",
        reason: blockedReason,
      });

      await promptSession(
        rootSessionID,
        [
          "Pipeline is blocked before review spawn.",
          blockedReason,
          "Update orchestration.agent_pools or add the required agent IDs in .opencode/opencode.jsonc.",
        ].join("\n"),
        true,
        pipeline.sessions[rootSessionID]?.directory,
      );
      return "blocked";
    }

    const reviewAgentID = reviewAgentResolution.agentID;
    const completionTaskRef = pipeline.routing?.taskRef ?? "n/a";
    const completionParallelGroup = normalizeParallelGroup(pipeline.routing?.parallelGroup);
    const completionSlot = buildDispatchSlot("review", completionParallelGroup, Number.MAX_SAFE_INTEGER);

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_requested",
      sessionID: implementationSession.sessionID,
      parentSessionID: implementationSession.parentSessionID ?? rootSessionID,
      stage: "review",
      taskRef: completionTaskRef,
      agentID: reviewAgentID,
      tier: reviewAgentResolution.tier,
      skillID: pipeline.routing?.skillID ?? "n/a",
      parallelGroup: completionParallelGroup,
      slot: completionSlot,
      status: "requested",
    });

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_started",
      sessionID: implementationSession.sessionID,
      parentSessionID: implementationSession.parentSessionID ?? rootSessionID,
      stage: "review",
      taskRef: completionTaskRef,
      agentID: reviewAgentID,
      tier: reviewAgentResolution.tier,
      skillID: pipeline.routing?.skillID ?? "n/a",
      parallelGroup: completionParallelGroup,
      slot: completionSlot,
      status: "in_progress",
    });

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

    await writeExecutionGraphEvent(pipeline, {
      eventType: "spawn_completed",
      sessionID: childSession.id,
      parentSessionID: implementationSession.sessionID,
      stage: "review",
      taskRef: completionTaskRef,
      agentID: reviewAgentID,
      tier: reviewAgentResolution.tier,
      skillID: pipeline.routing?.skillID ?? "n/a",
      parallelGroup: completionParallelGroup,
      slot: completionSlot,
      status: "completed",
    });

    markDispatchTaskCompleted(pipeline, completionTaskRef);

    await writeExecutionGraphEvent(pipeline, {
      eventType: "task_completed",
      sessionID: implementationSession.sessionID,
      parentSessionID: implementationSession.parentSessionID ?? rootSessionID,
      stage: "implementation",
      taskRef: completionTaskRef,
      agentID: pipeline.routing?.agentID ?? "n/a",
      tier: pipeline.routing?.tier ?? settings.taskRouting.defaultTier,
      skillID: pipeline.routing?.skillID ?? "n/a",
      parallelGroup: completionParallelGroup,
      slot: buildDispatchSlot("implementation", completionParallelGroup, Number.MAX_SAFE_INTEGER),
      status: "completed",
    });

    await promptSession(
      childSession.id,
      buildReviewPrompt(pipeline),
      false,
      reviewDirectory,
      reviewAgentID,
    );

    await promptSession(
      rootSessionID,
      `Review session ${childSession.id} created. Awaiting deterministic review handoff.`,
      true,
      pipeline.sessions[rootSessionID]?.directory,
    );

    return "spawned";
  }

  async function registerSession(session: Session): Promise<void> {
    const rootSessionID = resolveRootSessionID(session.id, session.parentID);
    const pipeline = ensurePipeline(rootSessionID);

    if (session.id === rootSessionID && !pipeline.taskTraversal?.taskDescription) {
      const diagnosticTaskDescription = extractTaskDescription(session.title ?? session.id);
      pipeline.taskTraversal = {
        ...pipeline.taskTraversal,
        taskDescription: diagnosticTaskDescription,
      };
    }

    let stage: PipelineStage = "triage";
    if (session.parentID && pipeline.sessions[session.parentID]) {
      stage = deriveChildStage(pipeline, pipeline.sessions[session.parentID]);
    } else if (session.id !== rootSessionID && pipeline.currentStage) {
      stage = pipeline.currentStage;
    }

    registerKnownSession(session, rootSessionID, stage, session.parentID, session.directory);
    await persistState();

    if (session.id === rootSessionID) {
      await writeExecutionGraphEvent(pipeline, {
        eventType: "pipeline_started",
        sessionID: session.id,
        parentSessionID: session.parentID ?? "n/a",
        stage: "triage",
        taskRef: pipeline.taskTraversal?.taskRef ?? "n/a",
        agentID: "orchestrator",
        tier: pipeline.routing?.tier ?? settings.taskRouting.defaultTier,
        skillID: pipeline.routing?.skillID ?? "n/a",
        parallelGroup: pipeline.routing?.parallelGroup ?? "default",
        slot: "triage:root",
        status: "started",
      });
    }
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
      normalizePipelineRuntimeState(existing);
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
      executionSeq: 0,
      executionDedupes: {},
      dispatchQueue: [],
      dispatchInFlight: [],
      completedTaskRefs: [],
      createdAt: now,
      updatedAt: now,
    };

    state.sessionToRoot[rootSessionID] = rootSessionID;
    state.pipelines[rootSessionID] = pipeline;
    normalizePipelineRuntimeState(pipeline);
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
    return getPipelineDisabledReason(pipeline) !== null;
  }

  function getPipelineDisabledReason(pipeline: PipelineState): string | null {
    if (settings.mode === "off") {
      return "orchestration is configured OFF in demonlord.config.json";
    }

    if (state.runtime.off) {
      return "global orchestration mode is OFF (run `/pipeline on` to resume)";
    }

    if (pipeline.stopped) {
      return `pipeline ${pipeline.rootSessionID} is stopped (${pipeline.stopReason ?? "unknown"})`;
    }

    return null;
  }

  async function renderStatusSnapshot(pipeline: PipelineState): Promise<string> {
    const pending = pipeline.pendingTransition
      ? `${pipeline.pendingTransition.from} -> ${pipeline.pendingTransition.to}`
      : "none";
    const executionGraph = await readExecutionGraphEntries(executionGraphPath, pipeline.rootSessionID);
    const executionOrderLines = renderExecutionOrderSummary(executionGraph);
    const overlapLines = renderOverlapWindowSummary(executionGraph);
    const statusLines = [
      `Pipeline: ${pipeline.rootSessionID}`,
      `Mode: ${getEffectiveMode()}`,
      `Stage: ${pipeline.currentStage}`,
      `Transition: ${pipeline.transition}`,
      `Stopped: ${pipeline.stopped ? `yes (${pipeline.stopReason ?? "unknown"})` : "no"}`,
      `Pending: ${pending}`,
      `Worktree: ${pipeline.worktree?.worktreePath ?? "n/a"}`,
      `Routing: ${pipeline.routing ? `${pipeline.routing.skillID} (${pipeline.routing.mode})` : "n/a"}`,
      `Tasklist Context: ${pipeline.taskTraversal?.tasklistPath ?? "n/a"}`,
      `Execution Target: ${
        pipeline.routing?.agentID
          ? `${pipeline.routing.agentID} [${pipeline.routing.role ?? "n/a"}/${pipeline.routing.tier ?? "n/a"}]`
          : "n/a"
      }`,
      `Task Ref: ${pipeline.routing?.taskRef ?? "n/a"}`,
      `Spec Handoff: ${
        pipeline.specHandoff
          ? `${pipeline.specHandoff.completed ? "completed" : "required"} -> ${pipeline.specHandoff.targetSkillID}`
          : "n/a"
      }`,
      `Dispatch Queue: ${pipeline.dispatchQueue?.length ?? 0}`,
      `In Flight: ${pipeline.dispatchInFlight?.length ?? 0}`,
      "Session Tree:",
      ...renderSessionTree(pipeline, pipeline.rootSessionID, 0),
      "Execution Order:",
      ...executionOrderLines,
      "Overlap Windows:",
      ...overlapLines,
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
    const taskRef = session.stage === "triage" ? pipeline.taskTraversal?.taskRef ?? "n/a" : pipeline.routing?.taskRef ?? "n/a";
    const agentID = session.stage === "triage" ? "planner" : pipeline.routing?.agentID ?? "n/a";
    const line = `${indent}- ${session.sessionID} [${session.stage}] {${session.status}} task=${taskRef} agent=${agentID}${currentMarker}`;
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
    state.updatedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(normalized)}\n`;

    await scheduleWrite(async () => {
      await mkdir(dirname(eventLogPath), { recursive: true });
      await appendFile(eventLogPath, serialized, "utf-8");
      await writePersistedSnapshot();
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

  async function writeExecutionGraphEvent(pipeline: PipelineState, input: ExecutionGraphEventInput): Promise<void> {
    const normalized = normalizeExecutionGraphEventInput(input);

    await scheduleWrite(async () => {
      normalizePipelineRuntimeState(pipeline);
      const dedupeKey = buildExecutionGraphDedupeKey(pipeline.rootSessionID, normalized);
      if (pipeline.executionDedupes?.[dedupeKey]) {
        return;
      }

      const nextSeq = typeof pipeline.executionSeq === "number" && pipeline.executionSeq > 0
        ? pipeline.executionSeq + 1
        : 1;
      const payload: ExecutionGraphEventEntry = {
        seq: nextSeq,
        ts: new Date().toISOString(),
        rootSessionID: pipeline.rootSessionID,
        eventType: normalized.eventType,
        sessionID: normalized.sessionID,
        parentSessionID: normalized.parentSessionID,
        stage: normalized.stage,
        taskRef: normalized.taskRef,
        agentID: normalized.agentID,
        tier: normalized.tier,
        skillID: normalized.skillID,
        parallelGroup: normalized.parallelGroup,
        slot: normalized.slot,
        status: normalized.status,
        reason: normalized.reason,
      };

      await mkdir(dirname(executionGraphPath), { recursive: true });
      await appendFile(executionGraphPath, `${JSON.stringify(payload)}\n`, "utf-8");

      pipeline.executionSeq = nextSeq;
      pipeline.executionDedupes = {
        ...(pipeline.executionDedupes ?? {}),
        [dedupeKey]: nextSeq,
      };
      pruneExecutionGraphDedupes(pipeline.executionDedupes, nextSeq);

      pipeline.updatedAt = Date.now();
      await writePersistedSnapshot();
    });
  }

  async function persistState(): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await scheduleWrite(async () => {
      await writePersistedSnapshot();
    });
  }

  async function writePersistedSnapshot(): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    const snapshot = buildPersistedSnapshot();
    await writeJsonAtomically(statePath, snapshot);
  }

  function buildPersistedSnapshot(): PersistedOrchestrationState {
    const pipelineSummaries: Record<string, PipelineSummary> = {};
    for (const [rootSessionID, pipeline] of Object.entries(state.pipelines)) {
      pipelineSummaries[rootSessionID] = {
        rootSessionID,
        currentStage: pipeline.currentStage,
        transition: pipeline.transition,
        stopped: pipeline.stopped,
        stopReason: pipeline.stopReason,
        updatedAt: pipeline.updatedAt,
        pendingTransition: pipeline.pendingTransition,
        nextSessionID: pipeline.nextSessionID,
        routing: pipeline.routing,
        taskTraversal: pipeline.taskTraversal,
        worktree: pipeline.worktree,
        specHandoff: pipeline.specHandoff,
      };
    }

    return {
      version: 2,
      updatedAt: state.updatedAt,
      runtime: {
        off: state.runtime.off,
        enabled: settings.enabled,
        configuredMode: settings.mode,
        effectiveMode: getEffectiveMode(),
      },
      sessionToRoot: state.sessionToRoot,
      pipelines: state.pipelines,
      pipelineSummaries,
      commandQueue: {
        path: commandQueuePath,
        lastProcessedLine: state.commandQueue.lastProcessedLine,
        lastProcessedAt: state.commandQueue.lastProcessedAt,
        processedDedupes: state.commandQueue.processedDedupes,
      },
    };
  }

  async function readCommandQueueLines(filePath: string): Promise<string[]> {
    try {
      const raw = await readFile(filePath, "utf-8");
      return splitCommandQueueLines(raw);
    } catch {
      return [];
    }
  }

  function getEffectiveMode(): OrchestrationMode {
    if (!settings.enabled) {
      return "off";
    }

    if (state.runtime.off || settings.mode === "off") {
      return "off";
    }

    return settings.mode;
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
        task_routing?: unknown;
        agent_pools?: unknown;
        parallelism?: unknown;
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
      taskRouting: parseTaskRoutingSettings(config.task_routing),
      agentPools: parseAgentPools(config.agent_pools),
      parallelism: parseParallelismSettings(config.parallelism),
    };
  } catch {
    return cloneOrchestrationSettings(defaultOrchestrationSettings);
  }
}

async function loadPersistedState(
  filePath: string,
  commandQueuePath: string,
  settings: OrchestrationSettings,
): Promise<PersistedOrchestrationState> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedOrchestrationState> & {
      version?: number;
      runtime?: { off?: unknown };
      sessionToRoot?: unknown;
      pipelines?: unknown;
      commandQueue?: Partial<CommandQueueState>;
    };

    if (parsed.version === 2) {
      const runtimeOff = parsed.runtime?.off === true;
      return {
        version: 2,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        runtime: {
          off: runtimeOff,
          enabled: settings.enabled,
          configuredMode: settings.mode,
          effectiveMode: runtimeOff || settings.mode === "off" ? "off" : settings.mode,
        },
        sessionToRoot: isRecord(parsed.sessionToRoot) ? (parsed.sessionToRoot as Record<string, string>) : {},
        pipelines: isRecord(parsed.pipelines) ? (parsed.pipelines as Record<string, PipelineState>) : {},
        pipelineSummaries: {},
        commandQueue: {
          path: commandQueuePath,
          lastProcessedLine:
            typeof parsed.commandQueue?.lastProcessedLine === "number" && parsed.commandQueue.lastProcessedLine >= 0
              ? parsed.commandQueue.lastProcessedLine
              : 0,
          lastProcessedAt:
            typeof parsed.commandQueue?.lastProcessedAt === "string"
              ? parsed.commandQueue.lastProcessedAt
              : undefined,
          processedDedupes: isRecord(parsed.commandQueue?.processedDedupes)
            ? (parsed.commandQueue?.processedDedupes as Record<string, number>)
            : {},
        },
      };
    }

    if (parsed.version === 1) {
      return {
        version: 2,
        updatedAt: new Date().toISOString(),
        runtime: {
          off: parsed.runtime?.off === true,
          enabled: settings.enabled,
          configuredMode: settings.mode,
          effectiveMode: parsed.runtime?.off === true || settings.mode === "off" ? "off" : settings.mode,
        },
        sessionToRoot: isRecord(parsed.sessionToRoot) ? (parsed.sessionToRoot as Record<string, string>) : {},
        pipelines: isRecord(parsed.pipelines) ? (parsed.pipelines as Record<string, PipelineState>) : {},
        pipelineSummaries: {},
        commandQueue: {
          path: commandQueuePath,
          lastProcessedLine: 0,
          processedDedupes: {},
        },
      };
    }

    return createEmptyPersistedState(commandQueuePath, settings);
  } catch {
    return createEmptyPersistedState(commandQueuePath, settings);
  }
}

function createEmptyPersistedState(
  commandQueuePath: string,
  settings: OrchestrationSettings,
): PersistedOrchestrationState {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    runtime: {
      off: false,
      enabled: settings.enabled,
      configuredMode: settings.mode,
      effectiveMode: settings.mode === "off" ? "off" : settings.mode,
    },
    sessionToRoot: {},
    pipelines: {},
    pipelineSummaries: {},
    commandQueue: {
      path: commandQueuePath,
      lastProcessedLine: 0,
      processedDedupes: {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneOrchestrationSettings(input: OrchestrationSettings): OrchestrationSettings {
  return {
    ...input,
    taskRouting: {
      ...input.taskRouting,
    },
    agentPools: cloneAgentPools(input.agentPools),
    parallelism: {
      maxParallelTotal: input.parallelism.maxParallelTotal,
      maxParallelByRole: {
        planning: input.parallelism.maxParallelByRole.planning,
        implementation: input.parallelism.maxParallelByRole.implementation,
        review: input.parallelism.maxParallelByRole.review,
      },
      maxParallelByTier: {
        lite: input.parallelism.maxParallelByTier.lite,
        standard: input.parallelism.maxParallelByTier.standard,
        pro: input.parallelism.maxParallelByTier.pro,
      },
    },
  };
}

function cloneAgentPools(pools: AgentPools): AgentPools {
  return {
    planning: {
      lite: [...pools.planning.lite],
      standard: [...pools.planning.standard],
      pro: [...pools.planning.pro],
    },
    implementation: {
      lite: [...pools.implementation.lite],
      standard: [...pools.implementation.standard],
      pro: [...pools.implementation.pro],
    },
    review: {
      lite: [...pools.review.lite],
      standard: [...pools.review.standard],
      pro: [...pools.review.pro],
    },
  };
}

function parseTaskRoutingSettings(input: unknown): TaskRoutingSettings {
  if (!isRecord(input)) {
    return {
      ...defaultOrchestrationSettings.taskRouting,
    };
  }

  const source = input.source === "tasklist_explicit" ? "tasklist_explicit" : "tasklist_explicit";
  const defaultTier = normalizeExecutionTier(input.default_tier) ?? defaultOrchestrationSettings.taskRouting.defaultTier;

  return {
    source,
    defaultTier,
  };
}

function parseAgentPools(input: unknown): AgentPools {
  const pools = cloneAgentPools(defaultOrchestrationSettings.agentPools);
  if (!isRecord(input)) {
    return pools;
  }

  for (const role of ["planning", "implementation", "review"] as const) {
    const roleConfig = input[role];
    if (!isRecord(roleConfig)) {
      continue;
    }

    for (const tier of ["lite", "standard", "pro"] as const) {
      const parsedCandidates = toStringArray(roleConfig[tier]);
      if (parsedCandidates.length > 0) {
        pools[role][tier] = parsedCandidates;
      }
    }
  }

  return pools;
}

function parseParallelismSettings(input: unknown): ParallelismSettings {
  if (!isRecord(input)) {
    return {
      maxParallelTotal: defaultOrchestrationSettings.parallelism.maxParallelTotal,
      maxParallelByRole: {
        planning: defaultOrchestrationSettings.parallelism.maxParallelByRole.planning,
        implementation: defaultOrchestrationSettings.parallelism.maxParallelByRole.implementation,
        review: defaultOrchestrationSettings.parallelism.maxParallelByRole.review,
      },
      maxParallelByTier: {
        lite: defaultOrchestrationSettings.parallelism.maxParallelByTier.lite,
        standard: defaultOrchestrationSettings.parallelism.maxParallelByTier.standard,
        pro: defaultOrchestrationSettings.parallelism.maxParallelByTier.pro,
      },
    };
  }

  const byRole = isRecord(input.max_parallel_by_role) ? input.max_parallel_by_role : {};
  const byTier = isRecord(input.max_parallel_by_tier) ? input.max_parallel_by_tier : {};

  return {
    maxParallelTotal: parsePositiveLimit(
      input.max_parallel_total,
      defaultOrchestrationSettings.parallelism.maxParallelTotal,
    ),
    maxParallelByRole: {
      planning: parsePositiveLimit(
        byRole.planning,
        defaultOrchestrationSettings.parallelism.maxParallelByRole.planning,
      ),
      implementation: parsePositiveLimit(
        byRole.implementation,
        defaultOrchestrationSettings.parallelism.maxParallelByRole.implementation,
      ),
      review: parsePositiveLimit(byRole.review, defaultOrchestrationSettings.parallelism.maxParallelByRole.review),
    },
    maxParallelByTier: {
      lite: parsePositiveLimit(byTier.lite, defaultOrchestrationSettings.parallelism.maxParallelByTier.lite),
      standard: parsePositiveLimit(
        byTier.standard,
        defaultOrchestrationSettings.parallelism.maxParallelByTier.standard,
      ),
      pro: parsePositiveLimit(byTier.pro, defaultOrchestrationSettings.parallelism.maxParallelByTier.pro),
    },
  };
}

function parsePositiveLimit(candidate: unknown, fallback: number): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return fallback;
  }

  const normalized = Math.trunc(candidate);
  if (normalized < 1) {
    return fallback;
  }

  return normalized;
}

function normalizeExecutionRole(value: unknown): ExecutionRole | null {
  if (value === "planning" || value === "implementation" || value === "review") {
    return value;
  }

  return null;
}

function normalizeExecutionTier(value: unknown): ExecutionTier | null {
  if (value === "lite" || value === "standard" || value === "pro") {
    return value;
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function resolveAgentFromPools(input: {
  role: ExecutionRole;
  requestedTier: ExecutionTier;
  defaultTier: ExecutionTier;
  agentPools: AgentPools;
  configuredAgentIDs: Set<string>;
  configuredAgentSourceError?: string;
  configuredAgentSourcePath?: string;
}): AgentResolution {
  const {
    role,
    requestedTier,
    defaultTier,
    agentPools,
    configuredAgentIDs,
    configuredAgentSourceError,
    configuredAgentSourcePath,
  } = input;

  if (configuredAgentSourceError) {
    return {
      ok: false,
      reason: [
        `Blocked: unable to load configured agents from ${configuredAgentSourcePath ?? ".opencode/opencode.jsonc"}.`,
        configuredAgentSourceError,
      ].join(" "),
    };
  }

  const rolePools = agentPools[role];

  const requestedAgent = firstConfiguredAgent(rolePools[requestedTier], configuredAgentIDs);
  if (requestedAgent) {
    return {
      ok: true,
      agentID: requestedAgent,
      tier: requestedTier,
      fallbackUsed: "requested_tier",
      reason: `Resolved ${role}/${requestedTier} to '${requestedAgent}' from orchestration.agent_pools.`,
    };
  }

  if (defaultTier !== requestedTier) {
    const defaultAgent = firstConfiguredAgent(rolePools[defaultTier], configuredAgentIDs);
    if (defaultAgent) {
      return {
        ok: true,
        agentID: defaultAgent,
        tier: defaultTier,
        fallbackUsed: "default_tier",
        reason: [
          `Requested tier '${requestedTier}' for role '${role}' had no configured agent.`,
          `Fell back to default tier '${defaultTier}' and selected '${defaultAgent}'.`,
        ].join(" "),
      };
    }
  }

  const legacyAgentID = LEGACY_ROLE_AGENT[role];
  if (hasConfiguredAgent(legacyAgentID, configuredAgentIDs)) {
    return {
      ok: true,
      agentID: legacyAgentID,
      tier: defaultTier,
      fallbackUsed: "legacy_singleton",
      reason: [
        `No configured agent found in orchestration.agent_pools for role='${role}' tier='${requestedTier}'.`,
        `Using legacy singleton '${legacyAgentID}' for backward compatibility.`,
      ].join(" "),
    };
  }

  return {
    ok: false,
    reason: [
      `Blocked: no configured agent for role='${role}' tier='${requestedTier}'.`,
      `Checked requested tier, default tier '${defaultTier}', and legacy '${legacyAgentID}'.`,
    ].join(" "),
  };
}

function firstConfiguredAgent(candidates: string[], configuredAgentIDs: Set<string>): string | null {
  for (const candidate of candidates) {
    if (hasConfiguredAgent(candidate, configuredAgentIDs)) {
      return candidate;
    }
  }

  return null;
}

function hasConfiguredAgent(agentID: string, configuredAgentIDs: Set<string>): boolean {
  return configuredAgentIDs.has(agentID);
}

async function loadConfiguredAgentIDs(worktree: string): Promise<ConfiguredAgentCatalog> {
  const configPath = resolve(worktree, ".opencode", "opencode.jsonc");

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parseJsonc(raw);
    if (!isRecord(parsed) || !isRecord(parsed.agent)) {
      return {
        ids: new Set<string>(),
        sourcePath: configPath,
        loadError: "Missing or invalid top-level 'agent' object.",
      };
    }

    return {
      ids: new Set(Object.keys(parsed.agent)),
      sourcePath: configPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error while parsing JSONC.";
    return {
      ids: new Set<string>(),
      sourcePath: configPath,
      loadError: message,
    };
  }
}

function parseJsonc(raw: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsoncDocument(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((entry) => `offset ${entry.offset}: ${printParseErrorCode(entry.error)}`)
      .join("; ");
    throw new Error(details || "Unknown JSONC parse error.");
  }

  return parsed;
}

function parseQueuedCommand(rawLine: string): PipelineControlQueueCommand | null {
  try {
    const parsed = JSON.parse(rawLine) as Partial<PipelineControlQueueCommand>;
    const action = parsed.action;
    if (
      parsed.version !== 1 ||
      parsed.source !== "pipelinectl" ||
      (action !== "off" && action !== "on" && action !== "advance" && action !== "approve" && action !== "stop") ||
      typeof parsed.id !== "string" ||
      typeof parsed.sessionID !== "string" ||
      typeof parsed.dedupeKey !== "string" ||
      typeof parsed.requestedAt !== "string"
    ) {
      return null;
    }

    const stage = normalizeStage(parsed.stage);
    const expectation = isRecord(parsed.expectation)
      ? {
          rootSessionID:
            typeof parsed.expectation.rootSessionID === "string" ? parsed.expectation.rootSessionID : undefined,
          stage: normalizeStage(parsed.expectation.stage) ?? undefined,
          transition: isTransitionState(parsed.expectation.transition)
            ? parsed.expectation.transition
            : undefined,
          pipelineUpdatedAt:
            typeof parsed.expectation.pipelineUpdatedAt === "number" ? parsed.expectation.pipelineUpdatedAt : undefined,
          pendingRequired:
            typeof parsed.expectation.pendingRequired === "boolean" ? parsed.expectation.pendingRequired : undefined,
        }
      : undefined;

    return {
      version: 1,
      id: parsed.id,
      source: "pipelinectl",
      action,
      sessionID: parsed.sessionID,
      targetSessionID: typeof parsed.targetSessionID === "string" ? parsed.targetSessionID : undefined,
      stage: stage ?? undefined,
      dedupeKey: parsed.dedupeKey,
      requestedAt: parsed.requestedAt,
      expectation,
    };
  } catch {
    return null;
  }
}

function splitCommandQueueLines(raw: string): string[] {
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines;
}

function normalizePipelineRuntimeState(pipeline: PipelineState): void {
  pipeline.executionSeq = typeof pipeline.executionSeq === "number" && pipeline.executionSeq > 0
    ? Math.trunc(pipeline.executionSeq)
    : 0;
  pipeline.executionDedupes = isRecord(pipeline.executionDedupes)
    ? (pipeline.executionDedupes as Record<string, number>)
    : {};
  pipeline.dispatchQueue = Array.isArray(pipeline.dispatchQueue) ? pipeline.dispatchQueue : [];
  pipeline.dispatchInFlight = Array.isArray(pipeline.dispatchInFlight) ? pipeline.dispatchInFlight : [];
  pipeline.completedTaskRefs = Array.isArray(pipeline.completedTaskRefs)
    ? pipeline.completedTaskRefs.map((taskRef) => taskRef.toUpperCase())
    : [];
}

function normalizeParallelGroup(value: string | undefined): string {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : "default";
}

function buildDispatchSlot(stage: PipelineStage, parallelGroup: string, taskIndex: number): string {
  const normalizedIndex = Number.isFinite(taskIndex) && taskIndex >= 0 ? Math.trunc(taskIndex) : "fifo";
  return `${stage}:${parallelGroup}:${normalizedIndex}`;
}

function buildDispatchQueueItem(input: {
  stage: PipelineStage;
  taskRef: string;
  role: ExecutionRole;
  tier: ExecutionTier;
  skillID: string;
  parallelGroup: string;
  dependsOn: string[];
  taskIndex: number;
  requestedBySessionID: string;
  parentSessionID: string;
}): DispatchQueueItem {
  const taskRef = input.taskRef.toUpperCase();
  const parallelGroup = normalizeParallelGroup(input.parallelGroup);
  return {
    stage: input.stage,
    taskRef,
    role: input.role,
    tier: input.tier,
    skillID: input.skillID,
    parallelGroup,
    dependsOn: input.dependsOn.map((dependency) => dependency.toUpperCase()),
    taskIndex: Number.isFinite(input.taskIndex) ? Math.max(0, Math.trunc(input.taskIndex)) : Number.MAX_SAFE_INTEGER,
    queuedAt: Date.now(),
    requestedBySessionID: input.requestedBySessionID,
    parentSessionID: input.parentSessionID,
    slot: buildDispatchSlot(input.stage, parallelGroup, input.taskIndex),
  };
}

function enqueueDispatchTask(pipeline: PipelineState, candidate: DispatchQueueItem): { inserted: boolean; queuePosition: number } {
  normalizePipelineRuntimeState(pipeline);
  const queue = pipeline.dispatchQueue ?? [];
  const inFlight = pipeline.dispatchInFlight ?? [];
  const completed = new Set((pipeline.completedTaskRefs ?? []).map((taskRef) => taskRef.toUpperCase()));

  if (completed.has(candidate.taskRef) || inFlight.some((item) => item.taskRef === candidate.taskRef)) {
    const existingPosition = queue.findIndex((item) => item.taskRef === candidate.taskRef);
    return {
      inserted: false,
      queuePosition: existingPosition,
    };
  }

  const existingIndex = queue.findIndex((item) => item.taskRef === candidate.taskRef);
  if (existingIndex >= 0) {
    queue.sort(compareDispatchQueueItems);
    return {
      inserted: false,
      queuePosition: queue.findIndex((item) => item.taskRef === candidate.taskRef),
    };
  }

  queue.push(candidate);
  queue.sort(compareDispatchQueueItems);
  pipeline.dispatchQueue = queue;
  return {
    inserted: true,
    queuePosition: queue.findIndex((item) => item.taskRef === candidate.taskRef),
  };
}

function compareDispatchQueueItems(left: DispatchQueueItem, right: DispatchQueueItem): number {
  const stageOrder = { triage: 0, implementation: 1, review: 2 } as const;
  if (stageOrder[left.stage] !== stageOrder[right.stage]) {
    return stageOrder[left.stage] - stageOrder[right.stage];
  }

  const groupCompare = left.parallelGroup.localeCompare(right.parallelGroup);
  if (groupCompare !== 0) {
    return groupCompare;
  }

  if (left.taskIndex !== right.taskIndex) {
    return left.taskIndex - right.taskIndex;
  }

  if (left.queuedAt !== right.queuedAt) {
    return left.queuedAt - right.queuedAt;
  }

  return left.taskRef.localeCompare(right.taskRef);
}

function peekDispatchQueue(pipeline: PipelineState): DispatchQueueItem | null {
  normalizePipelineRuntimeState(pipeline);
  const queue = pipeline.dispatchQueue ?? [];
  queue.sort(compareDispatchQueueItems);
  return queue[0] ?? null;
}

function dequeueDispatchTask(pipeline: PipelineState, taskRef: string): void {
  normalizePipelineRuntimeState(pipeline);
  const normalizedTaskRef = taskRef.toUpperCase();
  pipeline.dispatchQueue = (pipeline.dispatchQueue ?? []).filter((item) => item.taskRef !== normalizedTaskRef);
}

function markDispatchInFlight(pipeline: PipelineState, item: DispatchQueueItem, startedBySessionID: string): void {
  normalizePipelineRuntimeState(pipeline);
  const normalizedTaskRef = item.taskRef.toUpperCase();
  pipeline.dispatchInFlight = (pipeline.dispatchInFlight ?? []).filter((entry) => entry.taskRef !== normalizedTaskRef);
  pipeline.dispatchInFlight.push({
    stage: item.stage,
    taskRef: normalizedTaskRef,
    role: item.role,
    tier: item.tier,
    parallelGroup: item.parallelGroup,
    slot: item.slot,
    startedAt: Date.now(),
    startedBySessionID,
  });
}

function markDispatchTaskCompleted(pipeline: PipelineState, taskRef: string): void {
  normalizePipelineRuntimeState(pipeline);
  const normalizedTaskRef = taskRef.toUpperCase();
  pipeline.dispatchInFlight = (pipeline.dispatchInFlight ?? []).filter((entry) => entry.taskRef !== normalizedTaskRef);

  const completed = new Set((pipeline.completedTaskRefs ?? []).map((entry) => entry.toUpperCase()));
  completed.add(normalizedTaskRef);
  pipeline.completedTaskRefs = Array.from(completed).sort();
}

function clearDispatchInFlightTask(pipeline: PipelineState, taskRef: string): void {
  normalizePipelineRuntimeState(pipeline);
  const normalizedTaskRef = taskRef.toUpperCase();
  pipeline.dispatchInFlight = (pipeline.dispatchInFlight ?? []).filter((entry) => entry.taskRef !== normalizedTaskRef);
}

function computeParallelDispatchUsage(pipelines: Record<string, PipelineState>): ParallelDispatchUsage {
  const usage: ParallelDispatchUsage = {
    total: 0,
    byRole: {
      planning: 0,
      implementation: 0,
      review: 0,
    },
    byTier: {
      lite: 0,
      standard: 0,
      pro: 0,
    },
  };

  for (const pipeline of Object.values(pipelines)) {
    normalizePipelineRuntimeState(pipeline);
    for (const inFlight of pipeline.dispatchInFlight ?? []) {
      usage.total += 1;
      usage.byRole[inFlight.role] += 1;
      usage.byTier[inFlight.tier] += 1;
    }
  }

  return usage;
}

function evaluateParallelCapacity(
  candidate: DispatchQueueItem,
  usage: ParallelDispatchUsage,
  limits: ParallelismSettings,
): { ok: true } | { ok: false; reason: string } {
  if (usage.total >= limits.maxParallelTotal) {
    return {
      ok: false,
      reason: `global parallel cap reached (${usage.total}/${limits.maxParallelTotal})`,
    };
  }

  const roleUsage = usage.byRole[candidate.role];
  const roleCap = limits.maxParallelByRole[candidate.role];
  if (roleUsage >= roleCap) {
    return {
      ok: false,
      reason: `role cap reached for ${candidate.role} (${roleUsage}/${roleCap})`,
    };
  }

  const tierUsage = usage.byTier[candidate.tier];
  const tierCap = limits.maxParallelByTier[candidate.tier];
  if (tierUsage >= tierCap) {
    return {
      ok: false,
      reason: `tier cap reached for ${candidate.tier} (${tierUsage}/${tierCap})`,
    };
  }

  return { ok: true };
}

async function resolveTaskDependencyStatus(input: {
  dependsOn: string[];
  pipeline: PipelineState;
  tasklistPath?: string;
}): Promise<{ missing: string[] }> {
  const required = input.dependsOn.map((taskRef) => taskRef.toUpperCase());
  if (required.length === 0) {
    return { missing: [] };
  }

  const completed = new Set((input.pipeline.completedTaskRefs ?? []).map((taskRef) => taskRef.toUpperCase()));
  if (input.tasklistPath) {
    try {
      const tasklistRaw = await readFile(input.tasklistPath, "utf-8");
      const checked = parseCompletedTaskRefsFromTasklist(tasklistRaw);
      for (const taskRef of checked) {
        completed.add(taskRef);
      }
    } catch {
      // Deterministically continue with currently known completion set.
    }
  }

  const missing = required.filter((taskRef) => !completed.has(taskRef));
  return { missing };
}

function parseCompletedTaskRefsFromTasklist(content: string): Set<string> {
  const completed = new Set<string>();
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[(x|X)\]\s+\*\*(T-\d+(?:\.\d+)+)\*\*/);
    if (!match || !match[2]) {
      continue;
    }

    completed.add(match[2].toUpperCase());
  }

  return completed;
}

function normalizeExecutionGraphEventInput(input: ExecutionGraphEventInput): ExecutionGraphEventInput {
  return {
    eventType: input.eventType.trim(),
    sessionID: input.sessionID.trim() || "n/a",
    parentSessionID: input.parentSessionID.trim() || "n/a",
    stage: input.stage,
    taskRef: input.taskRef.trim() || "n/a",
    agentID: input.agentID.trim() || "n/a",
    tier: input.tier.trim() || "n/a",
    skillID: input.skillID.trim() || "n/a",
    parallelGroup: normalizeParallelGroup(input.parallelGroup),
    slot: input.slot.trim() || "n/a",
    status: input.status.trim() || "unknown",
    reason: typeof input.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : undefined,
  };
}

function buildExecutionGraphDedupeKey(rootSessionID: string, input: ExecutionGraphEventInput): string {
  return `${rootSessionID}:${input.taskRef}:${input.eventType}:${input.status}`;
}

function pruneExecutionGraphDedupes(cache: Record<string, number>, latestSeq: number): void {
  const floor = Math.max(0, latestSeq - 2048);
  for (const [key, seq] of Object.entries(cache)) {
    if (typeof seq !== "number" || seq < floor) {
      delete cache[key];
    }
  }
}

async function readExecutionGraphEntries(filePath: string, rootSessionID: string): Promise<ExecutionGraphEventEntry[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return splitCommandQueueLines(raw)
      .map((line) => parseExecutionGraphEntry(line))
      .filter((entry): entry is ExecutionGraphEventEntry => Boolean(entry))
      .filter((entry) => entry.rootSessionID === rootSessionID)
      .sort((left, right) => left.seq - right.seq);
  } catch {
    return [];
  }
}

function parseExecutionGraphEntry(rawLine: string): ExecutionGraphEventEntry | null {
  try {
    const parsed = JSON.parse(rawLine) as Partial<ExecutionGraphEventEntry>;
    if (
      typeof parsed.seq !== "number" ||
      typeof parsed.ts !== "string" ||
      typeof parsed.rootSessionID !== "string" ||
      typeof parsed.eventType !== "string" ||
      typeof parsed.sessionID !== "string" ||
      typeof parsed.parentSessionID !== "string" ||
      (parsed.stage !== "triage" && parsed.stage !== "implementation" && parsed.stage !== "review") ||
      typeof parsed.taskRef !== "string" ||
      typeof parsed.agentID !== "string" ||
      typeof parsed.tier !== "string" ||
      typeof parsed.skillID !== "string" ||
      typeof parsed.parallelGroup !== "string" ||
      typeof parsed.slot !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }

    return {
      seq: parsed.seq,
      ts: parsed.ts,
      rootSessionID: parsed.rootSessionID,
      eventType: parsed.eventType,
      sessionID: parsed.sessionID,
      parentSessionID: parsed.parentSessionID,
      stage: parsed.stage,
      taskRef: parsed.taskRef,
      agentID: parsed.agentID,
      tier: parsed.tier,
      skillID: parsed.skillID,
      parallelGroup: parsed.parallelGroup,
      slot: parsed.slot,
      status: parsed.status,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function renderExecutionOrderSummary(entries: ExecutionGraphEventEntry[]): string[] {
  if (entries.length === 0) {
    return ["- none"];
  }

  return entries.slice(-12).map((entry) => {
    const reasonSegment = entry.reason ? ` reason=${entry.reason}` : "";
    return `- #${entry.seq} ${entry.eventType} task=${entry.taskRef} stage=${entry.stage} status=${entry.status}${reasonSegment}`;
  });
}

function renderOverlapWindowSummary(entries: ExecutionGraphEventEntry[]): string[] {
  if (entries.length === 0) {
    return ["- none"];
  }

  const activeBySlot = new Map<string, { startSeq: number; group: string; taskRef: string }>();
  const windowsByGroup = new Map<string, string[]>();
  const lastSeq = entries[entries.length - 1]?.seq ?? 0;

  for (const entry of entries) {
    if (entry.eventType === "spawn_started") {
      activeBySlot.set(entry.slot, {
        startSeq: entry.seq,
        group: entry.parallelGroup,
        taskRef: entry.taskRef,
      });
      continue;
    }

    if (entry.eventType !== "spawn_completed") {
      continue;
    }

    const started = activeBySlot.get(entry.slot);
    if (!started) {
      continue;
    }

    const group = started.group;
    const windows = windowsByGroup.get(group) ?? [];
    windows.push(`[${started.startSeq}-${entry.seq}] ${started.taskRef}`);
    windowsByGroup.set(group, windows);
    activeBySlot.delete(entry.slot);
  }

  for (const [slot, started] of activeBySlot.entries()) {
    const windows = windowsByGroup.get(started.group) ?? [];
    windows.push(`[${started.startSeq}-${lastSeq}] ${started.taskRef} (active:${slot})`);
    windowsByGroup.set(started.group, windows);
  }

  if (windowsByGroup.size === 0) {
    return ["- none"];
  }

  return Array.from(windowsByGroup.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, windows]) => `- ${group}: ${windows.join(", ")}`);
}

function dedupePathEntries(entries: string[]): string[] {
  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

async function ensureShellBootstrapFile(filePath: string, worktree: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buildShellBootstrapScript(worktree), "utf-8");
}

function buildShellBootstrapScript(worktree: string): string {
  const quotedWorktree = JSON.stringify(worktree);
  return [
    `__demonlord_pipeline_root=${quotedWorktree}`,
    "pipelinectl() {",
    "  local root=\"${OPENCODE_WORKTREE:-$__demonlord_pipeline_root}\"",
    "  \"$root/agents/tools/pipelinectl.sh\" \"$@\"",
    "}",
    "piplinectl() {",
    "  pipelinectl \"$@\"",
    "}",
    "export -f pipelinectl piplinectl >/dev/null 2>&1 || true",
  ].join("\n");
}

function pruneProcessedCommandDedupes(cache: Record<string, number>): void {
  const now = Date.now();
  for (const [key, expiresAt] of Object.entries(cache)) {
    if (typeof expiresAt !== "number" || expiresAt <= now) {
      delete cache[key];
    }
  }
}

function isTransitionState(value: unknown): value is TransitionState {
  return (
    value === "idle" ||
    value === "awaiting_approval" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "completed" ||
    value === "stopped"
  );
}

function setNoReplyIfSupported(output: { parts: unknown[] }): void {
  const mutable = output as { noReply?: boolean };
  mutable.noReply = true;
}

async function validateSpecHandoffMarkerFile(filePath: string): Promise<{ ok: boolean; missing: string[] }> {
  try {
    const content = await readFile(filePath, "utf-8");
    return validateSpecHandoffMarkerContent(content);
  } catch {
    return {
      ok: false,
      missing: ["file not found"],
    };
  }
}

function validateSpecHandoffMarkerContent(content: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!content.includes(SPEC_HANDOFF_READY_MARKER)) {
    missing.push(SPEC_HANDOFF_READY_MARKER);
  }

  for (const heading of SPEC_HANDOFF_REQUIRED_HEADINGS) {
    const pattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "im");
    if (!pattern.test(content)) {
      missing.push(heading);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeJsonAtomically(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(tempPath, serialized, "utf-8");
  await rename(tempPath, filePath);
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

async function resolveTaskTraversalContext(
  worktree: string,
  input: { taskDescription: string; existing?: TaskTraversalContext },
): Promise<TaskTraversalContext> {
  const existing = input.existing;
  const taskDescription = existing?.taskDescription ?? input.taskDescription;
  const taskRef = existing?.taskRef;

  let tasklistPath = existing?.tasklistPath;
  if (!tasklistPath && taskRef) {
    tasklistPath = (await resolveTasklistPath(worktree, taskDescription, taskRef)) ?? undefined;
  }

  return {
    taskDescription,
    taskRef,
    tasklistPath,
  };
}

async function resolveTaskExecutionMetadata(taskContext: TaskTraversalContext): Promise<TaskExecutionLookup> {
  if (!taskContext.taskRef) {
    return {
      warning: [
        "EXECUTION metadata lookup skipped because persisted task traversal context is missing taskRef.",
        `Context='${taskContext.taskDescription ?? "unknown"}'. Falling back to legacy routing defaults.`,
      ].join(" "),
    };
  }

  if (!taskContext.tasklistPath) {
    return {
      warning: [
        `Could not resolve persisted tasklistPath for task '${taskContext.taskRef}'.`,
        "Falling back to legacy routing defaults.",
      ].join(" "),
    };
  }

  try {
    const content = await readFile(taskContext.tasklistPath, "utf-8");
    const parsed = parseTaskExecutionMetadata(content, taskContext.tasklistPath);
    const metadata = parsed.get(taskContext.taskRef);
    if (!metadata) {
      return {
        warning: [
          `Missing EXECUTION metadata for '${taskContext.taskRef}' in ${taskContext.tasklistPath}.`,
          "Falling back to legacy role/tier routing behavior.",
        ].join(" "),
      };
    }

    return { metadata };
  } catch {
    return {
      warning: [
        `Unable to read tasklist '${taskContext.tasklistPath}' for '${taskContext.taskRef}'.`,
        "Falling back to legacy routing defaults.",
      ].join(" "),
    };
  }
}

function extractTaskReference(taskDescription: string): string | null {
  const matched = taskDescription.match(TASK_REF_PATTERN);
  if (!matched || !matched[0]) {
    return null;
  }

  return matched[0].toUpperCase();
}

async function resolveTasklistPath(worktree: string, taskDescription: string, taskRef?: string): Promise<string | null> {
  const explicit = taskDescription.match(/([A-Za-z0-9_-]+_Tasklist\.md)/);
  if (explicit && explicit[1]) {
    const directPath = resolve(worktree, "agents", explicit[1]);
    try {
      const fileStats = await stat(directPath);
      if (fileStats.isFile()) {
        return directPath;
      }
    } catch {
      // Fall through to discovery.
    }
  }

  const discovered = await listTasklistPaths(worktree);
  if (taskRef) {
    for (const candidate of discovered) {
      try {
        const raw = await readFile(candidate, "utf-8");
        const hasTask = new RegExp(`<!--\\s*TASK:${escapeRegExp(taskRef)}\\s*-->`, "i").test(raw);
        if (hasTask) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }

  return discovered[0] ?? null;
}

async function listTasklistPaths(worktree: string): Promise<string[]> {
  const agentsDirectory = resolve(worktree, "agents");
  try {
    const entries = await readdir(agentsDirectory, { withFileTypes: true });
    const tasklistStats = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith("_Tasklist.md"))
        .map(async (entry) => {
          const absolutePath = resolve(agentsDirectory, entry.name);
          const metadata = await stat(absolutePath);
          return {
            path: absolutePath,
            mtimeMs: metadata.mtimeMs,
          };
        }),
    );

    tasklistStats.sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }

      return left.path.localeCompare(right.path);
    });

    return tasklistStats.map((entry) => entry.path);
  } catch {
    return [];
  }
}

function parseTaskExecutionMetadata(content: string, tasklistPath: string): Map<string, TaskExecutionMetadata> {
  const metadataByTask = new Map<string, TaskExecutionMetadata>();
  const lines = content.split("\n");
  let pendingTaskRef: string | null = null;
  let pendingTaskIndex = -1;
  let taskIndex = 0;

  for (const line of lines) {
    const taskMatch = line.match(/^\s*<!--\s*TASK:([^\s]+)\s*-->\s*$/i);
    if (taskMatch && taskMatch[1]) {
      pendingTaskRef = taskMatch[1].trim().toUpperCase();
      pendingTaskIndex = taskIndex;
      taskIndex += 1;
      continue;
    }

    if (!pendingTaskRef) {
      continue;
    }

    const executionMatch = line.match(/^\s*<!--\s*EXECUTION:(.+)-->\s*$/i);
    if (!executionMatch || !executionMatch[1]) {
      continue;
    }

    const parsed = parseTaskExecutionComment(executionMatch[1].trim(), pendingTaskRef, tasklistPath, pendingTaskIndex);
    if (parsed) {
      metadataByTask.set(pendingTaskRef, parsed);
    }

    pendingTaskRef = null;
    pendingTaskIndex = -1;
  }

  return metadataByTask;
}

function parseTaskExecutionComment(
  rawExecutionJson: string,
  taskRef: string,
  tasklistPath: string,
  taskIndex: number,
): TaskExecutionMetadata | null {
  try {
    const parsed = JSON.parse(rawExecutionJson) as {
      execution?: {
        role?: unknown;
        tier?: unknown;
        skill?: unknown;
        parallel_group?: unknown;
        depends_on?: unknown;
      };
    };

    if (!isRecord(parsed.execution)) {
      return null;
    }

    const role = normalizeExecutionRole(parsed.execution.role);
    const tier = normalizeExecutionTier(parsed.execution.tier);
    if (!role || !tier) {
      return null;
    }

    const skillID = typeof parsed.execution.skill === "string" && parsed.execution.skill.trim()
      ? parsed.execution.skill.trim()
      : undefined;
    const parallelGroup =
      typeof parsed.execution.parallel_group === "string" && parsed.execution.parallel_group.trim()
        ? parsed.execution.parallel_group.trim()
        : undefined;

    const dependsOn = toStringArray(parsed.execution.depends_on);

    return {
      taskRef,
      role,
      tier,
      skillID,
      parallelGroup,
      dependsOn,
      taskIndex,
      tasklistPath,
    };
  } catch {
    return null;
  }
}

function shouldPreferSpecExpertFirst(taskDescription: string): boolean {
  const normalized = taskDescription.toLowerCase();
  if (AMBIGUITY_HINT_PATTERN.test(normalized)) {
    return true;
  }

  const tokens = normalized
    .split(/[^a-z0-9-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  for (const token of tokens) {
    if (SPEC_DISCOVERY_TOKENS.has(token)) {
      return true;
    }
  }

  return false;
}

function applySpecExpertFirstPolicy(routing: RouteResult): RouteResult {
  if (routing.skill_id === SPEC_EXPERT_SKILL_ID) {
    return {
      ...routing,
      mode: "heuristic",
      reason: `Ambiguity-first policy confirmed ${SPEC_EXPERT_SKILL_ID}. ${routing.reason}`,
    };
  }

  return {
    skill_id: SPEC_EXPERT_SKILL_ID,
    mode: "heuristic",
    reason: `Ambiguity-first policy overrode ${routing.skill_id} with ${SPEC_EXPERT_SKILL_ID}. ${routing.reason}`,
  };
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

function buildSpecHandoffPrompt(
  taskDescription: string,
  pipeline: PipelineState,
  childSessionID: string,
  handoff: SpecHandoffState,
): string {
  const taskID = pipeline.worktree?.taskID ?? "unknown-task";
  const worktreePath = pipeline.worktree?.worktreePath ?? "unknown-worktree";

  return [
    "Spec-first routing selected this session to produce a deterministic handoff artifact.",
    "Before any coding session can start, create the spec marker file below.",
    "",
    "Required output:",
    `- File: ${handoff.markerPath}`,
    `- Include exact marker token: ${SPEC_HANDOFF_READY_MARKER}`,
    `- Include headings: ${SPEC_HANDOFF_REQUIRED_HEADINGS.join(", ")}`,
    "- Keep sections concise and implementation-ready.",
    "",
    "Session metadata:",
    `- Parent Session: ${pipeline.rootSessionID}`,
    `- Spec Session: ${childSessionID}`,
    `- Task ID: ${taskID}`,
    `- Next Skill After Handoff: ${handoff.targetSkillID}`,
    `- Worktree: ${worktreePath}`,
    `- Task Description: ${taskDescription}`,
  ].join("\n");
}

function applyGlobalOffToPipelines(pipelines: Record<string, PipelineState>): void {
  for (const pipeline of Object.values(pipelines)) {
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
}

function applyGlobalOnToPipelines(pipelines: Record<string, PipelineState>): number {
  let resumed = 0;

  for (const pipeline of Object.values(pipelines)) {
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

  return resumed;
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
    `- Spec Handoff Marker: ${pipeline.specHandoff?.markerPath ?? "n/a"}`,
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

export const __orchestratorTestUtils = {
  applySpecExpertFirstPolicy,
  applyGlobalOffToPipelines,
  applyGlobalOnToPipelines,
  buildCommandDedupKey,
  extractTaskReference,
  getNextStage,
  loadPersistedState,
  parseAgentPools,
  parseJsonc,
  parseTaskExecutionMetadata,
  parseTaskRoutingSettings,
  normalizeErrorSignature,
  normalizeStage,
  parseQueuedCommand,
  rememberPreHandledCommand,
  resolveAgentFromPools,
  shouldIgnoreError,
  splitCommandQueueLines,
  pruneProcessedCommandDedupes,
  setNoReplyIfSupported,
  shouldPreferSpecExpertFirst,
  validateSpecHandoffMarkerContent,
  wasPreHandled,
  writeJsonAtomically,
};

export default OrchestratorPlugin;
