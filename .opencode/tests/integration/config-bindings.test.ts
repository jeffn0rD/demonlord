import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";

const execFileAsync = promisify(execFile);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENCODE_ROOT = resolve(TEST_DIR, "../..");
const REPO_ROOT = resolve(OPENCODE_ROOT, "..");

interface OpenCodeConfig {
  agent?: Record<string, unknown>;
}

function extractFrontmatterAgent(markdown: string): string | null {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/m.exec(markdown);
  if (!frontmatterMatch) {
    return null;
  }

  const agentMatch = /^agent:\s*(\S+)\s*$/m.exec(frontmatterMatch[1]);
  return agentMatch?.[1] ?? null;
}

describe("command/config bindings", () => {
  test("all command agent frontmatter values map to configured agents", async () => {
    const configRaw = await readFile(resolve(OPENCODE_ROOT, "opencode.jsonc"), "utf-8");
    const config = parse(configRaw) as OpenCodeConfig;
    const configuredAgents = new Set(Object.keys(config.agent ?? {}));

    assert.ok(configuredAgents.size > 0, "opencode.jsonc must define at least one agent");

    const commandsDir = resolve(OPENCODE_ROOT, "commands");
    const commandEntries = await readdir(commandsDir, { withFileTypes: true });

    for (const entry of commandEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const commandPath = resolve(commandsDir, entry.name);
      const markdown = await readFile(commandPath, "utf-8");
      const agent = extractFrontmatterAgent(markdown);

      assert.ok(agent, `Command ${entry.name} is missing an agent frontmatter field`);
      assert.ok(
        configuredAgents.has(agent),
        `Command ${entry.name} references unknown agent '${agent}'`,
      );
    }
  });

  test("worktree manager CLI list command executes under ESM", async () => {
    const scriptPath = resolve(REPO_ROOT, "agents/tools/worktree_manager.ts");
    const { stdout } = await execFileAsync(
      "node",
      ["--experimental-strip-types", scriptPath, "list"],
      { cwd: REPO_ROOT },
    );

    const records = JSON.parse(stdout) as unknown;
    assert.ok(Array.isArray(records), "list command must return a JSON array");
  });
});
