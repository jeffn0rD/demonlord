import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");
const INSTALLER_PATH = resolve(REPO_ROOT, "scripts/install-demonlord.sh");

describe("installer/bootstrap regression", () => {
  test("local-source install excludes transient .opencode entries", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "installer-source-"));
    const targetRoot = await mkdtemp(join(tmpdir(), "installer-target-"));

    try {
      await createInstallerSourceFixture(sourceRoot);

      const initResult = await runCommand("git", ["init", "-q", targetRoot]);
      assert.equal(initResult.code, 0, initResult.stderr);

      const installResult = await runCommand("bash", [
        INSTALLER_PATH,
        "--source",
        sourceRoot,
        "--target",
        targetRoot,
        "--skip-bootstrap",
      ]);
      assert.equal(installResult.code, 0, installResult.stderr);

      const copiedContent = await readFile(join(targetRoot, ".opencode", "keep.txt"), "utf-8");
      assert.equal(copiedContent, "keep\n");

      await assert.rejects(() => access(join(targetRoot, ".opencode", "node_modules")));
      await assert.rejects(() => access(join(targetRoot, ".opencode", ".cache")));
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  test("dry-run fails preflight for invalid remote source", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "installer-dryrun-target-"));

    try {
      const initResult = await runCommand("git", ["init", "-q", targetRoot]);
      assert.equal(initResult.code, 0, initResult.stderr);

      const dryRunResult = await runCommand("bash", [
        INSTALLER_PATH,
        "--dry-run",
        "--source",
        "https://example.invalid/nope.git",
        "--target",
        targetRoot,
      ]);

      assert.notEqual(dryRunResult.code, 0);
      assert.match(dryRunResult.stderr, /Unable to reach remote source/);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});

async function createInstallerSourceFixture(sourceRoot: string): Promise<void> {
  await mkdir(join(sourceRoot, ".opencode", "node_modules", "artifact"), { recursive: true });
  await mkdir(join(sourceRoot, ".opencode", ".cache"), { recursive: true });
  await mkdir(join(sourceRoot, "agents"), { recursive: true });
  await mkdir(join(sourceRoot, "doc"), { recursive: true });
  await mkdir(join(sourceRoot, "scripts"), { recursive: true });

  await writeFile(join(sourceRoot, ".opencode", "keep.txt"), "keep\n");
  await writeFile(join(sourceRoot, ".opencode", "node_modules", "artifact", "junk.txt"), "junk\n");
  await writeFile(join(sourceRoot, ".opencode", ".cache", "cache.txt"), "cache\n");
  await writeFile(join(sourceRoot, "scripts", "bootstrap.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(join(sourceRoot, "scripts", "install-demonlord.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(join(sourceRoot, "demonlord.config.json"), "{}\n");
  await writeFile(join(sourceRoot, ".env.example"), "GITHUB_PAT=\n");
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolveResult({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (error) => {
      resolveResult({
        code: 1,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });
  });
}
