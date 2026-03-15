# Demonlord Autonomous Software Factory

An autonomous software factory built on OpenCode that transforms your repository into an automated development pipeline with specialized AI agents, isolated worktrees, and deterministic quality gates.

## Overview

Demonlord replaces manual coding workflows with specialized AI agents that work in parallel, isolated environments to plan, implement, and review code changes while enforcing strict quality gates.

### Key Features
- **Specialized Agent Ecosystem**: Planner, Orchestrator, Minion, and Reviewer agents
- **Isolated Worktrees**: Parallel execution without file-locking conflicts
- **Deterministic Quality Gates**: All code must pass linting and testing before commit
- **Discord Integration**: Two-way communication with approval workflows
- **Event-Driven Orchestration**: Plugin-based coordination between pipeline stages
- **Manual-First Orchestration Controls**: Config-driven pipeline control with explicit stage transitions

## Quick Start

### One-Command Installer (Recommended)

From your target repository root, run the installer and let it inject assets plus bootstrap dependencies/shims:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-demonlord.sh | bash -s -- --source https://github.com/<owner>/<repo>.git
```

Local source example (when you already have a cloned Demonlord template):

```bash
/path/to/demonlord-template/scripts/install-demonlord.sh --source /path/to/demonlord-template --target .
```

Preflight and recovery options:

- `--dry-run`: preview actions without changing files
- `--skip-bootstrap`: inject assets only
- `--rollback`: restore managed paths from `.demonlord-install-backup/latest`

Managed-asset apply policy is explicit and deterministic:
- Preserve unmanaged paths outside the installer-managed set.
- Backup existing managed assets to `.demonlord-install-backup/latest` before replacement.
- Replace managed assets from source only after backup succeeds.
- Persist policy + backup manifests in `.demonlord-install-backup/latest/policy-manifest.txt` and `.demonlord-install-backup/latest/manifest.txt`.

Installer exit codes are deterministic for automation:
- `2` usage error, `10` preflight failure, `20` source validation failure
- `30` backup failure
- `40` apply failure without rollback, `41` apply failure with successful automatic rollback, `42` apply failure with rollback failure
- `50` bootstrap failure after sync, `60` rollback command failure

Installer sync is deterministic for managed assets: local-source installs skip transient entries inside `.opencode` (for example `node_modules`, `.cache`, and editor temp files) so reruns stay reproducible across machines.

### Inject Demonlord Into Your Repository

Use this project as a template source and copy these assets into your target repository root:

- `.opencode/`
- `agents/`
- `scripts/`
- `doc/`
- `demonlord.config.json`
- `.env.example`

### Bootstrap Required Dependencies

After assets are in your target repository, run:

```bash
cd .opencode && npm install
```

Then return to repository root and install shell helpers:

```bash
cd .. && ./scripts/bootstrap.sh
```

### Configure Environment

- Copy `.env.example` to `.env`
- Add your GitHub PAT (`GITHUB_PAT`) and Discord credentials
- Configure Discord command allowlists (`DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_ROLE_IDS`, optional `DISCORD_ALLOWED_CHANNEL_ID`)
- Add a GitHub repository secret named `PROJECT_V2_TOKEN` for Project V2 automation
- Review `demonlord.config.json` for worktree and orchestration settings

### Start OpenCode and Run Pipeline

```bash
opencode
```

- Use `/triage` to analyze issues and generate plans
- Use `/implement` to execute the next subphase

Bootstrap policy: any repeatable install/setup behavior (dependencies, command shims, generated local runtime helpers) should be added to `scripts/bootstrap.sh`; `scripts/install-demonlord.sh` should delegate to it for deterministic one-command provisioning.

### First-Run Validation

After installation/bootstrap, verify the environment in this order:

```bash
opencode
```

```bash
pipelinectl status
```

- Confirm `.env` has placeholders filled for `GITHUB_PAT`, `DISCORD_BOT_TOKEN`, and Discord webhook URLs.
- Confirm inbound Discord authorization IDs are configured in `.env` and/or `demonlord.config.json`.
- Confirm `demonlord.config.json` exists (bootstrap creates minimum defaults if missing).
- Confirm `pipelinectl` resolves (`type pipelinectl`) or use `./agents/tools/pipelinectl.sh status` directly.

## Architecture

The system operates through a three-stage lifecycle:

1. **Triage**: The Planner agent analyzes GitHub issues and generates atomic `.md` plan files
2. **Implementation**: The Orchestrator spawns Minion agents in isolated worktrees to execute tasks
3. **Review**: The Reviewer agent analyzes output and requests human approval via Discord

Routing in V1 is explicit from tasklist metadata. Runnable tasks can declare `execution.role`, `execution.tier`, optional `execution.skill`, optional `execution.parallel_group`, and optional `execution.depends_on`. Missing metadata falls back deterministically to legacy behavior with warning-level logging.

All code changes must pass through the `submit_implementation` quality gate, which enforces your repository's linting and testing standards.

## Configuration

Key configuration files:

- **`.env`**: Contains secrets (GitHub PAT, Discord tokens)
- **`demonlord.config.json`**: Factory settings (worktree paths, orchestration mode/approval policy, Discord personas)
- **`.opencode/opencode.jsonc`**: Agent definitions, MCP servers, and permissions
- **`.github/workflows/project-board.yml`**: Label-based GitHub Project V2 status routing

### Project Board Automation Setup

To enable `SUBPHASE-2.2` workflow routing, configure these GitHub repository settings:

1. **Create a PAT** for automation:
   - Use a personal access token (classic)
   - Scopes: `project` and `repo` (required for private repositories)
2. **Add secret**:
   - `PROJECT_V2_TOKEN` = your PAT
3. **Add repository variables**:
   - `PROJECT_V2_ID`
   - `PROJECT_V2_STATUS_FIELD_ID`
   - `PROJECT_V2_STATUS_TODO_OPTION_ID`
   - `PROJECT_V2_STATUS_IN_PROGRESS_OPTION_ID`
   - `PROJECT_V2_STATUS_REVIEW_OPTION_ID`
   - `PROJECT_V2_STATUS_DONE_OPTION_ID`
4. **Create status labels** (canonical):
   - `Status: Todo`
   - `Status: In Progress`
   - `Status: In Review`
   - `Status: Done`

The workflow also accepts legacy compact labels (`status:todo`, `status:in-progress`, `status:review`, `status:done`) for compatibility.

### Worktree and Orchestration Settings

The `demonlord.config.json` file includes both worktree and orchestration control configuration:

```json
{
  "worktrees": {
    "directory": "../worktrees",
    "prefix": "task-",
    "approval_required": true,
    "agent_approval": {
      "minion": true,
      "reviewer": false
    }
  },
  "orchestration": {
    "enabled": true,
    "mode": "manual",
    "require_approval_before_spawn": true,
    "ignore_aborted_messages": true,
    "verbose_events": true
  }
}
```

This allows you to require approval for specific agent types and keep orchestration manual by default during development/testing.

### V1 Routing and Parallelism Extensions

Active orchestration schema extensions for deterministic tasklist-explicit multi-tier routing:

```json
{
  "orchestration": {
    "agent_pools": {
      "planning": { "lite": ["planner"], "pro": ["planner-pro", "planner"] },
      "implementation": {
        "lite": ["minion-lite", "minion"],
        "standard": ["minion-standard", "minion"],
        "pro": ["minion-pro", "minion"]
      },
      "review": { "lite": ["reviewer-lite", "reviewer"], "pro": ["reviewer-pro", "reviewer"] }
    },
    "task_routing": { "source": "tasklist_explicit", "default_tier": "standard" },
    "parallelism": {
      "max_parallel_total": 1,
      "max_parallel_by_role": { "planning": 1, "implementation": 1, "review": 1 },
      "max_parallel_by_tier": { "lite": 1, "standard": 1, "pro": 1 }
    },
    "execution_graph": {
      "enabled": true,
      "path": "_bmad-output/execution-graph.ndjson",
      "verbosity": "concise"
    },
    "cycle_runner": {
      "implement_recovery_retry_limit": 1
    }
  }
}
```

Routing behavior is deterministic: orchestrator reads `EXECUTION` metadata from tasklists, resolves role/tier against `agent_pools`, then falls back in order (`default_tier` -> legacy singleton) before blocking with explicit reason logs.

Dispatch behavior is deterministic: tasks enter a FIFO queue by `stage` + `parallel_group` + tasklist order, enforce `depends_on`, and honor `parallelism` caps (`total`, `by_role`, `by_tier`) before spawn.

Cycle resume hardening is configurable: `orchestration.cycle_runner.implement_recovery_retry_limit` controls how many consecutive non-`ok` implement attempts are tolerated before cycle runner fails fast (default fallback is `3`; `1` is the strictest runaway guard).

## Usage

### Commands
- **`/triage`**: Analyze GitHub issues and generate implementation plans
- **`/implement`**: Execute the next available subphase from the tasklist
- **`/run-review <review> <p1..p5> [hint] [phase] [dry-run]`**: Deterministic pre-hook review runner route that executes review commands and persists versioned review artifacts
- **`/mreview <file> [hint]`**: Run strict DRY/KISS/SOLID module review for one file with deterministic gate output
- **`/creview <codename> <subphase>`**: Run subphase code review against plan/tasklist/spec evidence
- **`/phreview <codename> <phase> [hint]`**: Run final phase-closeout review using persisted review artifacts and spec alignment checks
- **`/pipeline status [session]`**: Inspect pipeline tree, stage, routing, worktree, execution order, and overlap windows
- **`/pipeline advance <triage|implementation|review> [session]`**: Trigger explicit stage transition
- **`/pipeline stop [session]`**: Stop a specific pipeline
- **`/pipeline off`**: Disable orchestration globally
- **`pipelinectl status [session]`**: Shell fallback with session tree, execution order, and overlap windows
- **`pipelinectl off|on|advance|approve|stop`**: Shell fallback control commands via queue handoff
- **`/worktrees`**: (Future) List and manage active worktrees

Review artifacts are persisted under `_bmad-output/cycle-state/reviews/` using deterministic round-versioned JSON filenames (for example, `beelzebub-phase-1-subphase-1-4-round-1.json`).

With orchestrator enabled, `/run-review` is intercepted in plugin `command.execute.before` and routed through the shared review executor (no agent-instruction dependency). Direct `/creview`, `/mreview`, and `/phreview` command contracts remain available.

### Subphase Commit Provenance Policy

- Default policy is one commit per subphase and one subphase per PR.
- If a subphase needs multiple commits, PR body must include a `SUBPHASE_PROVENANCE` marker with:
  - `codename`
  - `subphase`
  - `commits` (exact hashes for that subphase)
  - `multi_commit_rationale` (required when more than one hash is listed)
- Use `.github/PULL_REQUEST_TEMPLATE.md` for the canonical marker format.
- CI enforces this contract in `.github/workflows/subphase-provenance-gateway.yml`.

### Local Shell Control Fallback

When slash-command UX is constrained, use the shell fallback:

```bash
./scripts/bootstrap.sh
```

```bash
# from repository root
pipelinectl status
pipelinectl advance implementation
pipelinectl approve
```

The orchestrator plugin injects `OPENCODE_SESSION_ID`, `OPENCODE_WORKTREE`, and orchestration state/queue paths via `shell.env`, and prepends the worktree tooling paths so `pipelinectl` resolves without a full path in active shell sessions.

Outside an active OpenCode shell session, run `./agents/tools/pipelinectl.sh ...` directly.

Verification example:

```bash
pipelinectl status
pipelinectl off
pipelinectl on
```

Expected behavior: deterministic status text, then queued control messages for `off/on`, followed by updated status after queue processing.

### Discord Integration
Receive notifications and control agents via Discord slash commands:
- **`/approve`**: Approve worktree creation or code changes
- **`/party`**: Start Party Mode for the targeted session
- **`/continue`**: Continue Party Mode execution
- **`/halt`**: Pause Party Mode execution
- **`/focus`**: Focus Party Mode on a specific agent
- **`/add-agent`**: Add agents to Party Mode
- **`/export`**: Export Party Mode transcript

Discord command-center hardening defaults:
- Inbound commands are allowlist-gated by `discord.authorization.allowed_user_ids` and/or `discord.authorization.allowed_role_ids`.
- Optional `discord.authorization.allowed_channel_id` restricts commands to one channel.
- Retry/backoff policy is fixed and deterministic: `max_attempts=3`, delays `0ms`, `250ms`, `1000ms`, no jitter.
- Outbound/inbound dedupe uses in-memory TTL (`10m`) for this cycle.

Verification entrypoint:

```bash
npm --prefix .opencode run verify:beelzebub
```

## Quality Gates

All implementation agents are restricted from using `git push` directly. Instead, they must use the `submit_implementation` tool which:

1. Runs your repository's `npm run lint` and `npm run test`
2. Returns errors to the agent for automatic fixing if tests fail  
3. Only commits code after successful validation

This ensures that all code meets your quality standards before being committed.

## Troubleshooting

- **OpenCode fails to start**: Restore from `.opencode/opencode.jsonc.known-good`
- **Agents not appearing**: Verify `.opencode/opencode.jsonc` uses singular keys (`agent`, not `agents`)
- **Permission errors**: Check `.env` contains required tokens
- **Skill matching issues**: Ensure `SKILL.md` files have proper YAML frontmatter with `name` and `description`
- **Worktree creation fails**: Verify sufficient disk space (minimum 2GB) and Git permissions
- **`/pipeline` still shows LLM reasoning**: Apply the local OpenCode command-hook patch documented in `doc/opencode_command_noReply_patch.md`
- **`pipelinectl` says session context missing**: run within an active OpenCode shell session or export `OPENCODE_SESSION_ID`
- **`pipelinectl: command not found`**: run `./scripts/bootstrap.sh`, then restart shell and confirm `~/.local/bin` is on `PATH`
- **Queued shell command rejected as stale**: rerun `pipelinectl status` and retry with fresh state
- **Installer fails midway**: run `./scripts/install-demonlord.sh --rollback`, resolve the error, then rerun installer
- **Installer exits with `E41`**: partial apply failed but automatic rollback restored prior managed assets; fix the root cause and rerun
- **Installer exits with `E42`**: partial apply failed and rollback also failed; correct permissions and run `./scripts/install-demonlord.sh --rollback`
- **Offline/proxy npm install issues**: rerun bootstrap with configured proxy env (`HTTPS_PROXY`, `HTTP_PROXY`, optional `NPM_CONFIG_REGISTRY`) or run `./scripts/install-demonlord.sh --skip-bootstrap` and bootstrap later
- **Bootstrap takes too long**: Check network connectivity and npm registry access
- **Discord command denied**: verify `discord.authorization` allowlists and optional channel gate match the caller context

## Validation Requirements

Before production deployment, verify:
- **Environment**: Node.js v18+, Git v2.30+, Bun runtime available
- **Bootstrap**: `./scripts/bootstrap.sh` completes in <60 seconds
- **End-to-end**: Simple "Hello World" task completes within 5 minutes
- **Error handling**: System gracefully handles network timeouts and disk space issues

## Customization

- **Add Skills**: Create `.opencode/skills/<name>/SKILL.md` with proper frontmatter
- **Custom Tools**: Add TypeScript tools to `.opencode/tools/` using Zod validation  
- **Modify Behavior**: Extend plugins in `.opencode/plugins/` to handle additional events

## Recovery

If OpenCode configuration becomes corrupted, restore from the backup:
```bash
cp .opencode/opencode.jsonc.known-good .opencode/opencode.jsonc
```

This ensures you can always recover to a working state.

---

*Note: This is a template repository designed to be injected into other projects. Keep dependencies lightweight and ensure a smooth bootstrap process.*
