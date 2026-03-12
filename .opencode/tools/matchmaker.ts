import { createOpencodeClient } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin/tool";
import { readdir, readFile } from "fs/promises";
import { resolve } from "path";

interface SkillDefinition {
  id: string;
  description: string;
  filePath: string;
  body: string;
}

interface RouteResult {
  skill_id: string;
  reason: string;
  mode: "llm" | "heuristic";
}

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
  },
  async execute(args, context) {
    const skills = await loadSkillDefinitions(context.worktree);
    if (skills.length === 0) {
      return JSON.stringify(
        {
          error: "No valid SKILL.md files found under .opencode/skills.",
          skill_id: null,
        },
        null,
        2,
      );
    }

    const requestedMode = args.mode ?? "llm";
    if (requestedMode === "heuristic") {
      const heuristicResult = routeHeuristically(args.task_description, skills);
      return JSON.stringify(heuristicResult, null, 2);
    }

    const llmResult = await routeWithLlm(args.task_description, skills, context.directory, context.worktree);
    if (llmResult) {
      return JSON.stringify(llmResult, null, 2);
    }

    const fallbackResult = routeHeuristically(args.task_description, skills);
    return JSON.stringify(fallbackResult, null, 2);
  },
});

async function loadSkillDefinitions(worktreeRoot: string): Promise<SkillDefinition[]> {
  const skillsRoot = resolve(worktreeRoot, ".opencode", "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectory = entry.name;
    const skillPath = resolve(skillsRoot, skillDirectory, "SKILL.md");

    try {
      const raw = await readFile(skillPath, "utf-8");
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
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
      });
    } catch {
      continue;
    }
  }

  return skills;
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
): Promise<RouteResult | null> {
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
      return null;
    }

    ephemeralSessionID = created.data.id;

    const skillPrompt = skills
      .map((skill) => `- ${skill.id}: ${skill.description}`)
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
      return null;
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
      return null;
    }

    const matchingSkill = skills.find((skill) => skill.id === parsed.skill_id);
    if (!matchingSkill) {
      return null;
    }

    return {
      skill_id: matchingSkill.id,
      reason: parsed.reason,
      mode: "llm",
    };
  } catch {
    return null;
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

function routeHeuristically(taskDescription: string, skills: SkillDefinition[]): RouteResult {
  const taskTokens = tokenize(taskDescription);

  let bestSkill = skills[0];
  let bestScore = -1;

  for (const skill of skills) {
    const skillTokens = tokenize(`${skill.id} ${skill.description} ${skill.body}`);
    let score = 0;

    for (const token of taskTokens) {
      if (skillTokens.has(token)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  return {
    skill_id: bestSkill.id,
    reason:
      bestScore > 0
        ? `Heuristic overlap score ${bestScore} selected ${bestSkill.id}.`
        : `No overlap found; defaulted to ${bestSkill.id}.`,
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

export default route_task;
