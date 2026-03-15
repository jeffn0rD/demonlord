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
  authorization: DiscordAuthorizationSettings;
}

interface DiscordAuthorizationSettings {
  required: boolean;
  allowedUserIDs: string[];
  allowedRoleIDs: string[];
  allowedChannelID?: string;
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
  attempts?: number;
}

interface InboundAuthorizationContext {
  source: "discord" | "other" | "unknown";
  hasDiscordSignal: boolean;
  userID?: string;
  roleIDs: string[];
  channelID?: string;
}

interface ApproveCommandInput {
  name: string;
  sessionID: string;
  arguments: string;
  interactionToken?: string;
}

interface ParsedInboundCommandArguments {
  arguments: string;
  interactionToken?: string;
  explicitSessionID?: string;
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
    authorization: {
      required: true,
      allowedUserIDs: [],
      allowedRoleIDs: [],
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
const PREHANDLED_DEDUPE_TTL_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [0, 250, 1000] as const;
const MASKED_SECRET = "[REDACTED]";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
  const preHandledFailures = new Map<string, number>();
  const inboundDedupes = new Map<string, number>();
  const outboundDedupes = new Map<string, number>();

  if (!settings.enabled) {
    return {};
  }

  validateDiscordStartupConfiguration(settings);

  return {
    "command.execute.before": async (input, output) => {
      const handled = await handleInboundCommand(input, "prehook");
      if (!handled) {
        return;
      }
      output.parts = [];
      setNoReplyIfSupported(output);
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "command.executed") {
        const properties = readRecord(event, "properties");
        const handled = await handleInboundCommand(properties, "event");
        if (handled) {
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
      if (!checkOutboundDedupe(outboundDedupes, dedupeKey)) {
        return;
      }

      const delivery = await sendOutboundNotification(notification);
      if (delivery.ok) {
        commitOutboundDedupe(outboundDedupes, dedupeKey);
      } else {
        const details = delivery.error ? ` ${redactSecrets(delivery.error)}` : "";
        const attempts = delivery.attempts ? ` after ${delivery.attempts} attempts` : "";
        await sendFeedback(
          notification.sessionID,
          `Discord outbound delivery failed for '${notification.event}'${attempts}.${details}`.trim(),
        );
      }
    },
  };

  async function executeInboundCommand(
    commandInput: ApproveCommandInput,
  ): Promise<{ ok: true; feedback?: string } | { ok: false; error: string }> {
    const commandName = normalizeCommandName(commandInput.name);
    const operation: () => Promise<string | undefined> = commandName === "approve"
      ? async () => {
        await forwardApproveCommand(commandInput);
        return undefined;
      }
      : () => handlePartyCommand(commandInput);
    const retried = await executeWithDeterministicRetry(operation);

    if (!retried.ok) {
      return {
        ok: false,
        error: `Inbound command '${commandName}' failed after ${retried.attempts} attempts. ${retried.error}`,
      };
    }

    if (typeof retried.value === "string") {
      return {
        ok: true,
        feedback: retried.value,
      };
    }

    return { ok: true };
  }

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
        parts: [{ type: "text", text: redactSecrets(message) }],
      },
      query: { directory: worktree },
    });
  }

  async function handleInboundCommand(source: unknown, ingress: "prehook" | "event"): Promise<boolean> {
    const commandName = normalizeCommandName(readCommandName(source));

    if (commandName in LEGACY_COMMANDS) {
      const feedbackSessionID = readFeedbackSessionID(source);
      if (feedbackSessionID) {
        await sendFeedback(
          feedbackSessionID,
          `Command '${commandName}' is no longer supported. ${LEGACY_COMMANDS[commandName as LegacyCommandName]}`,
        );
      }
      return true;
    }

    if (!isManagedCommand(commandName)) {
      return false;
    }

    const parsed = parseInboundCommandArguments(
      commandName,
      readCommandArguments(source),
      readInteractionTokenFromSource(source),
      source,
    );
    const failureDedupeKey = buildFailureDedupKey(commandName, readFeedbackSessionID(source), parsed);
    if (ingress === "event" && wasPreHandledFailure(preHandledFailures, failureDedupeKey)) {
      return true;
    }

    const authContext = buildInboundAuthorizationContext(source, parsed.interactionToken);
    const authz = authorizeInboundCommand(settings.discord.authorization, authContext, ingress);
    if (!authz.ok) {
      if (ingress === "prehook") {
        rememberPreHandledFailure(preHandledFailures, failureDedupeKey);
      }
      const feedbackSessionID = readFeedbackSessionID(source);
      if (feedbackSessionID) {
        await sendFeedback(feedbackSessionID, authz.reason);
      }
      return true;
    }

    const sessionResolution = await resolveSessionTarget(worktree, parsed.explicitSessionID);
    if (!sessionResolution.ok) {
      if (ingress === "prehook") {
        rememberPreHandledFailure(preHandledFailures, failureDedupeKey);
      }
      const feedbackSessionID = readFeedbackSessionID(source);
      if (feedbackSessionID) {
        await sendFeedback(feedbackSessionID, `Session resolution failed: ${sessionResolution.reason}`);
      }
      return true;
    }

    const targetSessionID = sessionResolution.sessionID!;
    const commandInput: ApproveCommandInput = {
      name: commandName,
      sessionID: targetSessionID,
      arguments: parsed.arguments,
      interactionToken: parsed.interactionToken,
    };

    if (ingress === "event" && wasPreHandledCommand(preHandledCommands, commandInput)) {
      return true;
    }

    if (!rememberInboundCommand(inboundDedupes, commandInput)) {
      return true;
    }

    if (ingress === "prehook") {
      rememberPreHandledCommand(preHandledCommands, commandInput);
      rememberPreHandledFailure(preHandledFailures, failureDedupeKey);
    }

    const result = await executeInboundCommand(commandInput);
    if (!result.ok) {
      await sendFeedback(targetSessionID, result.error);
    } else if (result.feedback) {
      await sendFeedback(targetSessionID, result.feedback);
    }

    return true;
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

function buildFailureDedupKey(
  commandName: string,
  feedbackSessionID: string | undefined,
  parsed: ParsedInboundCommandArguments,
): string {
  const sessionID = normalizeOptionalToken(feedbackSessionID) ?? "(missing-session)";
  const explicitSessionID = normalizeOptionalToken(parsed.explicitSessionID) ?? "";
  const interactionToken = normalizeOptionalToken(parsed.interactionToken) ?? "";
  return `${normalizeCommandName(commandName)}:${sessionID}:${explicitSessionID}:${parsed.arguments.trim()}:token:${interactionToken}`;
}

function buildOutboundDedupeKey(notification: OutboundNotification): string {
  return `${notification.event}:${stableSerialize(notification.payload)}`;
}

function rememberPreHandledCommand(cache: Map<string, number>, commandInput: ApproveCommandInput): void {
  rememberPreHandledKey(cache, buildCommandDedupKey(commandInput));
}

function rememberPreHandledFailure(cache: Map<string, number>, dedupeKey: string): void {
  rememberPreHandledKey(cache, dedupeKey);
}

function rememberPreHandledKey(cache: Map<string, number>, key: string): void {
  const now = Date.now();
  cache.set(key, now + PREHANDLED_DEDUPE_TTL_MS);

  for (const [cacheKey, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(cacheKey);
    }
  }
}

function wasPreHandledCommand(cache: Map<string, number>, commandInput: ApproveCommandInput): boolean {
  return wasPreHandledKey(cache, buildCommandDedupKey(commandInput));
}

function wasPreHandledFailure(cache: Map<string, number>, dedupeKey: string): boolean {
  return wasPreHandledKey(cache, dedupeKey);
}

function wasPreHandledKey(cache: Map<string, number>, key: string): boolean {
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

function checkOutboundDedupe(cache: Map<string, number>, key: string): boolean {
  const now = Date.now();

  // Cleanup expired entries
  for (const [cacheKey, expiresAt] of cache) {
    if (expiresAt <= now) {
      cache.delete(cacheKey);
    }
  }

  const expiresAt = cache.get(key);
  if (expiresAt && expiresAt > now) {
    return false; // Already exists, do not send
  }

  return true; // Should send
}

function commitOutboundDedupe(cache: Map<string, number>, key: string): void {
  const now = Date.now();
  cache.set(key, now + OUTBOUND_DEDUPE_TTL_MS);
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
  commandName: string,
  rawArguments: string,
  metadataToken?: string,
  source?: unknown,
): ParsedInboundCommandArguments {
  const explicitSessionFromSource = readExplicitSessionIDFromSource(source);
  const tokens = rawArguments
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  const kept: string[] = [];
  let interactionToken: string | undefined = normalizeOptionalToken(metadataToken);
  let explicitSessionID: string | undefined = explicitSessionFromSource;

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

    const inlineSessionID = readInlineSessionFlag(token);
    if (inlineSessionID) {
      explicitSessionID = explicitSessionID ?? inlineSessionID;
      continue;
    }

    if (isSessionFlag(token)) {
      const next = tokens[index + 1];
      if (next) {
        explicitSessionID = explicitSessionID ?? normalizeOptionalToken(next);
        index += 1;
      }
      continue;
    }

    kept.push(token);
  }

  if (!explicitSessionID && commandName === "approve") {
    const firstToken = kept[0];
    if (firstToken && SESSION_ID_PATTERN.test(firstToken)) {
      explicitSessionID = firstToken;
      kept.shift();
    }
  }

  return {
    arguments: kept.join(" "),
    interactionToken,
    explicitSessionID,
  };
}

function isSessionFlag(token: string): boolean {
  return token === "--session-id" || token === "--session_id" || token === "--session";
}

function readInlineSessionFlag(token: string): string | undefined {
  if (token.startsWith("--session-id=")) {
    return normalizeOptionalToken(token.slice("--session-id=".length));
  }

  if (token.startsWith("--session_id=")) {
    return normalizeOptionalToken(token.slice("--session_id=".length));
  }

  if (token.startsWith("--session=")) {
    return normalizeOptionalToken(token.slice("--session=".length));
  }

  return undefined;
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

function readExplicitSessionIDFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const metadata = readRecord(record, "metadata");
  const args = readRecord(record, "args") ?? readRecord(metadata, "args");

  return normalizeOptionalToken(
    readString(record, "session_id") ||
      readString(record, "target_session_id") ||
      readString(args, "session_id") ||
      readString(args, "session") ||
      readString(metadata, "session_id") ||
      readString(metadata, "target_session_id"),
  );
}

function readFeedbackSessionID(source: unknown): string {
  if (!source || typeof source !== "object") {
    return "";
  }

  const record = source as Record<string, unknown>;
  const metadata = readRecord(record, "metadata");
  return normalizeOptionalToken(
    readString(record, "sessionID") ||
      readString(record, "session_id") ||
      readString(metadata, "sessionID") ||
      readString(metadata, "session_id"),
  ) ?? "";
}

function readCommandName(source: unknown): string {
  if (!source || typeof source !== "object") {
    return "";
  }

  const record = source as Record<string, unknown>;
  return readString(record, "command") || readString(record, "name");
}

function readCommandArguments(source: unknown): string {
  if (!source || typeof source !== "object") {
    return "";
  }

  const record = source as Record<string, unknown>;
  if (typeof record.arguments === "string") {
    return record.arguments;
  }

  const metadata = readRecord(record, "metadata");
  const argsRecord = readRecord(record, "args") ?? readRecord(metadata, "args");
  const argsText = readString(argsRecord, "text") || readString(argsRecord, "raw");
  if (argsText) {
    return argsText;
  }

  const orderedArgs = [
    readString(argsRecord, "agent"),
    readString(argsRecord, "note"),
    readString(argsRecord, "agents"),
    readString(argsRecord, "export_path"),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return orderedArgs.join(" ");
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readInboundSource(source: unknown): "discord" | "other" | "unknown" {
  const record = typeof source === "object" && source ? source as Record<string, unknown> : undefined;
  const metadata = readRecord(record, "metadata");

  const rawSource =
    readString(record, "source") ||
    readString(record, "origin") ||
    readString(record, "transport") ||
    readString(metadata, "source") ||
    readString(metadata, "origin") ||
    readString(metadata, "transport");

  const normalized = normalizeOptionalToken(rawSource)?.toLowerCase();
  if (normalized === "discord") {
    return "discord";
  }

  if (normalized) {
    return "other";
  }

  return "unknown";
}

function buildInboundAuthorizationContext(source: unknown, interactionToken?: string): InboundAuthorizationContext {
  const record = typeof source === "object" && source ? source as Record<string, unknown> : undefined;
  const metadata = readRecord(record, "metadata");
  const userRecord = readRecord(record, "user") ?? readRecord(metadata, "user");
  const channelRecord = readRecord(record, "channel") ?? readRecord(metadata, "channel");

  const userID =
    normalizeOptionalToken(readString(record, "user_id")) ||
    normalizeOptionalToken(readString(record, "userID")) ||
    normalizeOptionalToken(readString(userRecord, "id")) ||
    normalizeOptionalToken(readString(metadata, "user_id"));
  const roleIDs = mergeUnique(
    readStringArrayValue(record?.role_ids),
    readStringArrayValue(record?.roleIDs),
    readStringArrayValue(userRecord?.role_ids),
    readStringArrayValue(userRecord?.roles),
    readStringArrayValue(metadata?.role_ids),
  );
  const channelID =
    normalizeOptionalToken(readString(record, "channel_id")) ||
    normalizeOptionalToken(readString(record, "channelID")) ||
    normalizeOptionalToken(readString(channelRecord, "id")) ||
    normalizeOptionalToken(readString(metadata, "channel_id"));

  const hasDiscordSignal = Boolean(
    interactionToken ||
      normalizeOptionalToken(readString(record, "interaction_id")) ||
      normalizeOptionalToken(readString(record, "interactionToken")) ||
      normalizeOptionalToken(readString(metadata, "interaction_id")) ||
      normalizeOptionalToken(readString(metadata, "interactionToken")) ||
      userID ||
      roleIDs.length > 0 ||
      channelID,
  );

  return {
    source: readInboundSource(source),
    hasDiscordSignal,
    roleIDs,
    ...(userID ? { userID } : {}),
    ...(channelID ? { channelID } : {}),
  };
}

function authorizeInboundCommand(
  settings: DiscordAuthorizationSettings,
  context: InboundAuthorizationContext,
  ingress: "prehook" | "event",
): { ok: true } | { ok: false; reason: string } {
  if (!settings.required) {
    return { ok: true };
  }

  if (ingress === "event" && context.source !== "other" && !context.hasDiscordSignal) {
    return {
      ok: false,
      reason: "Discord command denied: missing Discord identity context for an authorization-required command.",
    };
  }

  if (context.source === "discord" && !context.hasDiscordSignal) {
    return {
      ok: false,
      reason: "Discord command denied: missing Discord identity context for an authorization-required command.",
    };
  }

  if (!context.hasDiscordSignal) {
    return { ok: true };
  }

  const channelConstraint = settings.allowedChannelID;
  if (channelConstraint && context.channelID !== channelConstraint) {
    const actual = context.channelID ?? "(missing)";
    return {
      ok: false,
      reason: `Discord command denied: channel '${actual}' is not authorized. Expected '${channelConstraint}'.`,
    };
  }

  const userAllowed = Boolean(context.userID && settings.allowedUserIDs.includes(context.userID));
  const roleAllowed = context.roleIDs.some((roleID) => settings.allowedRoleIDs.includes(roleID));
  if (userAllowed || roleAllowed) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Discord command denied: caller is not in the configured user/role allowlist.",
  };
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
  const configPath = resolve(worktree, "demonlord.config.json");
  let raw = "";

  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    const readError = error as NodeJS.ErrnoException;
    if (readError.code === "ENOENT") {
      raw = "{}";
    } else {
      throw new Error(
        `Communication plugin failed to read config '${configPath}': ${formatError(error)}`,
      );
    }
  }

  let parsed: {
    orchestration?: {
      enabled?: unknown;
      mode?: unknown;
    };
    discord?: {
      enabled?: unknown;
      personas?: Record<string, { name?: unknown; avatarUrl?: unknown }>;
      authorization?: {
        required?: unknown;
        allowed_user_ids?: unknown;
        allowed_role_ids?: unknown;
        allowed_channel_id?: unknown;
      };
    };
  };

  try {
    parsed = JSON.parse(raw) as {
      orchestration?: {
        enabled?: unknown;
        mode?: unknown;
      };
      discord?: {
        enabled?: unknown;
        personas?: Record<string, { name?: unknown; avatarUrl?: unknown }>;
        authorization?: {
          required?: unknown;
          allowed_user_ids?: unknown;
          allowed_role_ids?: unknown;
          allowed_channel_id?: unknown;
        };
      };
    };
  } catch (error) {
    throw new Error(
      `Communication plugin failed to parse config '${configPath}': ${formatError(error)}`,
    );
  }

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

  const auth = parsed.discord?.authorization;
  const allowedUserIDs = mergeUnique(
    readStringArrayValue(auth?.allowed_user_ids),
    parseCommaSeparatedEnv("DISCORD_ALLOWED_USER_IDS"),
  );
  const allowedRoleIDs = mergeUnique(
    readStringArrayValue(auth?.allowed_role_ids),
    parseCommaSeparatedEnv("DISCORD_ALLOWED_ROLE_IDS"),
  );
  const allowedChannelID =
    normalizeOptionalToken(typeof auth?.allowed_channel_id === "string" ? auth.allowed_channel_id : undefined) ||
    normalizeOptionalToken(process.env.DISCORD_ALLOWED_CHANNEL_ID);
  const required = typeof auth?.required === "boolean"
    ? auth.required
    : defaults.discord.authorization.required;

  return {
    enabled,
    mode,
    discord: {
      enabled: discordEnabled,
      personas,
      authorization: {
        required,
        allowedUserIDs,
        allowedRoleIDs,
        ...(allowedChannelID ? { allowedChannelID } : {}),
      },
    },
  };
}

function validateDiscordStartupConfiguration(settings: CommunicationSettings): void {
  if (!settings.discord.enabled) {
    return;
  }

  const missing: string[] = [];
  if (!normalizeOptionalToken(process.env.DISCORD_BOT_TOKEN)) {
    missing.push("DISCORD_BOT_TOKEN");
  }
  const requiredWebhookKeys = Object.keys(settings.discord.personas)
    .map((personaKey) => toWebhookEnvKey(personaKey))
    .sort();
  for (const webhookKey of requiredWebhookKeys) {
    if (!normalizeOptionalToken(process.env[webhookKey])) {
      missing.push(webhookKey);
    }
  }
  if (
    settings.discord.authorization.required &&
    settings.discord.authorization.allowedUserIDs.length === 0 &&
    settings.discord.authorization.allowedRoleIDs.length === 0
  ) {
    missing.push("discord.authorization.allowed_user_ids or discord.authorization.allowed_role_ids");
  }

  if (missing.length > 0) {
    throw new Error(
      `Communication plugin startup validation failed. Missing required Discord configuration: ${missing.join(", ")}.`,
    );
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

    const contextResult = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(contextResult.context, sessionID, worktree, contextResult.loadError);

    if (contextResult.context?.transition === "awaiting_approval") {
      return {
        kind: "mapped",
        notification: createNotification(settings, metadata.persona, {
          event: "pipeline.approval_requested",
          sessionID,
          payload: {
            ...metadata,
            status: "awaiting_approval",
            stage: contextResult.context.stage,
          },
        }),
      };
    }

    if (contextResult.context?.transition === "completed") {
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

    const contextResult = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(contextResult.context, sessionID, worktree, contextResult.loadError);
    const error = readRecord(properties, "error");
    const errorCode = readString(error, "code") || "UNKNOWN";
    const errorMessage = readString(readRecord(error, "data"), "message") || "unknown error";

    if (contextResult.context?.transition === "blocked" || contextResult.context?.transition === "stopped") {
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

    const contextResult = await loadOrchestrationContext(worktree, sessionID);
    const metadata = buildMetadata(contextResult.context, sessionID, worktree, contextResult.loadError);

    return {
      kind: "mapped",
      notification: createNotification(settings, metadata.persona, {
        event: "pipeline.transition",
        sessionID,
        payload: {
            ...metadata,
            command_action: action,
            from_stage: contextResult.context?.pendingFrom ?? contextResult.context?.stage ?? metadata.stage,
            to_stage:
              contextResult.context?.pendingTo ??
              normalizePipelineStage(targetStage) ??
              contextResult.context?.stage ??
              metadata.stage,
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
  contextWarning?: string,
): {
  session_id: string;
  root_session_id: string;
  stage: string;
  transition: string;
  worktree: string;
  persona: string;
  context_warning?: string;
} {
  const stage = context?.stage ?? "unknown";
  return {
    session_id: sessionID,
    root_session_id: context?.rootSessionID ?? sessionID,
    stage,
    transition: context?.transition ?? "unknown",
    worktree: context?.worktree ?? fallbackWorktree,
    persona: resolvePersonaKey(stage),
    ...(contextWarning ? { context_warning: contextWarning } : {}),
  };
}

async function loadOrchestrationContext(
  worktree: string,
  sessionID: string,
): Promise<{ context?: OrchestrationContext; loadError?: string }> {
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
      context: {
        rootSessionID,
        stage,
        transition,
        worktree: resolvedWorktree,
        pendingFrom: readString(pending, "from"),
        pendingTo: readString(pending, "to"),
      },
    };
  } catch (error) {
    return {
      loadError: `orchestration-state unavailable: ${describeOrchestrationStateLoadError(error)}`,
    };
  }
}

function describeOrchestrationStateLoadError(error: unknown): string {
  const readError = error as NodeJS.ErrnoException;
  if (readError.code === "ENOENT") {
    return "state file is missing.";
  }

  if (error instanceof SyntaxError) {
    return "state file contains invalid JSON.";
  }

  return formatError(error);
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
  } catch (error) {
    const loadError = describeOrchestrationStateLoadError(error);
    if (explicitSessionID && explicitSessionID.trim().length > 0) {
      return {
        ok: false,
        reason:
          `Unable to load orchestration state (${loadError}) and cannot validate explicit session_id '${explicitSessionID}'.`,
        candidates: [],
      };
    }

    return {
      ok: false,
      reason: `Unable to load orchestration state (${loadError}) and no explicit session_id provided.`,
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

  return undefined;
}

function toWebhookEnvKey(personaKey: string): string {
  return `DISCORD_WEBHOOK_${personaKey.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

async function sendWithDiscordTransport(request: DiscordTransportRequest): Promise<DiscordTransportResult> {
  let lastStatus: number | undefined;
  const retried = await executeWithDeterministicRetry(async () => {
    const attempt = await sendWithDiscordTransportOnce(request);
    if (!attempt.ok) {
      lastStatus = attempt.status;
      throw new Error(attempt.error ?? "unknown Discord transport failure");
    }

    return attempt;
  });

  if (retried.ok) {
    return {
      ...retried.value,
      attempts: retried.attempts,
    };
  }

  return {
    ok: false,
    status: lastStatus,
    attempts: retried.attempts,
    error: retried.error,
  };
}

async function sendWithDiscordTransportOnce(request: DiscordTransportRequest): Promise<DiscordTransportResult> {
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

async function executeWithDeterministicRetry<T>(
  operation: () => Promise<T>,
): Promise<{ ok: true; attempts: number; value: T } | { ok: false; attempts: number; error: string }> {
  let lastError = "unknown failure";

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
    const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 0;
    if (backoff > 0) {
      await sleep(backoff);
    }

    try {
      const value = await operation();
      return {
        ok: true,
        attempts: attempt + 1,
        value,
      };
    } catch (error) {
      lastError = formatError(error);
    }
  }

  return {
    ok: false,
    attempts: RETRY_MAX_ATTEMPTS,
    error: `retry policy exhausted (${RETRY_MAX_ATTEMPTS} attempts; backoff ${RETRY_BACKOFF_MS.join("/")}ms). Last error: ${lastError}`,
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolveDelay) => {
    setTimeout(() => resolveDelay(), ms);
  });
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

function readStringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

function parseCommaSeparatedEnv(name: string): string[] {
  return readStringArrayValue(process.env[name]);
}

function mergeUnique(...groups: string[][]): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      if (value.length > 0) {
        merged.add(value);
      }
    }
  }

  return [...merged];
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

    const redacted = redactSecrets(text);
    return redacted.length > 160 ? `${redacted.slice(0, 160)}...` : redacted;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`);
  }

  return redactSecrets(String(error));
}

function redactSecrets(raw: string): string {
  let value = raw;

  const secretEnvKeys = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_WEBHOOK_PLANNER",
    "DISCORD_WEBHOOK_ORCHESTRATOR",
    "DISCORD_WEBHOOK_MINION",
    "DISCORD_WEBHOOK_REVIEWER",
  ];

  for (const envKey of secretEnvKeys) {
    const secret = normalizeOptionalToken(process.env[envKey]);
    if (secret) {
      value = replaceAllLiteral(value, secret, MASKED_SECRET);
    }
  }

  value = value.replace(/https:\/\/discord\.com\/api\/webhooks\/[^\s"']+/gi, MASKED_SECRET);
  return value;
}

function replaceAllLiteral(source: string, search: string, replacement: string): string {
  if (search.length === 0) {
    return source;
  }

  return source.split(search).join(replacement);
}
