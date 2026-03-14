import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const REGISTRY_PATH = resolve(REPO_ROOT, "agents/tools/worktree-registry.json");

type WorktreeStatus = "active" | "orphaned";

interface WorktreeRecord {
  taskId: string;
  agentType: string;
  purpose: string;
  worktreePath: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
  status: WorktreeStatus;
}

interface WorktreeRegistry {
  version: 1;
  updatedAt: string;
  worktrees: WorktreeRecord[];
}

interface RegisterWorktreeInput {
  taskId: string;
  agentType: string;
  purpose: string;
  worktreePath: string;
  branchName: string;
}

interface CleanupResult {
  removedWorktrees: string[];
  keptWorktrees: string[];
}

function createEmptyRegistry(): WorktreeRegistry {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    worktrees: [],
  };
}

async function loadRegistry(): Promise<WorktreeRegistry> {
  if (!existsSync(REGISTRY_PATH)) {
    return createEmptyRegistry();
  }

  const raw = await readFile(REGISTRY_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<WorktreeRegistry>;

  if (!Array.isArray(parsed.worktrees)) {
    return createEmptyRegistry();
  }

  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    worktrees: parsed.worktrees,
  };
}

async function saveRegistry(registry: WorktreeRegistry): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(REGISTRY_PATH, body, "utf-8");
}

function resolveWorktreePath(inputPath: string): string {
  if (inputPath.startsWith("/")) {
    return resolve(inputPath);
  }

  return resolve(REPO_ROOT, inputPath);
}

async function listGitWorktrees(): Promise<Set<string>> {
  const { stdout } = await execFileAsync("git", ["-C", REPO_ROOT, "worktree", "list", "--porcelain"]);
  const worktrees = new Set<string>();

  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }

    const worktreePath = line.replace(/^worktree\s+/, "").trim();
    if (worktreePath.length > 0) {
      worktrees.add(resolve(worktreePath));
    }
  }

  return worktrees;
}

export async function registerWorktree(input: RegisterWorktreeInput): Promise<WorktreeRecord> {
  const now = new Date().toISOString();
  const worktreePath = resolveWorktreePath(input.worktreePath);
  const registry = await loadRegistry();

  const nextRecord: WorktreeRecord = {
    taskId: input.taskId,
    agentType: input.agentType,
    purpose: input.purpose,
    worktreePath,
    branchName: input.branchName,
    createdAt: now,
    updatedAt: now,
    status: "active",
  };

  const index = registry.worktrees.findIndex((entry) => entry.worktreePath === worktreePath);
  if (index >= 0) {
    const existing = registry.worktrees[index];
    nextRecord.createdAt = existing.createdAt;
    registry.worktrees[index] = nextRecord;
  } else {
    registry.worktrees.push(nextRecord);
  }

  registry.updatedAt = now;
  await saveRegistry(registry);
  return nextRecord;
}

export async function listTrackedWorktrees(): Promise<WorktreeRecord[]> {
  const registry = await loadRegistry();
  return registry.worktrees;
}

export async function cleanupOrphanedWorktrees(): Promise<CleanupResult> {
  const registry = await loadRegistry();
  const gitWorktrees = await listGitWorktrees();
  const now = new Date().toISOString();

  const keptWorktrees: WorktreeRecord[] = [];
  const removedWorktrees: string[] = [];

  for (const tracked of registry.worktrees) {
    const absolutePath = resolveWorktreePath(tracked.worktreePath);
    const isActive = gitWorktrees.has(absolutePath);

    if (isActive) {
      keptWorktrees.push({
        ...tracked,
        worktreePath: absolutePath,
        status: "active",
        updatedAt: now,
      });
      continue;
    }

    removedWorktrees.push(absolutePath);
    if (existsSync(absolutePath)) {
      await rm(absolutePath, { recursive: true, force: true });
    }
  }

  registry.worktrees = keptWorktrees;
  registry.updatedAt = now;
  await saveRegistry(registry);

  await execFileAsync("git", ["-C", REPO_ROOT, "worktree", "prune"]);

  return {
    removedWorktrees,
    keptWorktrees: keptWorktrees.map((entry) => entry.worktreePath),
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      flags[key] = "true";
      continue;
    }

    flags[key] = value;
    index += 1;
  }

  return flags;
}

function printUsage(): void {
  const lines = [
    "Usage:",
    "  node agents/tools/worktree_manager.ts register --task-id <id> --agent-type <type> --purpose <purpose> --worktree-path <path> --branch-name <name>",
    "  node agents/tools/worktree_manager.ts list",
    "  node agents/tools/worktree_manager.ts cleanup",
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function runCli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "register") {
    const flags = parseFlags(args);
    const requiredKeys = ["task-id", "agent-type", "purpose", "worktree-path", "branch-name"] as const;

    for (const key of requiredKeys) {
      if (!flags[key]) {
        throw new Error(`Missing required flag: --${key}`);
      }
    }

    const record = await registerWorktree({
      taskId: flags["task-id"],
      agentType: flags["agent-type"],
      purpose: flags.purpose,
      worktreePath: flags["worktree-path"],
      branchName: flags["branch-name"],
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  if (command === "list") {
    const records = await listTrackedWorktrees();
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }

  if (command === "cleanup") {
    const result = await cleanupOrphanedWorktrees();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
