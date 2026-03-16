import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import submit_implementation from "../../tools/submit_implementation.ts";
import { runPipelineCtl } from "../../../../agents/tools/pipelinectl.ts";

type MockCommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

describe("phase 5.2 error handling", () => {
  test("returns deterministic failure payload when tests hit network timeout", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-network-timeout-"));

    try {
      await writeFixturePackageJson(worktreeRoot);
      const runCommand = createRunner((command) => {
        if (command === "npm run lint") {
          return { exitCode: 0 };
        }

        if (command === "npm run test") {
          return {
            exitCode: 1,
            stderr: "Error: ETIMEDOUT while calling https://api.example.test/health",
          };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "fix: handle transient network timeout",
          generate_tests: false,
          auto_fix: false,
          changed_files: ["src/api/health.ts"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.stage, "test");
      assert.match(parsed.stack_trace, /ETIMEDOUT/);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  test("surfaces disk-full failures during commit stage", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-disk-full-"));

    try {
      await writeFixturePackageJson(worktreeRoot);
      const runCommand = createRunner((command) => {
        if (command === "npm run lint" || command === "npm run test") {
          return { exitCode: 0 };
        }

        if (command === "git diff --name-only --cached") {
          return { exitCode: 0, stdout: "src/index.ts\n" };
        }

        if (command === "git diff --name-only" || command === "git ls-files --others --exclude-standard") {
          return { exitCode: 0, stdout: "" };
        }

        if (command.includes("git add") && command.includes("git commit")) {
          return {
            exitCode: 1,
            stderr: "fatal: unable to write new file: No space left on device",
          };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "fix: report disk pressure commit failures",
          generate_tests: false,
          auto_fix: false,
          changed_files: ["src/index.ts"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.stage, "commit_push");
      assert.match(parsed.stack_trace, /No space left on device/);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  test("returns actionable error for invalid orchestration snapshot config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipelinectl-invalid-config-"));

    try {
      const outputDir = resolve(root, "_bmad-output");
      await mkdir(outputDir, { recursive: true });

      const statePath = resolve(outputDir, "orchestration-state.json");
      const queuePath = resolve(outputDir, "orchestration-commands.ndjson");
      await writeFile(statePath, "{ this-is-not-json", "utf-8");

      const capture = createCaptureIO();
      const exitCode = await runPipelineCtl(
        ["status"],
        {
          OPENCODE_WORKTREE: root,
          OPENCODE_ORCHESTRATION_STATE: statePath,
          OPENCODE_ORCHESTRATION_COMMAND_QUEUE: queuePath,
          OPENCODE_SESSION_ID: "ses-invalid",
        },
        capture.io,
      );

      assert.equal(exitCode, 1);
      assert.match(capture.stderr.join(""), /Unable to read orchestration snapshot/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createRunner(resolver: (command: string) => MockCommandResult) {
  return async (_worktreeRoot: string, command: string) => {
    const result = resolver(command);
    return {
      command,
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function createContext(
  worktree: string,
  runCommand: (worktreeRoot: string, command: string) => Promise<{ command: string; exitCode: number; stdout: string; stderr: string }>,
) {
  return { worktree, runCommand } as unknown as Parameters<typeof submit_implementation.execute>[1];
}

async function writeFixturePackageJson(worktreeRoot: string): Promise<void> {
  await writeFile(
    resolve(worktreeRoot, "package.json"),
    JSON.stringify(
      {
        scripts: {
          lint: "eslint .",
          test: "vitest",
        },
        devDependencies: {
          vitest: "^1.0.0",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function createCaptureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout(message: string) {
        stdout.push(message);
      },
      stderr(message: string) {
        stderr.push(message);
      },
    },
  };
}
