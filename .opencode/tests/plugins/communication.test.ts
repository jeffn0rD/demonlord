import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import CommunicationPlugin from "../../plugins/communication.ts";
import { withNoLiveNetwork } from "../harness/discord-harness.ts";

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
