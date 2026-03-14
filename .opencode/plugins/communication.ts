import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { executePartyModeAction, type PartyModeAction, type PartyModeArgs, type PartyModeResult } from "../tools/party_mode.ts";

type OrchestrationMode = "off" | "manual" | "auto";

interface CommunicationSettings {
  enabled: boolean;
  mode: OrchestrationMode;
  discord: DiscordSettings;
}

interface DiscordPersonaSettings {
  name: string;
  avatarUrl?: string;
}

interface DiscordSettings {
  enabled: boolean;
  personas: Record<string, DiscordPersonaSettings>;
}

type OutboundEventName =
  | "session.idle"
  | "session.error"
  | "pipeline.approval_requested"
  | "pipeline.transition"
  | "pipeline.summary";

interface OutboundNotification {
  event: OutboundEventName;
  sessionID: string;
  personaKey: string;
  personaName: string;
  personaAvatarUrl?: string;
  payload: Record<string, unknown>;
}

type OutboundMappingResult =
  | { kind: "mapped"; notification: OutboundNotification }
  | { kind: "unsupported"; sessionID?: string; reason: string }
  | { kind: "ignored" };

interface OrchestrationContext {
  rootSessionID: string;
  stage: string;
  transition: string;
  worktree: string;
  pendingFrom?: string;
  pendingTo?: string;
}

interface SessionTargetResolution {
  ok: boolean;
  sessionID?: string;
  reason?: string;
  candidates: string[];
}

interface DiscordTransportRequest {
  webhookURL: string;
  payload: {
    username: string;
    avatar_url?: string;
    content: string;
  };
}

interface DiscordTransportResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface ApproveCommandInput {
  name: string;
  sessionID: string;
  arguments: string;
  interactionToken?: string;
}

type PartyCommandName = "party" | "continue" | "halt" | "focus" | "add-agent" | "export";

type LegacyCommandName = "reject" | "park" | "handoff";
const LEGACY_COMMANDS: Record<LegacyCommandName, string> = {
  reject: "Use `/halt <reason>` to pause execution with context, or `/pipeline stop [session_id]` for a hard stop.",
  park: "Use `/halt [note]` to pause, then `/continue [note]` to resume the party round.",
  handoff: "Use `/focus <agent> [note]` for targeted work or `/add-agent <agent...>` to expand the party.",
};

const defaults: CommunicationSettings = {
  enabled: true,
  mode: "manual",
  discord: {
    enabled: true,
    personas: {
      planner: { name: "Planner" },
      orchestrator: { name: "Orchestrator" },
      minion: { name: "Minion" },
      reviewer: { name: "Reviewer" },
    },
  },
};

const OUTBOUND_ALLOWLIST = new Set<OutboundEventName>([
  "session.idle",
  "session.error",
  "pipeline.approval_requested",
  "pipeline.transition",
  "pipeline.summary",
]);

const OUTBOUND_DEDUPE_TTL_MS = 10 * 60 * 1000;
const INBOUND_DEDUPE_TTL_MS = 10 * 60 * 1000;

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
  const inboundDedupes = new Map<string, number>();
  const outboundDedupes = new Map<string, number>();

  if (!settings.enabled) {
    return {};
  }

  return {
    "command.execute.before": async (input, output) => {
      const commandName = normalizeCommandName(input.command);

      // Check if command is a legacy command
      if (commandName in LEGACY_COMMANDS) {
        output.parts = [];
        await sendFeedback(input.sessionID, `Command '${commandName}' is no longer supported. ${LEGACY_COMMANDS[commandName as LegacyCommandName]}`);
        setNoReplyIfSupported(output);
        return;
      }

      if (!isManagedCommand(commandName)) {
        return;
      }

      const parsed = parseInboundCommandArguments(input.arguments, readInteractionTokenFromSource(input));

      // Resolve target session using session targeting policy
      const sessionResolution = await resolveSessionTarget(worktree, input.sessionID);
      if (!sessionResolution.ok) {
        output.parts = [];
        await sendFeedback(input.sessionID, `Session resolution failed: ${sessionResolution.reason}`);
        setNoReplyIfSupported(output);
        return;
      }

      const targetSessionID = sessionResolution.sessionID!;
      const commandInput: ApproveCommandInput = {
        name: commandName,
        sessionID: targetSessionID,
        arguments: parsed.arguments,
        interactionToken: parsed.interactionToken,
      };

      if (!rememberInboundCommand(inboundDedupes, commandInput)) {
        output.parts = [];
        setNoReplyIfSupported(output);
        return;
      }

      rememberPreHandledCommand(preHandledCommands, commandInput);

      if (commandName === "approve") {
        await forwardApproveCommand(commandInput);
        output.parts = [];
      } else {
        const feedback = await handlePartyCommand(commandInput);
        output.parts = [];
        await sendFeedback(targetSessionID, feedback);
      }

      setNoReplyIfSupported(output);
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "command.executed") {
        const properties = readRecord(event, "properties");
        const commandName = normalizeCommandName(readString(properties, "name"));
        if (isManagedCommand(commandName)) {
          const parsed = parseInboundCommandArguments(
            readString(properties, "arguments"),
            readInteractionTokenFromSource(properties),
          );
          const commandInput: ApproveCommandInput = {
            name: commandName,
            sessionID: readString(properties, "sessionID"),
            arguments: parsed.arguments,
            interactionToken: parsed.interactionToken,
          };

          if (!wasPreHandledCommand(preHandledCommands, commandInput)) {
            if (!rememberInboundCommand(inboundDedupes, commandInput)) {
              return;
            }

            if (commandName === "approve") {
              await forwardApproveCommand(commandInput);
            } else {
              const feedback = await handlePartyCommand(commandInput);
              await sendFeedback(commandInput.sessionID, feedback);
            }
          }

          return;
        }
      }

      const mapped = await mapOutboundNotification(event, settings, worktree);
      if (mapped.kind === "ignored") {
        return;
      }

      if (mapped.kind === "unsupported") {
        if (mapped.sessionID) {
          await sendFeedback(mapped.sessionID, `Discord outbound skipped: ${mapped.reason}`);
        }
        return;
      }

      const notification = mapped.notification;
      if (!OUTBOUND_ALLOWLIST.has(notification.event)) {
        await sendFeedback(notification.sessionID, `Discord outbound blocked for non-allowlisted event '${notification.event}'.`);
        return;
      }

      const dedupeKey = buildOutboundDedupeKey(notification);
      if (!rememberOutboundEvent(outboundDedupes, dedupeKey)) {
        return;
      }

      const delivery = await sendOutboundNotification(notification);
      if (!delivery.ok) {
        const details = delivery.error ? ` ${delivery.error}` : "";
        await sendFeedback(notification.sessionID, `Discord outbound delivery failed for '${notification.event}'.${details}`.trim());
      }
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

  async function sendOutboundNotification(notification: OutboundNotification): Promise<DiscordTransportResult> {
    if (!settings.discord.enabled) {
      return {
        ok: true,
      };
    }

    const webhookURL = resolveWebhookURL(notification.personaKey);
    if (!webhookURL) {
      return {
        ok: false,
        error: `Missing webhook for persona '${notification.personaKey}'. Expected env ${toWebhookEnvKey(notification.personaKey)}.`,
      };
    }

    const transportPayload: DiscordTransportRequest = {
      webhookURL,
      payload: {
        username: notification.personaName,
        ...(notification.personaAvatarUrl ? { avatar_url: notification.personaAvatarUrl } : {}),
        content: JSON.stringify({
          version: "v1",
          event: notification.event,
          payload: notification.payload,
        }),
      },
    };

    return sendWithDiscordTransport(transportPayload);
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
  if (commandInput.interactionToken) {
    return `${normalizeCommandName(commandInput.name)}:${commandInput.sessionID}:token:${commandInput.interactionToken}`;
  }

  return `${normalizeCommandName(commandInput.name)}:${commandInput.sessionID}:${commandInput.arguments.trim()}`;
}

function buildOutboundDedupeKey(notification: OutboundNotification): string {
  return `${notification.event}:${stableSerialize(notification.payload)}`;
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

function rememberOutboundEvent(cache: Map<string, number>, key: string): boolean {
  const now = Date.now();

  for (const [cacheKey, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(cacheKey);
    }
  }

  const expiresAt = cache.get(key);
  if (expiresAt && expiresAt > now) {
    return false;
  }

  cache.set(key, now + OUTBOUND_DEDUPE_TTL_MS);
  return true;
}

function rememberInboundCommand(cache: Map<string, number>, commandInput: ApproveCommandInput): boolean {
  const now = Date.now();

  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(key);
    }
  }

  const dedupeKey = buildCommandDedupKey(commandInput);
  const expiresAt = cache.get(dedupeKey);
  if (expiresAt && expiresAt > now) {
    return false;
  }

  cache.set(dedupeKey, now + INBOUND_DEDUPE_TTL_MS);
  return true;
}

function parseInboundCommandArguments(
  rawArguments: string,
  metadataToken?: string,
): { arguments: string; interactionToken?: string } {
  const tokens = rawArguments
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  const kept: string[] = [];
  let interactionToken: string | undefined = normalizeOptionalToken(metadataToken);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    const inlineToken = readInlineInteractionFlag(token);
    if (inlineToken) {
      interactionToken = interactionToken ?? inlineToken;
      continue;
    }

    if (isInteractionFlag(token)) {
      const next = tokens[index + 1];
      if (next) {
        interactionToken = interactionToken ?? normalizeOptionalToken(next);
        index += 1;
      }
      continue;
    }

    kept.push(token);
  }

  return {
    arguments: kept.join(" "),
    interactionToken,
  };
}

function isInteractionFlag(token: string): boolean {
  return token === "--interaction-token" || token === "--interaction-id";
}

function readInlineInteractionFlag(token: string): string | undefined {
  if (token.startsWith("--interaction-token=")) {
    return normalizeOptionalToken(token.slice("--interaction-token=".length));
  }

  if (token.startsWith("--interaction-id=")) {
    return normalizeOptionalToken(token.slice("--interaction-id=".length));
  }

  return undefined;
}

function readInteractionTokenFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const metadata = readRecord(record, "metadata");

  return normalizeOptionalToken(
    readString(record, "interactionToken") ||
      readString(record, "interaction_id") ||
      readString(record, "token") ||
      readString(metadata, "interactionToken") ||
      readString(metadata, "interaction_id") ||
      readString(metadata, "token"),
  );
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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
      discord?: {
        enabled?: unknown;
        personas?: Record<string, { name?: unknown; avatarUrl?: unknown }>;
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

    const discordEnabled = typeof parsed.discord?.enabled === "boolean"
      ? parsed.discord.enabled
      : defaults.discord.enabled;

    const personas = { ...defaults.discord.personas };
    for (const [personaKey, rawPersona] of Object.entries(parsed.discord?.personas ?? {})) {
      const existing = personas[personaKey] ?? { name: personaKey };
      const normalizedName = typeof rawPersona?.name === "string" && rawPersona.name.trim().length > 0
        ? rawPersona.name.trim()
        : existing.name;
      const normalizedAvatar = typeof rawPersona?.avatarUrl === "string" && rawPersona.avatarUrl.trim().length > 0
        ? rawPersona.avatarUrl.trim()
        : undefined;
      personas[personaKey] = {
        name: normalizedName,
        ...(normalizedAvatar ? { avatarUrl: normalizedAvatar } : {}),
      };
    }

    return {
      enabled,
      mode,
      discord: {
        enabled: discordEnabled,
        personas,
      },
    };
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

async function mapOutboundNotification(
  event: Event,
  settings: CommunicationSettings,
  worktree: string,
): Promise<OutboundMappingResult> {
  if (event.type === "session.idle") {
    const sessionID = readString(readRecord(event, "properties"), "sessionID");
    if (!sessionID) {
      return { kind: "ignored" };
    }

    const context = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(context, sessionID, worktree);

    if (context?.transition === "awaiting_approval") {
      return {
        kind: "mapped",
        notification: createNotification(settings, metadata.persona, {
          event: "pipeline.approval_requested",
          sessionID,
          payload: {
            ...metadata,
            status: "awaiting_approval",
            stage: context.stage,
          },
        }),
      };
    }

    if (context?.transition === "completed") {
      return {
        kind: "mapped",
        notification: createNotification(settings, metadata.persona, {
          event: "pipeline.summary",
          sessionID,
          payload: {
            ...metadata,
            status: "completed",
            result: "pass",
          },
        }),
      };
    }

    return {
      kind: "mapped",
      notification: createNotification(settings, metadata.persona, {
        event: "session.idle",
        sessionID,
        payload: {
          ...metadata,
          status: "idle",
          summary: "Session is waiting for operator input.",
        },
      }),
    };
  }

  if (event.type === "session.error") {
    const properties = readRecord(event, "properties");
    const sessionID = readString(properties, "sessionID");
    if (!sessionID) {
      return { kind: "ignored" };
    }

    const context = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(context, sessionID, worktree);
    const error = readRecord(properties, "error");
    const errorCode = readString(error, "code") || "UNKNOWN";
    const errorMessage = readString(readRecord(error, "data"), "message") || "unknown error";

    if (context?.transition === "blocked" || context?.transition === "stopped") {
      return {
        kind: "mapped",
        notification: createNotification(settings, metadata.persona, {
          event: "pipeline.summary",
          sessionID,
          payload: {
            ...metadata,
            status: "failed",
            result: "fail",
            error_code: errorCode,
            summary: errorMessage,
          },
        }),
      };
    }

    return {
      kind: "mapped",
      notification: createNotification(settings, metadata.persona, {
        event: "session.error",
        sessionID,
        payload: {
          ...metadata,
          status: "error",
          error_code: errorCode,
          summary: errorMessage,
        },
      }),
    };
  }

  if (event.type === "command.executed") {
    const properties = readRecord(event, "properties");
    const commandName = normalizeCommandName(readString(properties, "name"));
    if (commandName !== "pipeline") {
      return { kind: "ignored" };
    }

    const sessionID = readString(properties, "sessionID");
    if (!sessionID) {
      return {
        kind: "unsupported",
        reason: "Pipeline command event is missing sessionID.",
      };
    }

    const args = readString(properties, "arguments").trim();
    const [action = "", targetStage = ""] = args.split(/\s+/, 2);
    if (!action || !isPipelineTransitionAction(action)) {
      return {
        kind: "unsupported",
        sessionID,
        reason: `No outbound mapping for pipeline action '${action || "(empty)"}'.`,
      };
    }

    const context = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(context, sessionID, worktree);

    return {
      kind: "mapped",
      notification: createNotification(settings, metadata.persona, {
        event: "pipeline.transition",
        sessionID,
        payload: {
          ...metadata,
          command_action: action,
          from_stage: context?.pendingFrom ?? context?.stage ?? metadata.stage,
          to_stage: context?.pendingTo ?? normalizePipelineStage(targetStage) ?? context?.stage ?? metadata.stage,
        },
      }),
    };
  }

  return { kind: "ignored" };
}

function createNotification(
  settings: CommunicationSettings,
  personaKey: string,
  input: {
    event: OutboundEventName;
    sessionID: string;
    payload: Record<string, unknown>;
  },
): OutboundNotification {
  const persona = settings.discord.personas[personaKey] ?? settings.discord.personas.orchestrator ?? { name: "Orchestrator" };
  return {
    event: input.event,
    sessionID: input.sessionID,
    personaKey,
    personaName: persona.name,
    personaAvatarUrl: persona.avatarUrl,
    payload: {
      ...input.payload,
      persona: personaKey,
      worktree: input.payload.worktree,
      session_id: input.payload.session_id,
    },
  };
}

function buildMetadata(
  context: OrchestrationContext | undefined,
  sessionID: string,
  fallbackWorktree: string,
): {
  session_id: string;
  root_session_id: string;
  stage: string;
  transition: string;
  worktree: string;
  persona: string;
} {
  const stage = context?.stage ?? "unknown";
  return {
    session_id: sessionID,
    root_session_id: context?.rootSessionID ?? sessionID,
    stage,
    transition: context?.transition ?? "unknown",
    worktree: context?.worktree ?? fallbackWorktree,
    persona: resolvePersonaKey(stage),
  };
}

async function loadOrchestrationContext(worktree: string, sessionID: string): Promise<OrchestrationContext | undefined> {
  const statePath = resolve(worktree, "_bmad-output", "orchestration-state.json");

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sessionToRoot = readRecord(parsed, "sessionToRoot");
    const pipelines = readRecord(parsed, "pipelines");
    const pipelineSummaries = readRecord(parsed, "pipelineSummaries");

    const rootSessionID = readString(sessionToRoot, sessionID) || sessionID;
    const pipeline = readRecord(pipelines, rootSessionID);
    const summary = readRecord(pipelineSummaries, rootSessionID);
    const sessions = readRecord(pipeline, "sessions");
    const sessionState = readRecord(sessions, sessionID);
    const rootSessionState = readRecord(sessions, rootSessionID);
    const pending = readRecord(pipeline, "pendingTransition") ?? readRecord(summary, "pendingTransition");

    const stage =
      readString(sessionState, "stage") ||
      readString(rootSessionState, "stage") ||
      readString(pipeline, "currentStage") ||
      readString(summary, "currentStage") ||
      "unknown";
    const transition = readString(pipeline, "transition") || readString(summary, "transition") || "unknown";
    const resolvedWorktree =
      readString(readRecord(pipeline, "worktree"), "worktreePath") ||
      readString(sessionState, "directory") ||
      readString(rootSessionState, "directory") ||
      worktree;

    return {
      rootSessionID,
      stage,
      transition,
      worktree: resolvedWorktree,
      pendingFrom: readString(pending, "from"),
      pendingTo: readString(pending, "to"),
    };
  } catch {
    return undefined;
  }
}

async function resolveSessionTarget(
  worktree: string,
  explicitSessionID?: string,
): Promise<SessionTargetResolution> {
  // Load orchestration state to get all active sessions
  const statePath = resolve(worktree, "_bmad-output", "orchestration-state.json");
  let activeSessions: string[] = [];

  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pipelines = readRecord(parsed, "pipelines");

    // Collect all active sessions from all pipelines
    for (const [rootSessionID, pipelineData] of Object.entries(pipelines ?? {})) {
      const pipeline = pipelineData as Record<string, unknown>;
      const sessions = readRecord(pipeline, "sessions");
      if (sessions) {
        for (const [sessionID, sessionData] of Object.entries(sessions)) {
          const session = sessionData as Record<string, unknown>;
          const status = readString(session, "status");
          if (status === "active") {
            activeSessions.push(sessionID);
          }
        }
      }
    }
  } catch {
    // If we can't load the state, fall back to using the explicit session_id if provided
    if (explicitSessionID && explicitSessionID.trim().length > 0) {
      return {
        ok: true,
        sessionID: explicitSessionID,
        candidates: [explicitSessionID],
        reason: "Orchestration state not available, using provided session_id.",
      };
    }
    // If no explicit session_id is provided and no state is available, we can't resolve
    return {
      ok: false,
      reason: "Unable to load orchestration state and no explicit session_id provided.",
      candidates: [],
    };
  }

  // Deduplicate sessions
  activeSessions = [...new Set(activeSessions)];

  // If explicit session_id is provided, validate it
  if (explicitSessionID && explicitSessionID.trim().length > 0) {
    if (activeSessions.includes(explicitSessionID)) {
      return {
        ok: true,
        sessionID: explicitSessionID,
        candidates: activeSessions,
      };
    }

    const candidateHint = activeSessions.length > 0 ? activeSessions.join(", ") : "none";
    return {
      ok: false,
      reason: `No active session matches explicit session_id '${explicitSessionID}'. Active candidates: ${candidateHint}.`,
      candidates: activeSessions,
    };
  }

  // No explicit session_id provided - try to auto-target
  if (activeSessions.length === 0) {
    return {
      ok: false,
      reason: "No active candidate session is available.",
      candidates: [],
    };
  }

  if (activeSessions.length === 1) {
    return {
      ok: true,
      sessionID: activeSessions[0],
      candidates: activeSessions,
    };
  }

  // Multiple active sessions - require explicit session_id
  return {
    ok: false,
    reason: `Multiple active sessions found (${activeSessions.join(", ")}). Provide an explicit session_id.`,
    candidates: activeSessions,
  };
}

function resolvePersonaKey(stage: string): string {
  if (stage === "triage") {
    return "planner";
  }

  if (stage === "implementation") {
    return "minion";
  }

  if (stage === "review") {
    return "reviewer";
  }

  return "orchestrator";
}

function resolveWebhookURL(personaKey: string): string | undefined {
  const personaSpecific = process.env[toWebhookEnvKey(personaKey)];
  if (personaSpecific && personaSpecific.trim().length > 0) {
    return personaSpecific.trim();
  }

  const fallback = process.env.DISCORD_WEBHOOK_ORCHESTRATOR;
  if (fallback && fallback.trim().length > 0) {
    return fallback.trim();
  }

  return undefined;
}

function toWebhookEnvKey(personaKey: string): string {
  return `DISCORD_WEBHOOK_${personaKey.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

async function sendWithDiscordTransport(request: DiscordTransportRequest): Promise<DiscordTransportResult> {
  try {
    const response = await fetch(request.webhookURL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request.payload),
    });

    if (!response.ok) {
      const body = await safeReadResponseBody(response);
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${body ? ` ${body}` : ""}`,
      };
    }

    return {
      ok: true,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatError(error),
    };
  }
}

function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | undefined, key: string): string {
  if (!source) {
    return "";
  }

  const value = source[key];
  return typeof value === "string" ? value : "";
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
  return `{${entries.join(",")}}`;
}

function isPipelineTransitionAction(action: string): boolean {
  return action === "approve" || action === "advance" || action === "stop" || action === "off" || action === "on";
}

function normalizePipelineStage(raw: string): string | undefined {
  if (raw === "triage" || raw === "implementation" || raw === "review") {
    return raw;
  }

  return undefined;
}

async function safeReadResponseBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return "";
    }

    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
