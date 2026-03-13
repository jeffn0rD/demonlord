import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

type PipelineStage = "triage" | "implementation" | "review";
type TransitionState = "idle" | "awaiting_approval" | "in_progress" | "blocked" | "completed" | "stopped";

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

interface PipelineStateSnapshot {
  rootSessionID: string;
  currentStage: PipelineStage;
  transition: TransitionState;
  stopped: boolean;
  stopReason?: string;
  updatedAt: number;
  pendingTransition?: PendingTransition;
  sessions?: Record<string, PipelineSessionSnapshot>;
  routing?: PipelineRoutingSnapshot;
  taskTraversal?: {
    taskRef?: string;
  };
}

interface PipelineSessionSnapshot {
  sessionID: string;
  stage: PipelineStage;
  parentSessionID?: string;
  children: string[];
  status: "active" | "completed" | "blocked" | "stopped";
}

interface PipelineRoutingSnapshot {
  taskRef?: string;
  agentID?: string;
}

interface ExecutionGraphEntry {
  seq: number;
  rootSessionID: string;
  eventType: string;
  stage: PipelineStage;
  taskRef: string;
  parallelGroup: string;
  slot: string;
  status: string;
  reason?: string;
}

interface OrchestrationSnapshot {
  version: number;
  updatedAt: string;
  runtime?: {
    off?: boolean;
    enabled?: boolean;
    configuredMode?: string;
    effectiveMode?: string;
  };
  sessionToRoot?: Record<string, string>;
  pipelines?: Record<string, PipelineStateSnapshot>;
  pipelineSummaries?: Record<string, PipelineStateSnapshot>;
}

interface PipelineTarget {
  rootSessionID: string;
  pipeline: PipelineStateSnapshot;
}

interface PipelineQueueCommand {
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

interface RuntimeContext {
  worktree: string;
  statePath: string;
  queuePath: string;
  sessionID?: string;
}

interface PipelineCtlIO {
  stdout(message: string): void;
  stderr(message: string): void;
}

const VALID_STAGES = new Set<PipelineStage>(["triage", "implementation", "review"]);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const defaultIO: PipelineCtlIO = {
  stdout(message: string) {
    process.stdout.write(message);
  },
  stderr(message: string) {
    process.stderr.write(message);
  },
};

export async function runPipelineCtl(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: PipelineCtlIO = defaultIO,
): Promise<number> {
  const context = resolveRuntimeContext(env);
  const [actionRaw, ...args] = argv;
  const action = (actionRaw ?? "status").toLowerCase();

  if (action === "-h" || action === "--help" || action === "help") {
    io.stdout(`${renderUsage()}\n`);
    return 0;
  }

  const snapshot = await loadSnapshot(context.statePath);
  if (!snapshot) {
    io.stderr(
      `Unable to read orchestration snapshot at ${context.statePath}. Run a pipeline command first or verify OPENCODE_ORCHESTRATION_STATE.\n`,
    );
    return 1;
  }

  if (action === "status") {
    const executionGraphPath = resolve(context.worktree, "_bmad-output", "execution-graph.ndjson");
    const executionGraph = await loadExecutionGraph(executionGraphPath);
    io.stdout(`${renderStatus(snapshot, context.sessionID, args[0], executionGraph)}\n`);
    return 0;
  }

  if (action === "off" || action === "on") {
    const sessionID = context.sessionID;
    if (!sessionID) {
      io.stderr("Missing session context. Set OPENCODE_SESSION_ID or run inside an active OpenCode shell.\n");
      return 1;
    }

    const dedupeKey = `pipelinectl:${action}:global:${snapshot.updatedAt}`;
    const command = buildQueueCommand({
      action,
      sessionID,
      dedupeKey,
    });

    const appended = await appendQueueCommand(context.queuePath, command);
    if (!appended) {
      io.stderr(`Duplicate command ignored (dedupe key: ${dedupeKey}).\n`);
      return 1;
    }

    io.stdout(`Queued '${action}' (dedupe key: ${dedupeKey}).\n`);
    return 0;
  }

  if (isRuntimeOff(snapshot)) {
    io.stderr("Orchestration runtime is OFF. Run `pipelinectl on` and retry.\n");
    return 1;
  }

  if (action === "advance") {
    const requestedStage = args[0]?.toLowerCase();
    if (!requestedStage || !VALID_STAGES.has(requestedStage as PipelineStage)) {
      io.stderr("Usage: pipelinectl advance <triage|implementation|review> [session_id]\n");
      return 1;
    }

    const targetSessionID = args[1] ?? context.sessionID;
    if (!targetSessionID) {
      io.stderr("Missing session context for advance. Pass [session_id] or set OPENCODE_SESSION_ID.\n");
      return 1;
    }

    const resolved = resolvePipeline(snapshot, targetSessionID);
    if (!resolved) {
      io.stderr(`No pipeline found for session '${targetSessionID}'.\n`);
      return 1;
    }

    const expectedNext = nextStage(resolved.pipeline.currentStage);
    if (expectedNext !== requestedStage) {
      io.stderr(
        `Invalid transition ${resolved.pipeline.currentStage} -> ${requestedStage}. Expected '${expectedNext ?? "none"}'.\n`,
      );
      return 1;
    }

    if (resolved.pipeline.stopped) {
      io.stderr(
        `Pipeline ${resolved.rootSessionID} is stopped (${resolved.pipeline.stopReason ?? "unknown"}). Use 'pipelinectl on' first.\n`,
      );
      return 1;
    }

    const sessionID = context.sessionID ?? targetSessionID;
    const dedupeKey = `pipelinectl:advance:${resolved.rootSessionID}:${requestedStage}:${resolved.pipeline.updatedAt}`;
    const command = buildQueueCommand({
      action: "advance",
      stage: requestedStage as PipelineStage,
      sessionID,
      targetSessionID,
      dedupeKey,
      expectation: {
        rootSessionID: resolved.rootSessionID,
        stage: resolved.pipeline.currentStage,
        transition: resolved.pipeline.transition,
        pipelineUpdatedAt: resolved.pipeline.updatedAt,
      },
    });

    const appended = await appendQueueCommand(context.queuePath, command);
    if (!appended) {
      io.stderr(`Duplicate command ignored (dedupe key: ${dedupeKey}).\n`);
      return 1;
    }

    io.stdout(
      `Queued 'advance ${requestedStage}' for pipeline ${resolved.rootSessionID} (dedupe key: ${dedupeKey}).\n`,
    );
    return 0;
  }

  if (action === "approve" || action === "stop") {
    const targetSessionID = args[0] ?? context.sessionID;
    if (!targetSessionID) {
      io.stderr(`Missing session context for ${action}. Pass [session_id] or set OPENCODE_SESSION_ID.\n`);
      return 1;
    }

    const resolved = resolvePipeline(snapshot, targetSessionID);
    if (!resolved) {
      io.stderr(`No pipeline found for session '${targetSessionID}'.\n`);
      return 1;
    }

    if (action === "approve") {
      if (!resolved.pipeline.pendingTransition) {
        io.stderr("No pending transition requires approval.\n");
        return 1;
      }

      if (!resolved.pipeline.pendingTransition.approvalRequired) {
        io.stderr("Pending transition does not require approval.\n");
        return 1;
      }
    }

    if (action === "stop" && resolved.pipeline.stopped) {
      io.stderr(
        `Pipeline ${resolved.rootSessionID} is already stopped (${resolved.pipeline.stopReason ?? "unknown"}).\n`,
      );
      return 1;
    }

    const sessionID = context.sessionID ?? targetSessionID;
    const dedupeKey = `pipelinectl:${action}:${resolved.rootSessionID}:${resolved.pipeline.updatedAt}`;
    const command = buildQueueCommand({
      action,
      sessionID,
      targetSessionID,
      dedupeKey,
      expectation: {
        rootSessionID: resolved.rootSessionID,
        stage: resolved.pipeline.currentStage,
        transition: resolved.pipeline.transition,
        pipelineUpdatedAt: resolved.pipeline.updatedAt,
        pendingRequired: action === "approve",
      },
    });

    const appended = await appendQueueCommand(context.queuePath, command);
    if (!appended) {
      io.stderr(`Duplicate command ignored (dedupe key: ${dedupeKey}).\n`);
      return 1;
    }

    io.stdout(`Queued '${action}' for pipeline ${resolved.rootSessionID} (dedupe key: ${dedupeKey}).\n`);
    return 0;
  }

  io.stderr(`Unknown action '${action}'.\n${renderUsage()}\n`);
  return 1;
}

function resolveRuntimeContext(env: NodeJS.ProcessEnv): RuntimeContext {
  const fallbackWorktree = resolve(MODULE_DIR, "../..");
  const worktree = env.OPENCODE_WORKTREE ? resolve(env.OPENCODE_WORKTREE) : fallbackWorktree;
  const statePath = env.OPENCODE_ORCHESTRATION_STATE
    ? resolve(env.OPENCODE_ORCHESTRATION_STATE)
    : resolve(worktree, "_bmad-output", "orchestration-state.json");
  const queuePath = env.OPENCODE_ORCHESTRATION_COMMAND_QUEUE
    ? resolve(env.OPENCODE_ORCHESTRATION_COMMAND_QUEUE)
    : resolve(worktree, "_bmad-output", "orchestration-commands.ndjson");

  return {
    worktree,
    statePath,
    queuePath,
    sessionID: env.OPENCODE_SESSION_ID,
  };
}

async function loadSnapshot(filePath: string): Promise<OrchestrationSnapshot | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestrationSnapshot>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      runtime: parsed.runtime,
      sessionToRoot: parsed.sessionToRoot ?? {},
      pipelines: parsed.pipelines ?? {},
      pipelineSummaries: parsed.pipelineSummaries,
    };
  } catch {
    return null;
  }
}

function renderStatus(
  snapshot: OrchestrationSnapshot,
  envSessionID?: string,
  explicitSessionID?: string,
  executionGraph: ExecutionGraphEntry[] = [],
): string {
  const pipelines = getPipelineMap(snapshot);
  const roots = Object.keys(pipelines);
  if (roots.length === 0) {
    return "No pipelines found in orchestration snapshot.";
  }

  const selected = resolvePipeline(snapshot, explicitSessionID ?? envSessionID);
  if (selected) {
    return formatPipelineStatus(selected, snapshot, executionGraph);
  }

  const lines = [
    `Snapshot updated: ${snapshot.updatedAt}`,
    `Runtime mode: ${snapshot.runtime?.effectiveMode ?? snapshot.runtime?.configuredMode ?? "unknown"}`,
    "Pipelines:",
  ];
  for (const rootSessionID of roots.sort()) {
    const pipeline = pipelines[rootSessionID] as PipelineStateSnapshot;
    lines.push(
      `- ${rootSessionID}: stage=${pipeline.currentStage}, transition=${pipeline.transition}, stopped=${pipeline.stopped}`,
    );
  }

  return lines.join("\n");
}

function formatPipelineStatus(
  target: PipelineTarget,
  snapshot: OrchestrationSnapshot,
  executionGraph: ExecutionGraphEntry[],
): string {
  const pipeline = target.pipeline;
  const pending = pipeline.pendingTransition
    ? `${pipeline.pendingTransition.from} -> ${pipeline.pendingTransition.to}`
    : "none";
  const mode = snapshot.runtime?.effectiveMode ?? snapshot.runtime?.configuredMode ?? "unknown";
  const graphEntries = executionGraph
    .filter((entry) => entry.rootSessionID === target.rootSessionID)
    .sort((left, right) => left.seq - right.seq);
  const sessionTree = renderSessionTree(pipeline, target.rootSessionID, 0);
  const executionOrder = renderExecutionOrderSummary(graphEntries);
  const overlap = renderOverlapWindowSummary(graphEntries);

  return [
    `Pipeline: ${target.rootSessionID}`,
    `Mode: ${mode}`,
    `Stage: ${pipeline.currentStage}`,
    `Transition: ${pipeline.transition}`,
    `Stopped: ${pipeline.stopped ? `yes (${pipeline.stopReason ?? "unknown"})` : "no"}`,
    `Pending: ${pending}`,
    `UpdatedAt: ${pipeline.updatedAt}`,
    "Session Tree:",
    ...sessionTree,
    "Execution Order:",
    ...executionOrder,
    "Overlap Windows:",
    ...overlap,
  ].join("\n");
}

function resolvePipeline(snapshot: OrchestrationSnapshot, sessionID?: string): PipelineTarget | null {
  const pipelines = getPipelineMap(snapshot);
  const sessionToRoot = snapshot.sessionToRoot ?? {};
  if (sessionID) {
    const rootSessionID = sessionToRoot[sessionID] ?? (pipelines[sessionID] ? sessionID : undefined);
    if (!rootSessionID || !pipelines[rootSessionID]) {
      return null;
    }

    return {
      rootSessionID,
      pipeline: pipelines[rootSessionID] as PipelineStateSnapshot,
    };
  }

  const roots = Object.keys(pipelines);
  if (roots.length === 0) {
    return null;
  }

  const latest = roots
    .map((rootSessionID) => ({ rootSessionID, pipeline: pipelines[rootSessionID] as PipelineStateSnapshot }))
    .sort((left, right) => right.pipeline.updatedAt - left.pipeline.updatedAt)[0];

  return latest ?? null;
}

function getPipelineMap(snapshot: OrchestrationSnapshot): Record<string, PipelineStateSnapshot> {
  const pipelines = snapshot.pipelines ?? {};
  if (Object.keys(pipelines).length > 0) {
    return pipelines;
  }

  return snapshot.pipelineSummaries ?? {};
}

function renderSessionTree(pipeline: PipelineStateSnapshot, sessionID: string, depth: number): string[] {
  const sessions = pipeline.sessions;
  if (!sessions || !sessions[sessionID]) {
    return ["- unavailable (snapshot summary has no session tree)"];
  }

  const session = sessions[sessionID];
  const indent = "  ".repeat(depth);
  const taskRef = session.stage === "triage" ? pipeline.taskTraversal?.taskRef ?? "n/a" : pipeline.routing?.taskRef ?? "n/a";
  const agentID = session.stage === "triage" ? "planner" : pipeline.routing?.agentID ?? "n/a";
  const line = `${indent}- ${session.sessionID} [${session.stage}] {${session.status}} task=${taskRef} agent=${agentID}`;
  const childLines = (session.children ?? []).flatMap((childID) => renderSessionTree(pipeline, childID, depth + 1));
  return [line, ...childLines];
}

function renderExecutionOrderSummary(entries: ExecutionGraphEntry[]): string[] {
  if (entries.length === 0) {
    return ["- none"];
  }

  return entries.slice(-12).map((entry) => {
    const reasonSegment = entry.reason ? ` reason=${entry.reason}` : "";
    return `- #${entry.seq} ${entry.eventType} task=${entry.taskRef} stage=${entry.stage} status=${entry.status}${reasonSegment}`;
  });
}

function renderOverlapWindowSummary(entries: ExecutionGraphEntry[]): string[] {
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

    const windows = windowsByGroup.get(started.group) ?? [];
    windows.push(`[${started.startSeq}-${entry.seq}] ${started.taskRef}`);
    windowsByGroup.set(started.group, windows);
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

async function loadExecutionGraph(filePath: string): Promise<ExecutionGraphEntry[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseExecutionGraphEntry(line))
      .filter((entry): entry is ExecutionGraphEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function parseExecutionGraphEntry(rawLine: string): ExecutionGraphEntry | null {
  try {
    const parsed = JSON.parse(rawLine) as Partial<ExecutionGraphEntry>;
    if (
      typeof parsed.seq !== "number" ||
      typeof parsed.rootSessionID !== "string" ||
      typeof parsed.eventType !== "string" ||
      (parsed.stage !== "triage" && parsed.stage !== "implementation" && parsed.stage !== "review") ||
      typeof parsed.taskRef !== "string" ||
      typeof parsed.parallelGroup !== "string" ||
      typeof parsed.slot !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }

    return {
      seq: parsed.seq,
      rootSessionID: parsed.rootSessionID,
      eventType: parsed.eventType,
      stage: parsed.stage,
      taskRef: parsed.taskRef,
      parallelGroup: parsed.parallelGroup,
      slot: parsed.slot,
      status: parsed.status,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

function buildQueueCommand(input: {
  action: PipelineQueueCommand["action"];
  sessionID: string;
  targetSessionID?: string;
  stage?: PipelineStage;
  dedupeKey: string;
  expectation?: PipelineQueueCommand["expectation"];
}): PipelineQueueCommand {
  return {
    version: 1,
    id: `pcmd-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    source: "pipelinectl",
    action: input.action,
    sessionID: input.sessionID,
    targetSessionID: input.targetSessionID,
    stage: input.stage,
    dedupeKey: input.dedupeKey,
    requestedAt: new Date().toISOString(),
    expectation: input.expectation,
  };
}

async function appendQueueCommand(queuePath: string, command: PipelineQueueCommand): Promise<boolean> {
  await mkdir(dirname(queuePath), { recursive: true });

  const existing = await loadQueuedCommands(queuePath);
  if (existing.some((entry) => entry.dedupeKey === command.dedupeKey)) {
    return false;
  }

  await appendFile(queuePath, `${JSON.stringify(command)}\n`, "utf-8");
  return true;
}

async function loadQueuedCommands(queuePath: string): Promise<PipelineQueueCommand[]> {
  try {
    const raw = await readFile(queuePath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as PipelineQueueCommand;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is PipelineQueueCommand => Boolean(entry));
  } catch {
    return [];
  }
}

function nextStage(stage: PipelineStage): PipelineStage | null {
  if (stage === "triage") {
    return "implementation";
  }

  if (stage === "implementation") {
    return "review";
  }

  return null;
}

function isRuntimeOff(snapshot: OrchestrationSnapshot): boolean {
  if (snapshot.runtime?.off === true) {
    return true;
  }

  return snapshot.runtime?.effectiveMode === "off";
}

function renderUsage(): string {
  return [
    "Usage:",
    "  pipelinectl status [session_id]",
    "  pipelinectl off",
    "  pipelinectl on",
    "  pipelinectl advance <triage|implementation|review> [session_id]",
    "  pipelinectl approve [session_id]",
    "  pipelinectl stop [session_id]",
  ].join("\n");
}

if (import.meta.main) {
  runPipelineCtl(process.argv.slice(2)).then(
    (exitCode) => {
      process.exit(exitCode);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
