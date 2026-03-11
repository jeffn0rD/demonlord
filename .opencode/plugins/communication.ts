import { Plugin } from "@opencode-ai/plugin";
import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { WebhookClient } from "discord.js";

interface DiscordPersona {
  name: string;
  avatarUrl: string;
}

interface SessionLike {
  task?: string;
  agent?: { type?: string; name?: string };
  context?: { worktree?: string };
  metadata?: {
    worktreePath?: string;
    purpose?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PartyState {
  round: number;
  halted: boolean;
  focusedAgent: string | null;
  agents: Set<string>;
  transcript: string[];
}

interface SessionClient {
  session: {
    prompt: (sessionId: string, message: string) => Promise<void>;
  };
}

interface DemonlordConfig {
  discord: {
    enabled: boolean;
    personas: Record<string, DiscordPersona>;
  };
  worktrees: {
    directory: string;
    prefix: string;
    approval_required: boolean;
    agent_approval: Record<string, boolean>;
  };
}

export default class CommunicationPlugin extends Plugin {
  private config: DemonlordConfig | null = null;
  private readonly webhooks: Map<string, WebhookClient> = new Map();
  private readonly activeSessions: Map<string, SessionLike> = new Map();
  private readonly pendingWorktreeApprovals = new Map<
    string,
    { sessionId: string; agentType: string; worktreePath: string }
  >();
  private readonly approvedWorktrees = new Set<string>();
  private readonly partySessions = new Map<string, PartyState>();
  private latestClient: SessionClient | null = null;

  async onSessionCreated(client: SessionClient, sessionId: string, sessionData: SessionLike) {
    await this.initializeConfig();
    this.latestClient = client;
    this.activeSessions.set(sessionId, sessionData);

    const agentType = this.getAgentType(sessionData);
    const worktreePath = this.getWorktreePath(sessionData);
    if (!worktreePath) return;

    const approved = await this.checkWorktreeApproval(agentType, worktreePath);
    if (approved) return;

    this.pendingWorktreeApprovals.set(sessionId, { sessionId, agentType, worktreePath });
    await client.session.prompt(
      sessionId,
      "Worktree creation requires approval. Pause execution until /approve is received.",
    );

    if (!this.config?.discord.enabled) return;
    const persona = this.getPersona(agentType);
    const message = [
      `Approval required for ${agentType} worktree session.`,
      `Session: ${sessionId}`,
      `Worktree: ${worktreePath}`,
      `Use /approve ${sessionId} to continue.`,
    ].join("\n");
    await this.sendDiscordMessage(persona, message);
  }

  async onSessionIdle(client: SessionClient, sessionId: string, sessionData: SessionLike) {
    await this.initializeConfig();
    this.latestClient = client;
    if (!this.config?.discord.enabled) return;

    this.activeSessions.set(sessionId, sessionData);
    const agentType = this.getAgentType(sessionData);
    const persona = this.getPersona(agentType);
    const worktreeInfo = this.extractWorktreeInfo(sessionData);

    const message = this.formatSessionMessage("idle", agentType, sessionData, worktreeInfo);
    await this.sendDiscordMessage(persona, message);
  }

  async onSessionError(client: SessionClient, sessionId: string, error: Error, sessionData: SessionLike) {
    await this.initializeConfig();
    this.latestClient = client;
    if (!this.config?.discord.enabled) return;

    this.activeSessions.set(sessionId, sessionData);
    const agentType = this.getAgentType(sessionData);
    const persona = this.getPersona(agentType);
    const worktreeInfo = this.extractWorktreeInfo(sessionData);

    const message = this.formatSessionMessage("error", agentType, sessionData, worktreeInfo, error.message);
    await this.sendDiscordMessage(persona, message);
  }

  async handleSlashCommand(command: string, sessionId?: string): Promise<void> {
    await this.initializeConfig();

    if (this.activeSessions.size === 0) {
      console.log("No active sessions to handle command:", command);
      return;
    }

    const [commandName, ...args] = command.trim().split(/\s+/);
    const targetSessionId = sessionId || this.resolveSessionIdForCommand(commandName, args);
    const sessionData = this.activeSessions.get(targetSessionId);

    if (!sessionData) {
      console.log("No session data found for command:", command);
      return;
    }

    switch (commandName) {
      case "/approve":
        await this.handleApproveCommand(targetSessionId, sessionData, args);
        break;
      case "/park":
        await this.handleParkCommand(targetSessionId, sessionData, args);
        break;
      case "/handoff":
        await this.handleHandoffCommand(targetSessionId, sessionData, args);
        break;
      case "/party":
        await this.handlePartyCommand(targetSessionId, sessionData, args);
        break;
      case "/continue":
        await this.handleContinueCommand(targetSessionId, sessionData, args);
        break;
      case "/halt":
        await this.handleHaltCommand(targetSessionId, sessionData, args);
        break;
      case "/focus":
        await this.handleFocusCommand(targetSessionId, sessionData, args);
        break;
      case "/add-agent":
        await this.handleAddAgentCommand(targetSessionId, sessionData, args);
        break;
      case "/export":
        await this.handleExportCommand(targetSessionId, sessionData, args);
        break;
      default:
        console.log(`Unknown command: ${commandName}`);
        break;
    }
  }

  private async handleApproveCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    const approvalKey = args[0] && this.pendingWorktreeApprovals.has(args[0]) ? args[0] : sessionId;
    const pending = this.pendingWorktreeApprovals.get(approvalKey);

    if (pending) {
      this.approvedWorktrees.add(pending.worktreePath);
      this.pendingWorktreeApprovals.delete(approvalKey);
    }

    (sessionData as SessionLike & { approved?: boolean }).approved = true;
    this.activeSessions.set(sessionId, sessionData);
    await this.latestClient.session.prompt(sessionId, "User approved the worktree/session. Continue with the task.");
  }

  private async handleParkCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    await this.latestClient.session.prompt(sessionId, "User parked this session. Pause and wait for further instructions.");
  }

  private async handleHandoffCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    const newAgent = args[0] || "reviewer";
    if (!this.latestClient) return;
    await this.latestClient.session.prompt(sessionId, `User requested handoff to ${newAgent}. Prepare handoff context.`);
  }

  private async handlePartyCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    const current = this.getAgentType(sessionData);
    const partyState: PartyState = {
      round: 1,
      halted: false,
      focusedAgent: null,
      agents: new Set([current, ...args]),
      transcript: [`Party started by ${current}`],
    };
    this.partySessions.set(sessionId, partyState);
    await this.latestClient.session.prompt(
      sessionId,
      `Party Mode started. Active agents: ${Array.from(partyState.agents).join(", ")}. Begin round 1 discussion.`,
    );
  }

  private async handleContinueCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    const state = this.partySessions.get(sessionId);
    if (!state) {
      await this.latestClient.session.prompt(sessionId, "No Party Mode session exists. Use /party first.");
      return;
    }
    state.halted = false;
    state.round += 1;
    state.transcript.push(`Continue to round ${state.round}`);
    await this.latestClient.session.prompt(sessionId, `Continue Party Mode. Proceed with round ${state.round}.`);
  }

  private async handleHaltCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    const state = this.partySessions.get(sessionId);
    if (state) {
      state.halted = true;
      state.transcript.push("Halt requested by user");
    }
    await this.latestClient.session.prompt(sessionId, "Halt requested. Pause immediately and wait for /continue.");
  }

  private async handleFocusCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    const agent = args[0] || "minion";
    if (!this.latestClient) return;
    const state = this.partySessions.get(sessionId);
    if (state) {
      state.focusedAgent = agent;
      state.transcript.push(`Focus switched to ${agent}`);
    }
    await this.latestClient.session.prompt(sessionId, `Focus set to ${agent}. Prioritize ${agent} input this round.`);
  }

  private async handleAddAgentCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    const agentType = args[0] || "minion";
    if (!this.latestClient) return;
    const state = this.partySessions.get(sessionId);
    if (state) {
      state.agents.add(agentType);
      state.transcript.push(`Agent added: ${agentType}`);
    }
    await this.latestClient.session.prompt(sessionId, `Add ${agentType} to the collaborative discussion.`);
  }

  private async handleExportCommand(sessionId: string, sessionData: SessionLike, args: string[]) {
    if (!this.latestClient) return;
    const state = this.partySessions.get(sessionId);
    const worktreePath = this.getWorktreePath(sessionData);

    if (state && worktreePath) {
      const exportPath = resolve(worktreePath, "party-mode-export.md");
      const lines = [
        "# Party Mode Transcript",
        `- Session: ${sessionId}`,
        `- Round: ${state.round}`,
        `- Halted: ${state.halted}`,
        `- Focus: ${state.focusedAgent ?? "none"}`,
        `- Agents: ${Array.from(state.agents).join(", ")}`,
        "",
        "## Events",
        ...state.transcript.map((entry) => `- ${entry}`),
      ];
      await mkdir(worktreePath, { recursive: true });
      await writeFile(exportPath, `${lines.join("\n")}\n`, "utf-8");
      state.transcript.push(`Exported transcript to ${exportPath}`);
    }

    await this.latestClient.session.prompt(sessionId, "Export completed for Party Mode transcript.");
  }

  private async initializeConfig() {
    if (this.config) return;
    
    try {
      const configPath = resolve(process.cwd(), "demonlord.config.json");
      const configContent = await readFile(configPath, "utf-8");
      this.config = JSON.parse(configContent);
    } catch (error) {
      console.warn("Failed to load demonlord.config.json:", error);
      this.config = {
        discord: { enabled: false, personas: {} },
        worktrees: { directory: "../worktrees", prefix: "task-", approval_required: true, agent_approval: {} },
      };
    }
  }

  private extractWorktreeInfo(sessionData: SessionLike): string {
    if (sessionData.context?.worktree) {
      return `Worktree: ${sessionData.context.worktree}`;
    }
    if (sessionData.metadata?.worktreePath) {
      return `Worktree: ${sessionData.metadata.worktreePath}`;
    }
    return "Worktree: Not specified";
  }

  private formatSessionMessage(
    eventType: "idle" | "error",
    agentType: string,
    sessionData: SessionLike,
    worktreeInfo: string,
    errorMessage?: string,
  ): string {
    const timestamp = new Date().toISOString();
    let message = `**${agentType.toUpperCase()} Agent Session ${eventType === "error" ? "ERROR" : "IDLE"}**\n`;
    message += `Timestamp: ${timestamp}\n`;
    message += `${worktreeInfo}\n`;

    if (eventType === "error" && errorMessage) {
      message += `Error: ${errorMessage}\n`;
    }

    if (sessionData.task) {
      message += `Task: ${sessionData.task}\n`;
    }

    return message;
  }

  private async sendDiscordMessage(persona: DiscordPersona, message: string) {
    const personaKey = persona.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const webhookUrl =
      process.env[`DISCORD_WEBHOOK_URL_${personaKey}`] ?? process.env.DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
      console.warn("Discord webhook not configured. Set DISCORD_WEBHOOK_URL.");
      return;
    }

    let webhook = this.webhooks.get(webhookUrl);
    if (!webhook) {
      webhook = new WebhookClient({ url: webhookUrl });
      this.webhooks.set(webhookUrl, webhook);
    }

    await webhook.send({
      content: message,
      username: persona.name,
      avatarURL: persona.avatarUrl || undefined,
    });
  }

  async checkWorktreeApproval(agentType: string, worktreePath: string): Promise<boolean> {
    await this.initializeConfig();

    if (this.approvedWorktrees.has(worktreePath)) {
      return true;
    }

    if (!this.config?.worktrees.approval_required) {
      return true;
    }

    const agentApprovalRequired = this.config.worktrees.agent_approval?.[agentType] ?? true;
    if (!agentApprovalRequired) {
      return true;
    }

    console.log(`Worktree approval required for ${agentType} agent at ${worktreePath}`);
    return false;
  }

  async approveWorktree(worktreePath: string): Promise<void> {
    this.approvedWorktrees.add(worktreePath);
    console.log(`Worktree approved: ${worktreePath}`);
  }

  private getPersona(agentType: string): DiscordPersona {
    return this.config?.discord.personas[agentType] || this.config?.discord.personas.planner || {
      name: "Planner",
      avatarUrl: "",
    };
  }

  private getAgentType(sessionData: SessionLike): string {
    return sessionData.agent?.type || sessionData.agent?.name || "unknown";
  }

  private getWorktreePath(sessionData: SessionLike): string | null {
    return sessionData.context?.worktree || sessionData.metadata?.worktreePath || null;
  }

  private resolveSessionIdForCommand(commandName: string, args: string[]): string {
    if (commandName === "/approve" && args[0]) {
      return args[0];
    }
    return Array.from(this.activeSessions.keys())[0];
  }
}
