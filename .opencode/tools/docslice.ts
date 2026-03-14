import { tool } from "@opencode-ai/plugin/tool";
import { access, readFile } from "fs/promises";
import { constants } from "fs";
import { posix, relative, resolve } from "path";

const DEFAULT_MAX_LINES = 80;
const MAX_LINES_LIMIT = 220;

interface DocsliceArgs {
  skill_id?: string;
  file_path?: string;
  heading?: string;
  max_lines?: number;
  strict?: boolean;
}

interface DocsliceContext {
  worktree: string;
}

type DocsliceErrorCode =
  | "INVALID_INPUT"
  | "SKILL_NOT_FOUND"
  | "NO_RESOLVABLE_FILE"
  | "INVALID_FILE_PATH"
  | "FILE_NOT_FOUND"
  | "HEADING_NOT_FOUND"
  | "INDEX_NOT_FOUND";

interface DocsliceResult {
  ok: boolean;
  code?: DocsliceErrorCode;
  error?: string;
  skill_id?: string;
  file_path?: string;
  heading_requested?: string | null;
  heading_used?: string | null;
  slice_start_line?: number;
  slice_end_line?: number;
  total_lines?: number;
  truncated?: boolean;
  content?: string;
}

interface SkillIndexEntry {
  id: string;
  referencePaths: string[];
  landmarks: string[];
}

interface ParsedIndex {
  bySkillID: Map<string, SkillIndexEntry>;
}

interface HeadingRange {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}

const docslice = tool({
  description:
    "Resolve low-context documentation slices by skill/file/heading and return only the requested section window.",
  args: {
    skill_id: tool.schema
      .string()
      .optional()
      .describe("Optional skill ID. Used to resolve default documentation file/landmarks from doc/agent_docs_index.md."),
    file_path: tool.schema
      .string()
      .optional()
      .describe("Optional file path under the current worktree. Overrides skill-based file selection."),
    heading: tool.schema
      .string()
      .optional()
      .describe("Optional markdown heading to target. Uses top-of-file fallback unless strict=true."),
    max_lines: tool.schema
      .number()
      .int()
      .min(10)
      .max(MAX_LINES_LIMIT)
      .optional()
      .describe(`Maximum returned lines. Defaults to ${DEFAULT_MAX_LINES}.`),
    strict: tool.schema
      .boolean()
      .optional()
      .describe("When true, heading resolution failures return an error instead of top-of-file fallback."),
  },
  async execute(args: DocsliceArgs, context: DocsliceContext) {
    const result = await executeDocslice(args, context);
    return JSON.stringify(result, null, 2);
  },
});

export async function executeDocslice(args: DocsliceArgs, context: DocsliceContext): Promise<DocsliceResult> {
  const worktreeRoot = resolve(context.worktree);
  const maxLines = args.max_lines ?? DEFAULT_MAX_LINES;
  const strict = args.strict ?? false;

  if (!args.skill_id && !args.file_path) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      error: "Provide at least one of skill_id or file_path.",
    };
  }

  const indexPath = resolve(worktreeRoot, "doc", "agent_docs_index.md");
  const indexMarkdown = await safeRead(indexPath);
  if (!indexMarkdown) {
    return {
      ok: false,
      code: "INDEX_NOT_FOUND",
      error: "doc/agent_docs_index.md is missing or unreadable. Run skills maintenance first.",
    };
  }

  const parsedIndex = parseAgentDocsIndex(indexMarkdown);
  const skillEntry = args.skill_id ? parsedIndex.bySkillID.get(args.skill_id) : undefined;

  if (args.skill_id && !skillEntry) {
    return {
      ok: false,
      code: "SKILL_NOT_FOUND",
      error: `Skill '${args.skill_id}' was not found in doc/agent_docs_index.md.`,
    };
  }

  const relativeFilePath = await resolveTargetFilePath({
    explicitPath: args.file_path,
    skillEntry,
    worktreeRoot,
  });

  if (!relativeFilePath) {
    return {
      ok: false,
      code: "NO_RESOLVABLE_FILE",
      error: "Could not resolve a concrete file path. Provide file_path explicitly or add concrete references to the skill index.",
    };
  }

  if (hasGlobSyntax(relativeFilePath)) {
    return {
      ok: false,
      code: "INVALID_FILE_PATH",
      error: `Resolved path '${relativeFilePath}' is a pattern, not a concrete file.`,
    };
  }

  let absolutePath = "";
  try {
    absolutePath = resolveWithinWorktree(worktreeRoot, relativeFilePath);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_FILE_PATH",
      error: error instanceof Error ? error.message : "Resolved file path is invalid.",
      skill_id: args.skill_id,
      file_path: relativeFilePath,
    };
  }
  const source = await safeRead(absolutePath);
  if (!source) {
    return {
      ok: false,
      code: "FILE_NOT_FOUND",
      error: `Resolved file '${relativeFilePath}' is missing or unreadable.`,
      skill_id: args.skill_id,
      file_path: relativeFilePath,
    };
  }

  const lines = source.split(/\r?\n/);
  const headingRequested = args.heading?.trim() || null;

  let headingUsed: string | null = null;
  let range: HeadingRange | null = null;

  if (headingRequested) {
    range = findHeadingRange(lines, headingRequested);
    if (range) {
      headingUsed = range.heading;
    } else if (strict) {
      return {
        ok: false,
        code: "HEADING_NOT_FOUND",
        error: `Heading '${headingRequested}' was not found in '${relativeFilePath}'.`,
        skill_id: args.skill_id,
        file_path: relativeFilePath,
        heading_requested: headingRequested,
      };
    }
  }

  if (!range && skillEntry) {
    const inferredHeading = inferHeadingFromLandmarks(skillEntry.landmarks, lines);
    if (inferredHeading) {
      range = findHeadingRange(lines, inferredHeading);
      headingUsed = range?.heading ?? null;
    }
  }

  let sliceStart = 1;
  let sliceEnd = Math.min(lines.length, maxLines);
  let truncated = lines.length > maxLines;

  if (range) {
    sliceStart = range.startLine;
    const boundedEnd = range.startLine + maxLines - 1;
    sliceEnd = Math.min(range.endLine, boundedEnd);
    truncated = sliceEnd < range.endLine;
  }

  const content = lines.slice(Math.max(sliceStart - 1, 0), sliceEnd).join("\n");

  return {
    ok: true,
    skill_id: args.skill_id,
    file_path: relativeFilePath,
    heading_requested: headingRequested,
    heading_used: headingUsed,
    slice_start_line: sliceStart,
    slice_end_line: sliceEnd,
    total_lines: lines.length,
    truncated,
    content,
  };
}

async function resolveTargetFilePath(input: {
  explicitPath?: string;
  skillEntry?: SkillIndexEntry;
  worktreeRoot: string;
}): Promise<string | null> {
  if (input.explicitPath) {
    const normalized = normalizePath(input.explicitPath);
    if (!normalized) {
      return null;
    }
    return normalized;
  }

  const references = input.skillEntry?.referencePaths ?? [];
  const concreteMarkdown = references.filter((reference) => isConcreteFile(reference) && reference.endsWith(".md"));
  const concreteOther = references.filter((reference) => isConcreteFile(reference) && !reference.endsWith(".md"));
  const candidates = [...concreteMarkdown, ...concreteOther];

  for (const candidate of candidates) {
    let absolute = "";
    try {
      absolute = resolveWithinWorktree(input.worktreeRoot, candidate);
    } catch {
      continue;
    }
    if (await fileExists(absolute)) {
      return candidate;
    }
  }

  return null;
}

function parseAgentDocsIndex(markdown: string): ParsedIndex {
  const bySkillID = new Map<string, SkillIndexEntry>();

  const lines = markdown.split(/\r?\n/);
  let currentSkillID: string | null = null;
  let collectingLandmarks = false;

  for (const line of lines) {
    const skillHeaderMatch = line.match(/^###\s+`([^`]+)`\s*$/);
    if (skillHeaderMatch) {
      currentSkillID = skillHeaderMatch[1] ?? null;
      collectingLandmarks = false;

      if (currentSkillID && !bySkillID.has(currentSkillID)) {
        bySkillID.set(currentSkillID, {
          id: currentSkillID,
          referencePaths: [],
          landmarks: [],
        });
      }
      continue;
    }

    if (!currentSkillID) {
      continue;
    }

    const entry = bySkillID.get(currentSkillID);
    if (!entry) {
      continue;
    }

    if (line.startsWith("- Reference paths:")) {
      entry.referencePaths = extractBacktickTokens(line)
        .map((token) => normalizePath(token))
        .filter((token): token is string => Boolean(token));
      collectingLandmarks = false;
      continue;
    }

    if (line.startsWith("- Landmarks:")) {
      collectingLandmarks = true;
      continue;
    }

    if (collectingLandmarks) {
      if (line.startsWith("  - ")) {
        const landmark = line.replace(/^\s*-\s+/, "").trim();
        if (landmark) {
          entry.landmarks.push(landmark);
        }
        continue;
      }

      if (line.startsWith("- ")) {
        collectingLandmarks = false;
      }
    }
  }

  return { bySkillID };
}

function inferHeadingFromLandmarks(landmarks: string[], lines: string[]): string | null {
  const seen = new Set<string>();

  for (const landmark of landmarks) {
    const tokens = extractBacktickTokens(landmark);
    for (const token of tokens) {
      const normalized = token.trim();
      if (!normalized || normalized.includes("/") || normalized.includes("*")) {
        continue;
      }

      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      if (findHeadingRange(lines, normalized)) {
        return normalized;
      }
    }
  }

  return null;
}

function findHeadingRange(lines: string[], heading: string): HeadingRange | null {
  const wanted = normalizeHeading(heading);
  if (!wanted) {
    return null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseHeadingLine(lines[index] ?? "");
    if (!parsed) {
      continue;
    }

    if (normalizeHeading(parsed.heading) !== wanted) {
      continue;
    }

    let endLine = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = parseHeadingLine(lines[cursor] ?? "");
      if (!next) {
        continue;
      }

      if (next.level <= parsed.level) {
        endLine = cursor;
        break;
      }
    }

    return {
      heading: parsed.heading,
      level: parsed.level,
      startLine: index + 1,
      endLine,
    };
  }

  return null;
}

function parseHeadingLine(line: string): { level: number; heading: string } | null {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }

  const level = match[1]?.length ?? 0;
  const heading = (match[2] ?? "").trim();
  if (level < 1 || !heading) {
    return null;
  }

  return { level, heading };
}

function normalizeHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBacktickTokens(value: string): string[] {
  const tokens: string[] = [];
  const matcher = /`([^`]+)`/g;
  for (const match of value.matchAll(matcher)) {
    const token = (match[1] ?? "").trim();
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^\.\//, "")
    .replace(/^<worktree>\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  if (!normalized) {
    return null;
  }

  return normalized;
}

function isConcreteFile(pathValue: string): boolean {
  return !hasGlobSyntax(pathValue) && !pathValue.endsWith("/");
}

function hasGlobSyntax(pathValue: string): boolean {
  return pathValue.includes("*") || pathValue.includes("?") || pathValue.includes("[");
}

function resolveWithinWorktree(worktreeRoot: string, pathValue: string): string {
  const absolute = resolve(worktreeRoot, pathValue);
  const rel = posix.normalize(relative(worktreeRoot, absolute).split("\\").join("/"));
  if (rel.startsWith("../") || rel === "..") {
    throw new Error(`Resolved path '${pathValue}' is outside the worktree.`);
  }
  return absolute;
}

async function safeRead(pathValue: string): Promise<string | null> {
  try {
    return await readFile(pathValue, "utf-8");
  } catch {
    return null;
  }
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export const __docsliceTestUtils = {
  parseAgentDocsIndex,
  inferHeadingFromLandmarks,
  findHeadingRange,
  normalizeHeading,
};

export default docslice;
