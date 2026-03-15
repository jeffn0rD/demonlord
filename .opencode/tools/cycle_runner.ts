import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";
import { spawn } from "child_process";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, relative, resolve } from "path";

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
const STATE_DIRECTORY = ["_bmad-output", "cycle-state"] as const;
const REVIEW_ARTIFACT_DIRECTORY = ["_bmad-output", "cycle-state", "reviews"] as const;
const EVENT_ARTIFACT_DIRECTORY = ["_bmad-output", "cycle-state", "events"] as const;
const SKILLS_TEST_COMMAND = ["npm", "--prefix", ".opencode", "run", "skills:test"] as const;
const SKILLS_TEST_TIMEOUT_MS = 180000;
const MESSAGE_POLL_ATTEMPTS = 5;

const DEFAULT_AGENT_MODEL_BY_COMMAND: Record<CommandAgent, string> = {
  orchestrator: "openrouter/xiaomi/mimo-v2-flash",
  minion: "openrouter/openai/gpt-5.3-codex",
  reviewer: "openrouter/openai/gpt-5.3-codex",
};

type CommandAgent = "orchestrator" | "minion" | "reviewer";
type ImplementStatus = "ok" | "blocked" | "failed";
type ReviewStatus = "pass" | "pass-with-followups" | "fail";
type SubphaseRuntimeStatus = "pending" | "in_progress" | "passed" | "failed";
type CycleStatus = "running" | "completed" | "failed";

interface CycleRunnerArgs {
  codename: string;
  phase: string;
  max_repair_rounds?: number;
  max_subphases?: number;
  dry_run?: boolean;
  resume?: boolean;
  run_skill_selfcheck?: boolean;
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
  model?: string;
}

interface RuntimeCommandResult {
  sessionID: string;
  outputText: string;
}

interface CycleEventEntry {
  at: string;
  codename: string;
  phase: string;
  subphase?: string;
  event: "command_start" | "command_result" | "command_error" | "state_update";
  command?: string;
  agent?: CommandAgent;
  arguments?: string;
  model?: string;
  sessionID?: string;
  status?: string;
  note?: string;
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
  status: "dry_run" | "completed" | "partial" | "failed";
  dry_run: boolean;
  max_repair_rounds: number;
  max_subphases?: number;
  tasklist_path: string;
  state_path: string;
  subphases: string[];
  processed_subphases: string[];
  remaining_subphases?: string[];
  failure_reason?: string;
  skill_selfcheck?: SkillSelfCheckSummary;
}

type SkillSelfCheckStatus = "passed" | "failed" | "skipped";

interface SkillSelfCheckSummary {
  enabled: boolean;
  command: string;
  pre: SkillSelfCheckStatus;
  post: SkillSelfCheckStatus;
  note?: string;
}

interface SkillSelfCheckExecution {
  status: SkillSelfCheckStatus;
  note?: string;
}

interface SpawnCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

interface CommandStatusFallbackPayload {
  status?: unknown;
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
    max_subphases: tool.schema
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Optional limit for number of pending subphases to process in this run."),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("When true, only report planned subphases without executing commands."),
    resume: tool.schema
      .boolean()
      .optional()
      .describe("When true (default), resume from existing cycle-state file if present."),
    run_skill_selfcheck: tool.schema
      .boolean()
      .optional()
      .describe("When true (default), run non-destructive skills:test before and after cycle execution."),
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
  const dryRun = args.dry_run ?? false;
  const runSkillSelfcheck = args.run_skill_selfcheck ?? true;
  const skillSelfCheck = initializeSkillSelfCheckSummary(runSkillSelfcheck, dryRun);
  const phase = normalizePhaseSelector(args.phase);
  if (!phase) {
    return {
      ok: false,
      codename,
      phase: String(args.phase ?? ""),
      status: "failed",
      dry_run: dryRun,
      max_repair_rounds: args.max_repair_rounds ?? 2,
      max_subphases: args.max_subphases,
      tasklist_path: resolve(worktreeRoot, "agents", `${codename}_Tasklist.md`),
      state_path: resolve(worktreeRoot, ...STATE_DIRECTORY, `${codename}-phase-unknown.json`),
      subphases: [],
      processed_subphases: [],
      failure_reason: "Invalid phase selector. Use values like '1', 'PHASE-1', or 'SUBPHASE-1.2'.",
      skill_selfcheck: skillSelfCheck,
    };
  }

  const tasklistPath = resolve(worktreeRoot, "agents", `${codename}_Tasklist.md`);
  const statePath = resolve(worktreeRoot, ...STATE_DIRECTORY, `${codename}-phase-${phase}.json`);
  const eventPath = resolve(worktreeRoot, ...EVENT_ARTIFACT_DIRECTORY, `${codename}-phase-${phase}.ndjson`);
  const maxRepairRounds = args.max_repair_rounds ?? 2;
  const maxSubphases = args.max_subphases;
  const subphaseLimit = typeof maxSubphases === "number" ? maxSubphases : Number.POSITIVE_INFINITY;
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
      max_subphases: maxSubphases,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: [],
      processed_subphases: [],
      failure_reason: `Tasklist not found or unreadable: ${tasklistPath}`,
      skill_selfcheck: skillSelfCheck,
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
      max_subphases: maxSubphases,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: [],
      processed_subphases: [],
      failure_reason: `No subphases found for PHASE-${phase} in ${tasklistPath}`,
      skill_selfcheck: skillSelfCheck,
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
      max_subphases: maxSubphases,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: pendingSubphases,
      processed_subphases: [],
      skill_selfcheck: skillSelfCheck,
    };
  }

  if (runSkillSelfcheck) {
    const preCheck = await runSkillsSelfCheck(worktreeRoot);
    skillSelfCheck.pre = preCheck.status;
    if (preCheck.note) {
      skillSelfCheck.note = preCheck.note;
    }

    if (preCheck.status === "failed") {
      return {
        ok: false,
        codename,
        phase,
        status: "failed",
        dry_run: dryRun,
        max_repair_rounds: maxRepairRounds,
        max_subphases: maxSubphases,
        tasklist_path: tasklistPath,
        state_path: statePath,
        subphases: pendingSubphases,
        processed_subphases: [],
        failure_reason: `Pre-cycle skills self-check failed. ${preCheck.note ?? "Run npm --prefix .opencode run skills:test for details."}`,
        skill_selfcheck: skillSelfCheck,
      };
    }
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

  const trackedSubphases = collectTrackedPendingSubphases(parsedSubphases, state);

  const processedSubphases: string[] = [];
  let attemptedSubphases = 0;

  for (const subphase of parsedSubphases) {
    const entry = state.subphases[subphase.id];
    if (!entry) {
      continue;
    }

    if (shouldBootstrapTasklistCompletedSubphase(subphase, entry)) {
      entry.status = "passed";
      state.updatedAt = new Date().toISOString();
      await persistState(statePath, state);
      continue;
    }

    if (entry.status === "passed") {
      continue;
    }

    if (attemptedSubphases >= subphaseLimit) {
      break;
    }
    attemptedSubphases += 1;

    state.status = "running";
    state.currentSubphase = subphase.id;
    entry.status = "in_progress";
    state.updatedAt = new Date().toISOString();
    await persistState(statePath, state);

    await appendCycleEvent(eventPath, {
      at: new Date().toISOString(),
      codename,
      phase,
      subphase: subphase.id,
      event: "state_update",
      status: "in_progress",
      note: "Beginning subphase execution.",
    });

    const latestImplementStep = findLatestStep(entry, "implement");
    if (latestImplementStep?.status !== "ok") {
      let implementRun: RuntimeCommandResult;
      const implementModel = resolveModelForAgent("minion");
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_start",
        command: "implement",
        agent: "minion",
        arguments: `${codename} ${subphase.id}`,
        model: implementModel,
      });

      try {
        implementRun = await runtime.runCommand({
          title: buildSessionTitle("implement", codename, subphase.id),
          command: "implement",
          arguments: `${codename} ${subphase.id}`,
          agent: "minion",
          model: implementModel,
        });
      } catch (error) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = buildRuntimeFailureReason("implement", subphase.id, error);
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        await appendCycleEvent(eventPath, {
          at: new Date().toISOString(),
          codename,
          phase,
          subphase: subphase.id,
          event: "command_error",
          command: "implement",
          agent: "minion",
          arguments: `${codename} ${subphase.id}`,
          model: implementModel,
          status: "failed",
          note: formatUnknownError(error),
        });
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }

      const implementMarker = parseImplementMarker(implementRun.outputText);
      const implementStatus = normalizeImplementStatus(implementMarker.payload?.status);
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_result",
        command: "implement",
        agent: "minion",
        arguments: `${codename} ${subphase.id}`,
        model: implementModel,
        sessionID: implementRun.sessionID,
        status: implementStatus ?? "invalid",
        note: detectInfrastructureIssue(implementRun.outputText) ?? implementMarker.error,
      });

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
        const infraHint = detectInfrastructureIssue(implementRun.outputText);
        state.failureReason = infraHint
          ? `Implementation failed for SUBPHASE-${subphase.id}. Infrastructure signal: ${infraHint}. ${markerFailureHint("CYCLE_IMPLEMENT_RESULT", implementMarker)}`
          : `Implementation failed for SUBPHASE-${subphase.id}. ${markerFailureHint("CYCLE_IMPLEMENT_RESULT", implementMarker)}`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }
    } else {
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "state_update",
        status: "in_progress",
        note: "Resuming subphase from review stage; prior implement command already succeeded.",
      });
    }

    while (true) {
      let reviewRun: RuntimeCommandResult;
      const reviewModel = resolveModelForAgent("reviewer");
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_start",
        command: "creview",
        agent: "reviewer",
        arguments: `${codename} ${subphase.id}`,
        model: reviewModel,
      });

      try {
        reviewRun = await runtime.runCommand({
          title: buildSessionTitle("creview", codename, subphase.id),
          command: "creview",
          arguments: `${codename} ${subphase.id}`,
          agent: "reviewer",
          model: reviewModel,
        });
      } catch (error) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = buildRuntimeFailureReason("creview", subphase.id, error);
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        await appendCycleEvent(eventPath, {
          at: new Date().toISOString(),
          codename,
          phase,
          subphase: subphase.id,
          event: "command_error",
          command: "creview",
          agent: "reviewer",
          arguments: `${codename} ${subphase.id}`,
          model: reviewModel,
          status: "failed",
          note: formatUnknownError(error),
        });
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }

      const reviewMarker = parseReviewMarker(reviewRun.outputText);
      const reviewStatus = normalizeReviewStatus(reviewMarker.payload?.status);
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_result",
        command: "creview",
        agent: "reviewer",
        arguments: `${codename} ${subphase.id}`,
        model: reviewModel,
        sessionID: reviewRun.sessionID,
        status: reviewStatus ?? "invalid",
        note: detectInfrastructureIssue(reviewRun.outputText) ?? reviewMarker.error,
      });

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
        const infraHint = detectInfrastructureIssue(reviewRun.outputText);
        state.failureReason = infraHint
          ? `Review failed for SUBPHASE-${subphase.id}. Infrastructure signal: ${infraHint}. ${markerFailureHint("CYCLE_CREVIEW_RESULT", reviewMarker)}`
          : `Review output for SUBPHASE-${subphase.id} is missing a valid cycle verdict. ${markerFailureHint("CYCLE_CREVIEW_RESULT", reviewMarker)}`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }

      if (entry.repairRounds >= maxRepairRounds) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = `SUBPHASE-${subphase.id} exceeded max_repair_rounds=${maxRepairRounds}. Last review status: ${reviewStatus}.`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
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
      let repairRun: RuntimeCommandResult;
      const repairModel = resolveModelForAgent("minion");
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_start",
        command: "repair",
        agent: "minion",
        arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
        model: repairModel,
      });

      try {
        repairRun = await runtime.runCommand({
          title: buildSessionTitle("repair", codename, subphase.id),
          command: "repair",
          arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
          agent: "minion",
          model: repairModel,
        });
      } catch (error) {
        entry.status = "failed";
        state.status = "failed";
        state.failureReason = buildRuntimeFailureReason("repair", subphase.id, error);
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        await appendCycleEvent(eventPath, {
          at: new Date().toISOString(),
          codename,
          phase,
          subphase: subphase.id,
          event: "command_error",
          command: "repair",
          agent: "minion",
          arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
          model: repairModel,
          status: "failed",
          note: formatUnknownError(error),
        });
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }

      const repairMarker = parseRepairMarker(repairRun.outputText);
      const repairStatus = normalizeImplementStatus(repairMarker.payload?.status);
      await appendCycleEvent(eventPath, {
        at: new Date().toISOString(),
        codename,
        phase,
        subphase: subphase.id,
        event: "command_result",
        command: "repair",
        agent: "minion",
        arguments: `${codename} ${subphase.id} ${repairArtifactArg}`,
        model: repairModel,
        sessionID: repairRun.sessionID,
        status: repairStatus ?? "invalid",
        note: detectInfrastructureIssue(repairRun.outputText) ?? repairMarker.error,
      });

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
        const infraHint = detectInfrastructureIssue(repairRun.outputText);
        state.failureReason = infraHint
          ? `Repair failed for SUBPHASE-${subphase.id}. Infrastructure signal: ${infraHint}. ${markerFailureHint("CYCLE_REPAIR_RESULT", repairMarker)}`
          : `Repair failed for SUBPHASE-${subphase.id}. ${markerFailureHint("CYCLE_REPAIR_RESULT", repairMarker)}`;
        state.updatedAt = new Date().toISOString();
        await persistState(statePath, state);
        return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
      }

      entry.repairRounds += 1;
    }
  }

  const remainingSubphases = collectTrackedPendingSubphases(parsedSubphases, state);

  if (runSkillSelfcheck) {
    const postCheck = await runSkillsSelfCheck(worktreeRoot);
    skillSelfCheck.post = postCheck.status;
    if (postCheck.note) {
      skillSelfCheck.note = postCheck.note;
    }

    if (postCheck.status === "failed") {
      state.status = "failed";
      state.failureReason = `Post-cycle skills self-check failed. ${postCheck.note ?? "Run npm --prefix .opencode run skills:test for details."}`;
      state.updatedAt = new Date().toISOString();
      await persistState(statePath, state);
      return buildFailureResult(state, statePath, trackedSubphases, processedSubphases, dryRun, maxRepairRounds, skillSelfCheck);
    }
  }

  if (remainingSubphases.length > 0) {
    state.status = "running";
    state.currentSubphase = undefined;
    state.failureReason = undefined;
    state.updatedAt = new Date().toISOString();
    await persistState(statePath, state);

    return {
      ok: true,
      codename,
      phase,
      status: "partial",
      dry_run: false,
      max_repair_rounds: maxRepairRounds,
      max_subphases: maxSubphases,
      tasklist_path: tasklistPath,
      state_path: statePath,
      subphases: trackedSubphases,
      processed_subphases: processedSubphases,
      remaining_subphases: remainingSubphases,
      skill_selfcheck: skillSelfCheck,
    };
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
    max_subphases: maxSubphases,
    tasklist_path: tasklistPath,
    state_path: statePath,
    subphases: trackedSubphases,
    processed_subphases: processedSubphases,
    skill_selfcheck: skillSelfCheck,
  };
}

function createSdkRuntime(context: CycleRunnerContext): CycleRuntime {
  const client = createOpencodeClient({
    baseUrl: DEFAULT_SERVER_URL,
    directory: context.directory,
  });
  const sessionApi = client.session as {
    messages?: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<{ data: unknown }>;
    delete?: (input: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<unknown>;
  };

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
            model: input.model,
          },
          query: {
            directory: context.worktree,
          },
        });

        const commandOutput = collectTextParts(commandResponse.data);
        if (containsCycleMarker(commandOutput)) {
          return {
            sessionID,
            outputText: commandOutput,
          };
        }

        if (typeof sessionApi.messages !== "function") {
          return {
            sessionID,
            outputText: commandOutput,
          };
        }

        let latestMessageOutput = "";
        for (let attempt = 1; attempt <= MESSAGE_POLL_ATTEMPTS; attempt += 1) {
          const messageResponse = await sessionApi.messages({
            path: { id: sessionID },
            query: {
              directory: context.worktree,
            },
          });

          const candidateOutput = collectLatestMessageText(messageResponse.data);
          if (candidateOutput.length > 0) {
            latestMessageOutput = candidateOutput;
            const mergedOutput = [commandOutput, latestMessageOutput].filter((value) => value.length > 0).join("\n").trim();
            if (containsCycleMarker(mergedOutput)) {
              return {
                sessionID,
                outputText: mergedOutput,
              };
            }
          }

          if (attempt < MESSAGE_POLL_ATTEMPTS) {
            await delay(attempt * 100);
          }
        }

        return {
          sessionID,
          outputText:
            latestMessageOutput.length > 0
              ? [commandOutput, latestMessageOutput].filter((value) => value.length > 0).join("\n").trim()
              : commandOutput,
        };
      } finally {
        if (sessionID && typeof sessionApi.delete === "function") {
          await sessionApi
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

function collectLatestMessageText(payload: unknown): string {
  if (!Array.isArray(payload)) {
    return "";
  }

  for (let index = payload.length - 1; index >= 0; index -= 1) {
    const text = collectTextParts(payload[index]);
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function containsCycleMarker(text: string): boolean {
  return /<!--\s*CYCLE_[A-Z0-9_]+_RESULT[\s\S]*?-->/i.test(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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
  }

  reconcileStateWithTasklist(state, input.parsedSubphases);

  state.updatedAt = now;
  await persistState(input.statePath, state);
  return state;
}

function reconcileStateWithTasklist(state: PersistedCycleState, parsedSubphases: ParsedSubphase[]): void {
  const isSubphasePassed = (subphaseID: string): boolean => {
    const entry = state.subphases[subphaseID];
    if (!entry) {
      return false;
    }

    return entry.status === "passed";
  };

  if (state.currentSubphase && isSubphasePassed(state.currentSubphase)) {
    state.currentSubphase = undefined;
  }

  if (state.failureReason) {
    const failedSubphase = extractFailureSubphase(state.failureReason);
    if (failedSubphase && isSubphasePassed(failedSubphase)) {
      state.failureReason = undefined;
    }
  }

  const pendingExists = parsedSubphases.some((subphase) => {
    const entry = state.subphases[subphase.id];
    return !entry || entry.status !== "passed";
  });

  if (state.status === "failed" && !state.failureReason) {
    state.status = pendingExists ? "running" : "completed";
  }

  if (!pendingExists && state.status !== "failed") {
    state.status = "completed";
  }
}

function extractFailureSubphase(reason: string): string | null {
  const match = reason.match(/SUBPHASE-([0-9]+(?:\.[0-9A-Za-z]+)+)/i);
  return match && match[1] ? match[1] : null;
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

async function appendCycleEvent(path: string, entry: CycleEventEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

function resolveModelForAgent(agent: CommandAgent): string {
  if (agent === "orchestrator") {
    return process.env.OPENCODE_MODEL_ORCHESTRATOR ?? DEFAULT_AGENT_MODEL_BY_COMMAND.orchestrator;
  }

  if (agent === "reviewer") {
    return process.env.OPENCODE_MODEL_REVIEWER ?? DEFAULT_AGENT_MODEL_BY_COMMAND.reviewer;
  }

  return process.env.OPENCODE_MODEL_MINION ?? DEFAULT_AGENT_MODEL_BY_COMMAND.minion;
}

function buildRuntimeFailureReason(action: "implement" | "creview" | "repair", subphase: string, error: unknown): string {
  return [
    `Cycle runtime failure during ${action} for SUBPHASE-${subphase}.`,
    `Error: ${formatUnknownError(error)}.`,
    "This usually indicates external session interruption/deletion or a transient OpenCode backend issue.",
  ].join(" ");
}

function detectInfrastructureIssue(outputText: string): string | null {
  if (!outputText) {
    return null;
  }

  if (/FOREIGN KEY constraint failed/i.test(outputText)) {
    return "sqlite foreign-key violation";
  }

  if (/NotFoundError/i.test(outputText) || /session\s+not\s+found/i.test(outputText)) {
    return "session not found";
  }

  if (/Unable to connect|ECONNREFUSED|fetch failed/i.test(outputText)) {
    return "unable to connect to OpenCode server";
  }

  return null;
}

function parseImplementMarker(rawOutput: string): ParsedMarker<ImplementMarkerPayload> {
  const marker = parseMarkerComment<ImplementMarkerPayload>(rawOutput, "CYCLE_IMPLEMENT_RESULT");
  if (marker.markerFound) {
    return marker;
  }

  const fallback = parseCommandStatusFallback(rawOutput);
  if (!fallback) {
    return marker;
  }

  return {
    markerFound: true,
    payload: {
      status: fallback.status ? String(fallback.status) : undefined,
    },
    error: "Used fallback parser from JSON appendix because cycle marker was not found.",
  };
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
  const marker = parseMarkerComment<RepairMarkerPayload>(rawOutput, "CYCLE_REPAIR_RESULT");
  if (marker.markerFound) {
    return marker;
  }

  const fallback = parseCommandStatusFallback(rawOutput);
  if (!fallback) {
    return marker;
  }

  return {
    markerFound: true,
    payload: {
      status: fallback.status ? String(fallback.status) : undefined,
    },
    error: "Used fallback parser from JSON appendix because cycle marker was not found.",
  };
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

function parseCommandStatusFallback(rawOutput: string): CommandStatusFallbackPayload | null {
  const codeBlocks = [...rawOutput.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (let index = codeBlocks.length - 1; index >= 0; index -= 1) {
    const candidate = codeBlocks[index]?.[1];
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as CommandStatusFallbackPayload;
      if (parsed && typeof parsed === "object" && "status" in parsed) {
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

function shouldBootstrapTasklistCompletedSubphase(subphase: ParsedSubphase, entry: SubphaseState): boolean {
  if (!subphase.completed) {
    return false;
  }

  if (entry.status !== "pending") {
    return false;
  }

  if (entry.repairRounds > 0) {
    return false;
  }

  return entry.history.length === 0;
}

function collectTrackedPendingSubphases(parsedSubphases: ParsedSubphase[], state: PersistedCycleState): string[] {
  return parsedSubphases.filter((subphase) => state.subphases[subphase.id]?.status !== "passed").map((subphase) => subphase.id);
}

function recordStep(state: SubphaseState, event: CycleStepEvent): void {
  state.history.push(event);
}

function findLatestStep(state: SubphaseState, action: CycleStepEvent["action"]): CycleStepEvent | null {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const candidate = state.history[index];
    if (candidate?.action === action) {
      return candidate;
    }
  }

  return null;
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

function initializeSkillSelfCheckSummary(enabled: boolean, dryRun: boolean): SkillSelfCheckSummary {
  const command = SKILLS_TEST_COMMAND.join(" ");
  if (!enabled) {
    return {
      enabled: false,
      command,
      pre: "skipped",
      post: "skipped",
      note: "Disabled by run_skill_selfcheck=false.",
    };
  }

  if (dryRun) {
    return {
      enabled: true,
      command,
      pre: "skipped",
      post: "skipped",
      note: "Skipped in dry-run mode.",
    };
  }

  return {
    enabled: true,
    command,
    pre: "skipped",
    post: "skipped",
  };
}

async function runSkillsSelfCheck(worktreeRoot: string): Promise<SkillSelfCheckExecution> {
  const packagePath = resolve(worktreeRoot, ".opencode", "package.json");
  const maintenanceScriptPath = resolve(worktreeRoot, ".opencode", "scripts", "skill_docs_maintenance.mjs");

  const hasPackage = await fileExists(packagePath);
  const hasMaintenanceScript = await fileExists(maintenanceScriptPath);
  if (!hasPackage || !hasMaintenanceScript) {
    return {
      status: "skipped",
      note: "skills:test prerequisites not found (.opencode/package.json or skill_docs_maintenance.mjs missing).",
    };
  }

  const [command, ...commandArgs] = SKILLS_TEST_COMMAND;

  try {
    const result = await spawnCommandCapture(command, commandArgs, worktreeRoot, SKILLS_TEST_TIMEOUT_MS);
    if (!result.timedOut && result.exitCode === 0) {
      return { status: "passed" };
    }

    return {
      status: "failed",
      note: formatSpawnFailure(result),
    };
  } catch (error) {
    return {
      status: "failed",
      note: `Unable to execute skills self-check: ${formatUnknownError(error)}`,
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function spawnCommandCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function formatSpawnFailure(result: SpawnCommandResult): string {
  if (result.timedOut) {
    return `Command timed out after ${SKILLS_TEST_TIMEOUT_MS}ms.`;
  }

  const exitSummary = `exit code ${String(result.exitCode ?? "null")}${result.signal ? ` (signal ${result.signal})` : ""}`;
  const output = summarizeProcessOutput(result.stdout, result.stderr);
  return output.length > 0 ? `Command failed with ${exitSummary}. Output tail: ${output}` : `Command failed with ${exitSummary}.`;
}

function summarizeProcessOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter((value) => value.length > 0).join("\n");
  if (combined.length <= 700) {
    return combined;
  }

  return combined.slice(combined.length - 700);
}

function buildFailureResult(
  state: PersistedCycleState,
  statePath: string,
  pendingSubphases: string[],
  processedSubphases: string[],
  dryRun: boolean,
  maxRepairRounds: number,
  skillSelfCheck: SkillSelfCheckSummary,
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
    skill_selfcheck: skillSelfCheck,
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
  parseImplementMarker,
  parseRepairMarker,
  parseReviewFallback,
};

export default cycle_runner;
