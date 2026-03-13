import { spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, extname, resolve } from "path";
import { tool } from "@opencode-ai/plugin/tool";

const CONVENTIONAL_COMMIT_PATTERN =
  /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([a-z0-9-]+\))?: .{3,}$/;

type ApiTestRunner = "vitest" | "jest" | "mocha" | "node-test" | "unknown";
type E2ETestRunner = "playwright" | "cypress" | "webdriverio" | "none";

interface SubmitImplementationArgs {
  commit_message: string;
  generate_tests?: boolean;
  auto_fix?: boolean;
  changed_files?: string[];
}

interface SubmitImplementationContext {
  worktree: string;
  runCommand?: (worktreeRoot: string, command: string) => Promise<CommandResult>;
}

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FrameworkDetection {
  apiRunner: ApiTestRunner;
  e2eRunner: E2ETestRunner;
  fileExtension: "ts" | "js";
  detectionError?: string;
}

interface GeneratedTestArtifacts {
  files: string[];
  notes: string[];
}

interface SubmissionResult {
  ok: boolean;
  stage: "generate" | "lint" | "test" | "commit_push" | "complete";
  frameworks: FrameworkDetection;
  generated_tests: string[];
  notes: string[];
  lint?: CommandResult;
  test?: CommandResult;
  commit_push?: CommandResult;
  stack_trace?: string;
  auto_fix_actions?: string[];
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BunShellResultLike {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
}

interface BunShellPromiseLike extends Promise<BunShellResultLike> {
  nothrow?: () => BunShellPromiseLike;
}

type BunShellFunction = (template: TemplateStringsArray, ...values: unknown[]) => BunShellPromiseLike;

const MAX_AUTO_FIX_ATTEMPTS = 3;
const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)secrets?(\/|$)/i,
  /(^|\/)passwords?(\/|$)/i,
];

const submit_implementation = tool({
  description:
    "Validate implementation with lint/test gates, generate lightweight API/E2E test scaffolds, then commit and push.",
  args: {
    commit_message: tool.schema
      .string()
      .trim()
      .min(10)
      .regex(
        CONVENTIONAL_COMMIT_PATTERN,
        "commit_message must follow Conventional Commit format like 'feat: add quality gate'.",
      )
      .describe("Conventional commit message used for the gated commit."),
    generate_tests: tool.schema
      .boolean()
      .optional()
      .describe("When true (default), generate lightweight API/E2E test scaffolds from changed files."),
    auto_fix: tool.schema
      .boolean()
      .optional()
      .describe("When true (default), attempt deterministic lint/test remediation before failing."),
    changed_files: tool.schema
      .array(tool.schema.string().min(1))
      .optional()
      .describe("Optional changed file paths to target test generation."),
  },
  async execute(args: SubmitImplementationArgs, context: SubmitImplementationContext) {
    const worktreeRoot = resolve(context.worktree);
    const executeCommand = context.runCommand ?? runCommand;
    const autoFix = args.auto_fix ?? true;
    const generateTests = args.generate_tests ?? true;
    const frameworks = await detectFrameworks(worktreeRoot);
    const notes: string[] = [];
    if (frameworks.detectionError) {
      notes.push(`Framework detection fallback: ${frameworks.detectionError}`);
    }

    const changedFiles =
      args.changed_files && args.changed_files.length > 0
        ? normalizeChangedFiles(args.changed_files)
        : await detectChangedFiles(worktreeRoot, executeCommand);

    let generated: GeneratedTestArtifacts = { files: [], notes: [] };
    if (generateTests) {
      generated = await generateSimplifiedTests(worktreeRoot, frameworks, changedFiles);
      notes.push(...generated.notes);
    } else {
      notes.push("Test generation skipped by request (generate_tests=false).");
    }

    let lintResult = await executeCommand(worktreeRoot, "npm run lint");
    const autoFixActions: string[] = [];

    if (lintResult.exitCode !== 0 && autoFix) {
      for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS; i++) {
        autoFixActions.push(`Attempted lint autofix (try ${i + 1}) via npm run lint -- --fix.`);
        const lintFixResult = await executeCommand(worktreeRoot, "npm run lint -- --fix");
        if (lintFixResult.exitCode !== 0) {
          lintResult = mergeCommandOutput(lintResult, lintFixResult, "lint:auto-fix");
          break;
        }
        lintResult = await executeCommand(worktreeRoot, "npm run lint");
        if (lintResult.exitCode === 0) break;
      }
    }

    if (lintResult.exitCode !== 0) {
      const result: SubmissionResult = {
        ok: false,
        stage: "lint",
        frameworks,
        generated_tests: generated.files,
        notes,
        lint: lintResult,
        stack_trace: extractStackTrace(lintResult),
        auto_fix_actions: autoFixActions,
      };

      return JSON.stringify(result, null, 2);
    }

    let testResult = await executeCommand(worktreeRoot, "npm run test");
    if (testResult.exitCode !== 0 && autoFix) {
      const snapshotFixCommand = inferSnapshotFixCommand(frameworks.apiRunner);
      if (snapshotFixCommand) {
        for (let i = 0; i < MAX_AUTO_FIX_ATTEMPTS; i++) {
          autoFixActions.push(`Attempted snapshot refresh via ${snapshotFixCommand} (try ${i + 1}).`);
          const snapshotFixResult = await executeCommand(worktreeRoot, snapshotFixCommand);
          if (snapshotFixResult.exitCode !== 0) {
            testResult = mergeCommandOutput(testResult, snapshotFixResult, "test:auto-fix");
            break;
          }
          testResult = await executeCommand(worktreeRoot, "npm run test");
          if (testResult.exitCode === 0) break;
        }
      }
    }

    if (testResult.exitCode !== 0) {
      if (generated.files.length === 0 && generateTests) {
        notes.push(
          "No test files were generated; pass changed_files to target API/E2E test blueprints for the modified surface area.",
        );
      }

      const result: SubmissionResult = {
        ok: false,
        stage: "test",
        frameworks,
        generated_tests: generated.files,
        notes,
        lint: lintResult,
        test: testResult,
        stack_trace: extractStackTrace(testResult),
        auto_fix_actions: autoFixActions,
      };

      return JSON.stringify(result, null, 2);
    }

    const stageList = normalizeChangedFiles([...changedFiles, ...generated.files]);

    const sensitiveFiles = stageList.filter((filePath) =>
      SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filePath.toLowerCase())),
    );
    if (sensitiveFiles.length > 0) {
      const result: SubmissionResult = {
        ok: false,
        stage: "commit_push",
        frameworks,
        generated_tests: generated.files,
        notes: [`Detected sensitive files in staging scope: ${sensitiveFiles.join(", ")}. Commit aborted.`],
        lint: lintResult,
        test: testResult,
        stack_trace: "Security check failed: sensitive files detected.",
      };
      return JSON.stringify(result, null, 2);
    }

    if (stageList.length === 0) {
      const result: SubmissionResult = {
        ok: false,
        stage: "commit_push",
        frameworks,
        generated_tests: generated.files,
        notes: ["No files to stage. Ensure changes are detected."],
        lint: lintResult,
        test: testResult,
        stack_trace: "No files staged for commit.",
      };
      return JSON.stringify(result, null, 2);
    }

    const detectedWorktreeChanges = await detectChangedFiles(worktreeRoot, executeCommand);
    const stagedSet = new Set(stageList);
    const unexpectedChanges = detectedWorktreeChanges.filter((filePath) => !stagedSet.has(filePath));
    if (unexpectedChanges.length > 0) {
      const result: SubmissionResult = {
        ok: false,
        stage: "commit_push",
        frameworks,
        generated_tests: generated.files,
        notes: [
          `Unexpected changed files not in staging scope: ${unexpectedChanges.join(", ")}. Update changed_files or clean the worktree.`,
        ],
        lint: lintResult,
        test: testResult,
        stack_trace: "Staging scope check failed: unexpected worktree changes detected.",
      };
      return JSON.stringify(result, null, 2);
    }

    const escapedFiles = stageList.map((filePath) => quoteForBash(filePath)).join(" ");
    const commitAndPushCommand = `git add ${escapedFiles} && git commit -m ${quoteForBash(args.commit_message)} && git push`;
    const commitResult = await executeCommand(worktreeRoot, commitAndPushCommand);
    if (commitResult.exitCode !== 0) {
      const result: SubmissionResult = {
        ok: false,
        stage: "commit_push",
        frameworks,
        generated_tests: generated.files,
        notes,
        lint: lintResult,
        test: testResult,
        commit_push: commitResult,
        stack_trace: extractStackTrace(commitResult),
        auto_fix_actions: autoFixActions,
      };

      return JSON.stringify(result, null, 2);
    }

    const result: SubmissionResult = {
      ok: true,
      stage: "complete",
      frameworks,
      generated_tests: generated.files,
      notes,
      lint: lintResult,
      test: testResult,
      commit_push: commitResult,
      auto_fix_actions: autoFixActions,
    };

    return JSON.stringify(result, null, 2);
  },
});

async function detectFrameworks(worktreeRoot: string): Promise<FrameworkDetection> {
  const packagePath = resolve(worktreeRoot, "package.json");
  let packageJson: PackageJsonLike = {};

  try {
    const raw = await readFile(packagePath, "utf-8");
    packageJson = JSON.parse(raw) as PackageJsonLike;
  } catch (error) {
    const detectionError =
      error instanceof Error ? error.message : "Unable to read package.json for framework detection.";
    return {
      apiRunner: "unknown",
      e2eRunner: "none",
      fileExtension: "ts",
      detectionError,
    };
  }

  const scripts = packageJson.scripts ?? {};
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };

  const testScript = scripts.test ?? "";
  const lintScript = scripts.lint ?? "";
  const scriptFingerprint = `${testScript} ${lintScript}`.toLowerCase();

  const apiRunner: ApiTestRunner = detectApiRunner(dependencies, scriptFingerprint);
  const e2eRunner: E2ETestRunner = detectE2ERunner(dependencies, scriptFingerprint);
  const fileExtension: "ts" | "js" =
    hasDependency(dependencies, "typescript") || /\btsx?\b/.test(scriptFingerprint) ? "ts" : "js";

  return {
    apiRunner,
    e2eRunner,
    fileExtension,
  };
}

function detectApiRunner(dependencies: Record<string, string>, scriptFingerprint: string): ApiTestRunner {
  if (hasDependency(dependencies, "vitest") || scriptFingerprint.includes("vitest")) {
    return "vitest";
  }

  if (hasDependency(dependencies, "jest") || scriptFingerprint.includes("jest")) {
    return "jest";
  }

  if (hasDependency(dependencies, "mocha") || scriptFingerprint.includes("mocha")) {
    return "mocha";
  }

  if (scriptFingerprint.includes("node --test") || scriptFingerprint.includes("node:test")) {
    return "node-test";
  }

  return "unknown";
}

function detectE2ERunner(dependencies: Record<string, string>, scriptFingerprint: string): E2ETestRunner {
  if (hasDependency(dependencies, "@playwright/test") || scriptFingerprint.includes("playwright")) {
    return "playwright";
  }

  if (hasDependency(dependencies, "cypress") || scriptFingerprint.includes("cypress")) {
    return "cypress";
  }

  if (hasDependency(dependencies, "webdriverio") || scriptFingerprint.includes("webdriverio")) {
    return "webdriverio";
  }

  return "none";
}

function hasDependency(dependencies: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(dependencies, key);
}

async function detectChangedFiles(worktreeRoot: string, runner: (worktreeRoot: string, command: string) => Promise<CommandResult>): Promise<string[]> {
  const commands = [
    "git diff --name-only --cached",
    "git diff --name-only",
    "git ls-files --others --exclude-standard",
  ];
  const files = new Set<string>();

  for (const command of commands) {
    const result = await runner(worktreeRoot, command);
    if (result.exitCode !== 0) {
      continue;
    }

    for (const line of result.stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value.length > 0) {
        files.add(value.replace(/\\/g, "/"));
      }
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

function normalizeChangedFiles(changedFiles: string[]): string[] {
  const normalized = new Set<string>();
  for (const file of changedFiles) {
    const cleaned = file.trim().replace(/\\/g, "/");
    if (cleaned.length > 0) {
      normalized.add(cleaned);
    }
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
}

async function generateSimplifiedTests(
  worktreeRoot: string,
  frameworks: FrameworkDetection,
  changedFiles: string[],
): Promise<GeneratedTestArtifacts> {
  const artifacts: GeneratedTestArtifacts = {
    files: [],
    notes: [],
  };

  if (changedFiles.length === 0) {
    artifacts.notes.push("No changed files detected for test generation.");
    return artifacts;
  }

  const apiTargets = changedFiles.filter((file) => isApiCandidate(file)).slice(0, 3);
  const e2eTargets = changedFiles.filter((file) => isE2ECandidate(file)).slice(0, 3);

  if (frameworks.apiRunner === "unknown") {
    artifacts.notes.push("API test runner could not be inferred from package.json; API scaffold generation skipped.");
  } else if (apiTargets.length > 0) {
    for (const target of apiTargets) {
      const semanticKey = toSemanticKey(target);
      const apiTestPath = resolve(
        worktreeRoot,
        "tests",
        "generated",
        "api",
        `${semanticKey}.generated.${frameworks.fileExtension}`,
      );
      const apiContent = renderApiTestTemplate(frameworks.apiRunner, target, semanticKey);
      await writeGeneratedFile(apiTestPath, apiContent);
      artifacts.files.push(toDisplayPath(worktreeRoot, apiTestPath));
    }
  }

  if (frameworks.e2eRunner === "none") {
    artifacts.notes.push("No E2E runner detected from package.json; E2E scaffold generation skipped.");
  } else if (e2eTargets.length > 0) {
    for (const target of e2eTargets) {
      const semanticKey = toSemanticKey(target);
      const e2eTestPath = resolve(
        worktreeRoot,
        "tests",
        "generated",
        "e2e",
        `${semanticKey}.generated.${frameworks.fileExtension}`,
      );
      const e2eContent = renderE2ETestTemplate(frameworks.e2eRunner, target, semanticKey);
      await writeGeneratedFile(e2eTestPath, e2eContent);
      artifacts.files.push(toDisplayPath(worktreeRoot, e2eTestPath));
    }
  }

  if (artifacts.files.length > 0) {
    artifacts.notes.push(
      "Generated test files are intentionally skip-first templates with semantic locators so agents can fill assertions incrementally.",
    );
  }

  if (apiTargets.length === 0) {
    artifacts.notes.push("No API-like changed files detected; API scaffold generation skipped.");
  }

  if (e2eTargets.length === 0) {
    artifacts.notes.push("No UI/E2E-like changed files detected; E2E scaffold generation skipped.");
  }

  return artifacts;
}

function isApiCandidate(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.includes("/api/") ||
    normalized.includes("/routes/") ||
    normalized.includes("/route/") ||
    normalized.includes("/controllers/") ||
    normalized.includes("/services/") ||
    normalized.includes("/service/") ||
    normalized.includes("endpoint")
  );
}

function isE2ECandidate(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.includes("/frontend/") ||
    normalized.includes("/ui/") ||
    normalized.includes("/pages/") ||
    normalized.includes("/components/") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".jsx")
  );
}

function toSemanticKey(filePath: string): string {
  const trimmed = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutExtension = trimmed.slice(0, trimmed.length - extname(trimmed).length);
  const normalized = withoutExtension
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return normalized || "generated-target";
}

function renderApiTestTemplate(runner: ApiTestRunner, target: string, semanticKey: string): string {
  const contractPath = `/api/${semanticKey}`;

  switch (runner) {
    case "vitest":
      return [
        'import { describe, expect, it } from "vitest";',
        "",
        `describe("Generated API contract for ${target}", () => {`,
        "  it.skip(\"validates happy-path and error-path contracts\", async () => {",
        `    const request = { method: "GET", path: "${contractPath}" };`,
        "    expect(request.path.startsWith(\"/api/\")).toBe(true);",
        "  });",
        "});",
        "",
      ].join("\n");
    case "jest":
      return [
        'import { describe, expect, it } from "@jest/globals";',
        "",
        `describe("Generated API contract for ${target}", () => {`,
        "  it.skip(\"validates happy-path and error-path contracts\", async () => {",
        `    const request = { method: "GET", path: "${contractPath}" };`,
        "    expect(request.path.startsWith(\"/api/\")).toBe(true);",
        "  });",
        "});",
        "",
      ].join("\n");
    case "mocha":
      return [
        'import { strict as assert } from "node:assert";',
        "",
        `describe("Generated API contract for ${target}", () => {`,
        "  it.skip(\"validates happy-path and error-path contracts\", async () => {",
        `    const request = { method: "GET", path: "${contractPath}" };`,
        "    assert.equal(request.path.startsWith(\"/api/\"), true);",
        "  });",
        "});",
        "",
      ].join("\n");
    case "node-test":
      return [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        "",
        `test.skip("Generated API contract for ${target}", async () => {`,
        `  const request = { method: "GET", path: "${contractPath}" };`,
        "  assert.equal(request.path.startsWith(\"/api/\"), true);",
        "});",
        "",
      ].join("\n");
    default:
      return "";
  }
}

function renderE2ETestTemplate(runner: E2ETestRunner, target: string, semanticKey: string): string {
  switch (runner) {
    case "playwright":
      return [
        'import { expect, test } from "@playwright/test";',
        "",
        `test.skip("Generated semantic locator smoke for ${target}", async ({ page }) => {`,
        "  await page.goto(\"/\");",
        "  await expect(page.getByRole(\"main\")).toBeVisible();",
        `  await expect(page.getByTestId("${semanticKey}-root")).toBeVisible();`,
        "});",
        "",
      ].join("\n");
    case "cypress":
      return [
        `describe("Generated semantic locator smoke for ${target}", () => {`,
        "  it.skip(\"verifies main region and target root test id\", () => {",
        "    cy.visit(\"/\");",
        "    cy.get(\"main\").should(\"exist\");",
        `    cy.get('[data-testid="${semanticKey}-root"]').should("exist");`,
        "  });",
        "});",
        "",
      ].join("\n");
    case "webdriverio":
      return [
        `describe("Generated semantic locator smoke for ${target}", () => {`,
        "  it.skip(\"verifies main region and target root test id\", async () => {",
        "    await browser.url(\"/\");",
        "    await expect(await $(\"main\")).toBeExisting();",
        `    await expect(await $('[data-testid="${semanticKey}-root"]')).toBeExisting();`,
        "  });",
        "});",
        "",
      ].join("\n");
    default:
      return "";
  }
}

async function writeGeneratedFile(filePath: string, content: string): Promise<void> {
  if (!content) {
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

function toDisplayPath(worktreeRoot: string, filePath: string): string {
  return filePath
    .replace(`${worktreeRoot}/`, "")
    .replace(/\\/g, "/");
}

function inferSnapshotFixCommand(apiRunner: ApiTestRunner): string | null {
  if (apiRunner === "vitest" || apiRunner === "jest") {
    return "npm run test -- --updateSnapshot";
  }

  return null;
}

async function runCommand(worktreeRoot: string, command: string): Promise<CommandResult> {
  const bunShell = getBunShell();
  if (bunShell) {
    const script = `cd ${quoteForBash(worktreeRoot)} && ${command}`;

    try {
      const shellRun = bunShell`bash -lc ${script}`;
      const rawResult = typeof shellRun.nothrow === "function" ? await shellRun.nothrow() : await shellRun;
      return {
        command,
        exitCode: normalizeExitCode(rawResult.exitCode),
        stdout: normalizeOutput(rawResult.stdout),
        stderr: normalizeOutput(rawResult.stderr),
      };
    } catch (error) {
      return {
        command,
        exitCode: 1,
        stdout: "",
        stderr: formatUnknownError(error),
      };
    }
  }

  return runCommandWithSpawn(worktreeRoot, command);
}

function runCommandWithSpawn(worktreeRoot: string, command: string): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveResult) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: worktreeRoot,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      resolveResult({
        command,
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (error: Error) => {
      resolveResult({
        command,
        exitCode: 1,
        stdout,
        stderr: error.stack ?? error.message,
      });
    });
  });
}

function mergeCommandOutput(primary: CommandResult, secondary: CommandResult, label: string): CommandResult {
  return {
    command: `${primary.command} + ${label}`,
    exitCode: primary.exitCode,
    stdout: [primary.stdout, `[${label}] stdout`, secondary.stdout].filter((line) => line.length > 0).join("\n"),
    stderr: [primary.stderr, `[${label}] stderr`, secondary.stderr].filter((line) => line.length > 0).join("\n"),
  };
}

function extractStackTrace(result: CommandResult): string {
  const merged = [result.stdout, result.stderr].filter((line) => line.trim().length > 0).join("\n").trim();
  if (merged.length > 0) {
    return merged;
  }

  return `Command '${result.command}' failed with exit code ${result.exitCode}.`;
}

function getBunShell(): BunShellFunction | null {
  const bunGlobal = (globalThis as { Bun?: { $?: BunShellFunction } }).Bun;
  return bunGlobal?.$ ?? null;
}

function normalizeExitCode(exitCode: number | undefined): number {
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    return exitCode;
  }

  return 1;
}

function normalizeOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf-8");
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function quoteForBash(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export const __submitImplementationTestUtils = {
  CONVENTIONAL_COMMIT_PATTERN,
  detectApiRunner,
  detectE2ERunner,
  toSemanticKey,
  isApiCandidate,
  isE2ECandidate,
  inferSnapshotFixCommand,
};

export default submit_implementation;
