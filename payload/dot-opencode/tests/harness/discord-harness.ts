export const DISCORD_MAX_ATTEMPTS = 3;
export const DISCORD_RETRY_BACKOFF_MS = [0, 250, 1000] as const;
export const DISCORD_DEDUPE_TTL_MS = 10 * 60 * 1000;
export const DISCORD_CONTRACT_FIXTURE = "tests/harness/discord-contracts.v1.json";

export interface MockDiscordSendResult {
  ok: boolean;
  attempt: number;
  error?: string;
}

export interface MockDiscordSendAttempt<TPayload> {
  attempt: number;
  at: number;
  payload: TPayload;
  ok: boolean;
  error?: string;
}

export interface MockDiscordSender<TPayload> {
  attempts: MockDiscordSendAttempt<TPayload>[];
  send(payload: TPayload): Promise<MockDiscordSendResult>;
}

export interface MockDiscordSenderOptions {
  failAttempts?: readonly number[];
  now?: () => number;
}

export interface MockInboundEnvelope {
  version: "v1";
  interaction_id: string;
  token: string;
  command: string;
  session_id?: string;
  args: Record<string, string>;
  user: {
    id: string;
    role_ids: string[];
  };
  channel: {
    id: string;
  };
}

export interface MockInboundEnvelopeOverrides {
  interactionID?: string;
  token?: string;
  sessionID?: string;
  args?: Record<string, string>;
  userID?: string;
  roleIDs?: string[];
  channelID?: string;
}

export interface DeterministicClock {
  now(): number;
  advanceBy(ms: number): number;
  sleep(ms: number): Promise<number>;
}

export interface DedupeCache {
  remember(key: string): boolean;
  has(key: string): boolean;
  prune(): void;
  size(): number;
}

export function createMockDiscordSender<TPayload>(options: MockDiscordSenderOptions = {}): MockDiscordSender<TPayload> {
  const failAttempts = new Set(options.failAttempts ?? []);
  const now = options.now ?? (() => Date.now());
  const attempts: MockDiscordSendAttempt<TPayload>[] = [];

  return {
    attempts,
    async send(payload: TPayload): Promise<MockDiscordSendResult> {
      const attempt = attempts.length + 1;
      const shouldFail = failAttempts.has(attempt);
      const result: MockDiscordSendAttempt<TPayload> = {
        attempt,
        at: now(),
        payload,
        ok: !shouldFail,
        error: shouldFail ? `mock send failed at attempt ${attempt}` : undefined,
      };
      attempts.push(result);

      return {
        ok: result.ok,
        attempt,
        error: result.error,
      };
    },
  };
}

export function createMockInboundEnvelope(command: string, overrides: MockInboundEnvelopeOverrides = {}): MockInboundEnvelope {
  return {
    version: "v1",
    interaction_id: overrides.interactionID ?? "ixn-0001",
    token: overrides.token ?? "token-0001",
    command,
    session_id: overrides.sessionID,
    args: { ...(overrides.args ?? {}) },
    user: {
      id: overrides.userID ?? "user-0001",
      role_ids: [...(overrides.roleIDs ?? [])],
    },
    channel: {
      id: overrides.channelID ?? "channel-0001",
    },
  };
}

export function createDeterministicClock(startMs = 0): DeterministicClock {
  let now = startMs;

  return {
    now(): number {
      return now;
    },
    advanceBy(ms: number): number {
      if (ms < 0) {
        throw new Error("advanceBy requires a non-negative duration");
      }
      now += ms;
      return now;
    },
    async sleep(ms: number): Promise<number> {
      return this.advanceBy(ms);
    },
  };
}

export function buildDeterministicRetryTimeline(
  maxAttempts = DISCORD_MAX_ATTEMPTS,
  backoffMs: readonly number[] = DISCORD_RETRY_BACKOFF_MS,
): number[] {
  if (maxAttempts <= 0) {
    return [];
  }

  const timeline: number[] = [];
  const normalizedBackoff = backoffMs.length > 0 ? backoffMs : [0];
  let elapsed = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const delay = normalizedBackoff[Math.min(attempt, normalizedBackoff.length - 1)] ?? 0;
    elapsed += delay;
    timeline.push(elapsed);
  }

  return timeline;
}

export function createInMemoryDedupeCache(ttlMs = DISCORD_DEDUPE_TTL_MS, now: () => number = () => Date.now()): DedupeCache {
  const cache = new Map<string, number>();

  function pruneExpired(): void {
    const current = now();
    for (const [key, expiresAt] of cache.entries()) {
      if (expiresAt <= current) {
        cache.delete(key);
      }
    }
  }

  return {
    remember(key: string): boolean {
      pruneExpired();
      if (cache.has(key)) {
        return false;
      }

      cache.set(key, now() + ttlMs);
      return true;
    },
    has(key: string): boolean {
      pruneExpired();
      return cache.has(key);
    },
    prune(): void {
      pruneExpired();
    },
    size(): number {
      pruneExpired();
      return cache.size;
    },
  };
}

export async function withNoLiveNetwork<T>(run: () => Promise<T> | T): Promise<T> {
  const originalFetch = globalThis.fetch;
  const blockedFetch = (async () => {
    throw new Error("Live network access is disabled in deterministic Discord tests.");
  }) as typeof globalThis.fetch;

  globalThis.fetch = blockedFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
