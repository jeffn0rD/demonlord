import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { __cycleRunnerTestUtils, runCycle } from "../../tools/cycle_runner.ts";

interface RuntimeInvocation {
  title: string;
  command: string;
  arguments: string;
  agent: "orchestrator" | "minion" | "reviewer";
}

describe("cycle_runner tool", () => {
  test("normalizes phase selectors from phase and subphase values", () => {
    assert.equal(__cycleRunnerTestUtils.normalizePhaseSelector("1"), "1");
    assert.equal(__cycleRunnerTestUtils.normalizePhaseSelector("PHASE-2"), "2");
    assert.equal(__cycleRunnerTestUtils.normalizePhaseSelector("SUBPHASE-3.4A"), "3");
    assert.equal(__cycleRunnerTestUtils.normalizePhaseSelector("bogus"), null);
  });

  test("parses subphases and detects completion from task checkboxes", () => {
    const parsed = __cycleRunnerTestUtils.parseSubphasesForPhase(buildTasklistFixture(), "1");
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.id, "1.1");
    assert.equal(parsed[0]?.completed, true);
    assert.equal(parsed[1]?.id, "1.2");
    assert.equal(parsed[1]?.completed, false);
    assert.deepEqual(parsed[1]?.taskRefs, ["T-1.2.1", "T-1.2.2"]);
  });

  test("supports dry-run without spawning command sessions", async () => {
    const root = await prepareWorkspace("alpha");
    const runtime = createMockRuntime([]);

    try {
      const result = await runCycle(
        {
          codename: "alpha",
          phase: "PHASE-1",
          dry_run: true,
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, "dry_run");
      assert.deepEqual(result.subphases, ["1.2"]);
      assert.equal(runtime.invocations.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs implement then review for a passing subphase", async () => {
    const root = await prepareWorkspace("alpha");
    const runtime = createMockRuntime([
      marker("CYCLE_IMPLEMENT_RESULT", { status: "ok", subphase: "1.2" }),
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", target: "1.2" }),
    ]);

    try {
      const result = await runCycle(
        {
          codename: "alpha",
          phase: "1",
          max_repair_rounds: 2,
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.equal(result.status, "completed");
      assert.deepEqual(runtime.invocations.map((item) => item.command), ["implement", "creview"]);
      assert.equal(runtime.invocations[0]?.arguments, "alpha 1.2");
      assert.equal(runtime.invocations[1]?.arguments, "alpha 1.2");

      const statePath = resolve(root, "_bmad-output", "cycle-state", "alpha-phase-1.json");
      const persisted = JSON.parse(await readFile(statePath, "utf-8")) as {
        status: string;
        subphases: Record<string, { status: string }>;
      };
      assert.equal(persisted.status, "completed");
      assert.equal(persisted.subphases["1.2"]?.status, "passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runs review-repair loop when review fails then passes", async () => {
    const root = await prepareWorkspace("alpha");
    const runtime = createMockRuntime([
      marker("CYCLE_IMPLEMENT_RESULT", { status: "ok", subphase: "1.2" }),
      marker("CYCLE_CREVIEW_RESULT", { status: "fail", target: "1.2" }),
      marker("CYCLE_REPAIR_RESULT", { status: "ok", target: "1.2" }),
      marker("CYCLE_CREVIEW_RESULT", { status: "pass", target: "1.2" }),
    ]);

    try {
      const result = await runCycle(
        {
          codename: "alpha",
          phase: "1",
          max_repair_rounds: 2,
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, true);
      assert.deepEqual(runtime.invocations.map((item) => item.command), ["implement", "creview", "repair", "creview"]);

      const repairArgs = runtime.invocations[2]?.arguments ?? "";
      const repairArgParts = repairArgs.split(/\s+/);
      assert.equal(repairArgParts.length >= 3, true);
      const reviewArtifactPath = resolve(root, repairArgParts[2] ?? "");
      const artifactRaw = await readFile(reviewArtifactPath, "utf-8");
      const artifact = JSON.parse(artifactRaw) as { review_status: string };
      assert.equal(artifact.review_status, "fail");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when max repair rounds are exceeded", async () => {
    const root = await prepareWorkspace("alpha");
    const runtime = createMockRuntime([
      marker("CYCLE_IMPLEMENT_RESULT", { status: "ok", subphase: "1.2" }),
      marker("CYCLE_CREVIEW_RESULT", { status: "fail", target: "1.2" }),
      marker("CYCLE_REPAIR_RESULT", { status: "ok", target: "1.2" }),
      marker("CYCLE_CREVIEW_RESULT", { status: "fail", target: "1.2" }),
    ]);

    try {
      const result = await runCycle(
        {
          codename: "alpha",
          phase: "1",
          max_repair_rounds: 1,
        },
        { directory: root, worktree: root },
        runtime,
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.match(result.failure_reason ?? "", /exceeded max_repair_rounds=1/i);
      assert.deepEqual(runtime.invocations.map((item) => item.command), ["implement", "creview", "repair", "creview"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function prepareWorkspace(codename: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cycle-runner-"));
  await mkdir(resolve(root, "agents"), { recursive: true });
  const tasklistPath = resolve(root, "agents", `${codename}_Tasklist.md`);
  await writeFile(tasklistPath, buildTasklistFixture(), "utf-8");
  return root;
}

function buildTasklistFixture(): string {
  return [
    "# Tasklist",
    "",
    "## PHASE-1",
    "<!-- PHASE:1 -->",
    "",
    "### SUBPHASE-1.1",
    "<!-- SUBPHASE:1.1 -->",
    "**Tasks:**",
    "<!-- TASK:T-1.1.1 -->",
    "- [x] **T-1.1.1** done",
    "",
    "### SUBPHASE-1.2",
    "<!-- SUBPHASE:1.2 -->",
    "**Tasks:**",
    "<!-- TASK:T-1.2.1 -->",
    "- **T-1.2.1** pending",
    "<!-- TASK:T-1.2.2 -->",
    "- [ ] **T-1.2.2** pending",
    "",
    "## PHASE-2",
    "<!-- PHASE:2 -->",
    "",
    "### SUBPHASE-2.1",
    "<!-- SUBPHASE:2.1 -->",
    "**Tasks:**",
    "<!-- TASK:T-2.1.1 -->",
    "- **T-2.1.1** pending",
    "",
  ].join("\n");
}

function marker(name: string, payload: unknown): string {
  return [`<!-- ${name}`, JSON.stringify(payload), "-->", ""].join("\n");
}

function createMockRuntime(outputs: string[]): {
  invocations: RuntimeInvocation[];
  runCommand: (input: RuntimeInvocation) => Promise<{ sessionID: string; outputText: string }>;
} {
  const invocations: RuntimeInvocation[] = [];

  return {
    invocations,
    async runCommand(input: RuntimeInvocation): Promise<{ sessionID: string; outputText: string }> {
      invocations.push(input);
      const outputText = outputs.shift();
      if (typeof outputText !== "string") {
        throw new Error(`No mock output left for command ${input.command}`);
      }

      return {
        sessionID: `session-${invocations.length}`,
        outputText,
      };
    },
  };
}
