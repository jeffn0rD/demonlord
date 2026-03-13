import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, test } from "node:test";
import { __partyModeTestUtils, executePartyModeAction } from "../../tools/party_mode.ts";

describe("party_mode hardening", () => {
  test("rejects transcript export to protected internal directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "party-mode-export-"));
    const sessionID = "ses-export-guard";

    try {
      const context = { worktree: root };
      const started = await executePartyModeAction(
        {
          action: "start",
          session_id: sessionID,
        },
        context,
      );
      assert.equal(started.ok, true);

      for (const exportPath of [
        "_bmad-output/../.opencode/skills/frontend-specialist/SKILL.md",
        "agents/minion_Plan.md",
        ".github/workflows/ci.md",
      ]) {
        const blocked = await executePartyModeAction(
          {
            action: "export",
            session_id: sessionID,
            export_path: exportPath,
          },
          context,
        );

        assert.equal(blocked.ok, false);
        assert.equal(blocked.code, "INVALID_INPUT");
        assert.match(blocked.error ?? "", /protected directories/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("writes atomically and cleans up temp files when rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "party-mode-atomic-"));
    const statePath = resolve(root, "state.json");

    try {
      await __partyModeTestUtils.writeTextAtomically(statePath, "{\"version\":1}\n");
      await __partyModeTestUtils.writeTextAtomically(statePath, "{\"version\":2}\n");

      const persisted = await readFile(statePath, "utf-8");
      assert.equal(persisted, "{\"version\":2}\n");

      const directoryTarget = resolve(root, "state-dir");
      await mkdir(directoryTarget, { recursive: true });
      await assert.rejects(() => __partyModeTestUtils.writeTextAtomically(directoryTarget, "bad\n"));

      const entries = await readdir(root);
      const leftoverTemps = entries.filter((entry) => entry.endsWith(".tmp"));
      assert.deepEqual(leftoverTemps, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
