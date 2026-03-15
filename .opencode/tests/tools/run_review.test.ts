import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { __runReviewTestUtils, executeRunReview } from "../../tools/run_review.ts";

interface RuntimeInvocation {
  title: string;
  command: string;
  arguments: string;
  agent: "reviewer";
  model?: string;
}

describe("run_review tool", () => {
  test("normalizes review names and expected markers", () => {
    assert.equal(__runReviewTestUtils.normalizeReviewName("/creview"), "creview");
    assert.equal(__runReviewTestUtils.normalizeReviewName("phreview"), "phreview");
    assert.equal(__runReviewTestUtils.normalizeReviewName("repair"), null);
    assert.equal(__runReviewTestUtils.resolveExpectedMarker("future-review"), "CYCLE_FUTURE_REVIEW_RESULT");
  });

  test("parses /run-review command arguments for creview with hint, phase override, and dry-run", () => {
    const parsed = __runReviewTestUtils.parseRunReviewCommandArguments(
      'creview beelzebub 1.5 "focus marker parsing" PHASE-1 dry-run',
    );

    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.equal(parsed.args.review, "creview");
    assert.equal(parsed.args.parameter_1, "beelzebub");
    assert.equal(parsed.args.parameter_2, "1.5");
    assert.equal(parsed.args.hint, "focus marker parsing");
    assert.equal(parsed.args.phase, "PHASE-1");
    assert.equal(parsed.args.dry_run, true);
  });

  test("parses /run-review command arguments for mreview with quoted module target", () => {
    const parsed = __runReviewTestUtils.parseRunReviewCommandArguments(
      'mreview ".opencode/tools/run review.ts" "TypeError in parser"',
    );

    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.equal(parsed.args.review, "mreview");
    assert.equal(parsed.args.parameter_1, ".opencode/tools/run review.ts");
    assert.equal(parsed.args.hint, "TypeError in parser");
    assert.equal(parsed.args.phase, undefined);
    assert.equal(parsed.args.dry_run, undefined);
  });

  test("runs creview, parses marker, and persists incremented round artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-creview-"));
    await mkdir(resolve(root, "_bmad-output", "cycle-state", "reviews"), { recursive: true });
    await writeFile(
      resolve(root, "_bmad-output", "cycle-state", "reviews", "alpha-phase-1-subphase-1-2-round-1.json"),
      JSON.stringify({ prior: true }, null, 2),
      "utf-8",
    );

    const runtime = createMockRuntime([
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", codename: "alpha", target: "1.2" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "creview",
          parameter_1: "alpha",
          parameter_2: "1.2",
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.review_status, "pass");
      assert.equal(result.round, 2);
      assert.equal(runtime.invocations.length, 1);
      assert.equal(runtime.invocations[0]?.command, "creview");
      assert.equal(runtime.invocations[0]?.arguments, "alpha 1.2");

      const artifactPath = resolve(root, result.artifact_path ?? "");
      const artifact = JSON.parse(await readFile(artifactPath, "utf-8")) as {
        review_type: string;
        phase: string;
        subphase: string;
        review_status: string;
        round: number;
      };
      assert.equal(artifact.review_type, "creview");
      assert.equal(artifact.phase, "1");
      assert.equal(artifact.subphase, "1.2");
      assert.equal(artifact.review_status, "pass");
      assert.equal(artifact.round, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails creview when output marker family does not match expected marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-marker-mismatch-"));
    const runtime = createMockRuntime([
      marker("CYCLE_MREVIEW_RESULT", { status: "pass", target: "src/module.ts" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "creview",
          parameter_1: "alpha",
          parameter_2: "1.2",
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, false);
      assert.equal(result.marker_name, "CYCLE_MREVIEW_RESULT");
      assert.match(result.marker_error ?? "", /Expected CYCLE_CREVIEW_RESULT marker but found CYCLE_MREVIEW_RESULT\./);
      assert.equal(result.code, "INVALID_INPUT");
      assert.equal(typeof result.artifact_path, "string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allocates unique artifact rounds under concurrent executions", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-round-concurrency-"));
    const runtimeA = createMockRuntime([
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", codename: "alpha", target: "1.2" }),
    ]);
    const runtimeB = createMockRuntime([
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", codename: "alpha", target: "1.2" }),
    ]);

    try {
      const [resultA, resultB] = await Promise.all([
        executeRunReview(
          {
            review: "creview",
            parameter_1: "alpha",
            parameter_2: "1.2",
          },
          { directory: root, worktree: root },
          runtimeA,
        ),
        executeRunReview(
          {
            review: "creview",
            parameter_1: "alpha",
            parameter_2: "1.2",
          },
          { directory: root, worktree: root },
          runtimeB,
        ),
      ]);

      assert.equal(resultA.ok, true);
      assert.equal(resultB.ok, true);
      assert.notEqual(resultA.round, resultB.round);
      assert.notEqual(resultA.artifact_path, resultB.artifact_path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("infers active phase for mreview from tasklist when no explicit phase provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-mreview-phase-"));
    await mkdir(resolve(root, "agents"), { recursive: true });
    await writeFile(resolve(root, "agents", "alpha_Tasklist.md"), buildTasklistFixture(), "utf-8");

    const runtime = createMockRuntime([
      marker("CYCLE_MREVIEW_RESULT", { status: "pass", target: "src/module.ts" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "mreview",
          parameter_1: "src/module.ts",
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.phase, "2");
      assert.match(result.artifact_path ?? "", /module-phase-2-src-module-ts-round-1\.json$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports explicit phase override for mreview", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-mreview-override-"));
    await mkdir(resolve(root, "agents"), { recursive: true });
    await writeFile(resolve(root, "agents", "alpha_Tasklist.md"), buildTasklistFixture(), "utf-8");

    const runtime = createMockRuntime([
      marker("CYCLE_MREVIEW_RESULT", { status: "pass", target: "src/module.ts" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "mreview",
          parameter_1: "src/module.ts",
          phase: "PHASE-4",
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.phase, "4");
      assert.match(result.artifact_path ?? "", /module-phase-4-src-module-ts-round-1\.json$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects highest active phase across tasklists deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-mreview-multi-tasklist-"));
    await mkdir(resolve(root, "agents"), { recursive: true });
    await writeFile(resolve(root, "agents", "alpha_Tasklist.md"), buildTasklistFixtureForActivePhase("2"), "utf-8");
    await writeFile(resolve(root, "agents", "zeta_Tasklist.md"), buildTasklistFixtureForActivePhase("5"), "utf-8");

    const runtime = createMockRuntime([
      marker("CYCLE_MREVIEW_RESULT", { status: "pass", target: "src/module.ts" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "mreview",
          parameter_1: "src/module.ts",
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.phase, "5");
      assert.match(result.artifact_path ?? "", /module-phase-5-src-module-ts-round-1\.json$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dry-run previews without executing runtime or writing artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-review-dryrun-"));
    const runtime = createMockRuntime([
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", codename: "alpha", target: "1.2" }),
    ]);

    try {
      const result = await executeRunReview(
        {
          review: "creview",
          parameter_1: "alpha",
          parameter_2: "1.2",
          hint: "focus on retries",
          dry_run: true,
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.dry_run, true);
      assert.equal(runtime.invocations.length, 0);
      assert.equal(result.artifact_path?.includes("round-1.json"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createMockRuntime(outputs: string[]): { runCommand: (input: RuntimeInvocation) => Promise<{ sessionID: string; outputText: string }>; invocations: RuntimeInvocation[] } {
  const invocations: RuntimeInvocation[] = [];
  let index = 0;

  return {
    invocations,
    async runCommand(input: RuntimeInvocation): Promise<{ sessionID: string; outputText: string }> {
      invocations.push(input);
      const outputText = outputs[index] ?? "";
      index += 1;

      return {
        sessionID: `session-${index}`,
        outputText,
      };
    },
  };
}

function marker(name: string, payload: Record<string, unknown>): string {
  return `<!-- ${name}\n${JSON.stringify(payload)}\n-->`;
}

function buildTasklistFixture(): string {
  return [
    "# Tasklist",
    "",
    "## PHASE-1",
    "<!-- PHASE:1 -->",
    "<!-- SUBPHASE:1.1 -->",
    "- [x] **T-1.1.1** done",
    "",
    "## PHASE-2",
    "<!-- PHASE:2 -->",
    "<!-- SUBPHASE:2.1 -->",
    "- [ ] **T-2.1.1** pending",
  ].join("\n");
}

function buildTasklistFixtureForActivePhase(activePhase: string): string {
  return [
    "# Tasklist",
    "",
    "## PHASE-1",
    "<!-- PHASE:1 -->",
    "<!-- SUBPHASE:1.1 -->",
    activePhase === "1" ? "- [ ] **T-1.1.1** pending" : "- [x] **T-1.1.1** done",
    "",
    "## PHASE-2",
    "<!-- PHASE:2 -->",
    "<!-- SUBPHASE:2.1 -->",
    activePhase === "2" ? "- [ ] **T-2.1.1** pending" : "- [x] **T-2.1.1** done",
    "",
    "## PHASE-5",
    "<!-- PHASE:5 -->",
    "<!-- SUBPHASE:5.1 -->",
    activePhase === "5" ? "- [ ] **T-5.1.1** pending" : "- [x] **T-5.1.1** done",
  ].join("\n");
}
