import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";
import type { Dirent } from "fs";
import { readdir, readFile } from "fs/promises";
import { resolve } from "path";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillDefinition {
  id: string;
  description: string;
  filePath: string;
  body: string;
  routingHints: string;
}

export interface RouteResult {
  skill_id: string;
  reason: string;
  mode: "llm" | "heuristic";
}

interface ResolveTaskRouteInput {
  taskDescription: string;
  directory: string;
  worktree: string;
  mode?: "llm" | "heuristic";
  excludeSkillIDs?: string[];
}

interface RouteTaskArgs {
  task_description: string;
  mode?: "llm" | "heuristic";
  exclude_skill_ids?: string[];
}

interface RouteTaskContext {
  directory: string;
  worktree: string;
}

interface LlmRouteAttempt {
  result: RouteResult | null;
  failureReason?: string;
}

const ROUTING_HINT_WEIGHT = 5;
const SKILL_ID_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 2;
const BODY_WEIGHT = 1;

const AMBIGUITY_TERMS = new Set([
  "ambiguous",
  "ambiguity",
  "unclear",
  "unsure",
  "unknown",
  "conflict",
  "spec",
  "specs",
  "requirement",
  "requirements",
  "tasklist",
  "plan",
  "codename",
  "recommendation",
  "recommendations",
  "where",
  "find",
  "discover",
]);

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";

const route_task = tool({
  description:
    "Route a task description to the best skill by reading SKILL.md files and selecting a skill ID.",
  args: {
    task_description: tool.schema
      .string()
      .min(3)
      .describe("Task to route to the most appropriate specialist skill."),
    mode: tool.schema
      .enum(["llm", "heuristic"])
      .optional()
      .describe("Routing strategy. Defaults to llm with automatic heuristic fallback."),
    exclude_skill_ids: tool.schema
      .array(tool.schema.string().min(1))
      .optional()
      .describe("Optional skill IDs to exclude from routing decisions."),
  },
  async execute(args: RouteTaskArgs, context: RouteTaskContext) {
    try {
      const resolved = await resolveTaskRoute({
        taskDescription: args.task_description,
        directory: context.directory,
        worktree: context.worktree,
        mode: args.mode,
        excludeSkillIDs: args.exclude_skill_ids,
      });

      return JSON.stringify(resolved, null, 2);
    } catch (error) {
      return JSON.stringify(
        {
          error: formatUnknownError(error),
          skill_id: null,
        },
        null,
        2,
      );
    }
  },
});

export async function resolveTaskRoute(input: ResolveTaskRouteInput): Promise<RouteResult> {
  const allSkills = await loadSkillDefinitions(input.worktree);
  const excludedSkills = new Set(input.excludeSkillIDs ?? []);
  const skills = allSkills.filter((skill) => !excludedSkills.has(skill.id));

  if (skills.length === 0) {
    throw new Error(
      excludedSkills.size > 0
        ? "No eligible SKILL.md files found after exclusions under .opencode/skills."
        : "No valid SKILL.md files found under .opencode/skills.",
    );
  }

  const requestedMode = input.mode ?? "llm";
  if (requestedMode === "heuristic") {
    return routeHeuristically(input.taskDescription, skills);
  }

  const llmAttempt = await routeWithLlm(input.taskDescription, skills, input.directory, input.worktree);
  if (llmAttempt.result) {
    return llmAttempt.result;
  }

  return routeHeuristically(input.taskDescription, skills, llmAttempt.failureReason);
}

export async function loadSkillDefinitions(worktreeRoot: string): Promise<SkillDefinition[]> {
  const skillsRoot = resolve(worktreeRoot, ".opencode", "skills");

  let entries: Dirent[];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const skills: SkillDefinition[] = [];

  for (const entry of directories) {
    const skillDirectory = entry.name;
    const skillPath = resolve(skillsRoot, skillDirectory, "SKILL.md");

    try {
      const raw = await readFile(skillPath, "utf-8");
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        continue;
      }

      if (!SKILL_NAME_PATTERN.test(parsed.name)) {
        continue;
      }

      if (parsed.name !== skillDirectory) {
        continue;
      }

      skills.push({
        id: parsed.name,
        description: parsed.description,
        filePath: skillPath,
        body: raw,
        routingHints: extractRoutingHints(raw),
      });
    } catch {
      continue;
    }
  }

  return skills;
}

function extractRoutingHints(markdown: string): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) => /^##\s+Routing Hints\s*$/i.test(line.trim()));
  if (startIndex < 0) {
    return "";
  }

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##\s+/.test(line.trim())) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

function parseSkillFrontmatter(markdown: string): { name: string; description: string } | null {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descriptionMatch) {
    return null;
  }

  const name = stripYamlString(nameMatch[1]);
  const description = stripYamlString(descriptionMatch[1]);

  if (!name || !description) {
    return null;
  }

  return { name, description };
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  const singleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  const doubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  if (singleQuoted || doubleQuoted) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

async function routeWithLlm(
  taskDescription: string,
  skills: SkillDefinition[],
  directory: string,
  worktree: string,
): Promise<LlmRouteAttempt> {
  const client = createOpencodeClient({
    baseUrl: DEFAULT_SERVER_URL,
    directory,
  });

  let ephemeralSessionID: string | null = null;

  try {
    const created = await client.session.create({
      body: {
        title: "matchmaker-routing",
      },
      query: {
        directory: worktree,
      },
    });

    if (!created.data?.id) {
      return {
        result: null,
        failureReason: "LLM routing session could not be created.",
      };
    }

    ephemeralSessionID = created.data.id;

    const skillPrompt = skills
      .map((skill) => {
        const hints = skill.routingHints.trim();
        if (hints.length === 0) {
          return `- ${skill.id}: ${skill.description}`;
        }

        return `- ${skill.id}: ${skill.description} | routing hints: ${hints}`;
      })
      .join("\n");

    const routingPrompt = [
      "You are a deterministic skill router.",
      "Pick exactly one skill_id from the allowed list.",
      "Return only JSON with keys: skill_id, reason.",
      "Allowed skills:",
      skillPrompt,
      "",
      `Task: ${taskDescription}`,
    ].join("\n");

    const response = await client.session.prompt({
      path: { id: ephemeralSessionID },
      body: {
        agent: "orchestrator",
        noReply: false,
        parts: [{ type: "text", text: routingPrompt }],
      },
      query: {
        directory: worktree,
      },
    });

    if (!response.data?.parts) {
      return {
        result: null,
        failureReason: "LLM routing response did not include any content.",
      };
    }

    const responseTextParts: string[] = [];
    for (const part of response.data.parts) {
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        responseTextParts.push(candidate.text);
      }
    }

    const responseText = responseTextParts.join("\n").trim();

    const parsed = parseRouterOutput(responseText);
    if (!parsed) {
      return {
        result: null,
        failureReason: "LLM routing response was not valid JSON.",
      };
    }

    const matchingSkill = skills.find((skill) => skill.id === parsed.skill_id);
    if (!matchingSkill) {
      return {
        result: null,
        failureReason: `LLM selected unknown skill '${parsed.skill_id}'.`,
      };
    }

    return {
      result: {
        skill_id: matchingSkill.id,
        reason: parsed.reason,
        mode: "llm",
      },
    };
  } catch (error) {
    return {
      result: null,
      failureReason: `LLM routing request failed: ${formatUnknownError(error)}`,
    };
  } finally {
    if (ephemeralSessionID) {
      await client.session
        .delete({
          path: { id: ephemeralSessionID },
          query: {
            directory: worktree,
          },
        })
        .catch(() => undefined);
    }
  }
}

function parseRouterOutput(raw: string): { skill_id: string; reason: string } | null {
  const parsedDirect = tryParseJson(raw);
  if (parsedDirect) {
    return parsedDirect;
  }

  const jsonBlock = raw.match(/\{[\s\S]*\}/);
  if (!jsonBlock) {
    return null;
  }

  return tryParseJson(jsonBlock[0]);
}

function tryParseJson(raw: string): { skill_id: string; reason: string } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }

    const candidate = value as {
      skill_id?: unknown;
      skill?: unknown;
      reason?: unknown;
    };
    const skillID =
      typeof candidate.skill_id === "string"
        ? candidate.skill_id
        : typeof candidate.skill === "string"
          ? candidate.skill
          : null;

    if (!skillID) {
      return null;
    }

    const reason = typeof candidate.reason === "string" ? candidate.reason : "LLM selected the closest skill.";
    return {
      skill_id: skillID,
      reason,
    };
  } catch {
    return null;
  }
}

function routeHeuristically(
  taskDescription: string,
  skills: SkillDefinition[],
  fallbackReason?: string,
): RouteResult {
  const taskTokens = tokenize(taskDescription);
  const ambiguousTask = shouldPreferSpecExpert(taskDescription, taskTokens);
  const scoreBySkill = new Map<string, number>();

  let bestSkill = skills[0];
  let bestScore = -1;

  for (const skill of skills) {
    let score = 0;

    score += overlapScore(taskTokens, tokenize(skill.id), SKILL_ID_WEIGHT);
    score += overlapScore(taskTokens, tokenize(skill.description), DESCRIPTION_WEIGHT);
    score += overlapScore(taskTokens, tokenize(skill.routingHints), ROUTING_HINT_WEIGHT);
    score += overlapScore(taskTokens, tokenize(skill.body), BODY_WEIGHT);

    scoreBySkill.set(skill.id, score);

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  const specExpert = skills.find((skill) => skill.id === "spec-expert");
  if (ambiguousTask && specExpert) {
    const specScore = scoreBySkill.get(specExpert.id) ?? 0;

    return {
      skill_id: specExpert.id,
      reason: [
        fallbackReason ? `Fallback activated: ${fallbackReason}` : null,
        `Ambiguity-first policy selected ${specExpert.id} before implementation routing.`,
        `Heuristic score for ${specExpert.id}: ${specScore}.`,
      ]
        .filter((item): item is string => Boolean(item))
        .join(" "),
      mode: "heuristic",
    };
  }

  return {
    skill_id: bestSkill.id,
    reason: [
      fallbackReason ? `Fallback activated: ${fallbackReason}` : null,
      bestScore > 0
        ? `Heuristic overlap score ${bestScore} selected ${bestSkill.id}.`
        : `No overlap found; defaulted to ${bestSkill.id}.`,
    ]
      .filter((item): item is string => Boolean(item))
      .join(" "),
    mode: "heuristic",
  };
}

function tokenize(input: string): Set<string> {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  return new Set(tokens);
}

function overlapScore(taskTokens: Set<string>, skillTokens: Set<string>, weight: number): number {
  if (weight <= 0 || taskTokens.size === 0 || skillTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of taskTokens) {
    if (skillTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap * weight;
}

function shouldPreferSpecExpert(taskDescription: string, taskTokens: Set<string>): boolean {
  const normalized = taskDescription.toLowerCase();
  if (/(not sure|unsure|unclear|ambiguous|conflict|recommend)/.test(normalized)) {
    return true;
  }

  for (const token of taskTokens) {
    if (AMBIGUITY_TERMS.has(token)) {
      return true;
    }
  }

  return false;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export default route_task;

export const __matchmakerTestUtils = {
  extractRoutingHints,
  parseSkillFrontmatter,
  parseRouterOutput,
  routeHeuristically,
  shouldPreferSpecExpert,
};
