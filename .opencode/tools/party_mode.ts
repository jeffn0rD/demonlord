import { tool } from "@opencode-ai/plugin/tool";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DEFAULT_EXPORT_DIRECTORY = ["_bmad-output", "party-mode"] as const;
const DEFAULT_EXPORT_PREFIX = "party-mode-transcript";

export type PartyModeAction =
  | "start"
  | "continue"
  | "halt"
  | "focus"
  | "add-agent"
  | "note"
  | "status"
  | "export";

export interface PartyModeArgs {
  action: PartyModeAction;
  session_id: string;
  agent?: string;
  agents?: string[];
  note?: string;
  export_path?: string;
}

export interface PartyModeContext {
  worktree: string;
}

export interface PartyModeResult {
  ok: boolean;
  action: PartyModeAction;
  state?: PartyState;
  export_path?: string;
  error?: string;
  code?:
    | "INVALID_INPUT"
    | "NOT_STARTED"
    | "INVALID_STATE"
    | "PATH_OUTSIDE_WORKTREE"
    | "WRITE_FAILED";
}

interface NormalizedPartyModeArgs {
  action: PartyModeAction;
  sessionID: string;
  agent?: string;
  agents: string[];
  note?: string;
  exportPath?: string;
}

export interface PartyState {
  sessionID: string;
  round: number;
  halted: boolean;
  focusedAgent: string | null;
  agents: string[];
  transcript: string[];
  updatedAt: string;
}

const partyModeTool = tool({
  description: "Manage Party Mode state for multi-agent round-based collaboration in a shared worktree.",
  args: {
    action: tool.schema
      .enum(["start", "continue", "halt", "focus", "add-agent", "note", "status", "export"])
      .describe("Party Mode action to execute."),
    session_id: tool.schema
      .string()
      .min(1)
      .regex(
        SESSION_ID_PATTERN,
        "session_id must be 1-64 chars and contain only letters, digits, dot, underscore, colon, or hyphen.",
      )
      .describe("Target session ID for Party Mode state."),
    agent: tool.schema.string().optional().describe("Agent identifier used for focus or add-agent actions."),
    agents: tool.schema
      .array(tool.schema.string().min(1))
      .optional()
      .describe("Agents to include when starting or extending a party."),
    note: tool.schema.string().optional().describe("Transcript note attached to this action."),
    export_path: tool.schema
      .string()
      .optional()
      .describe("Optional export path under the worktree. Defaults to _bmad-output/party-mode/party-mode-transcript-<session_id>.md."),
  },
  async execute(args: PartyModeArgs, context: PartyModeContext) {
    const result = await executePartyModeAction(args, context);
    return JSON.stringify(result, null, 2);
  },
});

export async function executePartyModeAction(
  args: PartyModeArgs,
  context: PartyModeContext,
): Promise<PartyModeResult> {
  try {
    const normalized = normalizeArgs(args);
    const worktreeRoot = resolve(context.worktree);
    const stateDirectory = resolveWithinWorktree(worktreeRoot, ".opencode", ".party-mode");
    const statePath = resolveWithinWorktree(worktreeRoot, ".opencode", ".party-mode", `${normalized.sessionID}.json`);

    switch (normalized.action) {
      case "start": {
        const initialAgents = dedupeAgents([normalized.agent, ...normalized.agents, "orchestrator"]);
        const state: PartyState = {
          sessionID: normalized.sessionID,
          round: 1,
          halted: false,
          focusedAgent: null,
          agents: initialAgents,
          transcript: [
            "Party Mode started.",
            normalized.note ?? "Initial round opened.",
          ],
          updatedAt: new Date().toISOString(),
        };

        await saveState(stateDirectory, statePath, state);
        return { ok: true, action: normalized.action, state };
      }

      case "status": {
        const state = await loadState(statePath);
        if (!state) {
          return {
            ok: false,
            action: normalized.action,
            code: "NOT_STARTED",
            error: `Party Mode has not been started for session '${normalized.sessionID}'.`,
          };
        }

        return { ok: true, action: normalized.action, state };
      }

      case "export": {
        const state = await loadState(statePath);
        if (!state) {
          return {
            ok: false,
            action: normalized.action,
            code: "NOT_STARTED",
            error: `Party Mode has not been started for session '${normalized.sessionID}'.`,
          };
        }

        const exportPath = normalized.exportPath
          ? resolveWithinWorktree(worktreeRoot, normalized.exportPath)
          : resolveWithinWorktree(
              worktreeRoot,
              ...DEFAULT_EXPORT_DIRECTORY,
              `${DEFAULT_EXPORT_PREFIX}-${normalized.sessionID}.md`,
            );
        const exportContent = renderTranscript(state);

        try {
          await mkdir(dirname(exportPath), { recursive: true });
          await writeFile(exportPath, exportContent, "utf-8");
        } catch (error) {
          return {
            ok: false,
            action: normalized.action,
            code: "WRITE_FAILED",
            error: error instanceof Error ? error.message : "Failed to write transcript export.",
          };
        }

        const relativeExportPath = relative(worktreeRoot, exportPath);
        state.transcript.push(`Transcript exported to ${relativeExportPath}`);
        state.updatedAt = new Date().toISOString();
        await saveState(stateDirectory, statePath, state);

        return {
          ok: true,
          action: normalized.action,
          export_path: relativeExportPath,
          state,
        };
      }

      default: {
        const state = await loadState(statePath);
        if (!state) {
          return {
            ok: false,
            action: normalized.action,
            code: "NOT_STARTED",
            error: `Party Mode has not been started for session '${normalized.sessionID}'.`,
          };
        }

        mutateState(state, {
          action: normalized.action,
          agent: normalized.agent,
          agents: normalized.agents,
          note: normalized.note,
        });
        state.updatedAt = new Date().toISOString();
        await saveState(stateDirectory, statePath, state);
        return { ok: true, action: normalized.action, state };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Party Mode input.";
    const code = message.includes("outside the current worktree")
      ? "PATH_OUTSIDE_WORKTREE"
      : "INVALID_INPUT";
    return {
      ok: false,
      action: args.action,
      code,
      error: message,
    };
  }
}

function normalizeArgs(args: PartyModeArgs): NormalizedPartyModeArgs {
  const sessionID = normalizeSessionID(args.session_id);
  const action = args.action;
  const note = normalizeOptionalText(args.note);
  const agent = normalizeOptionalAgent(args.agent);
  const agents = normalizeAgentList(args.agents ?? []);
  const exportPath = normalizeOptionalText(args.export_path);

  if (action === "focus" && !agent) {
    throw new Error("focus action requires a valid agent identifier.");
  }

  if (action === "add-agent" && dedupeAgents([agent, ...agents]).length === 0) {
    throw new Error("add-agent action requires at least one valid agent identifier.");
  }

  if (action === "note" && !note) {
    throw new Error("note action requires a non-empty note.");
  }

  if (action === "export" && exportPath && !exportPath.endsWith(".md")) {
    throw new Error("export_path must end with .md for transcript exports.");
  }

  return {
    action,
    sessionID,
    agent,
    agents,
    note,
    exportPath,
  };
}

function normalizeSessionID(value: string): string {
  const normalized = value.trim();
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(
      "session_id must be 1-64 chars and contain only letters, digits, dot, underscore, colon, or hyphen.",
    );
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalAgent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (!AGENT_ID_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid agent identifier '${normalized}'. Use lowercase alphanumeric values with optional single hyphens.`,
    );
  }

  return normalized;
}

function normalizeAgentList(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const agent = normalizeOptionalAgent(value);
    if (agent) {
      normalized.push(agent);
    }
  }

  return dedupeAgents(normalized);
}

function resolveWithinWorktree(worktreeRoot: string, ...segments: string[]): string {
  const candidate = resolve(worktreeRoot, ...segments);
  assertWithinWorktree(worktreeRoot, candidate);
  return candidate;
}

function assertWithinWorktree(worktreeRoot: string, candidatePath: string): void {
  const relativePath = relative(worktreeRoot, candidatePath);
  if (!relativePath) {
    return;
  }

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Resolved path '${candidatePath}' is outside the current worktree.`);
  }
}

async function loadState(statePath: string): Promise<PartyState | null> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const state = parsed as Partial<PartyState>;
    if (
      typeof state.sessionID !== "string" ||
      typeof state.round !== "number" ||
      typeof state.halted !== "boolean" ||
      !Array.isArray(state.agents) ||
      !Array.isArray(state.transcript)
    ) {
      return null;
    }

    if (!SESSION_ID_PATTERN.test(state.sessionID)) {
      return null;
    }

    return {
      sessionID: state.sessionID,
      round: state.round,
      halted: state.halted,
      focusedAgent: typeof state.focusedAgent === "string" ? state.focusedAgent : null,
      agents: state.agents.filter(
        (agent): agent is string => typeof agent === "string" && AGENT_ID_PATTERN.test(agent),
      ),
      transcript: state.transcript.filter((entry): entry is string => typeof entry === "string"),
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function saveState(directory: string, statePath: string, state: PartyState): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function mutateState(
  state: PartyState,
  args: {
    action: "continue" | "halt" | "focus" | "add-agent" | "note";
    agent?: string;
    agents?: string[];
    note?: string;
  },
): void {
  switch (args.action) {
    case "continue": {
      state.round += 1;
      state.halted = false;
      state.transcript.push(`Round ${state.round} started.`);
      if (args.note) {
        state.transcript.push(args.note);
      }
      return;
    }

    case "halt": {
      state.halted = true;
      state.transcript.push(args.note ?? "Party Mode halted.");
      return;
    }

    case "focus": {
      if (!args.agent) {
        throw new Error("focus action requires a non-empty agent value.");
      }
      const focused = args.agent;
      state.focusedAgent = focused;
      if (!state.agents.includes(focused)) {
        state.agents.push(focused);
      }
      state.transcript.push(`Focus moved to ${focused}.`);
      return;
    }

    case "add-agent": {
      const merged = dedupeAgents([args.agent, ...(args.agents ?? [])]);
      if (merged.length === 0) {
        throw new Error("add-agent action requires at least one agent.");
      }

      for (const agent of merged) {
        if (!state.agents.includes(agent)) {
          state.agents.push(agent);
        }
      }

      state.transcript.push(`Agents added: ${merged.join(", ")}.`);
      return;
    }

    case "note": {
      if (!args.note) {
        throw new Error("note action requires a non-empty note.");
      }
      state.transcript.push(args.note);
      return;
    }
  }
}

function dedupeAgents(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const agents: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    agents.push(normalized);
  }

  return agents;
}

function renderTranscript(state: PartyState): string {
  const agentList = state.agents.length > 0 ? state.agents.join(", ") : "none";
  const lines = [
    "# Party Mode Transcript",
    "",
    "## Metadata",
    `- Session ID: ${state.sessionID}`,
    `- Round: ${state.round}`,
    `- Halted: ${state.halted ? "yes" : "no"}`,
    `- Focused Agent: ${state.focusedAgent ?? "none"}`,
    `- Agents: ${agentList}`,
    `- Updated At: ${state.updatedAt}`,
    "",
    "## Timeline",
    ...state.transcript.map((entry, index) => `${index + 1}. ${entry}`),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export default partyModeTool;
