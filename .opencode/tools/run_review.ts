import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, relative, resolve } from "path";

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";
const REVIEW_ARTIFACT_DIRECTORY = ["_bmad-output", "cycle-state", "reviews"] as const;
const REVIEW_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface RunReviewArgs {
  review: string;
  parameter_1?: string;
  parameter_2?: string;
  parameter_3?: string;
  parameter_4?: string;
  parameter_5?: string;
  hint?: string;
  phase?: string;
  dry_run?: boolean;
}

interface RunReviewContext {
  directory: string;
  worktree: string;
}

type ParseRunReviewCommandResult =
  | {
    ok: true;
    args: RunReviewArgs;
    tokens: string[];
  }
  | {
    ok: false;
    error: string;
    tokens: string[];
  };

interface RuntimeCommandInput {
  title: string;
  command: string;
  arguments: string;
  agent: "reviewer";
  model?: string;
}

interface RuntimeCommandResult {
  sessionID: string;
  outputText: string;
}

interface ReviewRuntime {
  runCommand(input: RuntimeCommandInput): Promise<RuntimeCommandResult>;
}

interface ParsedMarker<T> {
  markerFound: boolean;
  markerName?: string;
  payload?: T;
  error?: string;
}

interface MarkerPayload {
  status?: unknown;
  verdict?: {
    status?: unknown;
  };
  [key: string]: unknown;
}

interface ResolvedScope {
  review: string;
  codename?: string;
  phase?: string;
  subphase?: string;
  target?: string;
  artifactStem: string;
}

type RunReviewErrorCode =
  | "INVALID_INPUT"
  | "INVALID_REVIEW"
  | "MISSING_REQUIRED_PARAMETER"
  | "INVALID_PHASE"
  | "EXECUTION_FAILED"
  | "WRITE_FAILED";

interface RunReviewResult {
  ok: boolean;
  code?: RunReviewErrorCode;
  error?: string;
  review: string;
  command: string;
  argument_list: string[];
  argument_string: string;
  hint: string | null;
  phase: string | null;
  dry_run: boolean;
  codename?: string;
  subphase?: string;
  target?: string;
  expected_marker: string;
  marker_name?: string;
  marker_found: boolean;
  marker_error?: string;
  review_status?: string | null;
  artifact_path?: string;
  round?: number;
  output_excerpt?: string;
  session_id?: string;
}

const run_review = tool({
  description: "Run any review command, persist marker output, and return summary metadata.",
  args: {
    review: tool.schema
      .string()
      .min(1)
      .describe("Review command ID (for example: creview, mreview, phreview, or future review commands)."),
    parameter_1: tool.schema.string().optional().describe("First positional argument for the review command."),
    parameter_2: tool.schema.string().optional().describe("Second positional argument for the review command."),
    parameter_3: tool.schema.string().optional().describe("Third positional argument for the review command."),
    parameter_4: tool.schema.string().optional().describe("Fourth positional argument for the review command."),
    parameter_5: tool.schema.string().optional().describe("Fifth positional argument for the review command."),
    hint: tool.schema
      .string()
      .optional()
      .describe("Optional instruction or hint text appended as a final command argument."),
    phase: tool.schema
      .string()
      .optional()
      .describe("Optional explicit phase override (example: 1 or PHASE-1), used primarily for module review scoping."),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("When true, preview invocation, marker expectation, and artifact path without executing the review."),
  },
  async execute(args: RunReviewArgs, context: RunReviewContext) {
    const result = await executeRunReview(args, context);
    return JSON.stringify(result, null, 2);
  },
});

export async function executeRunReview(
  args: RunReviewArgs,
  context: RunReviewContext,
  runtime: ReviewRuntime = createSdkRuntime(context),
): Promise<RunReviewResult> {
  const review = normalizeReviewName(args.review);
  if (!review) {
    return {
      ok: false,
      code: "INVALID_REVIEW",
      error: "review must be a lowercase command ID (letters, digits, hyphen) ending with 'review'.",
      review: args.review,
      command: args.review,
      argument_list: [],
      argument_string: "",
      hint: normalizeOptionalText(args.hint),
      phase: normalizePhaseSelector(args.phase),
      dry_run: args.dry_run ?? false,
      expected_marker: "",
      marker_found: false,
    };
  }

  const worktreeRoot = resolve(context.worktree);
  const hint = normalizeOptionalText(args.hint);
  const argumentList = collectArgumentList(args, hint);
  const explicitPhase = normalizePhaseSelector(args.phase);
  if (args.phase && !explicitPhase) {
    return {
      ok: false,
      code: "INVALID_PHASE",
      error: `phase '${args.phase}' is invalid. Use '<n>' or 'PHASE-<n>'.`,
      review,
      command: review,
      argument_list: argumentList,
      argument_string: buildCommandArgumentString(argumentList),
      hint,
      phase: null,
      dry_run: args.dry_run ?? false,
      expected_marker: resolveExpectedMarker(review),
      marker_found: false,
    };
  }

  const resolved = await resolveScope({
    review,
    argumentList,
    explicitPhase,
    worktreeRoot,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      error: resolved.error,
      review,
      command: review,
      argument_list: argumentList,
      argument_string: buildCommandArgumentString(argumentList),
      hint,
      phase: explicitPhase,
      dry_run: args.dry_run ?? false,
      expected_marker: resolveExpectedMarker(review),
      marker_found: false,
    };
  }

  const scope = resolved.scope;
  const expectedMarker = resolveExpectedMarker(review);
  const argumentString = buildCommandArgumentString(argumentList);
  const reviewDirectory = resolve(worktreeRoot, ...REVIEW_ARTIFACT_DIRECTORY);
  const previewRound = await resolveNextRound(reviewDirectory, scope.artifactStem);
  const previewArtifactPath = resolve(reviewDirectory, `${scope.artifactStem}-round-${previewRound}.json`);
  const relativePreviewArtifactPath = relative(worktreeRoot, previewArtifactPath).replace(/\\/g, "/");
  const dryRun = args.dry_run ?? false;

  if (dryRun) {
    return {
      ok: true,
      review,
      command: review,
      argument_list: argumentList,
      argument_string: argumentString,
      hint,
      phase: scope.phase ?? null,
      codename: scope.codename,
      subphase: scope.subphase,
      target: scope.target,
      dry_run: true,
      expected_marker: expectedMarker,
      marker_found: false,
      artifact_path: relativePreviewArtifactPath,
      round: previewRound,
    };
  }

  let runResult: RuntimeCommandResult;
  try {
    runResult = await runtime.runCommand({
      title: buildSessionTitle(review, scope),
      command: review,
      arguments: argumentString,
      agent: "reviewer",
    });
  } catch (error) {
    return {
      ok: false,
      code: "EXECUTION_FAILED",
      error: formatUnknownError(error),
      review,
      command: review,
      argument_list: argumentList,
      argument_string: argumentString,
      hint,
      phase: scope.phase ?? null,
      codename: scope.codename,
      subphase: scope.subphase,
      target: scope.target,
      dry_run: false,
      expected_marker: expectedMarker,
      marker_found: false,
    };
  }

  const parsedMarker = parseReviewMarker(runResult.outputText, expectedMarker, review);
  const reviewStatus = normalizeStatus(parsedMarker.payload?.status) ?? normalizeStatus(parsedMarker.payload?.verdict?.status);
  const artifactPayload = {
    review_type: review,
    codename: scope.codename,
    phase: scope.phase,
    subphase: scope.subphase,
    target: scope.target,
    review_status: reviewStatus,
    marker_name: parsedMarker.markerName,
    marker: parsedMarker.payload,
    marker_found: parsedMarker.markerFound,
    marker_error: parsedMarker.error,
    command: review,
    argument_list: argumentList,
    argument_string: argumentString,
    output_excerpt: runResult.outputText.slice(0, 4000),
    created_at: new Date().toISOString(),
    session_id: runResult.sessionID,
  };

  let persistedArtifact: { path: string; round: number };

  try {
    persistedArtifact = await persistReviewArtifactWithRound(reviewDirectory, scope.artifactStem, artifactPayload);
  } catch (error) {
    return {
      ok: false,
      code: "WRITE_FAILED",
      error: formatUnknownError(error),
      review,
      command: review,
      argument_list: argumentList,
      argument_string: argumentString,
      hint,
      phase: scope.phase ?? null,
      codename: scope.codename,
      subphase: scope.subphase,
      target: scope.target,
      dry_run: false,
      expected_marker: expectedMarker,
      marker_name: parsedMarker.markerName,
      marker_found: parsedMarker.markerFound,
      marker_error: parsedMarker.error,
      review_status: reviewStatus,
    };
  }

  const relativeArtifactPath = relative(worktreeRoot, persistedArtifact.path).replace(/\\/g, "/");

  const markerValid = parsedMarker.markerFound && !parsedMarker.error;

  return {
    ok: markerValid,
    review,
    command: review,
    argument_list: argumentList,
    argument_string: argumentString,
    hint,
    phase: scope.phase ?? null,
    codename: scope.codename,
    subphase: scope.subphase,
    target: scope.target,
    dry_run: false,
    expected_marker: expectedMarker,
    marker_name: parsedMarker.markerName,
    marker_found: parsedMarker.markerFound,
    marker_error: parsedMarker.error,
    review_status: reviewStatus,
    artifact_path: relativeArtifactPath,
    output_excerpt: runResult.outputText.slice(0, 1200),
    session_id: runResult.sessionID,
    round: persistedArtifact.round,
    error: markerValid ? undefined : parsedMarker.error,
    code: markerValid ? undefined : "INVALID_INPUT",
  };
}

export function parseRunReviewCommandArguments(rawArguments: string): ParseRunReviewCommandResult {
  const tokens = splitCommandArguments(rawArguments);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: "missing review command. Usage: /run-review <creview|mreview|phreview|future-review> [args] [hint] [phase] [dry-run]",
      tokens,
    };
  }

  const [reviewToken, ...rest] = tokens;
  const review = reviewToken.trim().replace(/^\//, "");
  const normalizedReview = normalizeReviewName(review) ?? review.toLowerCase();
  const remaining = [...rest];

  let dryRun = false;
  const trailingToken = remaining[remaining.length - 1];
  if (trailingToken && isDryRunToken(trailingToken)) {
    dryRun = true;
    remaining.pop();
  }

  let phase: string | undefined;
  const maybePhase = remaining[remaining.length - 1];
  if (maybePhase && shouldTreatTrailingPhaseAsOverride(normalizedReview, remaining.length, maybePhase)) {
    phase = maybePhase;
    remaining.pop();
  }

  const args: RunReviewArgs = {
    review,
  };

  if (normalizedReview === "creview" || normalizedReview === "phreview") {
    assignParameter(args, 1, remaining[0]);
    assignParameter(args, 2, remaining[1]);
    const hint = normalizeOptionalText(remaining.slice(2).join(" "));
    if (hint) {
      args.hint = hint;
    }
  } else if (normalizedReview === "mreview") {
    assignParameter(args, 1, remaining[0]);
    const hint = normalizeOptionalText(remaining.slice(1).join(" "));
    if (hint) {
      args.hint = hint;
    }
  } else {
    for (let index = 0; index < 5; index += 1) {
      assignParameter(args, index + 1, remaining[index]);
    }

    const hint = normalizeOptionalText(remaining.slice(5).join(" "));
    if (hint) {
      args.hint = hint;
    }
  }

  if (phase) {
    args.phase = phase;
  }

  if (dryRun) {
    args.dry_run = true;
  }

  return {
    ok: true,
    args,
    tokens,
  };
}

function createSdkRuntime(context: RunReviewContext): ReviewRuntime {
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
          throw new Error("Failed to create review execution session.");
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

async function resolveScope(input: {
  review: string;
  argumentList: string[];
  explicitPhase: string | null;
  worktreeRoot: string;
}): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; code: RunReviewErrorCode; error: string }> {
  const review = input.review;
  const first = input.argumentList[0];
  const second = input.argumentList[1];

  if (review === "creview") {
    if (!first || !second) {
      return {
        ok: false,
        code: "MISSING_REQUIRED_PARAMETER",
        error: "creview requires codename and subphase/phase target arguments.",
      };
    }

    const phase = input.explicitPhase ?? normalizePhaseSelector(second) ?? (await resolveActivePhaseFromCodename(first, input.worktreeRoot));
    const subphase = normalizeSubphaseSelector(second) ?? second.trim();

    return {
      ok: true,
      scope: {
        review,
        codename: first,
        phase: phase ?? undefined,
        subphase,
        target: second,
        artifactStem: `${sanitizePathSegment(first)}-phase-${sanitizePathSegment(phase ?? "unknown")}-subphase-${sanitizePathSegment(subphase)}`,
      },
    };
  }

  if (review === "mreview") {
    if (!first) {
      return {
        ok: false,
        code: "MISSING_REQUIRED_PARAMETER",
        error: "mreview requires a file/module target argument.",
      };
    }

    const phase =
      input.explicitPhase ??
      (await resolveActivePhaseFromMostRecentTasklist(input.worktreeRoot)) ??
      (await resolveLatestPhaseFromArtifacts(input.worktreeRoot));

    return {
      ok: true,
      scope: {
        review,
        phase: phase ?? undefined,
        target: first,
        artifactStem: `module-phase-${sanitizePathSegment(phase ?? "unknown")}-${sanitizePathSegment(first)}`,
      },
    };
  }

  if (review === "phreview") {
    if (!first || !second) {
      return {
        ok: false,
        code: "MISSING_REQUIRED_PARAMETER",
        error: "phreview requires codename and phase arguments.",
      };
    }

    const normalizedPhase = normalizePhaseSelector(second) ?? input.explicitPhase;
    if (!normalizedPhase) {
      return {
        ok: false,
        code: "INVALID_PHASE",
        error: `phreview phase '${second}' is invalid. Use '<n>' or 'PHASE-<n>'.`,
      };
    }

    return {
      ok: true,
      scope: {
        review,
        codename: first,
        phase: normalizedPhase,
        target: `${first} ${second}`,
        artifactStem: `${sanitizePathSegment(first)}-phase-${sanitizePathSegment(normalizedPhase)}-gate`,
      },
    };
  }

  const fallbackPhase = input.explicitPhase ?? (await resolveLatestPhaseFromArtifacts(input.worktreeRoot));
  const targetLabel = input.argumentList.join("-") || "review";
  return {
    ok: true,
    scope: {
      review,
      phase: fallbackPhase ?? undefined,
      target: targetLabel,
      artifactStem: `${sanitizePathSegment(review)}-${sanitizePathSegment(targetLabel)}`,
    },
  };
}

async function resolveActivePhaseFromCodename(codename: string, worktreeRoot: string): Promise<string | null> {
  const tasklistPath = resolve(worktreeRoot, "agents", `${codename}_Tasklist.md`);
  try {
    const raw = await readFile(tasklistPath, "utf-8");
    return resolveActivePhaseFromTasklist(raw);
  } catch {
    return null;
  }
}

async function resolveActivePhaseFromMostRecentTasklist(worktreeRoot: string): Promise<string | null> {
  const agentsDirectory = resolve(worktreeRoot, "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDirectory);
  } catch {
    return null;
  }

  const tasklists = entries.filter((entry) => entry.endsWith("_Tasklist.md"));
  if (tasklists.length === 0) {
    return null;
  }

  const sortedTasklists = [...tasklists].sort((left, right) => left.localeCompare(right));
  const entriesWithPhase = await Promise.all(
    sortedTasklists.map(async (name) => {
      const path = resolve(agentsDirectory, name);
      const raw = await readFile(path, "utf-8").catch(() => null);
      if (typeof raw !== "string") {
        return null;
      }

      const phase = resolveActivePhaseFromTasklist(raw);
      if (!phase) {
        return null;
      }

      const phaseNumber = Number(phase);
      if (!Number.isInteger(phaseNumber) || phaseNumber <= 0) {
        return null;
      }

      return {
        name,
        phase,
        phaseNumber,
      };
    }),
  );

  const candidates = entriesWithPhase.filter((entry): entry is { name: string; phase: string; phaseNumber: number } => entry !== null);
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.phaseNumber !== left.phaseNumber) {
      return right.phaseNumber - left.phaseNumber;
    }
    return left.name.localeCompare(right.name);
  });

  return candidates[0]?.phase ?? null;
}

function resolveActivePhaseFromTasklist(tasklistRaw: string): string | null {
  const lines = tasklistRaw.split(/\r?\n/);
  const phases = collectPhaseRanges(lines);
  if (phases.length === 0) {
    return null;
  }

  for (const phase of phases) {
    for (let index = phase.startIndex; index <= phase.endIndex; index += 1) {
      const line = lines[index] ?? "";
      if (/^\s*-\s*\[ \]\s+\*\*T-[0-9]+\.[0-9]+\.[0-9]+\*\*/.test(line)) {
        return phase.id;
      }
    }
  }

  return phases[phases.length - 1]?.id ?? null;
}

function collectPhaseRanges(lines: string[]): Array<{ id: string; startIndex: number; endIndex: number }> {
  const markers: Array<{ id: string; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? "").match(/^\s*<!--\s*PHASE:(\d+)\s*-->\s*$/i);
    if (match && match[1]) {
      markers.push({
        id: match[1],
        index,
      });
    }
  }

  const ranges: Array<{ id: string; startIndex: number; endIndex: number }> = [];
  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    const next = markers[index + 1];
    ranges.push({
      id: current.id,
      startIndex: current.index + 1,
      endIndex: next ? next.index - 1 : lines.length - 1,
    });
  }

  return ranges;
}

async function resolveLatestPhaseFromArtifacts(worktreeRoot: string): Promise<string | null> {
  const reviewDirectory = resolve(worktreeRoot, ...REVIEW_ARTIFACT_DIRECTORY);
  let entries: string[];
  try {
    entries = await readdir(reviewDirectory);
  } catch {
    return null;
  }

  let highest = 0;
  for (const entry of entries) {
    const match = entry.match(/-phase-(\d+)-/i);
    const rawPhase = match?.[1];
    if (!rawPhase) {
      continue;
    }

    const phase = Number(rawPhase);
    if (Number.isFinite(phase) && phase > highest) {
      highest = phase;
    }
  }

  return highest > 0 ? String(highest) : null;
}

async function resolveNextRound(directory: string, stem: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 1;
  }

  const prefix = `${stem}-round-`;
  let maxRound = 0;

  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) {
      continue;
    }

    const remainder = entry.slice(prefix.length, -".json".length);
    const round = Number(remainder);
    if (Number.isInteger(round) && round > maxRound) {
      maxRound = round;
    }
  }

  return maxRound + 1;
}

async function persistReviewArtifactWithRound(
  directory: string,
  stem: string,
  payload: Record<string, unknown>,
): Promise<{ path: string; round: number }> {
  await mkdir(directory, { recursive: true });
  const firstRound = await resolveNextRound(directory, stem);
  const maxAttempts = 256;

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const round = firstRound + offset;
    const path = resolve(directory, `${stem}-round-${round}.json`);
    const payloadWithRound = {
      ...payload,
      round,
    };

    try {
      await persistReviewArtifact(path, payloadWithRound, true);
      return { path, round };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`unable to reserve artifact round for stem '${stem}' after ${maxAttempts} attempts`);
}

function resolveExpectedMarker(review: string): string {
  const normalized = review.toLowerCase();
  if (normalized === "creview") {
    return "CYCLE_CREVIEW_RESULT";
  }

  if (normalized === "mreview") {
    return "CYCLE_MREVIEW_RESULT";
  }

  if (normalized === "phreview") {
    return "CYCLE_PHREVIEW_RESULT";
  }

  return `CYCLE_${normalized.toUpperCase().replace(/-/g, "_")}_RESULT`;
}

function parseReviewMarker(rawOutput: string, expectedMarker: string, review: string): ParsedMarker<MarkerPayload> {
  const expected = parseMarkerComment<MarkerPayload>(rawOutput, expectedMarker);
  if (expected.markerFound) {
    return {
      ...expected,
      markerName: expectedMarker,
    };
  }

  const fallback = parseAnyCycleMarker(rawOutput);
  if (fallback) {
    if (isStrictMarkerReview(review) && fallback.markerName && fallback.markerName.toUpperCase() !== expectedMarker.toUpperCase()) {
      return {
        markerFound: true,
        markerName: fallback.markerName,
        payload: fallback.payload,
        error: `Expected ${expectedMarker} marker but found ${fallback.markerName}.`,
      };
    }

    return fallback;
  }

  return {
    markerFound: false,
    markerName: expectedMarker,
    error: expected.error,
  };
}

function isStrictMarkerReview(review: string): boolean {
  const normalized = review.toLowerCase();
  return normalized === "creview" || normalized === "mreview" || normalized === "phreview";
}

function parseAnyCycleMarker(rawOutput: string): ParsedMarker<MarkerPayload> | null {
  const matches = [...rawOutput.matchAll(/<!--\s*(CYCLE_[A-Z0-9_]+_RESULT)\s*([\s\S]*?)-->/gi)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const markerName = matches[index]?.[1];
    const payloadBlock = matches[index]?.[2];
    if (!markerName || !payloadBlock) {
      continue;
    }

    const payloadRaw = stripCodeFence(payloadBlock.trim());
    try {
      const payload = JSON.parse(payloadRaw) as MarkerPayload;
      return {
        markerFound: true,
        markerName,
        payload,
      };
    } catch (error) {
      return {
        markerFound: true,
        markerName,
        error: `${markerName} marker JSON is invalid: ${formatUnknownError(error)}`,
      };
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

function collectArgumentList(args: RunReviewArgs, hint: string | null): string[] {
  const values = [
    normalizeOptionalText(args.parameter_1),
    normalizeOptionalText(args.parameter_2),
    normalizeOptionalText(args.parameter_3),
    normalizeOptionalText(args.parameter_4),
    normalizeOptionalText(args.parameter_5),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  if (hint) {
    values.push(hint);
  }

  return values;
}

function buildSessionTitle(review: string, scope: ResolvedScope): string {
  const pieces = [
    "run-review",
    sanitizePathSegment(review),
    sanitizePathSegment(scope.codename ?? scope.phase ?? "scope"),
    sanitizePathSegment(scope.subphase ?? scope.target ?? "target"),
  ];

  return pieces.join("-");
}

function splitCommandArguments(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      if (quote === "'") {
        current += character;
      } else {
        escaping = true;
      }
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function assignParameter(args: RunReviewArgs, index: number, value: string | undefined): void {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return;
  }

  if (index === 1) {
    args.parameter_1 = normalized;
    return;
  }

  if (index === 2) {
    args.parameter_2 = normalized;
    return;
  }

  if (index === 3) {
    args.parameter_3 = normalized;
    return;
  }

  if (index === 4) {
    args.parameter_4 = normalized;
    return;
  }

  if (index === 5) {
    args.parameter_5 = normalized;
  }
}

function shouldTreatTrailingPhaseAsOverride(review: string, argumentCount: number, candidate: string): boolean {
  if (!normalizePhaseSelector(candidate)) {
    return false;
  }

  if (review === "phreview") {
    return false;
  }

  if (review === "creview") {
    return argumentCount > 2;
  }

  if (review === "mreview") {
    return argumentCount > 1;
  }

  return argumentCount > 1;
}

function isDryRunToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "dry-run" || normalized === "--dry-run";
}

function buildCommandArgumentString(argumentList: string[]): string {
  return argumentList.map((argument) => quoteCommandArgument(argument)).join(" ").trim();
}

function quoteCommandArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function normalizeReviewName(value: string): string | null {
  const normalized = value.trim().replace(/^\//, "").toLowerCase();
  if (!normalized || !REVIEW_NAME_PATTERN.test(normalized)) {
    return null;
  }

  if (!normalized.endsWith("review")) {
    return null;
  }

  return normalized;
}

function normalizePhaseSelector(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

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

function normalizeSubphaseSelector(raw: string): string | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  const match = input.match(/^(?:SUBPHASE-)?(\d+\.[0-9A-Za-z]+)$/i);
  return match?.[1] ?? null;
}

function stripCodeFence(raw: string): string {
  const withoutStart = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  return withoutStart.replace(/```\s*$/i, "").trim();
}

async function persistReviewArtifact(path: string, payload: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    flag: exclusive ? "wx" : "w",
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown };
  return candidate.code === "EEXIST";
}

function normalizeOptionalText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
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

export const __runReviewTestUtils = {
  normalizeReviewName,
  normalizePhaseSelector,
  normalizeSubphaseSelector,
  parseRunReviewCommandArguments,
  resolveExpectedMarker,
  resolveActivePhaseFromTasklist,
  parseReviewMarker,
  buildCommandArgumentString,
  splitCommandArguments,
};

export default run_review;
