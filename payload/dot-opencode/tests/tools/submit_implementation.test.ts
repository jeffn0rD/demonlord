import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import submit_implementation, { __submitImplementationTestUtils } from "../../tools/submit_implementation.ts";

type MockCommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

const {
  CONVENTIONAL_COMMIT_PATTERN,
  detectApiRunner,
  detectE2ERunner,
  toSemanticKey,
  isApiCandidate,
  isE2ECandidate,
  inferSnapshotFixCommand,
} = __submitImplementationTestUtils;

describe("submit_implementation tool", () => {
  let worktreeRoot: string;

  beforeEach(async () => {
    worktreeRoot = await mkdtemp(join(tmpdir(), "submit-implementation-"));
  });

  afterEach(async () => {
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  test("validates conventional commit pattern", () => {
    assert.match("feat: add deterministic quality gate", CONVENTIONAL_COMMIT_PATTERN);
    assert.doesNotMatch("add deterministic quality gate", CONVENTIONAL_COMMIT_PATTERN);
  });

  test("detects API and E2E runners from dependency and script fingerprints", () => {
    assert.equal(detectApiRunner({ vitest: "^1.0.0" }, ""), "vitest");
    assert.equal(detectApiRunner({}, "node --test"), "node-test");
    assert.equal(detectE2ERunner({ "@playwright/test": "^1.0.0" }, ""), "playwright");
    assert.equal(detectE2ERunner({}, ""), "none");
  });

  test("normalizes semantic keys and candidate detection", () => {
    assert.equal(toSemanticKey("src/api/user.ts"), "src-api-user");
    assert.equal(toSemanticKey("/components/ProfileCard.tsx"), "components-profilecard");
    assert.equal(isApiCandidate("src/services/auth.ts"), true);
    assert.equal(isApiCandidate("src/components/AuthForm.tsx"), false);
    assert.equal(isE2ECandidate("src/pages/Home.tsx"), true);
    assert.equal(isE2ECandidate("src/api/health.ts"), false);
  });

  test("infers snapshot refresh command for supported runners", () => {
    assert.equal(inferSnapshotFixCommand("vitest"), "npm run test -- --updateSnapshot");
    assert.equal(inferSnapshotFixCommand("jest"), "npm run test -- --updateSnapshot");
    assert.equal(inferSnapshotFixCommand("unknown"), null);
  });

  test("returns lint-stage failure payload with stack trace", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, (command) => {
      if (command === "npm run lint") {
        return { exitCode: 1, stderr: "lint failed: src/main.ts:1" };
      }

      return { exitCode: 0 };
    });

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: add lint failure test",
        generate_tests: false,
        auto_fix: false,
        changed_files: ["src/main.ts"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, "lint");
    assert.match(parsed.stack_trace, /lint failed/);
    assert.deepEqual(commandLog, ["npm run lint"]);
  });

  test("runs bounded lint auto-fix retries", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, (command) => {
      if (command === "npm run lint") {
        return { exitCode: 1, stderr: "still failing" };
      }

      if (command === "npm run lint -- --fix") {
        return { exitCode: 0 };
      }

      return { exitCode: 0 };
    });

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: add bounded lint retry test",
        generate_tests: false,
        auto_fix: true,
        changed_files: ["src/main.ts"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, "lint");
    assert.equal(parsed.auto_fix_actions.length, 3);
    assert.equal(commandLog.filter((command) => command === "npm run lint -- --fix").length, 3);
  });

  test("stages explicit changed files without git add -A", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, (command) => {
      if (command === "git diff --name-only --cached") {
        return { exitCode: 0, stdout: "src/index.ts\nsrc/util.ts\n" };
      }

      if (command === "git diff --name-only" || command === "git ls-files --others --exclude-standard") {
        return { exitCode: 0, stdout: "" };
      }

      return { exitCode: 0 };
    });

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: add explicit staging",
        generate_tests: false,
        changed_files: ["src/util.ts", "src/index.ts"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true);
    const gitCommand = commandLog.find((command) => command.startsWith("git add "));
    assert.ok(gitCommand);
    assert.doesNotMatch(gitCommand, /git add -A/);
    assert.match(gitCommand, /'src\/index\.ts'/);
    assert.match(gitCommand, /'src\/util\.ts'/);
  });

  test("rejects sensitive files in staging scope", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, () => ({ exitCode: 0 }));

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: block sensitive files",
        generate_tests: false,
        changed_files: [".env"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, "commit_push");
    assert.match(parsed.notes[0], /sensitive files/i);
    assert.equal(commandLog.some((command) => command.startsWith("git add ")), false);
  });

  test("fails when worktree contains unexpected unstaged or untracked changes", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, (command) => {
      if (command === "git diff --name-only --cached") {
        return { exitCode: 0, stdout: "src/index.ts\nsrc/extra.ts\n" };
      }

      if (command === "git diff --name-only" || command === "git ls-files --others --exclude-standard") {
        return { exitCode: 0, stdout: "" };
      }

      return { exitCode: 0 };
    });

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: check unexpected changes",
        generate_tests: false,
        changed_files: ["src/index.ts"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.stage, "commit_push");
    assert.match(parsed.notes[0], /Unexpected changed files/);
    assert.equal(commandLog.some((command) => command.startsWith("git add ")), false);
  });

  test("generates API test scaffold and stages generated file", async () => {
    await writeFixturePackageJson(worktreeRoot);

    const commandLog: string[] = [];
    const runCommand = createRunner(commandLog, (command) => {
      if (command === "git diff --name-only --cached") {
        return { exitCode: 0, stdout: "src/api/user.ts\n" };
      }

      if (command === "git diff --name-only") {
        return { exitCode: 0, stdout: "" };
      }

      if (command === "git ls-files --others --exclude-standard") {
        return { exitCode: 0, stdout: "tests/generated/api/src-api-user.generated.js\n" };
      }

      return { exitCode: 0 };
    });

    const result = await submit_implementation.execute(
      {
        commit_message: "feat: generate api scaffold",
        generate_tests: true,
        changed_files: ["src/api/user.ts"],
      },
      createContext(worktreeRoot, runCommand),
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true);
    assert.match(parsed.generated_tests[0], /tests\/generated\/api\/src-api-user\.generated\.js/);
    const generatedPath = resolve(worktreeRoot, "tests/generated/api/src-api-user.generated.js");
    const generatedContent = await readFile(generatedPath, "utf-8");
    assert.match(generatedContent, /it\.skip/);

    const gitCommand = commandLog.find((command) => command.startsWith("git add "));
    assert.ok(gitCommand);
    assert.match(gitCommand, /tests\/generated\/api\/src-api-user\.generated\.js/);
  });
});

function createRunner(commandLog: string[], resolver: (command: string) => MockCommandResult) {
  return async (_worktreeRoot: string, command: string) => {
    commandLog.push(command);
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
