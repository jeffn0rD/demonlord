# Demonlord Usage Guide

## First-Time Setup

### 0) One-Command Install (Recommended)

From the target repository root:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-demonlord.sh | bash -s -- --source https://github.com/<owner>/<repo>.git
```

Local template source example:

```bash
/path/to/demonlord-template/scripts/install-demonlord.sh --source /path/to/demonlord-template --target .
```

Useful flags:
- `--dry-run` (preview changes)
- `--skip-bootstrap` (copy/update assets only)
- `--rollback` (restore from `.demonlord-install-backup/latest`)

Deterministic sync note: local template installs intentionally skip transient `.opencode` entries (for example `node_modules`, `.cache`, and temp editor files) so copied assets match clean-source behavior.

### 1) Inject Demonlord Assets

Copy Demonlord assets into your target repository root (`.opencode/`, `agents/`, `scripts/`, `doc/`, `demonlord.config.json`, `.env.example`).

### 2) Install OpenCode Dependencies (Required)

```bash
cd .opencode && npm install
```

### 3) Install Local Shell Helpers

```bash
cd .. && ./scripts/bootstrap.sh
```

### 4) First-Run Validation

```bash
opencode
```

```bash
pipelinectl status
```

Check all of the following before your first `/triage` run:
- `.env` includes `GITHUB_PAT`, `DISCORD_BOT_TOKEN`, and Discord webhook values
- Discord command allowlists are configured (`DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_ROLE_IDS`, optional `DISCORD_ALLOWED_CHANNEL_ID`)
- `demonlord.config.json` exists (bootstrap will create minimum defaults when missing)
- `type pipelinectl` resolves, or `./agents/tools/pipelinectl.sh status` works directly

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
- Initialize or update explicit pipeline state
- Route tasks to appropriate specialized agents via the Matchmaker
- Wait for explicit pipeline transitions in manual mode (`/pipeline advance ...`)
- Enforce quality gates through the `submit_implementation` tool

Tasklist-explicit routing metadata (V1 contract) per runnable task:

```md
<!-- TASK:T-3.7.2 -->
<!-- EXECUTION:{"execution":{"role":"implementation","tier":"pro","skill":"orchestration-specialist","parallel_group":"routing-core","depends_on":["T-3.7.1"]}} -->
```

If `EXECUTION` metadata is missing, orchestrator falls back deterministically to legacy behavior and emits a warning-level event.

### 3. Review and Approval
Monitor Discord notifications for:
- **Worktree creation requests**: Approve or reject based on the agent type and purpose
- **Implementation completion**: Review code changes and approve for merge
- **Error notifications**: Address any issues that require human intervention

In manual mode, use local pipeline controls in the CLI:
- **`/pipeline status [session]`**: View parent/child stage tree plus execution order (`seq`) and overlap windows by `parallel_group`
- **`/pipeline advance <triage|implementation|review> [session]`**: Perform explicit transition
- **`/pipeline stop [session]` / `/pipeline off`**: Stop one pipeline or disable orchestration
- **`/pipeline approve [session]`**: Approve blocked spawn without Discord dependency

If slash-command handling is constrained, use the deterministic shell fallback:

```bash
./scripts/bootstrap.sh
```

- **`pipelinectl status [session]`** (includes session tree, execution order, overlap windows)
- **`pipelinectl off|on`**
- **`pipelinectl advance <triage|implementation|review> [session]`**
- **`pipelinectl approve [session]`**
- **`pipelinectl stop [session]`**

If your shell session does not include plugin-injected PATH context, run `./agents/tools/pipelinectl.sh ...` directly.

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
  - Maintain explicit persisted pipeline state per root session
  - Spawn isolated worktrees using `spawn_worktree.sh` after transition/approval checks
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
2. **Orchestration policy** checks `demonlord.config.json` approval settings
3. **If approval required**: transition is blocked pending explicit approval
4. **User approves**: `/pipeline approve [session]` (or `/approve` via Discord when available)
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
- **`/approve [session_id?]`**: Approve the current pending action via the deterministic pipeline path
- **`/party [agents...]`**: Start Party Mode for the targeted session
- **`/continue [note]`**: Continue the current Party Mode round
- **`/halt [note]`**: Halt/pause Party Mode for review or operator intervention
- **`/focus <agent> [note]`**: Focus Party Mode on one agent
- **`/add-agent <agent...>`**: Add one or more agents to the Party Mode roster
- **`/export [path]`**: Export Party Mode transcript markdown

Legacy Discord commands are fail-closed with migration guidance:
- **`/reject`** -> use `/halt <reason>` or `/pipeline stop [session_id]`
- **`/park`** -> use `/halt [note]` then `/continue [note]`
- **`/handoff`** -> use `/focus <agent> [note]` or `/add-agent <agent...>`

Authorization and reliability policy:
- Inbound Discord commands are allowlist-gated via `discord.authorization.allowed_user_ids` and/or `discord.authorization.allowed_role_ids`.
- Optional `discord.authorization.allowed_channel_id` enforces a single-command channel.
- Retry/backoff is deterministic and fixed (`max_attempts=3`, `0ms/250ms/1000ms`, no jitter).
- Outbound/inbound dedupe uses in-memory TTL (`10m`).

Verification entrypoint:

```bash
npm --prefix .opencode run verify:beelzebub
```

Control the orchestration pipeline locally via CLI commands:
- **`/pipeline status [session]`**
- **`/pipeline advance <triage|implementation|review> [session]`**
- **`/pipeline stop [session]`**
- **`/pipeline off`**
- **`/pipeline approve [session]`**

Shell fallback commands (`pipelinectl`) enqueue deterministic control intents into `_bmad-output/orchestration-commands.ndjson`, consumed by the orchestrator plugin. Status output is sourced from `_bmad-output/execution-graph.ndjson` and summarizes spawn sequence order plus overlap windows for quick operator inspection.

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
- **`orchestration.enabled`**: Master orchestration on/off switch
- **`orchestration.mode`**: `off` | `manual` | `auto` (default: `manual`)
- **`orchestration.require_approval_before_spawn`**: Block child spawn until approved
- **`orchestration.ignore_aborted_messages`**: Treat `MessageAbortedError` as non-fatal when true
- **`orchestration.verbose_events`**: Enable concise operational event messages
- **`orchestration.agent_pools`**: Role/tier to concrete agent ID mapping (first existing ID wins)
- **`orchestration.task_routing.source`**: V1 source is `tasklist_explicit`
- **`orchestration.task_routing.default_tier`**: Default tier used for deterministic metadata fallback
- **`orchestration.parallelism.max_parallel_total`**: Global concurrent task cap
- **`orchestration.parallelism.max_parallel_by_role`**: Per-role caps
- **`orchestration.parallelism.max_parallel_by_tier`**: Per-tier caps
- **`orchestration.execution_graph.enabled|path|verbosity`**: Concise NDJSON execution graph output controls
- **`orchestration.pipeline_command_short_circuit`**: `/pipeline` pre-hook short-circuit strategy (`no_reply` default, `prehook_error` fallback)
- **`discord.enabled`**: Enable/disable Discord integration
- **`discord.personas`**: Agent-specific Discord persona settings
- **`discord.authorization.required`**: Require authorization checks for inbound Discord-originated commands
- **`discord.authorization.allowed_user_ids`**: Explicit Discord user allowlist
- **`discord.authorization.allowed_role_ids`**: Explicit Discord role allowlist
- **`discord.authorization.allowed_channel_id`**: Optional inbound channel constraint

When execution graph logging is enabled, events are written to `_bmad-output/execution-graph.ndjson` with deterministic `seq` ordering and spawn/queue/block visibility.

### `.opencode/opencode.jsonc`
- **Agent definitions**: Required `description` field for all agents
- **MCP servers**: GitHub integration with environment variables
- **Permission matrix**: Quality gate enforcement
- **Recovery**: Always keep a backup at `.opencode/opencode.jsonc.known-good`

### GitHub Project V2 Routing (`.github/workflows/project-board.yml`)
- **Secret required**: `PROJECT_V2_TOKEN` (PAT classic with `project` scope; also add `repo` for private repositories)
- **Repository vars required**:
  - `PROJECT_V2_ID`
  - `PROJECT_V2_STATUS_FIELD_ID`
  - `PROJECT_V2_STATUS_TODO_OPTION_ID`
  - `PROJECT_V2_STATUS_IN_PROGRESS_OPTION_ID`
  - `PROJECT_V2_STATUS_REVIEW_OPTION_ID`
  - `PROJECT_V2_STATUS_DONE_OPTION_ID`
- **Routing labels** (canonical): `Status: Todo`, `Status: In Progress`, `Status: In Review`, `Status: Done`
- **Compatibility labels**: `status:todo`, `status:in-progress`, `status:review`, `status:done`

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

**`/pipeline` commands show reasoning text before output**
- **Solution**: Apply the local OpenCode command-hook patch in `doc/opencode_command_noReply_patch.md`
- **Check**: Confirm `orchestration.pipeline_command_short_circuit` is `no_reply` for patched builds, or switch to `prehook_error` to force a controlled pre-hook stop on unpatched cores

**`pipelinectl` rejects command as stale/invalid**
- **Solution**: Run `pipelinectl status` and retry with the latest state
- **Check**: Verify target stage and pending approval state before `advance`/`approve`

**`pipelinectl: command not found`**
- **Solution**: Run `./scripts/bootstrap.sh`, restart shell, and ensure `~/.local/bin` is in `PATH`
- **Check**: Run `type pipelinectl` and verify it resolves to `~/.local/bin/pipelinectl`

**Installer partially applied assets**
- **Solution**: Run `./scripts/install-demonlord.sh --rollback`, fix root cause, rerun installer
- **Check**: Confirm `.demonlord-install-backup/latest/manifest.txt` exists before rollback

**Offline/proxy dependency install failures**
- **Solution**: Export `HTTPS_PROXY`/`HTTP_PROXY` and optional `NPM_CONFIG_REGISTRY`, then rerun `./scripts/bootstrap.sh`
- **Alternative**: Use `./scripts/install-demonlord.sh --skip-bootstrap`, then bootstrap once network access is available

**Discord messages not appearing**
- **Solution**: Verify `.env` contains correct Discord webhook URLs
- **Check**: Ensure `discord.enabled` is set to `true`

**Discord command denied as unauthorized**
- **Solution**: Add caller user/role IDs to Discord allowlists
- **Check**: Confirm optional channel gate matches the command channel

**Issues are not moving on Project V2 board**
- **Solution**: Verify `PROJECT_V2_TOKEN` secret and all `PROJECT_V2_*` repository variables are set
- **Check**: Confirm the issue was labeled with a supported status label

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
