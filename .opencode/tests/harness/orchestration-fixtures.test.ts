import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createMultiSessionFixture,
  createSessionFixture,
  resolveSessionTarget,
} from "./orchestration-fixtures.ts";

describe("orchestration/session fixture builders", () => {
  test("builds deterministic multi-session fixtures", () => {
    const fixtures = createMultiSessionFixture(["ses-a", "ses-b"]);

    assert.equal(fixtures.length, 2);
    assert.equal(fixtures[0]?.title, "pipeline-1");
    assert.equal(fixtures[1]?.worktree, "/tmp/worktrees/pipeline-2");
    assert.equal(fixtures[0]?.active, true);
  });

  test("session targeting resolves explicit session first", () => {
    const fixtures = createMultiSessionFixture(["ses-a", "ses-b"]);
    const resolved = resolveSessionTarget(fixtures, "ses-b");

    assert.equal(resolved.ok, true);
    assert.equal(resolved.session_id, "ses-b");
    assert.deepEqual(resolved.candidates, ["ses-a", "ses-b"]);
  });

  test("session targeting auto-selects a single active candidate", () => {
    const fixtures = [
      createSessionFixture("ses-a", { active: false }),
      createSessionFixture("ses-b", { active: true }),
    ];
    const resolved = resolveSessionTarget(fixtures);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.session_id, "ses-b");
    assert.deepEqual(resolved.candidates, ["ses-b"]);
  });

  test("session targeting fails closed on ambiguous candidates", () => {
    const fixtures = createMultiSessionFixture(["ses-a", "ses-b"]);
    const resolved = resolveSessionTarget(fixtures);

    assert.equal(resolved.ok, false);
    assert.match(resolved.reason ?? "", /explicit session_id/i);
    assert.deepEqual(resolved.candidates, ["ses-a", "ses-b"]);
  });
});
