import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, test } from "node:test";
import { __partyModeTestUtils, executePartyModeAction } from "../../tools/party_mode.ts";

describe("party_mode hardening", () => {
  test("supports all primary actions with deterministic state transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "party-mode-actions-"));
    const sessionID = "ses-party-actions";

    try {
      const context = { worktree: root };

      const started = await executePartyModeAction(
        {
          action: "start",
          session_id: sessionID,
          agents: ["frontend-specialist"],
        },
        context,
      );
      assert.equal(started.ok, true);
      assert.equal(started.state?.round, 1);

      const continued = await executePartyModeAction(
        {
          action: "continue",
          session_id: sessionID,
          note: "Round two kickoff",
        },
        context,
      );
      assert.equal(continued.ok, true);
      assert.equal(continued.state?.round, 2);
      assert.equal(continued.state?.halted, false);

      const halted = await executePartyModeAction(
        {
          action: "halt",
          session_id: sessionID,
          note: "Need user decision",
        },
        context,
      );
      assert.equal(halted.ok, true);
      assert.equal(halted.state?.halted, true);

      const focused = await executePartyModeAction(
        {
          action: "focus",
          session_id: sessionID,
          agent: "backend-specialist",
        },
        context,
      );
      assert.equal(focused.ok, true);
      assert.equal(focused.state?.focusedAgent, "backend-specialist");

      const added = await executePartyModeAction(
        {
          action: "add-agent",
          session_id: sessionID,
          agents: ["reviewer", "backend-specialist"],
        },
        context,
      );
      assert.equal(added.ok, true);
      const addedAgents = new Set(added.state?.agents ?? []);
      assert.equal(addedAgents.has("frontend-specialist"), true);
      assert.equal(addedAgents.has("backend-specialist"), true);
      assert.equal(addedAgents.has("reviewer"), true);
      assert.equal(addedAgents.has("orchestrator"), true);

      const noted = await executePartyModeAction(
        {
          action: "note",
          session_id: sessionID,
          note: "Consensus reached on API boundary",
        },
        context,
      );
      assert.equal(noted.ok, true);

      const exported = await executePartyModeAction(
        {
          action: "export",
          session_id: sessionID,
        },
        context,
      );
      assert.equal(exported.ok, true);
      assert.equal(
        exported.export_path,
        `_bmad-output/party-mode/party-mode-transcript-${sessionID}.md`,
      );

      const transcriptPath = resolve(root, exported.export_path ?? "");
      const transcript = await readFile(transcriptPath, "utf-8");
      assert.match(transcript, new RegExp(`Session ID: ${sessionID}`));
      assert.match(transcript, /Focus moved to backend-specialist/);
      assert.match(transcript, /Consensus reached on API boundary/);

      const status = await executePartyModeAction(
        {
          action: "status",
          session_id: sessionID,
        },
        context,
      );
      assert.equal(status.ok, true);
      assert.equal(status.state?.round, 2);
      assert.equal(status.state?.focusedAgent, "backend-specialist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("rejects traversal paths that escape the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "party-mode-path-"));
    const sessionID = "ses-path-guard";

    try {
      const context = { worktree: root };
      await executePartyModeAction(
        {
          action: "start",
          session_id: sessionID,
        },
        context,
      );

      const escaped = await executePartyModeAction(
        {
          action: "export",
          session_id: sessionID,
          export_path: "../outside.md",
        },
        context,
      );

      assert.equal(escaped.ok, false);
      assert.equal(escaped.code, "PATH_OUTSIDE_WORKTREE");
      assert.match(escaped.error ?? "", /outside the current worktree/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
