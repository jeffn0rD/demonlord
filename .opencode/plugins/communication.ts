import { Plugin, OpenCodeClient } from '@opencode-ai/plugin';
import { readFile } from 'fs/promises';
import { WebhookClient } from 'discord.js';

interface DiscordPersona {
  name: string;
  avatarUrl: string;
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
  private webhooks: Map<string, WebhookClient> = new Map();
  private activeSessions: Map<string, any> = new Map();

  async onSessionIdle(client: OpenCodeClient, sessionId: string, sessionData: any) {
    await this.initializeConfig();
    if (!this.config?.discord.enabled) return;

    this.activeSessions.set(sessionId, sessionData);
    
    const agentType = sessionData.agent?.type || 'unknown';
    const persona = this.config.discord.personas[agentType] || this.config.discord.personas.planner;
    
    // Extract worktree information from session context if available
    const worktreeInfo = this.extractWorktreeInfo(sessionData);
    
    const message = this.formatSessionMessage('idle', agentType, sessionData, worktreeInfo);
    await this.sendDiscordMessage(persona, message);
  }

  async onSessionError(client: OpenCodeClient, sessionId: string, error: Error, sessionData: any) {
    await this.initializeConfig();
    if (!this.config?.discord.enabled) return;

    this.activeSessions.set(sessionId, sessionData);
    
    const agentType = sessionData.agent?.type || 'unknown';
    const persona = this.config.discord.personas[agentType] || this.config.discord.personas.planner;
    
    const worktreeInfo = this.extractWorktreeInfo(sessionData);
    
    const message = this.formatSessionMessage('error', agentType, sessionData, worktreeInfo, error.message);
    await this.sendDiscordMessage(persona, message);
  }

  // Handle inbound slash commands from Discord
  async handleSlashCommand(command: string, sessionId?: string): Promise<void> {
    await this.initializeConfig();
    
    if (!sessionId && this.activeSessions.size === 0) {
      console.log('No active sessions to handle command:', command);
      return;
    }
    
    // Use provided sessionId or the first active session
    const targetSessionId = sessionId || Array.from(this.activeSessions.keys())[0];
    const sessionData = this.activeSessions.get(targetSessionId);
    
    if (!sessionData) {
      console.log('No session data found for command:', command);
      return;
    }
    
    const [commandName, ...args] = command.trim().split(' ');
    
    switch (commandName) {
      case '/approve':
        await this.handleApproveCommand(targetSessionId, sessionData, args);
        break;
      case '/park':
        await this.handleParkCommand(targetSessionId, sessionData, args);
        break;
      case '/handoff':
        await this.handleHandoffCommand(targetSessionId, sessionData, args);
        break;
      case '/party':
        await this.handlePartyCommand(targetSessionId, sessionData, args);
        break;
      case '/continue':
        await this.handleContinueCommand(targetSessionId, sessionData, args);
        break;
      case '/halt':
        await this.handleHaltCommand(targetSessionId, sessionData, args);
        break;
      case '/focus':
        await this.handleFocusCommand(targetSessionId, sessionData, args);
        break;
      case '/add-agent':
        await this.handleAddAgentCommand(targetSessionId, sessionData, args);
        break;
      case '/export':
        await this.handleExportCommand(targetSessionId, sessionData, args);
        break;
      default:
        console.log(`Unknown command: ${commandName}`);
        break;
    }
  }

  private async handleApproveCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    // Mark session as approved in metadata
    sessionData.approved = true;
    this.activeSessions.set(sessionId, sessionData);
    await client.session.prompt(sessionId, 'User has approved this session. Please continue with the task.');
  }

  private async handleParkCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, 'User has parked this session. Please pause and wait for further instructions.');
  }

  private async handleHandoffCommand(sessionId: string, sessionData: any, args: string[]) {
    const newAgent = args[0] || 'reviewer';
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, `User has requested handoff to ${newAgent} agent. Please prepare for handoff.`);
  }

  private async handlePartyCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, 'User has initiated Party Mode. Please prepare for multi-agent collaborative session.');
  }

  private async handleContinueCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, 'User has requested to continue the session. Please proceed.');
  }

  private async handleHaltCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, 'User has requested to halt the session. Please pause immediately.');
  }

  private async handleFocusCommand(sessionId: string, sessionData: any, args: string[]) {
    const agent = args[0] || 'minion';
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, `User has requested to focus on ${agent} agent. Please adjust session focus accordingly.`);
  }

  private async handleAddAgentCommand(sessionId: string, sessionData: any, args: string[]) {
    const agentType = args[0] || 'minion';
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, `User has requested to add ${agentType} agent to the session. Please prepare for multi-agent collaboration.`);
  }

  private async handleExportCommand(sessionId: string, sessionData: any, args: string[]) {
    const client = new OpenCodeClient();
    await client.session.prompt(sessionId, 'User has requested to export session data. Please prepare session transcript for export.');
  }

  private async initializeConfig() {
    if (this.config) return;
    
    try {
      const configContent = await readFile('./demonlord.config.json', 'utf-8');
      this.config = JSON.parse(configContent);
    } catch (error) {
      console.warn('Failed to load demonlord.config.json:', error);
      this.config = {
        discord: { enabled: false, personas: {} },
        worktrees: { directory: '../worktrees', prefix: 'task-', approval_required: true, agent_approval: {} }
      };
    }
  }

  private extractWorktreeInfo(sessionData: any): string {
    // Look for worktree information in session context or metadata
    if (sessionData.context?.worktree) {
      return `Worktree: ${sessionData.context.worktree}`;
    }
    if (sessionData.metadata?.worktreePath) {
      return `Worktree: ${sessionData.metadata.worktreePath}`;
    }
    return 'Worktree: Not specified';
  }

  private formatSessionMessage(
    eventType: 'idle' | 'error',
    agentType: string,
    sessionData: any,
    worktreeInfo: string,
    errorMessage?: string
  ): string {
    const timestamp = new Date().toISOString();
    let message = `**${agentType.toUpperCase()} Agent Session ${eventType === 'error' ? 'ERROR' : 'IDLE'}**\n`;
    message += `Timestamp: ${timestamp}\n`;
    message += `${worktreeInfo}\n`;
    
    if (eventType === 'error' && errorMessage) {
      message += `Error: ${errorMessage}\n`;
    }
    
    if (sessionData.task) {
      message += `Task: ${sessionData.task}\n`;
    }
    
    return message;
  }

  private async sendDiscordMessage(persona: DiscordPersona, message: string) {
    // In a real implementation, this would use actual webhook URLs from environment variables
    // For the template, we'll log the message and simulate the webhook call
    console.log(`Discord Message [${persona.name}]: ${message}`);
    
    // TODO: Implement actual webhook sending when DISCORD_WEBHOOK_URL env var is available
    // const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    // if (webhookUrl) {
    //   const webhook = this.webhooks.get(webhookUrl) || new WebhookClient({ url: webhookUrl });
    //   if (!this.webhooks.has(webhookUrl)) {
    //     this.webhooks.set(webhookUrl, webhook);
    //   }
    //   await webhook.send({
    //     content: message,
    //     username: persona.name,
    //     avatarURL: persona.avatarUrl || undefined
    //   });
    // }
  }

  // Check if worktree creation requires approval based on config
  async checkWorktreeApproval(agentType: string, worktreePath: string): Promise<boolean> {
    await this.initializeConfig();
    
    if (!this.config?.worktrees.approval_required) {
      return true; // No approval required globally
    }
    
    // Check if specific agent type requires approval
    const agentApprovalRequired = this.config.worktrees.agent_approval?.[agentType] ?? true;
    if (!agentApprovalRequired) {
      return true; // This agent type doesn't require approval
    }
    
    // In a real implementation, this would wait for user approval via Discord
    // For the template, we'll simulate approval check
    console.log(`Worktree approval required for ${agentType} agent at ${worktreePath}`);
    return false; // Require explicit approval
  }

  // Method to approve a specific worktree
  async approveWorktree(worktreePath: string): Promise<void> {
    // In a real implementation, this would mark the worktree as approved
    // and notify any waiting sessions
    console.log(`Worktree approved: ${worktreePath}`);
  }
}