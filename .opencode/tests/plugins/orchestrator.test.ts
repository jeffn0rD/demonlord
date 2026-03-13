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

  test("sets noReply on compatible command pre-hook outputs", () => {
    const output: { parts: unknown[]; noReply?: boolean } = {
      parts: [],
    };

    __orchestratorTestUtils.setNoReplyIfSupported(output);

    assert.equal(output.noReply, true);
  });
});
