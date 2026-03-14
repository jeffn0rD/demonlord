import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import CommunicationPlugin from "../../plugins/communication.ts";
import { withNoLiveNetwork } from "../harness/discord-harness.ts";

process.env.DISCORD_BOT_TOKEN ??= "test-bot-token";
process.env.DISCORD_WEBHOOK_ORCHESTRATOR ??= "https://discord.example/orchestrator";
process.env.DISCORD_ALLOWED_USER_IDS ??= "user-allow-default";

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

describe("communication plugin deterministic network-free behavior", () => {
  test("handles approve command without requiring live network", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-no-network-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);

      const hook = plugin["command.execute.before"];
      assert.ok(hook, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await withNoLiveNetwork(async () => {
        await hook(
          {
            command: "approve",
            sessionID: "ses-root",
            arguments: "",
          } as Parameters<typeof hook>[0],
          output as Parameters<typeof hook>[1],
        );
      });

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 1);
      assert.equal(client.commands[0]?.command, "pipeline");
      assert.equal(client.commands[0]?.arguments, "approve");
      assert.equal(client.commands[0]?.sessionID, "ses-root");
      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dedupes command.executed event after pre-hook handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-dedupe-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);

      const commandBefore = plugin["command.execute.before"];
      const eventHook = plugin.event;

      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");
      assert.ok(eventHook, "communication plugin must expose event hook");

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-dup",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        { parts: [] } as Parameters<typeof commandBefore>[1],
      );

      await eventHook?.({
        event: {
          type: "command.executed",
          properties: {
            name: "approve",
            sessionID: "ses-dup",
            arguments: "",
          },
        } as never,
      });

      assert.equal(client.commands.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps idle events to approval payload with persona/worktree/session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-approval-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
          personas: {
            minion: {
              name: "Minion Bot",
            },
          },
        },
      });

      await writeOrchestrationState(root, {
        sessionID: "ses-outbound",
        stage: "implementation",
        transition: "awaiting_approval",
        directory: "/tmp/worktrees/ses-outbound",
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;

      assert.ok(eventHook, "communication plugin must expose event hook");

      await withEnv({ DISCORD_WEBHOOK_MINION: "https://discord.example/minion" }, async () => {
        const sentBodies: string[] = [];

        await withMockFetch(
          async (_url, init) => {
            sentBodies.push(typeof init?.body === "string" ? init.body : "");
            return createMockResponse(204);
          },
          async () => {
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-outbound",
                },
              } as never,
            });
          },
        );

        assert.equal(sentBodies.length, 1);
        const webhookPayload = JSON.parse(sentBodies[0] ?? "{}") as { username?: string; content?: string };
        const envelope = JSON.parse(webhookPayload.content ?? "{}") as {
          event?: string;
          payload?: {
            session_id?: string;
            persona?: string;
            worktree?: string;
          };
        };

        assert.equal(webhookPayload.username, "Minion Bot");
        assert.equal(envelope.event, "pipeline.approval_requested");
        assert.equal(envelope.payload?.session_id, "ses-outbound");
        assert.equal(envelope.payload?.persona, "minion");
        assert.equal(envelope.payload?.worktree, "/tmp/worktrees/ses-outbound");
      });

      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dedupes repeated outbound emissions for identical events", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-dedupe-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
        },
      });

      await writeOrchestrationState(root, {
        sessionID: "ses-dedupe",
        stage: "triage",
        transition: "idle",
        directory: "/tmp/worktrees/ses-dedupe",
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      await withEnv({ DISCORD_WEBHOOK_PLANNER: "https://discord.example/planner" }, async () => {
        let callCount = 0;

        await withMockFetch(
          async () => {
            callCount += 1;
            return createMockResponse(204);
          },
          async () => {
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-dedupe",
                },
              } as never,
            });

            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-dedupe",
                },
              } as never,
            });
          },
        );

        assert.equal(callCount, 1);
      });

      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("surfaces outbound send failures to orchestrator prompt path", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-failure-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
        },
      });

      await writeOrchestrationState(root, {
        sessionID: "ses-fail",
        stage: "triage",
        transition: "idle",
        directory: "/tmp/worktrees/ses-fail",
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      await withEnv({ DISCORD_WEBHOOK_PLANNER: "https://discord.example/planner" }, async () => {
        await withMockFetch(
          async () => createMockResponse(503, "discord unavailable"),
          async () => {
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-fail",
                },
              } as never,
            });
          },
        );
      });

      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /Discord outbound delivery failed/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails safe for unmapped pipeline actions under strict allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-failsafe-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      await withEnv({ DISCORD_WEBHOOK_ORCHESTRATOR: "https://discord.example/orchestrator" }, async () => {
        let callCount = 0;

        await withMockFetch(
          async () => {
            callCount += 1;
            return createMockResponse(204);
          },
          async () => {
            await eventHook?.({
              event: {
                type: "command.executed",
                properties: {
                  name: "pipeline",
                  sessionID: "ses-root",
                  arguments: "status",
                },
              } as never,
            });
          },
        );

        assert.equal(callCount, 0);
      });

      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /Discord outbound skipped/i);
      assert.match(client.prompts[0]?.text ?? "", /No outbound mapping for pipeline action 'status'/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

async function writeConfig(root: string, config: unknown): Promise<void> {
  const configPath = resolve(root, "demonlord.config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function writeOrchestrationState(
  root: string,
  state: {
    sessionID: string;
    stage: "triage" | "implementation" | "review";
    transition: string;
    directory: string;
  },
): Promise<void> {
  const bmadRoot = resolve(root, "_bmad-output");
  await mkdir(bmadRoot, { recursive: true });

  const statePath = resolve(bmadRoot, "orchestration-state.json");
  const fixture = {
    version: 2,
    sessionToRoot: {
      [state.sessionID]: state.sessionID,
    },
    pipelines: {
      [state.sessionID]: {
        rootSessionID: state.sessionID,
        currentStage: state.stage,
        transition: state.transition,
        sessions: {
          [state.sessionID]: {
            sessionID: state.sessionID,
            stage: state.stage,
            directory: state.directory,
            children: [],
            status: "active",
          },
        },
      },
    },
  };

  await writeFile(statePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
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

async function createPlugin(
  client: MockClient,
  root: string,
): Promise<Awaited<ReturnType<typeof CommunicationPlugin>>> {
  return CommunicationPlugin(
    {
      client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
      worktree: root,
    } as Parameters<typeof CommunicationPlugin>[0],
  );
}

describe("communication session targeting unit tests", () => {
  test("resolves explicit session_id when provided and active", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-explicit-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      // Create multi-session state
      await writeMultiSessionOrchestrationState(root, ["ses-a", "ses-b"]);

      const client = createMockClient();
      const plugin = await createPlugin(client, root);

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
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      // Create single active session
      await writeMultiSessionOrchestrationState(root, ["ses-a"]);

      const client = createMockClient();
      const plugin = await createPlugin(client, root);

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
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      // Create multi-session state
      await writeMultiSessionOrchestrationState(root, ["ses-a", "ses-b"]);

      const client = createMockClient();
      const plugin = await createPlugin(client, root);

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

  test("suppresses duplicate inbound interactions by command/session/token", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-session-dedupe-token-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      await writeMultiSessionOrchestrationState(root, ["ses-a"]);

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-a",
          arguments: "--interaction-token tok-dup-1",
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
          arguments: "--interaction-token tok-dup-1",
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

  test("returns deterministic migration guidance for legacy commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-legacy-guidance-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "handoff",
          sessionID: "ses-legacy",
          arguments: "reviewer",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /no longer supported/i);
      assert.match(client.prompts[0]?.text ?? "", /\/focus/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not intercept non-managed non-legacy commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-non-managed-pass-through-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "pipeline",
          sessionID: "ses-any",
          arguments: "status",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, undefined);
      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries outbound event on transient failure and commits dedupe after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-dedupe-retry-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      let callCount = 0;
      await withEnv({ DISCORD_WEBHOOK_ORCHESTRATOR: "https://discord.example/orchestrator" }, async () => {
        await withMockFetch(
          async () => {
            callCount += 1;
            if (callCount === 1) {
              return createMockResponse(500); // First call fails
            }
            return createMockResponse(204); // Second call succeeds
          },
          async () => {
            // First event should retry and eventually succeed.
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-retry",
                },
              } as never,
            });

            // Second identical event should be deduped after first succeeds.
            await eventHook?.({
              event: {
                type: "session.idle",
                properties: {
                  sessionID: "ses-retry",
                },
              } as never,
            });
          },
        );
      });

      assert.equal(callCount, 2, "Should have attempted delivery twice");
      assert.equal(client.prompts.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails fast when required Discord startup env keys are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-startup-validation-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const client = createMockClient();
      await assert.rejects(
        () =>
          withEnv(
            {
              DISCORD_BOT_TOKEN: "",
              DISCORD_WEBHOOK_ORCHESTRATOR: "",
              DISCORD_ALLOWED_USER_IDS: "",
              DISCORD_ALLOWED_ROLE_IDS: "",
            },
            async () => {
              await CommunicationPlugin({
                client: client as unknown as Parameters<typeof CommunicationPlugin>[0]["client"],
                worktree: root,
              } as Parameters<typeof CommunicationPlugin>[0]);
            },
          ),
        /startup validation failed/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses deterministic defaults when demonlord.config.json is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-missing-config-"));

    try {
      const client = createMockClient();
      const plugin = await withEnv(
        {
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_WEBHOOK_ORCHESTRATOR: "https://discord.example/orchestrator",
          DISCORD_ALLOWED_USER_IDS: "user-allow-default",
          DISCORD_ALLOWED_ROLE_IDS: "",
        },
        async () => createPlugin(client, root),
      );
      assert.ok(plugin.event, "communication plugin must initialize when config file is missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails fast with actionable error when demonlord.config.json is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-malformed-config-"));

    try {
      await writeFile(resolve(root, "demonlord.config.json"), "{\n  \"discord\": {\n", "utf-8");

      const client = createMockClient();
      await assert.rejects(
        () => createPlugin(client, root),
        /failed to parse config.*demonlord\.config\.json/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries outbound delivery deterministically and redacts secrets on terminal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-outbound-terminal-failure-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
        discord: {
          enabled: true,
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const eventHook = plugin.event;
      assert.ok(eventHook, "communication plugin must expose event hook");

      let callCount = 0;
      await withEnv(
        {
          DISCORD_WEBHOOK_ORCHESTRATOR: "https://discord.com/api/webhooks/secret-hook/value",
          DISCORD_BOT_TOKEN: "bot-secret-value",
        },
        async () => {
          await withMockFetch(
            async () => {
              callCount += 1;
              return createMockResponse(503, "downstream token bot-secret-value and https://discord.com/api/webhooks/secret-hook/value");
            },
            async () => {
              await eventHook?.({
                event: {
                  type: "session.idle",
                  properties: {
                    sessionID: "ses-terminal-fail",
                  },
                } as never,
              });
            },
          );
        },
      );

      assert.equal(callCount, 3);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /after 3 attempts/i);
      assert.doesNotMatch(client.prompts[0]?.text ?? "", /bot-secret-value/);
      assert.doesNotMatch(client.prompts[0]?.text ?? "", /discord\.com\/api\/webhooks/i);
      assert.match(client.prompts[0]?.text ?? "", /\[REDACTED\]/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies unauthorized inbound Discord callers deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-inbound-authz-deny-"));

    try {
      await writeConfig(root, {
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
        },
      });

      const client = createMockClient();
      const plugin = await createPlugin(client, root);
      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = {
        parts: [{ type: "text", text: "placeholder" }],
      };

      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-authz",
          arguments: "--interaction-token tok-authz",
          metadata: {
            user: { id: "user-deny", role_ids: ["role-deny"] },
            channel: { id: "channel-other" },
          },
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(output.noReply, true);
      assert.deepEqual(output.parts, []);
      assert.equal(client.commands.length, 0);
      assert.equal(client.prompts.length, 1);
      assert.match(client.prompts[0]?.text ?? "", /command denied/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries inbound command handling errors and surfaces terminal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "communication-inbound-retry-failure-"));

    try {
      await writeConfig(root, {
        orchestration: {
          enabled: true,
          mode: "manual",
        },
      });

      const commands: MockCommandCall[] = [];
      const prompts: MockPromptCall[] = [];
      const client: MockClient = {
        commands,
        prompts,
        session: {
          async command(input): Promise<void> {
            commands.push({
              sessionID: input.path.id,
              command: input.body.command,
              arguments: input.body.arguments,
            });
            throw new Error("forced inbound failure");
          },
          async prompt(input): Promise<void> {
            prompts.push({
              sessionID: input.path.id,
              text: input.body.parts[0]?.text ?? "",
            });
          },
        },
      };

      const plugin = await createPlugin(client, root);
      const commandBefore = plugin["command.execute.before"];
      assert.ok(commandBefore, "communication plugin must expose command.execute.before hook");

      const output: { parts: unknown[]; noReply?: boolean } = { parts: [] };
      await commandBefore(
        {
          command: "approve",
          sessionID: "ses-inbound-retry",
          arguments: "",
        } as Parameters<typeof commandBefore>[0],
        output as Parameters<typeof commandBefore>[1],
      );

      assert.equal(commands.length, 3);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0]?.text ?? "", /failed after 3 attempts/i);
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
