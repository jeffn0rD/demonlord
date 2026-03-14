import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, relative, resolve } from "path";

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
const STATE_DIRECTORY = ["_bmad-output", "cycle-state"] as const;
const REVIEW_ARTIFACT_DIRECTORY = ["_bmad-output", "cycle-state", "reviews"] as const;

type CommandAgent = "orchestrator" | "minion" | "reviewer";
type ImplementStatus = "ok" | "blocked" | "failed";
type ReviewStatus = "pass" | "pass-with-followups" | "fail";
type SubphaseRuntimeStatus = "pending" | "in_progress" | "passed" | "failed";
type CycleStatus = "running" | "completed" | "failed";

interface CycleRunnerArgs {
  codename: string;
  phase: string;
  max_repair_rounds?: number;
  dry_run?: boolean;
  resume?: boolean;
}

interface CycleRunnerContext {
  directory: string;
  worktree: string;
}

interface CycleRuntime {
  runCommand(input: RuntimeCommandInput): Promise<RuntimeCommandResult>;
}

interface RuntimeCommandInput {
  title: string;
  command: string;
  arguments: string;
  agent: CommandAgent;
}

interface RuntimeCommandResult {
  sessionID: string;
  outputText: string;
}

interface ParsedSubphase {
  id: string;
  taskRefs: string[];
  completed: boolean;
}

interface SubphaseState {
  status: SubphaseRuntimeStatus;
  repairRounds: number;
  taskRefs: string[];
  history: CycleStepEvent[];
}

interface CycleStepEvent {
  at: string;
  action: "implement" | "review" | "repair";
  sessionID: string;
  command: string;
  arguments: string;
  markerFound: boolean;
  status: string;
  note?: string;
}

interface PersistedCycleState {
  version: 1;
  codename: string;
  phase: string;
  tasklistPath: string;
  maxRepairRounds: number;
  status: CycleStatus;
  startedAt: string;
  updatedAt: string;
  currentSubphase?: string;
  subphases: Record<string, SubphaseState>;
  failureReason?: string;
}

interface CycleRunResult {
  ok: boolean;
  codename: string;
  phase: string;
  status: "dry_run" | "completed" | "failed";
  dry_run: boolean;
  max_repair_rounds: number;
  tasklist_path: string;
  state_path: string;
  subphases: string[];
  processed_subphases: string[];
  failure_reason?: string;
}

interface ParsedMarker<T> {
  markerFound: boolean;
  payload?: T;
  error?: string;
}

interface ImplementMarkerPayload {
  status?: string;
  codename?: string;
  subphase?: string;
  notes?: unknown;
}

interface ReviewMarkerPayload {
  status?: string;
  codename?: string;
  target?: string;
  notes?: unknown;
}

interface ReviewFallbackPayload {
  verdict?: {
    status?: unknown;
    severity_counts?: {
      critical?: unknown;
      high?: unknown;
      medium?: unknown;
      low?: unknown;
    };
  };
}

interface RepairMarkerPayload {
  status?: string;
  codename?: string;
  target?: string;
  notes?: unknown;
}

const cycle_runner = tool({
  description:
    "Run deterministic implement-review-repair loops across pending subphases in a selected phase.",
  args: {
    codename: tool.schema
      .string()
      .min(1)
      .describe("Codename prefix for agents/<codename>_Tasklist.md."),
    phase: tool.schema
      .string()
      .min(1)
      .describe("Phase selector (examples: '1', 'PHASE-1', 'SUBPHASE-1.2')."),
    max_repair_rounds: tool.schema
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Maximum repair-review loops per subphase before failing. Defaults to 2."),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("When true, only report planned subphases without executing commands."),
    resume: tool.schema
      .boolean()
      .optional()
      .describe("When true (default), resume from existing cycle-state file if present."),
  },
  async execute(args: CycleRunnerArgs, context: CycleRunnerContext) {
    const runtime = createSdkRuntime(context);
    const result = await runCycle(args, context, runtime);
    return JSON.stringify(result, null, 2);
  },
});

export async function runCycle(
  args: CycleRunnerArgs,
  context: CycleRunnerContext,
  runtime: CycleRuntime,
): Promise<CycleRunResult> {
  const worktreeRoot = resolve(context.worktree);
  const codename = sanitizeCodename(args.codename);
  const phase = normalizePhaseSelector(args.phase);
  if (!phase) {
    return {
      ok: false,
      codename,
      phase: String(args.phase ?? ""),
      status: "failed",
      dry_run: args.dry_run ?? false,
      max_repair_rounds: args.max_repair_rounds ?? 2,
      tasklist_path: resolve(worktreeRoot, "agents", `${codename}_Tasklist.md`),
      state_path: resolve(worktreeRoot, ...STATE_DIRECTORY, `${codename}-phase-unknown.json`),
      subphases: [],
      processed_subphases: [],
      failure_reason: "Invalid phase selector. Use values like '1', 'PHASE-1', or 'SUBPHASE-1.2'.",
    };
  }

  const tasklistPath = resolve(worktreeRoot, "agents", `${codename}_Tasklist.md`);
  const statePath = resolve(worktreeRoot, ...STATE_DIRECTORY, `${codename}-phase-${phase}.json`);
  const maxRepairRounds = args.max_repair_rounds ?? 2;
  const dryRun = args.dry_run ?? false;
  const shouldResume = args.resume ?? true;

  let tasklistRaw = "";
  try {
    tasklistRaw = await readFile(tasklistPath, "utf-8");
  } catch {
    return {
      ok: false,
      codename,
      phase,
      status: "failed",
      dry_run: dryRun,
      max_repair_rounds: maxRepairRounds,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: [],
      processed_subphases: [],
      failure_reason: `Tasklist not found or unreadable: ${tasklistPath}`,
    };
  }

  const parsedSubphases = parseSubphasesForPhase(tasklistRaw, phase);
  if (parsedSubphases.length === 0) {
    return {
      ok: false,
      codename,
      phase,
      status: "failed",
      dry_run: dryRun,
      max_repair_rounds: maxRepairRounds,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: [],
      processed_subphases: [],
      failure_reason: `No subphases found for PHASE-${phase} in ${tasklistPath}`,
    };
  }

  const pendingSubphases = parsedSubphases.filter((subphase) => !subphase.completed).map((subphase) => subphase.id);

  if (dryRun) {
    return {
      ok: true,
      codename,
      phase,
      status: "dry_run",
      dry_run: true,
      max_repair_rounds: maxRepairRounds,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: pendingSubphases,
      processed_subphases: [],
    };
  }

  const state = await loadOrInitializeState({
    statePath,
    codename,
    phase,
    tasklistPath,
    maxRepairRounds,
    parsedSubphases,
    shouldResume,
  });

  const processedSubphases: string[] = [];

  for (const subphase of parsedSubphases) {
    const entry = state.subphases[subphase.id];
    if (!entry) {
      continue;
    }

    if (subphase.completed) {
      entry.status = "passed";
      continue;
    }

    if (entry.status === "passed") {
      continue;
    }

    state.status = "running";
    state.currentSubphase = subphase.id;
    entry.status = "in_progress";
    state.updatedAt = new Date().toISOString();
    await persistState(statePath, state);

    const implementRun = await runtime.runCommand({
      title: buildSessionTitle("implement", codename, subphase.id),
      command: "implement",
      arguments: `${codename} ${subphase.id}`,
      agent: "minion",
    });

    const implementMarker = parseImplementMarker(implementRun.outputText);
    const implementStatus = normalizeImplementStatus(implementMarker.payload?.status);
    recordStep(entry, {
      at: new Date().toISOString(),
      action: "implement",
      sessionID: implementRun.sessionID,
      command: "implement",
      arguments: `${codename} ${subphase.id}`,
      markerFound: implementMarker.markerFound,
      status: implementStatus ?? "invalid",
      note: implementMarker.error,
    });
    state.updatedAt = new Date().toISOString();
    await persistState(statePath, state);

    if (implementStatus !== "ok") {
      entry.status = "failed";
      state.status = "failed";
      state.failureReason = `Implementation failed for SUBPHASE-${subphase.id}. ${markerFailureHint("CYCLE_IMPLEMENT_RESULT", implementMarker)}`;
      state.updatedAt = new Date().toISOString();
      await persistState(statePath, state);
      return buildFailureResult(state, statePath, pendingSubphases, processedSubphases, dryRun, maxRepairRounds);
    }

    while (true) {
      const reviewRun = await runtime.runCommand({
        title: buildSessionTitle("creview", codename, subphase.id),
        command: "creview",
        arguments: `${codename} ${subphase.id}`,
        agent: "reviewer",
      });

      const reviewMarker = parseReviewMarker(reviewRun.outputText);
      const reviewStatus = normalizeReviewStatus(reviewMarker.payload?.status);
      recordStep(entry, {
        at: new Date().toISOString(),
        action: "review",
        sessionID: reviewRun.sessionID,
        command: "creview",
        arguments: `${codename} ${subphase.id}`,
        markerFound: reviewMarker.markerFound,
        status: reviewStatus ?? "invalid",
        note: reviewMarker.error,
      });
      state.updatedAt = new Date().toISOString();
      await persistState(statePath, state);

      if (reviewStatus === "pass") {
        entry.status = "passed";
        processedSubphases.push(subphase.id);
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        break;
      }

      if (!reviewStatus) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = `Review output for SUBPHASE-${subphase.id} is missing a valid cycle verdict. ${markerFailureHint("CYCLE_CREVIEW_RESULT", reviewMarker)}`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, pendingSubphases, processedSubphases, dryRun, maxRepairRounds);
      }

      if (entry.repairRounds >= maxRepairRounds) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = `SUBPHASE-${subphase.id} exceeded max_repair_rounds=${maxRepairRounds}. Last review status: ${reviewStatus}.`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, pendingSubphases, processedSubphases, dryRun, maxRepairRounds);
      }

      const reviewArtifactPath = resolve(
        worktreeRoot,
        ...REVIEW_ARTIFACT_DIRECTORY,
        `${codename}-phase-${phase}-subphase-${sanitizePathSegment(subphase.id)}-round-${entry.repairRounds + 1}.json`,
      );
      await persistReviewArtifact(reviewArtifactPath, {
        codename,
        phase,
        subphase: subphase.id,
        review_status: reviewStatus,
        marker: reviewMarker.payload,
        output_excerpt: reviewRun.outputText.slice(0, 4000),
        created_at: new Date().toISOString(),
      });

      const repairArtifactArg = relative(worktreeRoot, reviewArtifactPath).replace(/\\/g, "/");
      const repairRun = await runtime.runCommand({
        title: buildSessionTitle("repair", codename, subphase.id),
        command: "repair",
        arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
        agent: "minion",
      });

      const repairMarker = parseRepairMarker(repairRun.outputText);
      const repairStatus = normalizeImplementStatus(repairMarker.payload?.status);
      recordStep(entry, {
        at: new Date().toISOString(),
        action: "repair",
        sessionID: repairRun.sessionID,
        command: "repair",
        arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
        markerFound: repairMarker.markerFound,
        status: repairStatus ?? "invalid",
        note: repairMarker.error,
      });
      state.updatedAt = new Date().toISOString();
      await persistState(statePath, state);

      if (repairStatus !== "ok") {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = `Repair failed for SUBPHASE-${subphase.id}. ${markerFailureHint("CYCLE_REPAIR_RESULT", repairMarker)}`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, pendingSubphases, processedSubphases, dryRun, maxRepairRounds);
      }

      entry.repairRounds += 1;
    }
  }

  state.status = "completed";
  state.currentSubphase = undefined;
  state.failureReason = undefined;
  state.updatedAt = new Date().toISOString();
  await persistState(statePath, state);

  return {
    ok: true,
    codename,
    phase,
    status: "completed",
    dry_run: false,
    max_repair_rounds: maxRepairRounds,
    tasklist_path: tasklistPath,
    state_path: statePath,
    subphases: pendingSubphases,
    processed_subphases: processedSubphases,
  };
}

function createSdkRuntime(context: CycleRunnerContext): CycleRuntime {
  const client = createOpencodeClient({
    baseUrl: DEFAULT_SERVER_URL,
    directory: context.directory,
  });

  return {
    async runCommand(input: RuntimeCommandInput): Promise<RuntimeCommandResult> {
      let sessionID: string | null = null;

      try {
        const created = await client.session.create({
          body: {
            title: input.title,
          },
          query: {
            directory: context.worktree,
          },
        });

        const createdSession = created.data as { id?: unknown } | undefined;
        if (!createdSession || typeof createdSession.id !== "string" || createdSession.id.trim().length === 0) {
          throw new Error("Failed to create execution session for cycle runner.");
        }
        sessionID = createdSession.id;

        const commandResponse = await client.session.command({
          path: { id: sessionID },
          body: {
            command: input.command,
            arguments: input.arguments,
            agent: input.agent,
          },
          query: {
            directory: context.worktree,
          },
        });

        return {
          sessionID,
          outputText: collectTextParts(commandResponse.data),
        };
      } finally {
        if (sessionID) {
          await client.session
            .delete({
              path: { id: sessionID },
              query: {
                directory: context.worktree,
              },
            })
            .catch(() => undefined);
        }
      }
    },
  };
}

function collectTextParts(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidate = payload as { parts?: unknown };
  if (!Array.isArray(candidate.parts)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of candidate.parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
    }
  }

  return textParts.join("\n").trim();
}

function sanitizeCodename(value: string): string {
  return value.trim();
}

function normalizePhaseSelector(raw: string): string | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  const directPhase = input.match(/^(?:PHASE-)?(\d+)$/i);
  if (directPhase && directPhase[1]) {
    return directPhase[1];
  }

  const subphasePattern = input.match(/^(?:SUBPHASE-)?(\d+)\.[0-9A-Za-z]+$/i);
  if (subphasePattern && subphasePattern[1]) {
    return subphasePattern[1];
  }

  return null;
}

function parseSubphasesForPhase(tasklistRaw: string, phase: string): ParsedSubphase[] {
  const lines = tasklistRaw.split("\n");
  const phaseRange = resolvePhaseRange(lines, phase);
  if (!phaseRange) {
    return [];
  }

  const subphaseMarkers: Array<{ id: string; markerIndex: number }> = [];
  for (let index = phaseRange.startIndex; index <= phaseRange.endIndex; index += 1) {
    const markerMatch = (lines[index] ?? "").match(/^\s*<!--\s*SUBPHASE:([0-9]+(?:\.[0-9A-Za-z]+)+)\s*-->\s*$/i);
    if (markerMatch && markerMatch[1]) {
      subphaseMarkers.push({
        id: markerMatch[1],
        markerIndex: index,
      });
    }
  }

  const parsed: ParsedSubphase[] = [];
  for (let index = 0; index < subphaseMarkers.length; index += 1) {
    const current = subphaseMarkers[index];
    const next = subphaseMarkers[index + 1];
    const contentStart = current.markerIndex + 1;
    const contentEnd = next ? next.markerIndex - 1 : phaseRange.endIndex;
    const { taskRefs, completed } = parseTaskCompletion(lines, contentStart, contentEnd);
    parsed.push({
      id: current.id,
      taskRefs,
      completed,
    });
  }

  return parsed;
}

function resolvePhaseRange(lines: string[], phase: string): { startIndex: number; endIndex: number } | null {
  const markers: Array<{ phase: string; index: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(/^\s*<!--\s*PHASE:(\d+)\s*-->\s*$/i);
    if (match && match[1]) {
      markers.push({
        phase: match[1],
        index,
      });
    }
  }

  const target = markers.find((entry) => entry.phase === phase);
  if (!target) {
    return null;
  }

  const targetPosition = markers.findIndex((entry) => entry.index === target.index);
  const next = targetPosition >= 0 ? markers[targetPosition + 1] : undefined;

  return {
    startIndex: target.index + 1,
    endIndex: next ? next.index - 1 : lines.length - 1,
  };
}

function parseTaskCompletion(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { taskRefs: string[]; completed: boolean } {
  const taskRefs: string[] = [];
  const completionFlags: boolean[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^\s*-\s*(?:\[(x|X| )\]\s*)?\*\*(T-\d+(?:\.[0-9A-Za-z]+)+)\*\*/);
    if (!match || !match[2]) {
      continue;
    }

    taskRefs.push(match[2].toUpperCase());
    completionFlags.push(match[1] === "x" || match[1] === "X");
  }

  return {
    taskRefs,
    completed: taskRefs.length > 0 && completionFlags.every((flag) => flag),
  };
}

async function loadOrInitializeState(input: {
  statePath: string;
  codename: string;
  phase: string;
  tasklistPath: string;
  maxRepairRounds: number;
  parsedSubphases: ParsedSubphase[];
  shouldResume: boolean;
}): Promise<PersistedCycleState> {
  const now = new Date().toISOString();

  let state: PersistedCycleState | null = null;
  if (input.shouldResume) {
    try {
      const raw = await readFile(input.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedCycleState>;
      if (
        parsed.version === 1 &&
        parsed.codename === input.codename &&
        parsed.phase === input.phase &&
        typeof parsed.startedAt === "string" &&
        parsed.subphases &&
        typeof parsed.subphases === "object"
      ) {
        state = {
          version: 1,
          codename: input.codename,
          phase: input.phase,
          tasklistPath: input.tasklistPath,
          maxRepairRounds: input.maxRepairRounds,
          status: parsed.status === "completed" || parsed.status === "failed" ? parsed.status : "running",
          startedAt: parsed.startedAt,
          updatedAt: now,
          currentSubphase: typeof parsed.currentSubphase === "string" ? parsed.currentSubphase : undefined,
          subphases: sanitizeSubphaseStateMap(parsed.subphases),
          failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : undefined,
        };
      }
    } catch {
      state = null;
    }
  }

  if (!state) {
    state = {
      version: 1,
      codename: input.codename,
      phase: input.phase,
      tasklistPath: input.tasklistPath,
      maxRepairRounds: input.maxRepairRounds,
      status: "running",
      startedAt: now,
      updatedAt: now,
      subphases: {},
    };
  }

  for (const subphase of input.parsedSubphases) {
    const existing = state.subphases[subphase.id];
    if (!existing) {
      state.subphases[subphase.id] = {
        status: subphase.completed ? "passed" : "pending",
        repairRounds: 0,
        taskRefs: subphase.taskRefs,
        history: [],
      };
      continue;
    }

    existing.taskRefs = subphase.taskRefs;
    if (subphase.completed) {
      existing.status = "passed";
    }
  }

  state.updatedAt = now;
  await persistState(input.statePath, state);
  return state;
}

function sanitizeSubphaseStateMap(raw: unknown): Record<string, SubphaseState> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const result: Record<string, SubphaseState> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const typed = value as Partial<SubphaseState>;
    result[key] = {
      status: normalizeSubphaseStatus(typed.status),
      repairRounds: typeof typed.repairRounds === "number" && typed.repairRounds >= 0 ? typed.repairRounds : 0,
      taskRefs: Array.isArray(typed.taskRefs)
        ? typed.taskRefs.filter((taskRef): taskRef is string => typeof taskRef === "string")
        : [],
      history: Array.isArray(typed.history)
        ? typed.history
            .filter((entry): entry is CycleStepEvent => {
              if (!entry || typeof entry !== "object") {
                return false;
              }

              const candidate = entry as Partial<CycleStepEvent>;
              return (
                typeof candidate.at === "string" &&
                (candidate.action === "implement" || candidate.action === "review" || candidate.action === "repair") &&
                typeof candidate.sessionID === "string" &&
                typeof candidate.command === "string" &&
                typeof candidate.arguments === "string" &&
                typeof candidate.markerFound === "boolean" &&
                typeof candidate.status === "string"
              );
            })
            .map((entry) => entry)
        : [],
    };
  }

  return result;
}

function normalizeSubphaseStatus(value: unknown): SubphaseRuntimeStatus {
  if (value === "pending" || value === "in_progress" || value === "passed" || value === "failed") {
    return value;
  }

  return "pending";
}

async function persistState(statePath: string, state: PersistedCycleState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function persistReviewArtifact(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function parseImplementMarker(rawOutput: string): ParsedMarker<ImplementMarkerPayload> {
  return parseMarkerComment<ImplementMarkerPayload>(rawOutput, "CYCLE_IMPLEMENT_RESULT");
}

function parseReviewMarker(rawOutput: string): ParsedMarker<ReviewMarkerPayload> {
  const marker = parseMarkerComment<ReviewMarkerPayload>(rawOutput, "CYCLE_CREVIEW_RESULT");
  if (marker.markerFound) {
    return marker;
  }

  const fallback = parseReviewFallback(rawOutput);
  if (!fallback) {
    return marker;
  }

  return {
    markerFound: true,
    payload: {
      status: fallback.verdict?.status ? String(fallback.verdict.status) : undefined,
    },
    error: "Used fallback parser from JSON appendix because cycle marker was not found.",
  };
}

function parseRepairMarker(rawOutput: string): ParsedMarker<RepairMarkerPayload> {
  return parseMarkerComment<RepairMarkerPayload>(rawOutput, "CYCLE_REPAIR_RESULT");
}

function parseReviewFallback(rawOutput: string): ReviewFallbackPayload | null {
  const codeBlocks = [...rawOutput.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let index = codeBlocks.length - 1; index >= 0; index -= 1) {
    const candidate = codeBlocks[index]?.[1];
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as ReviewFallbackPayload;
      if (parsed && parsed.verdict && typeof parsed.verdict === "object") {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function parseMarkerComment<T>(rawOutput: string, marker: string): ParsedMarker<T> {
  const regex = new RegExp(`<!--\\s*${marker}\\s*([\\s\\S]*?)-->`, "i");
  const match = rawOutput.match(regex);
  if (!match || !match[1]) {
    return {
      markerFound: false,
      error: `${marker} marker not found.`,
    };
  }

  const payloadRaw = stripCodeFence(match[1].trim());
  try {
    const parsed = JSON.parse(payloadRaw) as T;
    return {
      markerFound: true,
      payload: parsed,
    };
  } catch (error) {
    return {
      markerFound: true,
      error: `${marker} marker JSON is invalid: ${formatUnknownError(error)}`,
    };
  }
}

function stripCodeFence(raw: string): string {
  const withoutStart = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  return withoutStart.replace(/```\s*$/i, "").trim();
}

function normalizeImplementStatus(value: unknown): ImplementStatus | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "ok" || normalized === "blocked" || normalized === "failed") {
    return normalized;
  }

  return null;
}

function normalizeReviewStatus(value: unknown): ReviewStatus | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "pass" || normalized === "pass-with-followups" || normalized === "fail") {
    return normalized;
  }

  return null;
}

function recordStep(state: SubphaseState, event: CycleStepEvent): void {
  state.history.push(event);
}

function markerFailureHint(marker: string, parsed: ParsedMarker<unknown>): string {
  if (!parsed.markerFound) {
    return `${marker} marker missing from command output.`;
  }

  if (parsed.error) {
    return parsed.error;
  }

  return `${marker} marker did not provide a valid status.`;
}

function buildFailureResult(
  state: PersistedCycleState,
  statePath: string,
  pendingSubphases: string[],
  processedSubphases: string[],
  dryRun: boolean,
  maxRepairRounds: number,
): CycleRunResult {
  return {
    ok: false,
    codename: state.codename,
    phase: state.phase,
    status: "failed",
    dry_run: dryRun,
    max_repair_rounds: maxRepairRounds,
    tasklist_path: state.tasklistPath,
    state_path: statePath,
    subphases: pendingSubphases,
    processed_subphases: processedSubphases,
    failure_reason: state.failureReason,
  };
}

function buildSessionTitle(action: "implement" | "creview" | "repair", codename: string, subphase: string): string {
  return `cycle-${action}-${sanitizePathSegment(codename)}-${sanitizePathSegment(subphase)}`;
}

function sanitizePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown error";
}

export const __cycleRunnerTestUtils = {
  normalizePhaseSelector,
  parseSubphasesForPhase,
  parseMarkerComment,
  parseReviewFallback,
};

export default cycle_runner;
