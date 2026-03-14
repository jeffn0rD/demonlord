import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DISCORD_MAX_ATTEMPTS,
  DISCORD_RETRY_BACKOFF_MS,
  buildDeterministicRetryTimeline,
  createDeterministicClock,
} from "../harness/discord-harness.ts";
import { createMultiSessionFixture, resolveSessionTarget } from "../harness/orchestration-fixtures.ts";

describe("discord harness integration scenarios", () => {
  test("multi-session targeting policy is deterministic and fail-closed", () => {
    const sessions = createMultiSessionFixture(["ses-a", "ses-b"]);

    const explicit = resolveSessionTarget(sessions, "ses-b");
    const ambiguous = resolveSessionTarget(sessions);
    const single = resolveSessionTarget([sessions[0]!]);

    assert.equal(explicit.ok, true);
    assert.equal(explicit.session_id, "ses-b");

    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.reason ?? "", /explicit session_id/i);
    assert.deepEqual(ambiguous.candidates, ["ses-a", "ses-b"]);

    assert.equal(single.ok, true);
    assert.equal(single.session_id, "ses-a");
  });

  test("retry timeline follows locked max_attempts and backoff intervals", async () => {
    const timeline = buildDeterministicRetryTimeline(DISCORD_MAX_ATTEMPTS, DISCORD_RETRY_BACKOFF_MS);
    const clock = createDeterministicClock(1_000);

    const observedAttemptTimes: number[] = [];
    let previous = 0;
    for (const point of timeline) {
      const delta = point - previous;
      await clock.sleep(delta);
      observedAttemptTimes.push(clock.now());
      previous = point;
    }

    assert.deepEqual(timeline, [0, 250, 1250]);
    assert.deepEqual(observedAttemptTimes, [1_000, 1_250, 2_250]);
  });
});
