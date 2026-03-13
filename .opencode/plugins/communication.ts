import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { executePartyModeAction, type PartyModeAction, type PartyModeArgs, type PartyModeResult } from "../tools/party_mode.ts";

type OrchestrationMode = "off" | "manual" | "auto";

interface CommunicationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
}

interface ApproveCommandInput {
  name: string;
  sessionID: string;
  arguments: string;
}

type PartyCommandName = "party" | "continue" | "halt" | "focus" | "add-agent" | "export";

const defaults: CommunicationSettings = {
  enabled: true,
  mode: "manual",
};

const partyCommandActions: Record<PartyCommandName, PartyModeAction> = {
  party: "start",
  continue: "continue",
  halt: "halt",
  focus: "focus",
  "add-agent": "add-agent",
  export: "export",
};

const CommunicationPlugin: Plugin = async ({ client, worktree }) => {
  const settings = await loadSettings(worktree);
  const preHandledCommands = new Map<string, number>();

  if (!settings.enabled) {
    return {};
  }

  return {
    "command.execute.before": async (input, output) => {
      const commandName = normalizeCommandName(input.command);
      if (!isManagedCommand(commandName)) {
        return;
      }

      const commandInput: ApproveCommandInput = {
        name: commandName,
        sessionID: input.sessionID,
        arguments: input.arguments,
      };

      rememberPreHandledCommand(preHandledCommands, commandInput);

      if (commandName === "approve") {
        await forwardApproveCommand(commandInput);
        output.parts = [];
      } else {
        const feedback = await handlePartyCommand(commandInput);
        output.parts = [];
        await sendFeedback(commandInput.sessionID, feedback);
      }

      setNoReplyIfSupported(output);
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "command.executed") {
        return;
      }

      const commandName = normalizeCommandName(event.properties.name);
      if (!isManagedCommand(commandName)) {
        return;
      }

      const commandInput: ApproveCommandInput = {
        name: commandName,
        sessionID: event.properties.sessionID,
        arguments: event.properties.arguments,
      };

      if (wasPreHandledCommand(preHandledCommands, commandInput)) {
        return;
      }

      if (commandName === "approve") {
        await forwardApproveCommand(commandInput);
        return;
      }

      const feedback = await handlePartyCommand(commandInput);
      await sendFeedback(commandInput.sessionID, feedback);
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

  async function handlePartyCommand(commandInput: ApproveCommandInput): Promise<string> {
    const commandName = normalizeCommandName(commandInput.name);
    if (!isPartyCommand(commandName)) {
      return "Unsupported Party Mode command.";
    }

    const args = parsePartyModeArgs(commandInput, commandName);
    const result = await executePartyModeAction(args, { worktree });
    return formatPartyModeResult(result, args.session_id);
  }

  async function sendFeedback(sessionID: string, message: string): Promise<void> {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: "orchestrator",
        noReply: true,
        parts: [{ type: "text", text: message }],
      },
      query: { directory: worktree },
    });
  }
};

function normalizeCommandName(command: string): string {
  return command.replace(/^\//, "").toLowerCase();
}

function isManagedCommand(commandName: string): commandName is "approve" | PartyCommandName {
  return commandName === "approve" || isPartyCommand(commandName);
}

function isPartyCommand(commandName: string): commandName is PartyCommandName {
  return commandName in partyCommandActions;
}

function buildCommandDedupKey(commandInput: ApproveCommandInput): string {
  return `${normalizeCommandName(commandInput.name)}:${commandInput.sessionID}:${commandInput.arguments.trim()}`;
}

function rememberPreHandledCommand(cache: Map<string, number>, commandInput: ApproveCommandInput): void {
  const now = Date.now();
  cache.set(buildCommandDedupKey(commandInput), now + 30_000);

  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function wasPreHandledCommand(cache: Map<string, number>, commandInput: ApproveCommandInput): boolean {
  const key = buildCommandDedupKey(commandInput);
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

function parsePartyModeArgs(commandInput: ApproveCommandInput, commandName: PartyCommandName): PartyModeArgs {
  const sessionID = commandInput.sessionID;
  const rawArgs = commandInput.arguments.trim();
  const action = partyCommandActions[commandName];

  if (commandName === "party") {
    const parsedAgents = parseAgentList(rawArgs);
    return {
      action,
      session_id: sessionID,
      agents: parsedAgents.length > 0 ? parsedAgents : undefined,
    };
  }

  if (commandName === "continue" || commandName === "halt") {
    return {
      action,
      session_id: sessionID,
      note: rawArgs.length > 0 ? rawArgs : undefined,
    };
  }

  if (commandName === "focus") {
    const { head, tail } = splitHeadAndTail(rawArgs);
    return {
      action,
      session_id: sessionID,
      agent: head,
      note: tail,
    };
  }

  if (commandName === "add-agent") {
    const agents = parseAgentList(rawArgs);
    return {
      action,
      session_id: sessionID,
      agents,
    };
  }

  return {
    action,
    session_id: sessionID,
    export_path: rawArgs.length > 0 ? rawArgs : undefined,
  };
}

function parseAgentList(rawArgs: string): string[] {
  if (!rawArgs) {
    return [];
  }

  return rawArgs
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitHeadAndTail(rawArgs: string): { head?: string; tail?: string } {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {};
  }

  const [head, ...tailParts] = trimmed.split(/\s+/);
  const tail = tailParts.join(" ").trim();
  return {
    head,
    tail: tail.length > 0 ? tail : undefined,
  };
}

function formatPartyModeResult(result: PartyModeResult, sessionID: string): string {
  if (!result.ok) {
    const code = result.code ? ` [${result.code}]` : "";
    return `Party Mode${code}: ${result.error ?? "Operation failed."}`;
  }

  const state = result.state;
  if (!state) {
    return "Party Mode: command completed.";
  }

  const focus = state.focusedAgent ?? "none";
  const agentList = state.agents.length > 0 ? state.agents.join(", ") : "none";
  const halted = state.halted ? "yes" : "no";
  const base = `Party Mode ${result.action} applied for ${sessionID}. Round ${state.round}. Halted: ${halted}. Focus: ${focus}. Agents: ${agentList}.`;

  if (result.action === "export") {
    const exportPath = result.export_path ?? "(default path)";
    return `${base} Transcript exported to ${exportPath}.`;
  }

  return base;
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

function setNoReplyIfSupported(output: { parts: unknown[] }): void {
  const mutable = output as { noReply?: boolean };
  mutable.noReply = true;
}
