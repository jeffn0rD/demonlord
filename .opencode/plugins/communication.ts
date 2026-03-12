import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFile } from "fs/promises";
import { resolve } from "path";

type OrchestrationMode = "off" | "manual" | "auto";

interface CommunicationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
}

const defaults: CommunicationSettings = {
  enabled: true,
  mode: "manual",
};

const CommunicationPlugin: Plugin = async ({ client, worktree }) => {
  const settings = await loadSettings(worktree);

  if (!settings.enabled) {
    return {};
  }

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "command.executed") {
        return;
      }

      if (event.properties.name !== "approve") {
        return;
      }

      if (settings.mode === "off") {
        await client.session.prompt({
          path: { id: event.properties.sessionID },
          body: {
            agent: "orchestrator",
            noReply: true,
            parts: [{ type: "text", text: "Orchestration is OFF. `/approve` is unavailable." }],
          },
          query: { directory: worktree },
        });
        return;
      }

      const args = event.properties.arguments.trim();
      const commandArgs = args.length > 0 ? `approve ${args}` : "approve";

      await client.session.command({
        path: { id: event.properties.sessionID },
        body: {
          command: "pipeline",
          arguments: commandArgs,
          agent: "orchestrator",
        },
        query: { directory: worktree },
      });
    },
  };
};

async function loadSettings(worktree: string): Promise<CommunicationSettings> {
  try {
    const configPath = resolve(worktree, "demonlord.config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      orchestration?: {
        enabled?: unknown;
        mode?: unknown;
      };
    };

    const enabled = typeof parsed.orchestration?.enabled === "boolean"
      ? parsed.orchestration.enabled
      : defaults.enabled;
    const modeCandidate = parsed.orchestration?.mode;
    const mode: OrchestrationMode =
      modeCandidate === "off" || modeCandidate === "manual" || modeCandidate === "auto"
        ? modeCandidate
        : defaults.mode;

    return { enabled, mode };
  } catch {
    return defaults;
  }
}

export const plugin = CommunicationPlugin;
export default CommunicationPlugin;
