# Autonomous Software Factory (Demonlord) - Architecture & Technology Summary

This document serves as the master blueprint and reference guide for the "Demonlord" Autonomous Software Factory system designed to run on top of the OpenCode CLI/Web interface. 

The goal of this system is to abstract away manual orchestration, creating an automated pipeline where a Lead Developer can ingest GitHub issues, generate plans, route those plans to highly specialized "minion" AI agents working in true parallel isolated environments, enforce strict code-quality gates deterministically, and control the entire factory via Discord.

Because this factory is designed to be **generic and stack-agnostic**, it can be built into a standalone template repository and then injected/cloned into any target project repo.

---

## Core Technologies & Frameworks

### Base Platform
*   **OpenCode:** The core agentic environment, exposing Web UI, CLI, local file read/write, and a highly extensible Plugin/Skill/Command ecosystem.
*   **Node.js / TypeScript / Bun:** The underlying runtime for OpenCode plugins. All deterministic workflow gates and custom tools will be written in strict TypeScript.

### Integrations
*   **GitHub MCP (`@modelcontextprotocol/server-github`):** Used by Planner and Reviewer agents to ingest issues, read project state, create sub-issues, and manage Pull Requests.
*   **The Matchmaker Tool:** A custom dual-mode TypeScript tool (`.opencode/tools/matchmaker.ts`) for semantic "Query-Key" routing. Mode 1 uses fast LLM reasoning to map tasks to Agent Skills. Mode 2 (optional) uses lightweight local Node-based vector embeddings (like `voy-search`) to eliminate Python ML dependencies while retaining semantic matching capabilities.

### Infrastructure & Operations
*   **Git Worktrees (`git worktree`):** Replaces standard `git clone` or branch checkouts. Allows the system to spawn parallel agent sessions in completely isolated directories that share the same local repository history, preventing branch collision/file-locking.
*   **Discord (Webhooks & Bot API):** The primary Command Center. Outbound events (`session.idle`) trigger webhook notifications using dynamically assigned agent personas. Inbound messages (dictated `/slash` commands like `/approve`, `/park`, `/handoff`) are parsed by a lightweight bot plugin to redirect or unpause sessions.
*   **GitHub Actions:** Handles Kanban board automation. Agents are restricted to applying specific GitHub Labels (`Status: In Progress`, `Status: In Review`), which trigger native GitHub Actions to physically move cards on GitHub Projects V2 boards.

---

## The Workflow State Machine

The factory operates on an event-driven orchestration state machine (implemented in `.opencode/plugins/orchestrator.ts`), removing the unreliability of LLM-based orchestration loops.

### 1. Ingestion & Planning (`/triage`)
*   Triggered manually or via cron.
*   A **Planner Agent** (restricted from making code changes) reads new GitHub issues.
*   It generates a `.md` plan file in the `/agents/plans/` workspace detailing atomic tasks, parallel execution opportunities, and specific target files discovered via `glob` and `grep`.

### 2. Orchestration & Spawning (`/implement`)
*   The Orchestrator reads the plan.
*   It invokes the `matchmaker.ts` tool, passing the task requirements to find the exact Minion Skill (e.g., `demonlord-tooling-specialist`) matching the job.
*   V1 routing is tasklist-explicit: each runnable task provides `execution.role` and `execution.tier` metadata, and orchestrator resolves concrete agent IDs from config-defined role/tier pools.
*   For ambiguous/spec-heavy requests, it runs a spec-first pass and requires a marker artifact (`_bmad-output/spec-handoff-<taskID>.md`) with scope/constraints before coding begins.
*   A bash script (`spawn_worktree.sh`) generates an isolated sibling directory.
*   The specialized minion is spawned headlessly inside the worktree using the OpenCode SDK.

### 3. Implementation & Deterministic Gates
*   The minion implements the required code using native OpenCode editing tools.
*   **The Black Box Gate:** To prevent bad commits or skipped tests, the agent is stripped of native git bash commands via the OpenCode Permission Matrix. It must instead call a TypeScript plugin tool: `submit_implementation()`.
*   This tool is purely deterministic: it programmatically runs the repository's native `npm run lint` and `npm run test`. If they fail, the TS function intercepts the stack trace and feeds it back to the LLM to fix. If they pass, the TS function securely commits the code following strict conventional commit rules and pushes.

### 4. Review & Handoff
*   A **Reviewer Agent** analyzes the generated PR.
*   Events trigger the OpenCode Discord communication plugin, sending a Slack/Discord notification containing a summary and waiting for final Lead Developer approval.
*   The Lead Dev can dictate a `/approve` or `/reject [reason]` slash command to the Discord bot to finalize the pipeline or force a rework.

### 5. Orchestration Controls (Manual-First)
*   Pipeline behavior is controlled from `demonlord.config.json` under `orchestration`.
*   Default mode is `manual` for development/testing reliability.
*   Operators use explicit controls (`/pipeline status`, `/pipeline advance`, `/pipeline stop`, `/pipeline off`) instead of relying on inferred stage from session titles.
*   Spawn approvals can be enforced before child creation and supported through local command paths even when Discord is unavailable.
*   Execution order and parallel overlap are tracked in `_bmad-output/execution-graph.ndjson` for concise machine-readable auditing.

---

## Directory Structure Strategy

```text
/demonlord.config.json     # Centralized settings for Discord personas and factory configs
/.opencode/
  ├── opencode.jsonc       # Defines MCP servers, native Agent definitions, and Permission Matrix
  ├── commands/            # Custom UI commands (/triage, /implement)
  ├── skills/              # Agent skill profiles (the "Keys" for the matchmaker)
  │   └── demonlord-specialist/
  │       └── SKILL.md
  ├── plugins/
  │   ├── communication.ts # Discord Webhooks & Bot for 2-way comms
  │   └── orchestrator.ts  # Event-driven pipeline coordination and transition guards
  └── tools/
      ├── matchmaker.ts           # Dual-mode semantic routing logic
      └── submit_implementation.ts # The Deterministic Gate (lint/test/commit)

/agents/
  ├── tools/
  │   └── spawn_worktree.sh # Worktree generation script
  ├── plans/                # Triage-generated plan files
  └── completed/            # Transcripts of finished jobs
```

By decoupling these configurations from specific application frameworks (like Svelte or Fastify), this Autonomous Factory can be dropped into any project structure, relying on generic `package.json` scripts (`npm run test`) to enforce quality before PR generation.
