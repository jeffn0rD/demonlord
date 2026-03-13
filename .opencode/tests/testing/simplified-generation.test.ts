import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import submit_implementation from "../../tools/submit_implementation.ts";

type MockCommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

describe("phase 5.2 simplified test generation", () => {
  test("generates vitest + playwright scaffolds with semantic locators", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-framework-playwright-"));

    try {
      await writePackageJson(worktreeRoot, {
        scripts: {
          lint: "eslint .",
          test: "vitest",
        },
        devDependencies: {
          vitest: "^1.0.0",
          "@playwright/test": "^1.45.0",
          typescript: "^5.0.0",
        },
      });

      const runCommand = createRunner((command) => {
        if (command === "npm run lint" || command === "npm run test") {
          return { exitCode: 0 };
        }

        if (command === "git diff --name-only --cached" || command === "git diff --name-only") {
          return { exitCode: 0, stdout: "" };
        }

        if (command === "git ls-files --others --exclude-standard") {
          return { exitCode: 0, stdout: "" };
        }

        if (command.includes("git add") && command.includes("git commit") && command.includes("git push")) {
          return { exitCode: 0 };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "test: validate playwright scaffold generation",
          generate_tests: true,
          auto_fix: false,
          changed_files: ["src/api/user.ts", "frontend/pages/home.tsx"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.generated_tests.length, 2);
      assert.ok(parsed.generated_tests.some((path: string) => path.endsWith("src-api-user.generated.ts")));
      assert.ok(parsed.generated_tests.some((path: string) => path.endsWith("frontend-pages-home.generated.ts")));

      const apiContent = await readFile(
        resolve(worktreeRoot, "tests/generated/api/src-api-user.generated.ts"),
        "utf-8",
      );
      const e2eContent = await readFile(
        resolve(worktreeRoot, "tests/generated/e2e/frontend-pages-home.generated.ts"),
        "utf-8",
      );

      assert.match(apiContent, /from "vitest"/);
      assert.match(e2eContent, /from "@playwright\/test"/);
      assert.match(e2eContent, /getByTestId\("frontend-pages-home-root"\)/);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  test("generates jest + cypress scaffolds in js projects", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-framework-cypress-"));

    try {
      await writePackageJson(worktreeRoot, {
        scripts: {
          lint: "eslint .",
          test: "jest",
        },
        devDependencies: {
          jest: "^29.0.0",
          cypress: "^13.0.0",
        },
      });

      const runCommand = createRunner((command) => {
        if (command === "npm run lint" || command === "npm run test") {
          return { exitCode: 0 };
        }

        if (command === "git diff --name-only --cached" || command === "git diff --name-only") {
          return { exitCode: 0, stdout: "" };
        }

        if (command === "git ls-files --others --exclude-standard") {
          return { exitCode: 0, stdout: "" };
        }

        if (command.includes("git add") && command.includes("git commit") && command.includes("git push")) {
          return { exitCode: 0 };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "test: validate cypress scaffold generation",
          generate_tests: true,
          auto_fix: false,
          changed_files: ["src/api/session.js", "src/components/login.jsx"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, true);
      assert.ok(parsed.generated_tests.some((path: string) => path.endsWith("src-api-session.generated.js")));
      assert.ok(parsed.generated_tests.some((path: string) => path.endsWith("src-components-login.generated.js")));

      const apiContent = await readFile(
        resolve(worktreeRoot, "tests/generated/api/src-api-session.generated.js"),
        "utf-8",
      );
      const e2eContent = await readFile(
        resolve(worktreeRoot, "tests/generated/e2e/src-components-login.generated.js"),
        "utf-8",
      );

      assert.match(apiContent, /@jest\/globals/);
      assert.match(e2eContent, /cy\.visit\("\/"\)/);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  test("uses snapshot auto-fix loop for jest failures", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-autofix-jest-"));
    let testAttempts = 0;
    const commandLog: string[] = [];

    try {
      await writePackageJson(worktreeRoot, {
        scripts: {
          lint: "eslint .",
          test: "jest",
        },
        devDependencies: {
          jest: "^29.0.0",
        },
      });

      const runCommand = createRunner((command) => {
        commandLog.push(command);

        if (command === "npm run lint") {
          return { exitCode: 0 };
        }

        if (command === "npm run test") {
          testAttempts += 1;
          if (testAttempts === 1) {
            return { exitCode: 1, stderr: "Snapshot mismatch" };
          }
          return { exitCode: 0 };
        }

        if (command === "npm run test -- --updateSnapshot") {
          return { exitCode: 0 };
        }

        if (command === "git diff --name-only --cached" || command === "git diff --name-only") {
          return { exitCode: 0, stdout: "" };
        }

        if (command === "git ls-files --others --exclude-standard") {
          return { exitCode: 0, stdout: "" };
        }

        if (command.includes("git add") && command.includes("git commit") && command.includes("git push")) {
          return { exitCode: 0 };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "test: validate jest snapshot autofix workflow",
          generate_tests: false,
          auto_fix: true,
          changed_files: ["src/api/snapshots.ts"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, true);
      assert.ok(parsed.auto_fix_actions.some((action: string) => action.includes("updateSnapshot")));
      assert.equal(commandLog.includes("npm run test -- --updateSnapshot"), true);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  test("does not attempt snapshot auto-fix for unknown API runner", async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), "submit-autofix-unknown-"));
    const commandLog: string[] = [];

    try {
      await writePackageJson(worktreeRoot, {
        scripts: {
          lint: "eslint .",
          test: "custom-runner",
        },
        devDependencies: {},
      });

      const runCommand = createRunner((command) => {
        commandLog.push(command);

        if (command === "npm run lint") {
          return { exitCode: 0 };
        }

        if (command === "npm run test") {
          return { exitCode: 1, stderr: "Custom framework failure" };
        }

        return { exitCode: 0 };
      });

      const result = await submit_implementation.execute(
        {
          commit_message: "test: validate unknown runner autofix behavior",
          generate_tests: false,
          auto_fix: true,
          changed_files: ["src/service/health.ts"],
        },
        createContext(worktreeRoot, runCommand),
      );

      const parsed = JSON.parse(result);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.stage, "test");
      assert.equal(commandLog.some((command) => command.includes("updateSnapshot")), false);
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true });
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

async function writePackageJson(
  worktreeRoot: string,
  payload: {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  },
): Promise<void> {
  await writeFile(
    resolve(worktreeRoot, "package.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
}
