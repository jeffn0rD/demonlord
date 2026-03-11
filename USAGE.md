# Demonlord Usage Guide

## Daily Workflow

### 1. Issue Triage
Start by analyzing GitHub issues and generating implementation plans:

```
/triage
```

This command will:
- Fetch open GitHub issues
- Analyze requirements and identify target files
- Generate atomic plan files in `/agents/plans/`
- Post a summary to Discord with the plan details

### 2. Implementation Execution
Execute the generated plans using the implement command:

```
/implement
```

This command will:
- Read the tasklist and find the next available subphase
- Spawn isolated worktrees for parallel execution
- Route tasks to appropriate specialized agents via the Matchmaker
- Enforce quality gates through the `submit_implementation` tool

### 3. Review and Approval
Monitor Discord notifications for:
- **Worktree creation requests**: Approve or reject based on the agent type and purpose
- **Implementation completion**: Review code changes and approve for merge
- **Error notifications**: Address any issues that require human intervention

## Agent Roles and Responsibilities

### Planner Agent
- **When used**: `/triage` command execution
- **Responsibilities**: 
  - Analyze GitHub issues using `glob` and `grep` tools
  - Generate atomic, non-overlapping implementation plans
  - Create `.md` plan files in `/agents/plans/`
- **Restrictions**: Cannot make code changes

### Orchestrator Agent  
- **When used**: `/implement` command execution
- **Responsibilities**:
  - Parse planner output and extract task requirements
  - Use the Matchmaker tool to select appropriate specialized skills
  - Spawn isolated worktrees using `spawn_worktree.sh`
  - Launch Minion agents in the new worktrees
- **Tools**: `matchmaker.ts`, `spawn_worktree.sh`, OpenCode SDK

### Minion Agents
- **When used**: During implementation execution
- **Responsibilities**:
  - Execute specific code changes within isolated worktrees
  - Implement features or fixes as specified in the plan
  - Use the `submit_implementation` tool to enforce quality gates
- **Environment**: Isolated Git worktree with restricted toolset

### Reviewer Agent
- **When used**: Upon implementation completion
- **Responsibilities**:
  - Analyze Pull Request content and quality
  - Post Discord notifications for human-in-the-loop approval
  - Handle approval/rejection feedback via slash commands
- **Integration**: Discord webhook posting and command parsing

## Worktree Management

### Worktree Structure
Worktrees are created as sibling directories to your main repository:
```
your-project/
├── .opencode/          # Demonlord configuration
├── src/                # Your main code
└── worktrees/          # Isolated worktrees (configured in demonlord.config.json)
    ├── task-123/       # Worktree for specific task
    ├── task-456/       # Another worktree
    └── ...
```

### Worktree Approval Flow
1. **Orchestrator** requests worktree creation for a Minion agent
2. **Communication plugin** checks `demonlord.config.json` approval settings
3. **If approval required**: Discord message is sent with worktree details
4. **User approves**: `/approve` command unblocks the workflow
5. **Worktree created**: Minion agent begins execution in isolated environment

### Worktree Cleanup
The system automatically tracks active worktrees and cleans up orphaned ones. Future versions will include manual cleanup commands.

## Quality Gate Enforcement

### The `submit_implementation` Tool
All code changes must pass through this mandatory quality gate:

1. **Linting**: Runs `npm run lint` in the worktree
2. **Testing**: Runs `npm run test` in the worktree  
3. **Error Handling**: If tests fail, errors are returned to the agent for automatic fixing
4. **Commit**: Only successful validation results in a Git commit

### Permission Matrix
The system enforces quality gates through OpenCode's permission matrix:
```json
{
  "permission": {
    "bash": {
      "git push": "deny",
      "git push *": "deny"
    }
  }
}
```

This prevents agents from bypassing the quality gates by using direct `git push` commands.

## Discord Integration

### Outbound Messages
The system posts to Discord for:
- **Worktree creation requests**: Includes agent type, purpose, and approval request
- **Implementation completion**: Includes PR summary and approval request  
- **Error notifications**: Includes error details and suggested actions

### Inbound Commands
Control the system via Discord slash commands:
- **`/approve`**: Approve the current pending action
- **`/reject [reason]`**: Reject with optional feedback
- **`/park`**: Pause current work for later resumption
- **`/handoff [skill]`**: Transfer to a different specialized agent

### Configuration
Discord integration is configured in `demonlord.config.json`:
```json
{
  "discord": {
    "enabled": true,
    "personas": {
      "planner": {
        "name": "Planner",
        "avatarUrl": "https://..."
      },
      // ... other agents
    }
  }
}
```

## Configuration Reference

### `demonlord.config.json`
- **`worktrees.directory`**: Directory for worktree creation (relative to repo root)
- **`worktrees.prefix`**: Prefix for worktree directory names
- **`worktrees.approval_required`**: Global approval requirement toggle
- **`worktrees.agent_approval`**: Per-agent approval settings
- **`discord.enabled`**: Enable/disable Discord integration
- **`discord.personas`**: Agent-specific Discord persona settings

### `.opencode/opencode.jsonc`
- **Agent definitions**: Required `description` field for all agents
- **MCP servers**: GitHub integration with environment variables
- **Permission matrix**: Quality gate enforcement
- **Recovery**: Always keep a backup at `.opencode/opencode.jsonc.known-good`

## Troubleshooting

### Common Issues

**OpenCode fails to start after config changes**
- **Solution**: Restore from `.opencode/opencode.jsonc.known-good`
- **Prevention**: Always validate JSON syntax before saving

**Agents not appearing in command list**
- **Solution**: Verify singular keys (`agent`, not `agents`) in config
- **Check**: Ensure all agents have required `description` field

**Worktree creation fails**
- **Solution**: Check Git permissions and available disk space
- **Check**: Verify worktree directory path in `demonlord.config.json`

**Discord messages not appearing**
- **Solution**: Verify `.env` contains correct Discord webhook URLs
- **Check**: Ensure `discord.enabled` is set to `true`

### Debugging Tips

1. **Check OpenCode logs** for detailed error messages
2. **Validate configuration** against the official schema at `https://opencode.ai/config.json`
3. **Test individual components** by running them in isolation
4. **Use the recovery backup** if configuration becomes corrupted

## Customization

### Adding New Skills
Create specialized agent skills by adding `SKILL.md` files:
```
.opencode/skills/my-specialist/SKILL.md
```

Required frontmatter:
```yaml
---
name: my-specialist
description: Brief description of what this specialist does
---
```

### Creating Custom Tools
Add TypeScript tools to `.opencode/tools/` using Zod validation:
```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Tool description",
  args: {
    parameter: tool.schema.string().describe("Parameter description")
  },
  async execute(args, context) {
    // Tool implementation
  }
})
```

### Extending Plugins
Add event handlers to `.opencode/plugins/` for custom behavior:
```typescript
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "session.idle": async ({ event }) => {
      // Custom session idle handler
    }
  }
}
```