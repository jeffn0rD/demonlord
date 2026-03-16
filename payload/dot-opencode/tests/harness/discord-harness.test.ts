import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DISCORD_CONTRACT_FIXTURE,
  buildDeterministicRetryTimeline,
  createDeterministicClock,
  createInMemoryDedupeCache,
  createMockDiscordSender,
  createMockInboundEnvelope,
  withNoLiveNetwork,
} from "./discord-harness.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

interface DiscordContractFixture {
  version: string;
  retry_policy: {
    max_attempts: number;
    backoff_ms: number[];
    jitter: string;
  };
  dedupe_policy: {
    storage: string;
    ttl_ms: number;
  };
  outbound_events: Array<{ event: string; payload: Record<string, unknown> }>;
  inbound_commands: Array<{ command: string; envelope: Record<string, unknown> }>;
}

describe("discord harness utilities", () => {
  test("mock sender records deterministic attempts and failures", async () => {
    const clock = createDeterministicClock(100);
    const sender = createMockDiscordSender<{ event: string }>({
      failAttempts: [2],
      now: () => clock.now(),
    });

    const first = await sender.send({ event: "session.idle" });
    clock.advanceBy(250);
    const second = await sender.send({ event: "session.error" });

    assert.deepEqual(first, { ok: true, attempt: 1, error: undefined });
    assert.equal(second.ok, false);
    assert.equal(second.attempt, 2);
    assert.match(second.error ?? "", /attempt 2/);
    assert.equal(sender.attempts[0]?.at, 100);
    assert.equal(sender.attempts[1]?.at, 350);
  });

  test("builds deterministic retry timeline for locked backoff policy", () => {
    const timeline = buildDeterministicRetryTimeline(3);
    assert.deepEqual(timeline, [0, 250, 1250]);
  });

  test("in-memory dedupe cache honors ttl deterministically", () => {
    let now = 1_000;
    const dedupe = createInMemoryDedupeCache(50, () => now);

    assert.equal(dedupe.remember("approve:ses-1"), true);
    assert.equal(dedupe.remember("approve:ses-1"), false);
    assert.equal(dedupe.has("approve:ses-1"), true);

    now += 51;
    assert.equal(dedupe.has("approve:ses-1"), false);
    assert.equal(dedupe.size(), 0);
  });

  test("builds canonical inbound envelope shape", () => {
    const envelope = createMockInboundEnvelope("approve", {
      sessionID: "ses-target",
      args: { reason: "looks good" },
    });

    assert.equal(envelope.version, "v1");
    assert.equal(envelope.command, "approve");
    assert.equal(envelope.session_id, "ses-target");
    assert.equal(envelope.args.reason, "looks good");
    assert.equal(envelope.user.id, "user-0001");
  });

  test("loads versioned contract fixture with required command/event families", async () => {
    const fixturePath = resolve(HARNESS_DIR, "discord-contracts.v1.json");
    const raw = await readFile(fixturePath, "utf-8");
    const fixture = JSON.parse(raw) as DiscordContractFixture;

    assert.equal(DISCORD_CONTRACT_FIXTURE, "tests/harness/discord-contracts.v1.json");
    assert.equal(fixture.version, "v1");
    assert.equal(fixture.retry_policy.max_attempts, 3);
    assert.deepEqual(fixture.retry_policy.backoff_ms, [0, 250, 1000]);
    assert.equal(fixture.dedupe_policy.ttl_ms, 600000);
    assert.deepEqual(
      fixture.outbound_events.map((entry) => entry.event),
      [
        "session.idle",
        "session.error",
        "pipeline.approval_requested",
        "pipeline.transition",
        "pipeline.summary",
      ],
    );
    assert.deepEqual(
      fixture.inbound_commands.map((entry) => entry.command),
      ["approve", "party", "continue", "halt", "focus", "add-agent", "export"],
    );
  });

  test("no-network harness blocks live fetch calls", async () => {
    await assert.rejects(
      () =>
        withNoLiveNetwork(async () => {
          await fetch("https://example.com/");
        }),
      /Live network access is disabled/i,
    );
  });
});
