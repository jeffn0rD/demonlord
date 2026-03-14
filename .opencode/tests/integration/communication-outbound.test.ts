import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import CommunicationPlugin from "../../plugins/communication.ts";

const INTEGRATION_DIR = dirname(fileURLToPath(import.meta.url));

describe("communication outbound integration", () => {
  test("emits deterministic pipeline.summary pass/fail payloads for terminal states", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-integration-"));

    try {
      await writeConfig(root);

      const fixture = await readContractFixture();
      assert.ok(fixture.outbound_events.includes("pipeline.summary"));

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);
      const eventHook = plugin.event;

      assert.ok(eventHook, "communication plugin must expose event hook");

      await withEnv({ DISCORD_WEBHOOK_REVIEWER: "https://discord.example/reviewer" }, async () => {
        const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

        await withMockFetch(
          async (_url, init) => {
            const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { content?: string };
            const content = JSON.parse(body.content ?? "{}") as {
              event: string;
              payload: Record<string, unknown>;
            };
            emitted.push(content);
            return createMockResponse(204);
          },
          async () => {
            await writeOrchestrationState(root, "ses-summary", "review", "completed", "/tmp/worktrees/ses-summary");
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-summary",
                },
              } as never,
            });

            await writeOrchestrationState(root, "ses-summary", "review", "blocked", "/tmp/worktrees/ses-summary");
            await eventHook?.({
              event: {
                type: "session.error",
                properties: {
                  sessionID: "ses-summary",
                  error: {
                    code: "E_TEST",
                    data: {
                      message: "integration failure",
                    },
                  },
                },
              } as never,
            });
          },
        );

        assert.equal(emitted.length, 2);
        assert.deepEqual(
          emitted.map((entry) => entry.event),
          ["pipeline.summary", "pipeline.summary"],
        );
        assert.equal(emitted[0]?.payload.result, "pass");
        assert.equal(emitted[1]?.payload.result, "fail");
        assert.equal(emitted[0]?.payload.persona, "reviewer");
        assert.equal(emitted[1]?.payload.session_id, "ses-summary");
      });

      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createMockClient(): {
  prompts: Array<{ sessionID: string; text: string }>;
  session: {
    command(_input: unknown): Promise<void>;
    prompt(input: {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
    }): Promise<void>;
  };
} {
  const prompts: Array<{ sessionID: string; text: string }> = [];

  return {
    prompts,
    session: {
      async command(): Promise<void> {
        return;
      },
      async prompt(input): Promise<void> {
        prompts.push({
          sessionID: input.path.id,
          text: input.body.parts[0]?.text ?? "",
        });
      },
    },
  };
}

async function writeConfig(root: string): Promise<void> {
  await writeFile(
    resolve(root, "demonlord.config.json"),
    `${JSON.stringify(
      {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
          personas: {
            reviewer: {
              name: "Reviewer Bot",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function writeOrchestrationState(
  root: string,
  sessionID: string,
  stage: "triage" | "implementation" | "review",
  transition: string,
  directory: string,
): Promise<void> {
  const bmadRoot = resolve(root, "_bmad-output");
  await mkdir(bmadRoot, { recursive: true });

  const state = {
    version: 2,
    sessionToRoot: {
      [sessionID]: sessionID,
    },
    pipelines: {
      [sessionID]: {
        rootSessionID: sessionID,
        currentStage: stage,
        transition,
        sessions: {
          [sessionID]: {
            sessionID,
            stage,
            directory,
            children: [],
            status: "active",
          },
        },
      },
    },
  };

  await writeFile(resolve(bmadRoot, "orchestration-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function readContractFixture(): Promise<{ outbound_events: string[] }> {
  const raw = await readFile(resolve(INTEGRATION_DIR, "..", "harness", "discord-contracts.v1.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    outbound_events?: Array<{ event: string }>;
  };
  return {
    outbound_events: (parsed.outbound_events ?? []).map((entry) => entry.event),
  };
}

async function withMockFetch<T>(
  mock: (input: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    return mock(url, init);
  }) as typeof globalThis.fetch;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createMockResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(): Promise<string> {
      return body;
    },
  } as Response;
}
