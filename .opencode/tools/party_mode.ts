import { tool } from "@opencode-ai/plugin/tool";
import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve } from "path";

interface PartyState {
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
    session_id: tool.schema.string().min(1).describe("Target session ID for Party Mode state."),
    agent: tool.schema.string().optional().describe("Agent identifier used for focus or add-agent actions."),
    agents: tool.schema
      .array(tool.schema.string().min(1))
      .optional()
      .describe("Agents to include when starting or extending a party."),
    note: tool.schema.string().optional().describe("Transcript note attached to this action."),
    export_path: tool.schema
      .string()
      .optional()
      .describe("Optional export path. Defaults to <worktree>/party-mode-<session_id>.md."),
  },
  async execute(args: any, context: any) {
    const stateDirectory = resolve(context.worktree, ".opencode", ".party-mode");
    const statePath = resolve(stateDirectory, `${args.session_id}.json`);

    switch (args.action) {
      case "start": {
        const initialAgents = dedupeAgents([args.agent, ...(args.agents ?? []), "orchestrator"]);
        const state: PartyState = {
          sessionID: args.session_id,
          round: 1,
          halted: false,
          focusedAgent: null,
          agents: initialAgents,
          transcript: [
            "Party Mode started.",
            args.note?.trim() ? args.note.trim() : "Initial round opened.",
          ],
          updatedAt: new Date().toISOString(),
        };

        await saveState(stateDirectory, statePath, state);
        return JSON.stringify({ action: args.action, state }, null, 2);
      }

      case "status": {
        const state = await loadState(statePath);
        if (!state) {
          return JSON.stringify({ error: "Party Mode has not been started for this session." }, null, 2);
        }

        return JSON.stringify({ action: args.action, state }, null, 2);
      }

      case "export": {
        const state = await loadState(statePath);
        if (!state) {
          return JSON.stringify({ error: "Party Mode has not been started for this session." }, null, 2);
        }

        const exportPath = args.export_path
          ? resolve(context.worktree, args.export_path)
          : resolve(context.worktree, `party-mode-${args.session_id}.md`);
        const exportContent = renderTranscript(state);

        await writeFile(exportPath, exportContent, "utf-8");
        state.transcript.push(`Transcript exported to ${exportPath}`);
        state.updatedAt = new Date().toISOString();
        await saveState(stateDirectory, statePath, state);

        return JSON.stringify(
          {
            action: args.action,
            export_path: exportPath,
            state,
          },
          null,
          2,
        );
      }

      default: {
        const state = await loadState(statePath);
        if (!state) {
          return JSON.stringify({ error: "Party Mode has not been started for this session." }, null, 2);
        }

        const action = args.action;
        mutateState(state, {
          action,
          agent: args.agent,
          agents: args.agents,
          note: args.note,
        });
        state.updatedAt = new Date().toISOString();
        await saveState(stateDirectory, statePath, state);
        return JSON.stringify({ action: args.action, state }, null, 2);
      }
    }
  },
});

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

    return {
      sessionID: state.sessionID,
      round: state.round,
      halted: state.halted,
      focusedAgent: typeof state.focusedAgent === "string" ? state.focusedAgent : null,
      agents: state.agents.filter((agent): agent is string => typeof agent === "string"),
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
      if (args.note?.trim()) {
        state.transcript.push(args.note.trim());
      }
      return;
    }

    case "halt": {
      state.halted = true;
      state.transcript.push(args.note?.trim() ? args.note.trim() : "Party Mode halted.");
      return;
    }

    case "focus": {
      if (!args.agent?.trim()) {
        throw new Error("focus action requires a non-empty agent value.");
      }
      const focused = args.agent.trim();
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
      if (!args.note?.trim()) {
        throw new Error("note action requires a non-empty note.");
      }
      state.transcript.push(args.note.trim());
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
  const lines = [
    "# Party Mode Transcript",
    `- Session: ${state.sessionID}`,
    `- Round: ${state.round}`,
    `- Halted: ${state.halted}`,
    `- Focused Agent: ${state.focusedAgent ?? "none"}`,
    `- Agents: ${state.agents.join(", ")}`,
    `- Updated: ${state.updatedAt}`,
    "",
    "## Events",
    ...state.transcript.map((entry) => `- ${entry}`),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export default partyModeTool;
