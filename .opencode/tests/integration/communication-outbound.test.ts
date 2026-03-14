import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import CommunicationPlugin from "../../plugins/communication.ts";

const INTEGRATION_DIR = dirname(fileURLToPath(import.meta.url));

process.env.DISCORD_BOT_TOKEN ??= "test-bot-token";
process.env.DISCORD_WEBHOOK_ORCHESTRATOR ??= "https://discord.example/orchestrator";
process.env.DISCORD_ALLOWED_USER_IDS ??= "user-allow-default";

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

  test("emits deterministic pipeline.transition payloads for pipeline commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-transition-"));

    try {
      await writeConfig(root);

      const fixture = await readContractFixture();
      assert.ok(fixture.outbound_events.includes("pipeline.transition"));

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
            await writeOrchestrationState(root, "ses-transition", "review", "idle", "/tmp/worktrees/ses-transition");
            await eventHook?.({
              event: {
                type: "command.executed",
                properties: {
                  name: "pipeline",
                  sessionID: "ses-transition",
                  arguments: "advance",
                },
              } as never,
            });
          },
        );

        assert.equal(emitted.length, 1);
        assert.equal(emitted[0]?.event, "pipeline.transition");
        assert.equal(emitted[0]?.payload.command_action, "advance");
        assert.equal(emitted[0]?.payload.session_id, "ses-transition");
        assert.equal(emitted[0]?.payload.persona, "reviewer");
      });

      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits deterministic session.error payloads for non-terminal errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-error-non-terminal-"));

    try {
      await writeConfig(root);

      const fixture = await readContractFixture();
      assert.ok(fixture.outbound_events.includes("session.error"));

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
            // Write state with transition NOT blocked/stopped (e.g., "idle" or "active")
            // Use stage "review" to match DISCORD_WEBHOOK_REVIEWER
            await writeOrchestrationState(root, "ses-error", "review", "idle", "/tmp/worktrees/ses-error");
            await eventHook?.({
              event: {
                type: "session.error",
                properties: {
                  sessionID: "ses-error",
                  error: {
                    code: "E_TEST",
                    data: {
                      message: "non-terminal error",
                    },
                  },
                },
              } as never,
            });
          },
        );

        assert.equal(emitted.length, 1);
        assert.equal(emitted[0]?.event, "session.error");
        assert.equal(emitted[0]?.payload.error_code, "E_TEST");
        assert.equal(emitted[0]?.payload.session_id, "ses-error");
        assert.equal(emitted[0]?.payload.persona, "reviewer");
      });

      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface MockCommandCall {
  sessionID: string;
  command: string;
  arguments: string;
}

interface MockPromptCall {
  sessionID: string;
  text: string;
}

interface MockClient {
  commands: MockCommandCall[];
  prompts: MockPromptCall[];
  session: {
    command(input: {
      path: { id: string };
      body: { command: string; arguments: string };
    }): Promise<void>;
    prompt(input: {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
    }): Promise<void>;
  };
}

function createMockClient(): MockClient {
  const commands: MockCommandCall[] = [];
  const prompts: MockPromptCall[] = [];

  return {
    commands,
    prompts,
    session: {
      async command(input): Promise<void> {
        commands.push({
          sessionID: input.path.id,
          command: input.body.command,
          arguments: input.body.arguments,
        });
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

describe("communication session targeting integration", () => {
  test("resolves explicit session_id when provided and active", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-explicit-"));

    try {
      await writeConfig(root);

      // Create multi-session state with ses-a and ses-b active
      await writeMultiSessionOrchestrationState(root, ["ses-a", "ses-b"]);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-b",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 1);
      assert.equal(client.commands[0]?.sessionID, "ses-b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when explicit session_id is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-auto-"));

    try {
      await writeConfig(root);

      // Create single active session
      await writeMultiSessionOrchestrationState(root, ["ses-a"]);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      // Provide invalid explicit session_id - should fail closed
      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-invalid",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /No active session matches explicit session_id 'ses-invalid'/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when multiple active sessions and no explicit session_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-ambiguous-"));

    try {
      await writeConfig(root);

      // Create multi-session state
      await writeMultiSessionOrchestrationState(root, ["ses-a", "ses-b"]);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      // Provide empty session_id - should fail closed
      await commandBefore(
        {
          command: "approve",
          sessionID: "",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /Multiple active sessions found/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when no active sessions available", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-none-"));

    try {
      await writeConfig(root);

      // Create state with no active sessions
      await writeMultiSessionOrchestrationState(root, []);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-any",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /No active session matches explicit session_id 'ses-any'/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("suppresses duplicate inbound interactions by command/session/token", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-dedupe-token-int-"));

    try {
      await writeConfig(root);
      await writeMultiSessionOrchestrationState(root, ["ses-a"]);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-a",
          arguments: "--interaction-token tok-int-1",
          metadata: {
            user: {
              id: "user-allow-default",
              role_ids: [],
            },
            channel: {
              id: "channel-ops",
            },
          },
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-a",
          arguments: "--interaction-token tok-int-1",
          metadata: {
            user: {
              id: "user-allow-default",
              role_ids: [],
            },
            channel: {
              id: "channel-ops",
            },
          },
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(client.commands.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns deterministic migration guidance for unsupported legacy command", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-legacy-int-"));

    try {
      await writeConfig(root);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "park",
          sessionID: "ses-legacy",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /no longer supported/i);
      assert.match(client.prompts[0]?.text ?? "", /\/halt/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies unauthorized Discord command.executed payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-authz-deny-int-"));

    try {
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
              authorization: {
                required: true,
                allowed_user_ids: ["user-allow"],
                allowed_role_ids: ["role-allow"],
                allowed_channel_id: "channel-ops",
              },
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

      await writeMultiSessionOrchestrationState(root, ["ses-a"]);

      const client = createMockClient();
      const plugin = await CommunicationPlugin({
        client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
        worktree: root,
      } as Parameters<typeof CommunicationPlugin>[0]);

      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      await eventHook?.({
        event: {
          type: "command.executed",
          properties: {
            name: "approve",
            sessionID: "ses-a",
            arguments: "--interaction-token tok-authz",
            metadata: {
              user: {
                id: "user-deny",
                role_ids: ["role-deny"],
              },
              channel: {
                id: "channel-other",
              },
            },
          },
        } as never,
      });

      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /command denied/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeMultiSessionOrchestrationState(root: string, sessionIDs: string[]): Promise<void> {
  const bmadRoot = resolve(root, "_bmad-output");
  await mkdir(bmadRoot, { recursive: true });

  const statePath = resolve(bmadRoot, "orchestration-state.json");
  const pipelines: Record<string, unknown> = {};
  const sessionToRoot: Record<string, string> = {};

  for (const sessionID of sessionIDs) {
    sessionToRoot[sessionID] = sessionID;
    pipelines[sessionID] = {
      rootSessionID: sessionID,
      currentStage: "implementation",
      transition: "idle",
      sessions: {
        [sessionID]: {
          sessionID,
          stage: "implementation",
          directory: `/tmp/worktrees/${sessionID}`,
          children: [],
          status: "active",
        },
      },
    };
  }

  const fixture = {
    version: 2,
    sessionToRoot,
    pipelines,
  };

  await writeFile(statePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
}
