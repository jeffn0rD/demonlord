System Architecture Specification: Autonomous Software Factory (Demonlord)

1. Architectural Foundation & Vision

The Autonomous Software Factory (Demonlord) is engineered as a stack-agnostic orchestration layer built atop the OpenCode agentic environment. It represents a fundamental shift from stochastic, manual LLM prompting toward a deterministic, high-throughput software production line. By leveraging the OpenCode Model Context Protocol (MCP), a dual-mode TypeScript Matchmaker tool, and a strictly enforced plugin architecture, the factory transforms raw engineering requirements into validated code deployments through a rigid, automated pipeline.

The core architectural philosophy of "stack-agnosticism" ensures that the factory orchestration is decoupled from specific application frameworks (e.g., React, Svelte, or Fastify). By injecting the factory configurations into a target repository, it operates as a standalone resource, utilizing standardized entry points and universal testing protocols to maintain operational reliability across heterogeneous environments.

Core Platform Components

Component	Role in the Factory
OpenCode (Web/CLI/TUI)	The base agentic environment providing secure local file access and the execution context for specialized agent personas.
Node.js / TypeScript	The high-performance runtime for OpenCode plugins and the engine for enforcing deterministic quality gates via the OpenCode SDK.
OpenCode SDK	A type-safe JS/TS interface used to programmatically orchestrate sessions, spawn isolated worktrees, and handle Discord bot events.

This foundation provides the hardened infrastructure required to instantiate a specialized agent ecosystem entirely within the local repository boundary.

2. Specialized Agent Ecosystem

Professional-grade software engineering requires the elimination of general-purpose LLM stochasticity. The system replaces generic chat interactions with a hierarchy of specialized agent roles defined natively within .opencode/opencode.jsonc.

Primary Agent Personas

1. Planner Agent: Operates to ingest GitHub issues, utilize glob and grep to identify specific target files in the codebase, and generate atomic .md plan files within the /agents/plans/ workspace. The Planner is architecturally restricted from making code changes. V1 supports `planner` as the backward-compatible default and optional tier variants (`planner-lite`, `planner-pro`) through role/tier pool mapping.
2. Orchestrator: Functions as the task router. It parses the Planner's output and invokes the custom route_task.ts Matchmaker to route tasks to the appropriate specialized skills.
3. Minion Agents: Execution-focused entities spawned headlessly in parallel, isolated Git Worktrees via the OpenCode SDK. They operate within a restricted toolset to implement specific features or fixes. V1 defines implementation tiers `minion-lite`, `minion-standard`, and `minion-pro` with deterministic fallback to `minion`.
4. Reviewer Agent: Performs automated Pull Request (PR) analysis and triggers event-based notifications for human-in-the-loop (HITL) approval via Discord. V1 supports `reviewer-lite` and `reviewer-pro` with deterministic fallback to `reviewer`.

Agent Skills and the "Matchmaker" Logic

The "Agent Skills" framework provides reusable, on-demand instructions. Skills are defined in SKILL.md files (which must be all-caps) within the .opencode/skills/<name>/ directory. To ensure system integrity, the following validation rules are enforced for all skill definitions:

* Frontmatter Requirements: Must include name and description (1-1024 chars).
* Naming Constraints: The name field must match the directory name exactly. It must be 1–64 lowercase alphanumeric characters, use only single hyphen separators, and cannot start/end with a hyphen or contain consecutive hyphens (--).

The Dual-Mode Matchmaker Logic replaces heavy ML vector databases with a robust, Node-based TS tool (.opencode/tools/matchmaker.ts):

1. Parsing: The Orchestrator extracts semantic requirements from the .md plan.
2. Mode 1 (LLM Routing - Default): The tool reads all SKILL.md descriptions and uses the OpenCode SDK to ask a fast LLM model to select the best match.
3. Mode 2 (Local Embeddings - Optional): The tool queries a lightweight, Node-based vector engine (like voy-search) containing embedded skill representations.
4. Instantiation: The Orchestrator uses the selected skill ID and the OpenCode SDK (client.session.create) to initialize an isolated, headless agent session in a newly spawned Git worktree.

3. Integration Layer: MCP Servers & Configurations

The Model Context Protocol (MCP) provides agents with external state persistence and intelligence.

Strategic Integrations

* GitHub MCP (@modelcontextprotocol/server-github): Facilitates direct interaction with the project’s version control state. It allows Planner and Reviewer agents to ingest issues, create sub-issues for task decomposition, and programmatically manage the Pull Request lifecycle.
* Centralized Factory Config (demonlord.config.json): A single root-level file that manages Discord persona mappings, worktree output paths, and orchestration controls (enabled/off/manual/auto mode, approval gating, abort handling, and event verbosity), preventing pollution of core OpenCode files.

Configuration Protocol

MCP servers and core agent definitions are defined in the opencode.jsonc file.

Example opencode.jsonc Configuration:

{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "enabled": true,
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PAT}"
      }
    }
  },
  "agent": {
    "planner": {
      "description": "Analyzes issues and generates atomic plan files",
      "model": "anthropic/claude-3-5-sonnet",
      "prompt": "{file:./prompts/planner.txt}"
    }
  },
  "permission": {
    "bash": {
      "git push": "deny"
    }
  }
}


4. The Workflow State Machine

The factory discards unreliable LLM-based loops in favor of event-driven orchestration via OpenCode plugins. Plugins subscribe to session lifecycle events (`session.idle`, `session.error`, `session.created`) to coordinate transitions between pipeline stages while persisting explicit pipeline state (root session, stage, children, worktree, routing) as the source of truth.

The Three-Stage Lifecycle

1. Ingestion & Planning (/triage): Triggered by custom command, Discord slash command, or programmatic SDK call, the Planner ingests requirements and decomposes them into atomic, non-overlapping tasks.
2. Orchestration & Spawning (/implement): The Orchestrator invokes spawn_worktree.sh, creating isolated sibling directories for parallel execution, and uses the SDK (`client.session.create()`) to launch the matching Minion in the new worktree.
   - Spec-first branch (ambiguity policy): when requirements are unclear or documentation-heavy, the orchestrator routes first to `spec-expert` and requires a validated handoff artifact before spawning a coding implementation session.
   - Handoff artifact contract: `_bmad-output/spec-handoff-<taskID>.md` must include `<!-- DEMONLORD_SPEC_HANDOFF_READY -->`, `## Scope`, and `## Constraints`.
   - Handoff continuity contract: after marker validation, implementation spawn MUST reuse the pre-resolved execution target (`taskRef`, `role`, `tier`, `agentID`, `skill`) rather than resetting to implicit defaults.
3. Review & Handoff: Upon completion, a plugin listening to `session.idle` triggers the Reviewer agent and posts a Discord notification for human-in-the-loop approval.

Operational Modes and Manual Controls

The orchestration layer is configuration-driven and supports three deterministic modes:

* `off`: no automatic stage transitions, no child spawning, and no recovery prompts.
* `manual` (default): no auto-spawn; transitions occur only through explicit operator actions.
* `auto`: event-driven transitions remain enabled, but guarded by persisted pipeline-state validation and approval policy.

To remove dependence on title inference and ad hoc DB inspection, operators use first-class pipeline controls:

* `/pipeline status [session]`: Returns parent/child tree, stage, transition state, routing, and worktree context.
* `/pipeline advance <triage|implementation|review> [session]`: Executes an explicit deterministic transition.
* `/pipeline stop [session]` and global `/pipeline off`: Stops one pipeline or disables orchestration globally.
* `/pipeline approve [session]`: Local approval path for blocked spawn transitions (works without Discord).

Local Command Hook Patch (Optional, Personal/Local Use)

Some OpenCode builds still run slash commands through a visible LLM reasoning turn even when plugins handle control commands in `command.execute.before`. For local/personal workflows, Demonlord supports a compatibility patch to OpenCode core that adds `noReply` to the command pre-hook output contract.

When applied, orchestrator/communication plugins can set `output.noReply = true` for `/pipeline` and `/approve`, producing deterministic control responses without an LLM reasoning turn.

Patch details are versioned in `doc/opencode_command_noReply_patch.md`, including:

* target files in `/home/jeff0r/work/opencode`
* minimal diff for `packages/plugin/src/index.ts` and `packages/opencode/src/session/prompt.ts`
* verification commands and expected behavior
* rollback steps

Local Shell Control Plane (`pipelinectl`)

To guarantee deterministic operator control even when slash-command UX is constrained, Demonlord includes a shell fallback command (`pipelinectl`, backed by `agents/tools/pipelinectl.sh`) that reads orchestration snapshot state and appends validated control intents to a plugin-consumed command queue.

Control-plane artifacts:

* Snapshot: `_bmad-output/orchestration-state.json` (versioned, atomic temp-write+rename).
* Queue: `_bmad-output/orchestration-commands.ndjson` (append-only control intents).
* Session context: injected by plugin via `shell.env` (`OPENCODE_SESSION_ID`, `OPENCODE_WORKTREE`, state/queue paths) and PATH prepending for project-local pipelinectl execution.

Snapshot contract highlights (v2):

* `updatedAt`: top-level snapshot freshness timestamp.
* `runtime`: configured/effective orchestration mode and global-off status.
* `pipelineSummaries`: root-session keyed stage/transition/stopped/stopReason and pending-transition metadata.
* `pipelineSummaries.specHandoff`: marker status/path and target implementation skill when spec-first policy is active.
* `commandQueue`: queue path, last processed line, and dedupe metadata.

Failure and recovery behavior:

* Invalid/stale shell commands are rejected with explicit remediation (`pipelinectl status`, then retry).
* Duplicate queue commands are deduped by deterministic keys to avoid repeated state mutations.
* Queue processing advances linearly and persists offsets, preventing replays after restarts.
* Snapshot writes remain atomic to prevent partial reads during concurrent operator activity.

One-Command Installer Bootstrap

To support template injection into arbitrary repositories, Demonlord includes a standalone installer entrypoint (`scripts/install-demonlord.sh`) that can run from local disk or stdin (`curl | bash`) with explicit source targeting.

Installer contract:

* Required source assets: `.opencode/`, `agents/`, `doc/`, `scripts/bootstrap.sh`, `demonlord.config.json`, `.env.example`.
* Managed path backups: prior managed paths are snapshotted to `.demonlord-install-backup/latest` before sync.
* Idempotent reruns: installer replaces managed assets deterministically, then delegates environment setup to `scripts/bootstrap.sh`.
* Dry-run support: `--dry-run` emits exact planned actions without writing files.
* Rollback support: `--rollback` restores managed assets from the latest backup snapshot.

Bootstrap contract extensions:

* `scripts/bootstrap.sh` can now create a minimum `demonlord.config.json` when absent (preferring `.opencode/templates/demonlord.config.default.json`).
* Dependency install can be deferred (`--skip-deps`) for offline/proxy-constrained environments.
* Shim installation for `pipelinectl` remains deterministic and repeatable across reruns.

Horizontal Scaling via Git Worktrees

The adoption of Git Worktrees over standard branching is a critical architectural decision:

* Parallelism: Enables simultaneous, non-blocking execution of multiple agents on the same repository history without file-locking.
* Isolation: Each agent session is confined to a unique directory, preventing the "dirty state" issues common in shared-directory flows.
* Scalability: Allows the factory to scale horizontally across available compute resources by spawning new worktrees for every concurrent task.
* Project Context Management: Each worktree includes a project-context.md file that serves as a "constitution" for AI agents, ensuring consistent implementation decisions across all sessions.
* Project Context Management: Each worktree includes a project-context.md file that serves as a "constitution" for AI agents, ensuring consistent implementation decisions across all sessions.

Worktree Visibility and Approval

To maintain operational control and visibility, the system implements worktree approval and tracking:

* Configuration: The `demonlord.config.json` file contains `worktrees.approval_required`, `worktrees.agent_approval`, and `orchestration.require_approval_before_spawn` settings to control approval policy.
* Discord Integration: The communication plugin sends detailed messages about worktree creation, including the agent type, purpose, and worktree path.
* Approval Gating: When approval is required, the system pauses execution and waits for explicit approval (Discord `/approve` or local `/pipeline approve`) before proceeding with child-session creation.
* Tracking: The worktree manager maintains metadata about active worktrees for cleanup and monitoring purposes.

Abort and Error Policy

To reduce noise during manual testing while preserving deterministic recovery:

* `MessageAbortedError` can be treated as non-fatal when `orchestration.ignore_aborted_messages=true`.
* Recovery prompts are emitted only for real execution errors and deduplicated once per normalized signature.
* Structured orchestration events (`spawn requested/approved/blocked/completed`, `error`, `stopped`) are persisted for auditability.

4A. V1 Deterministic Multi-Tier Routing and Execution Graph

This section defines the mandatory V1 behavior for explicit tasklist-driven routing and concise execution visibility.

Scope and compatibility requirements:

* Complexity/tier selection source MUST be explicit tasklist metadata in V1 (`task_routing.source = "tasklist_explicit"`).
* The orchestrator MUST NOT infer complexity in V1.
* Manual-first controls (`/pipeline`, `pipelinectl`) MUST remain the authoritative control path.
* Backward compatibility with existing single-agent IDs (`planner`, `orchestrator`, `minion`, `reviewer`) MUST be preserved.

Agent Tiering Model (Role Families)

V1 role families and tiers:

* planning role family: `planner-lite`, `planner-pro` (optional)
* implementation role family: `minion-lite`, `minion-standard`, `minion-pro`
* review role family: `reviewer-lite`, `reviewer-pro`

Deterministic selection rules:

1. The orchestrator MUST identify the selected task from persisted task traversal context (`taskRef`, `tasklistPath`); session-title parsing is diagnostic-only.
   - This context MUST be persisted in pipeline state and reused for metadata lookup across approvals, retries, and resumed idle events.
2. It MUST read `execution.role` and `execution.tier` from that task's adjacent metadata block.
3. It MUST resolve candidates from `orchestration.agent_pools[role][tier]` in listed order.
4. It MUST select the first candidate that exists under `.opencode/opencode.jsonc.agent`.
5. If `.opencode/opencode.jsonc` cannot be read or parsed, agent resolution MUST fail closed (`task_blocked`) with explicit reason logging that includes the config load/parsing failure.
6. If no candidate exists, it MUST apply deterministic fallback in this order:
   a) `orchestration.task_routing.default_tier` for the same role;
   b) legacy singleton ID (`planner` | `minion` | `reviewer`) for that role;
   c) hard block with `task_blocked` if still unresolved.
7. Every fallback decision MUST be logged in the execution graph with `reason`.

Explicit Tasklist Routing Contract (V1)

Tasklist metadata is the routing source of truth. Each runnable task SHOULD include an adjacent `EXECUTION` metadata block.

Required fields:

* `execution.role`: `planning` | `implementation` | `review`
* `execution.tier`: `lite` | `standard` | `pro`

Optional fields:

* `execution.skill`: explicit skill override ID (string)
* `execution.parallel_group`: queue affinity token (string)
* `execution.depends_on`: array of task IDs (for example `T-3.7.1`)

Canonical task annotation format (deterministic JSON in markdown comment):

```md
<!-- TASK:T-3.7.2 -->
<!-- EXECUTION:{"execution":{"role":"implementation","tier":"pro","skill":"orchestration-specialist","parallel_group":"routing-core","depends_on":["T-3.7.1"]}} -->
- **T-3.7.2**: Implement role/tier agent resolution in orchestrator spawn flow.
```

Missing metadata behavior:

* If `EXECUTION` metadata is absent, the orchestrator MUST preserve legacy behavior (`role=implementation`, `tier=orchestration.task_routing.default_tier`, agent fallback to `minion`) and emit a warning-level log event.
* Missing metadata MUST NOT fail existing single-agent pipelines.
* Missing metadata warnings MUST be evaluated against the persisted selected task context, not inferred from session/request title text.

Constrained Parallel Execution Policy

Stage and dispatch rules:

* Global stage sequence MUST remain `triage -> implementation -> review`.
* Controlled parallelism is allowed only for implementation tasks that are dependency-ready.
* `execution.depends_on` MUST be fully satisfied before a task is eligible for spawn.

Deterministic queue semantics:

1. Task order source MUST be tasklist appearance order (`taskIndex`).
2. Scheduler order key MUST be: `stage`, then `parallel_group` (empty string sorts first), then FIFO by `taskIndex`.
3. If dependency is unresolved, task state MUST be `blocked` with explicit `reason`.
4. If capacity is unavailable (`max_parallel_total`, role cap, or tier cap), task state MUST be `queued`; tasks are never dropped.
5. When capacity becomes available, queued tasks MUST resume in deterministic order (same key as above).
6. `/pipeline status` and `pipelinectl status` MUST surface the same dispatch view: parent/child tree, execution order by `seq`, and overlap windows grouped by `parallel_group`.

Execution Graph Log Contract (Concise, Machine-Readable)

Default artifact path: `_bmad-output/execution-graph.ndjson`

Each event line MUST contain:

* `seq` (strictly increasing integer per root pipeline)
* `ts` (UTC ISO-8601 timestamp)
* `rootSessionID`, `eventType`
* `sessionID`, `parentSessionID`
* `stage`, `taskRef`, `agentID`, `tier`, `skillID`
* `parallelGroup`, `slot`, `status`
* optional `reason`

Required `eventType` values:

* `pipeline_started`
* `task_queued`
* `task_blocked`
* `spawn_requested`
* `spawn_started`
* `spawn_completed`
* `task_completed`
* `pipeline_completed`

Ordering and dedupe guarantees:

* Events MUST be appended atomically, one NDJSON object per line.
* `seq` allocation MUST be monotonic and gap-free for committed writes.
* Duplicate transitions for the same `(rootSessionID, taskRef, eventType, status)` MUST be deduped.
* Deduped attempts MUST NOT reorder subsequent committed events.
* Runtime default remains migration-safe single-flight (`parallelism` missing => total/role/tier caps all `1`).

Example event:

```json
{"seq":14,"ts":"2026-03-13T12:03:55.004Z","rootSessionID":"root-42","eventType":"task_blocked","sessionID":"sess-impl-2","parentSessionID":"root-42","stage":"implementation","taskRef":"T-3.8.3","agentID":"minion-pro","tier":"pro","skillID":"backend-specialist","parallelGroup":"impl-core","slot":"implementation:2","status":"blocked","reason":"depends_on unresolved: T-3.8.1"}
```

Human status summary contract (`/pipeline status`):

* MUST include parent->child spawn tree with task refs and agent IDs.
* MUST include deterministic execution order by `seq`.
* MUST include overlap windows as `[startSeq-endSeq]` per parallel group.

Config Schema Contract (migration-safe)

`demonlord.config.json` extension under `orchestration`:

```json
{
  "orchestration": {
    "agent_pools": {
      "planning": {
        "lite": ["planner"],
        "pro": ["planner-pro", "planner"]
      },
      "implementation": {
        "lite": ["minion-lite", "minion"],
        "standard": ["minion-standard", "minion"],
        "pro": ["minion-pro", "minion"]
      },
      "review": {
        "lite": ["reviewer-lite", "reviewer"],
        "pro": ["reviewer-pro", "reviewer"]
      }
    },
    "task_routing": {
      "source": "tasklist_explicit",
      "default_tier": "standard"
    },
    "parallelism": {
      "max_parallel_total": 1,
      "max_parallel_by_role": {
        "planning": 1,
        "implementation": 1,
        "review": 1
      },
      "max_parallel_by_tier": {
        "lite": 1,
        "standard": 1,
        "pro": 1
      }
    },
    "execution_graph": {
      "enabled": true,
      "path": "_bmad-output/execution-graph.ndjson",
      "verbosity": "concise"
    }
  }
}
```

Default and backward-compatibility behavior:

* If `agent_pools` is absent, runtime MUST use legacy single-agent IDs.
* If `task_routing` is absent, runtime MUST assume `source="tasklist_explicit"` and `default_tier="standard"` while preserving legacy fallback when metadata is missing.
* If `parallelism` is absent, effective limits MUST default to `1` for total/role/tier (single-flight behavior).
* If `execution_graph` is absent, runtime MUST default to enabled concise logging at `_bmad-output/execution-graph.ndjson`.
* Orchestrator MUST continue to treat tasklist metadata as the sole V1 tier source and MUST NOT derive tier from heuristic complexity signals.

V1 Acceptance Criteria (pass/fail)

| Dimension | Pass Criteria | Fail Signal | Verification Anchor |
| --- | --- | --- | --- |
| Explicit routing determinism | For the same `EXECUTION` metadata + `agent_pools`, resolver always selects the same first configured agent. | Different agent selected across repeated runs with identical inputs. | `.opencode/tests/plugins/orchestrator.test.ts` (`resolveAgentFromPools` ordering tests). |
| Legacy fallback behavior | Missing `EXECUTION` metadata falls back to legacy role/tier defaults and emits `routing_warning` with actionable reason text. | Pipeline routes silently without warning, or blocks when metadata is absent. | `.opencode/tests/plugins/orchestrator.test.ts`, `.opencode/tests/integration/orchestration-flow.test.ts`. |
| Constrained parallel dispatch | `depends_on` unresolved => `task_blocked`; cap saturation => `task_queued`; queued tasks resume deterministically when capacity frees. | Tasks spawn while blocked by deps/caps, or queued tasks are dropped. | `.opencode/tests/integration/orchestration-flow.test.ts` (dependency and cap-queue scenarios). |
| Execution-graph correctness | NDJSON entries include required fields, `seq` is monotonic and gap-free, lifecycle ordering is preserved, duplicate transitions are suppressed. | Missing required fields, non-monotonic sequence, out-of-order lifecycle, duplicate terminal/queue events. | `.opencode/tests/integration/orchestration-flow.test.ts` (execution-graph contract test). |
| Legacy workflow non-regression | Existing singleton agent flow (`planner` -> `minion` -> `reviewer`) remains functional without task metadata migration. | Legacy-only pipelines fail routing, block unexpectedly, or require new metadata to proceed. | Existing orchestration integration suite + fallback coverage in `.opencode/tests/integration/orchestration-flow.test.ts`. |

V1 Risks and Non-Goals

* Non-goal: automatic complexity scoring or LLM-inferred tiering.
* Non-goal: dynamic autoscaling based on token/cost telemetry.
* Risk: malformed task metadata can reduce throughput; mitigation is strict parser validation plus deterministic fallback.
* Risk: over-restrictive parallel caps can starve throughput; mitigation is explicit queue visibility in execution graph and `/pipeline status`.

5. Deterministic Quality Gates & Plugin Architecture

To enforce "professional-grade" output, the factory utilizes "Black Box Gates." Agents are intentionally stripped of native git push commands via the Permission Matrix, forcing them to interact with the repository through a deterministic TypeScript toolset.

**Comprehensive Testing Requirements:**
- All custom tools must include unit tests with 95%+ code coverage
- Plugin event handlers require integration tests validating proper event subscription and error handling
- End-to-end workflow validation must verify the complete Triage->Implement->Review pipeline
- Error scenario testing must cover network timeouts, disk space exhaustion, and configuration errors

**Simplified Testing Strategy (Quinn-inspired):**
- Lightweight test generation integrated directly into Minion agent workflow
- Automatic test framework detection from package.json
- API and E2E test generation with semantic locators and independent test structure
- Auto-fix loop for test failures before quality gate submission

The submit_implementation() Tool

Implementation agents must finalize their work via the submit_implementation() tool. This tool enforces a mandatory quality protocol:

1. Execution: The tool programmatically runs npm run lint and npm run test using context.worktree.
2. The Automated Error-Handling Loop: If a test fails (exit code 1), the tool intercepts the stdout/stderr and re-injects the stack trace into the agent's context. This triggers a "Retry" cycle where the agent must fix the error before another submission attempt is permitted.
3. Commitment: Only upon a successful (exit code 0) validation does the tool execute a commit—enforcing Conventional Commit standards—and push to the remote.

Custom Tooling with Zod Validation

Custom tools are defined in .opencode/tools/ using the tool() helper and Zod schemas to ensure strict argument validation.

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

export const submit_implementation = tool({
  description: "Mandatory gate: validates code via lint/test and commits changes.",
  args: {
    commit_message: tool.schema.string().min(10)
  },
  execute: async ({ args, context, $ }) => {
    const root = context.worktree;
    // Step 1: Deterministic Lint/Test
    const validation = await $`cd ${root} && npm run lint && npm run test`.nothrow();
    
    if (validation.exitCode !== 0) {
      return `Validation failed. Fix these errors: ${validation.stderr}`;
    }
    // Step 2: Atomic Commit
    await $`cd ${root} && git add . && git commit -m ${args.commit_message} && git push`;
    return "Implementation successfully validated and committed.";
  }
});


6. Command, Control & Infrastructure

The factory centralizes command through a Discord Command Center plugin, maintaining high visibility and developer control.

Integration Hubs

* Discord 2-Way Bot: The communication.ts plugin handles outbound events (session.idle) by posting summaries mapped to agent personas defined in demonlord.config.json. It also listens for inbound /slash commands (e.g., /triage, /approve, /reject [reason], /handoff [skill], /park, /party) and injects them into the relevant session via the OpenCode SDK.
* Kanban Automation: Agents are restricted to applying specific GitHub Labels (e.g., Status: In Progress). These label changes trigger GitHub Actions that physically move cards on the Project V2 boards.

Enhanced Collaboration: Party Mode

The system supports multi-agent collaborative sessions via the /party command, enabling real-time discussion between specialized agents with human-in-the-loop control:

* Round-Based Discussion: Agents participate in structured rounds where each provides input before user intervention
* User Control Interface: Discord slash commands (/continue, /halt, /focus [agent], /add-agent [type], /export) provide full orchestration control
* Context Preservation: All discussion artifacts are saved to the worktree for future reference and auditability
* Remote Participation: Users can initiate and participate in complex architectural discussions remotely via Discord

Enhanced Collaboration: Party Mode

The system supports multi-agent collaborative sessions via the /party command, enabling real-time discussion between specialized agents with human-in-the-loop control:

* Round-Based Discussion: Agents participate in structured rounds where each provides input before user intervention
* User Control Interface: Discord slash commands (/continue, /halt, /focus [agent], /add-agent [type], /export) provide full orchestration control
* Context Preservation: All discussion artifacts are saved to the worktree for future reference and auditability
* Remote Participation: Users can initiate and participate in complex architectural discussions remotely via Discord

Standardized Directory Strategy

The factory maintains a strict separation of concerns through the following structure:

demonlord.config.json
.opencode/
├── opencode.jsonc
├── opencode.jsonc.known-good   # Backup for recovery
├── commands/
├── skills/
│   └── frontend-specialist/
│       └── SKILL.md
├── tools/
│   ├── submit_implementation.ts
│   ├── matchmaker.ts
│   ├── worktree_manager.ts     # Worktree tracking and cleanup
│   └── party_mode.ts           # Multi-agent collaborative session orchestration
└── plugins/
    ├── communication.ts        # Discord two-way bot with worktree visibility
    └── orchestrator.ts         # Event-driven pipeline coordination


This architecture ensures the Autonomous Software Factory remains a portable, high-fidelity resource capable of being injected into any software project to establish a professional-grade production line.
