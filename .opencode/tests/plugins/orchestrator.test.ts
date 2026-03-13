import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { __orchestratorTestUtils } from "../../plugins/orchestrator.ts";

describe("orchestrator snapshot and queue helpers", () => {
  test("writes snapshot atomically as valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-atomic-"));
    const statePath = resolve(root, "state.json");

    try {
      await __orchestratorTestUtils.writeJsonAtomically(statePath, { version: 2, value: 1 });
      await __orchestratorTestUtils.writeJsonAtomically(statePath, { version: 2, value: 2, nested: { ok: true } });

      const raw = await readFile(statePath, "utf-8");
      const parsed = JSON.parse(raw) as { version: number; value: number; nested?: { ok: boolean } };
      assert.equal(parsed.version, 2);
      assert.equal(parsed.value, 2);
      assert.equal(parsed.nested?.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates v1 snapshots to v2 contract with command queue metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-migrate-"));
    const outputDir = resolve(root, "_bmad-output");
    const statePath = resolve(outputDir, "orchestration-state.json");
    const queuePath = resolve(outputDir, "orchestration-commands.ndjson");

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            version: 1,
            runtime: { off: true },
            sessionToRoot: { "ses-root": "ses-root" },
            pipelines: {},
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const migrated = await __orchestratorTestUtils.loadPersistedState(statePath, queuePath, {
        enabled: true,
        mode: "manual",
        requireApprovalBeforeSpawn: true,
        ignoreAbortedMessages: true,
        verboseEvents: true,
      });

      assert.equal(migrated.version, 2);
      assert.equal(migrated.runtime.off, true);
      assert.equal(migrated.runtime.effectiveMode, "off");
      assert.equal(migrated.commandQueue.path, queuePath);
      assert.equal(migrated.commandQueue.lastProcessedLine, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses queue commands and prunes expired dedupe keys", () => {
    const parsed = __orchestratorTestUtils.parseQueuedCommand(
      JSON.stringify({
        version: 1,
        id: "pcmd-1",
        source: "pipelinectl",
        action: "approve",
        sessionID: "ses-root",
        targetSessionID: "ses-root",
        dedupeKey: "approve:ses-root:100",
        requestedAt: new Date().toISOString(),
        expectation: {
          rootSessionID: "ses-root",
          stage: "triage",
          transition: "awaiting_approval",
          pipelineUpdatedAt: 100,
          pendingRequired: true,
        },
      }),
    );

    const invalid = __orchestratorTestUtils.parseQueuedCommand(
      JSON.stringify({
        version: 1,
        source: "pipelinectl",
        action: "invalid",
      }),
    );

    const dedupeCache: Record<string, number> = {
      stale: Date.now() - 1,
      keep: Date.now() + 60_000,
    };
    __orchestratorTestUtils.pruneProcessedCommandDedupes(dedupeCache);

    assert.equal(parsed?.action, "approve");
    assert.equal(invalid, null);
    assert.equal(dedupeCache.stale, undefined);
    assert.equal(typeof dedupeCache.keep, "number");
  });

  test("normalizes queue lines without trailing newline cursor drift", () => {
    let cursor = 0;
    const firstPass = __orchestratorTestUtils.splitCommandQueueLines("{\"id\":1}\n");
    const seenFirst = firstPass.slice(cursor);
    cursor = firstPass.length;

    const secondPass = __orchestratorTestUtils.splitCommandQueueLines("{\"id\":1}\n{\"id\":2}\n");
    const seenSecond = secondPass.slice(cursor);
    cursor = secondPass.length;

    assert.deepEqual(seenFirst, ["{\"id\":1}"]);
    assert.deepEqual(seenSecond, ["{\"id\":2}"]);
    assert.equal(cursor, 2);
  });

  test("sets noReply on compatible command pre-hook outputs", () => {
    const output: { parts: unknown[]; noReply?: boolean } = {
      parts: [],
    };

    __orchestratorTestUtils.setNoReplyIfSupported(output);

    assert.equal(output.noReply, true);
  });

  test("ignores MessageAbortedError only in manual mode when configured", () => {
    const manualIgnored = __orchestratorTestUtils.shouldIgnoreError(
      { name: "MessageAbortedError", message: "aborted" },
      {
        enabled: true,
        mode: "manual",
        requireApprovalBeforeSpawn: true,
        ignoreAbortedMessages: true,
        verboseEvents: false,
      },
    );
    const autoNotIgnored = __orchestratorTestUtils.shouldIgnoreError(
      { name: "MessageAbortedError", message: "aborted" },
      {
        enabled: true,
        mode: "auto",
        requireApprovalBeforeSpawn: true,
        ignoreAbortedMessages: true,
        verboseEvents: false,
      },
    );

    assert.equal(manualIgnored, true);
    assert.equal(autoNotIgnored, false);
  });

  test("normalizes error signatures to support deterministic dedupe", () => {
    const first = __orchestratorTestUtils.normalizeErrorSignature(
      { name: "NetworkError", message: "request 123 failed for ticket 99" },
      "implementation",
    );
    const second = __orchestratorTestUtils.normalizeErrorSignature(
      { name: "NetworkError", message: "request 456 failed for ticket 01" },
      "implementation",
    );

    assert.equal(first, second);
  });

  test("uses pre-handled command cache as idempotency guard", () => {
    const cache = new Map<string, number>();
    const command = {
      name: "pipeline",
      sessionID: "ses-root",
      arguments: "status",
    };

    __orchestratorTestUtils.rememberPreHandledCommand(cache, command);

    assert.equal(__orchestratorTestUtils.wasPreHandled(cache, command), true);
    assert.equal(__orchestratorTestUtils.wasPreHandled(cache, command), false);
  });

  test("returns deterministic stage progression order", () => {
    assert.equal(__orchestratorTestUtils.getNextStage("triage"), "implementation");
    assert.equal(__orchestratorTestUtils.getNextStage("implementation"), "review");
    assert.equal(__orchestratorTestUtils.getNextStage("review"), null);

    assert.equal(__orchestratorTestUtils.normalizeStage("triage"), "triage");
    assert.equal(__orchestratorTestUtils.normalizeStage("review"), "review");
    assert.equal(__orchestratorTestUtils.normalizeStage("invalid"), null);
  });

  test("detects ambiguity for spec-expert first-pass routing", () => {
    const ambiguous = __orchestratorTestUtils.shouldPreferSpecExpertFirst(
      "requirements are unclear and need recommendation from docs",
    );
    const concrete = __orchestratorTestUtils.shouldPreferSpecExpertFirst(
      "implement pipeline queue dedupe for orchestrator",
    );

    assert.equal(ambiguous, true);
    assert.equal(concrete, false);
  });

  test("applies spec-expert override route when ambiguity policy triggers", () => {
    const overridden = __orchestratorTestUtils.applySpecExpertFirstPolicy({
      skill_id: "backend-specialist",
      mode: "llm",
      reason: "LLM selected backend-specialist",
    });

    const confirmed = __orchestratorTestUtils.applySpecExpertFirstPolicy({
      skill_id: "spec-expert",
      mode: "heuristic",
      reason: "Heuristic selected spec-expert",
    });

    assert.equal(overridden.skill_id, "spec-expert");
    assert.equal(overridden.mode, "heuristic");
    assert.match(overridden.reason, /overrode backend-specialist/);

    assert.equal(confirmed.skill_id, "spec-expert");
    assert.equal(confirmed.mode, "heuristic");
    assert.match(confirmed.reason, /confirmed spec-expert/);
  });

  test("validates spec handoff marker content deterministically", () => {
    const valid = __orchestratorTestUtils.validateSpecHandoffMarkerContent([
      "# Spec Handoff",
      "<!-- DEMONLORD_SPEC_HANDOFF_READY -->",
      "## Scope",
      "- deliver routing updates",
      "## Constraints",
      "- preserve deterministic transitions",
    ].join("\n"));

    const invalid = __orchestratorTestUtils.validateSpecHandoffMarkerContent([
      "# Spec Handoff",
      "## Scope",
      "- missing marker and constraints",
    ].join("\n"));

    assert.equal(valid.ok, true);
    assert.deepEqual(valid.missing, []);

    assert.equal(invalid.ok, false);
    assert.match(invalid.missing.join(" "), /DEMONLORD_SPEC_HANDOFF_READY/);
    assert.match(invalid.missing.join(" "), /## Constraints/);
  });
});
