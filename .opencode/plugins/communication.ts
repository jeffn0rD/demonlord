import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFile } from "fs/promises";
import { resolve } from "path";

type OrchestrationMode = "off" | "manual" | "auto";

interface CommunicationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
}

interface ApproveCommandInput {
  sessionID: string;
  arguments: string;
}

const defaults: CommunicationSettings = {
  enabled: true,
  mode: "manual",
};

const CommunicationPlugin: Plugin = async ({ client, worktree }) => {
  const settings = await loadSettings(worktree);
  const preHandledApprovals = new Map<string, number>();

  if (!settings.enabled) {
    return {};
  }

  return {
    "command.execute.before": async (input, output) => {
      const commandName = normalizeCommandName(input.command);
      if (commandName !== "approve") {
        return;
      }

      const commandInput: ApproveCommandInput = {
        sessionID: input.sessionID,
        arguments: input.arguments,
      };

      rememberPreHandledApproval(preHandledApprovals, commandInput);
      await forwardApproveCommand(commandInput);
      output.parts = [];
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "command.executed") {
        return;
      }

      if (normalizeCommandName(event.properties.name) !== "approve") {
        return;
      }

      const commandInput: ApproveCommandInput = {
        sessionID: event.properties.sessionID,
        arguments: event.properties.arguments,
      };

      if (wasPreHandledApproval(preHandledApprovals, commandInput)) {
        return;
      }

      await forwardApproveCommand(commandInput);
    },
  };

  async function forwardApproveCommand(commandInput: ApproveCommandInput): Promise<void> {
      if (settings.mode === "off") {
        await client.session.prompt({
          path: { id: commandInput.sessionID },
          body: {
            agent: "orchestrator",
            noReply: true,
            parts: [{ type: "text", text: "Orchestration is OFF. `/approve` is unavailable." }],
          },
          query: { directory: worktree },
        });
        return;
      }

      const args = commandInput.arguments.trim();
      const commandArgs = args.length > 0 ? `approve ${args}` : "approve";

      await client.session.command({
        path: { id: commandInput.sessionID },
        body: {
          command: "pipeline",
          arguments: commandArgs,
          agent: "orchestrator",
        },
        query: { directory: worktree },
      });
  }
};

function normalizeCommandName(command: string): string {
  return command.replace(/^\//, "").toLowerCase();
}

function buildApprovalDedupKey(commandInput: ApproveCommandInput): string {
  return `${commandInput.sessionID}:${commandInput.arguments.trim()}`;
}

function rememberPreHandledApproval(cache: Map<string, number>, commandInput: ApproveCommandInput): void {
  const now = Date.now();
  cache.set(buildApprovalDedupKey(commandInput), now + 30_000);

  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function wasPreHandledApproval(cache: Map<string, number>, commandInput: ApproveCommandInput): boolean {
  const key = buildApprovalDedupKey(commandInput);
  const expiresAt = cache.get(key);
  const now = Date.now();

  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= now) {
    cache.delete(key);
    return false;
  }

  cache.delete(key);
  return true;
}

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
