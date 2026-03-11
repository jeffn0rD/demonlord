# Agentic Execution Tasklist: Autonomous Software Factory (Demonlord)

## How to execute
This document defines the atomic tasks required to build the Demonlord factory template. 
Agents should execute one subphase at a time. To trigger implementation, the Lead Developer or Orchestrator should run `/implement minion` (or similar configured command) specifying the target subphase.

---

## PHASE-1: Factory Foundation & Configuration
<!-- PHASE:1 -->
**Goal:** Establish the core OpenCode configuration, initialize the global permission matrix, and define the base agent personas natively.

### SUBPHASE-1.1: Core Native Configuration
<!-- SUBPHASE:1.1 -->
**Goal:** Initialize the OpenCode settings, define personas, and secure the environment.
**Entry criteria:** OpenCode environment is accessible.
**Exit criteria / QA checklist:**
- [x] `.opencode/opencode.jsonc` syntax is valid and contains `planner`, `orchestrator`, and `reviewer` agents.
- [x] `demonlord.config.json` exists with foundational settings.
**Proposed PR title:** chore: configure core opencode settings and personas
**Proposed commit message:** feat: initialize opencode.jsonc with native agents and permission matrix (Refs #1)

**Tasks:**
<!-- TASK:T-1.1.1 -->
- **T-1.1.1** (Refs #1): Create `.opencode/opencode.jsonc`. Define the base agents (`planner`, `orchestrator`, `minion`, `reviewer`) with appropriate `mode` (primary/subagent) and model selections. Touch points: `.opencode/opencode.jsonc`
<!-- TASK:T-1.1.2 -->
- **T-1.1.2** (Refs #1): Add the GitHub MCP server configuration to `opencode.jsonc`. Touch points: `.opencode/opencode.jsonc`
<!-- TASK:T-1.1.3 -->
- **T-1.1.3** (Refs #1): Implement the Global Permission Matrix in `opencode.jsonc`. Explicitly `deny` the use of `git push` in the `bash` tool to prevent agents from bypassing quality gates. Touch points: `.opencode/opencode.jsonc`
<!-- TASK:T-1.1.4 -->
- **T-1.1.4** (Refs #1): Create `demonlord.config.json` at the project root to hold non-OpenCode specific factory settings (worktree directories, Discord persona names). Touch points: `demonlord.config.json`

---

## PHASE-2: The Command Center (Discord & GitHub)
<!-- PHASE:2 -->
**Goal:** Connect the software factory to a Discord bot for two-way communication and automate the GitHub Kanban board.

### SUBPHASE-2.1: Discord Two-Way Bot Integration
<!-- SUBPHASE:2.1 -->
**Goal:** Build a plugin to handle outbound webhooks and inbound slash commands.
**Entry criteria:** PHASE-1 complete. `.env` file available with Discord tokens.
**Exit criteria / QA checklist:**
- [ ] Plugin cleanly maps OpenCode session events to Discord webhook payloads using mapped personas.
**Proposed PR title:** feat: implement discord command center bot
**Proposed commit message:** feat: add two-way discord communication plugin and slash commands (Refs #1)

**Tasks:**
<!-- TASK:T-2.1.1 -->
- **T-2.1.1** (Refs #1): Initialize `.opencode/package.json` with required dependencies (e.g., `discord.js` or generic fetch libraries). Touch points: `.opencode/package.json`
<!-- TASK:T-2.1.2 -->
- **T-2.1.2** (Refs #1): Create `.opencode/plugins/communication.ts`. Implement an event listener for `session.idle` and `session.error` that reads `demonlord.config.json` to assign the correct Discord persona (name/avatar) and posts a summary. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-2.1.3 -->
- **T-2.1.3** (Refs #1): Implement lightweight inbound `/slash` command parsing (e.g., `/approve`, `/park`, `/handoff`) that utilizes the OpenCode SDK (`client.session.prompt()`) to unpause or redirect sessions. Touch points: `.opencode/plugins/communication.ts`

### SUBPHASE-2.2: GitHub Automation
<!-- SUBPHASE:2.2 -->
**Goal:** Automate project board movement based on agent labels.
**Entry criteria:** None.
**Exit criteria / QA checklist:**
- [ ] Valid GitHub Action YAML exists.
**Proposed PR title:** chore: add github kanban automation
**Proposed commit message:** chore: implement label-based github project board routing (Refs #1)

**Tasks:**
<!-- TASK:T-2.2.1 -->
- **T-2.2.1** (Refs #1): Create `.github/workflows/project-board.yml` to trigger on `issues: [labeled]` and move cards to respective columns. Touch points: `.github/workflows/project-board.yml`

---

## PHASE-3: Matchmaker & Worktree Isolation
<!-- PHASE:3 -->
**Goal:** Implement the dual-mode semantic routing tool and build the worktree spawning script.

### SUBPHASE-3.1: Worktree Infrastructure
<!-- SUBPHASE:3.1 -->
**Goal:** Create scripts for headless isolation.
**Entry criteria:** None.
**Exit criteria / QA checklist:**
- [ ] Script successfully executes `git worktree add`.
**Proposed PR title:** feat: add git worktree provisioning
**Proposed commit message:** feat: implement spawn_worktree script for agent isolation (Refs #1)

**Tasks:**
<!-- TASK:T-3.1.1 -->
- **T-3.1.1** (Refs #1): Create `/agents/tools/spawn_worktree.sh` (or TS equivalent) taking a task ID to run `git worktree add ../worktrees/task-<id>`. Touch points: `/agents/tools/spawn_worktree.sh`

### SUBPHASE-3.2: The Dual-Mode Matchmaker
<!-- SUBPHASE:3.2 -->
**Goal:** Build the tool that maps tasks to Agent Skills without requiring a Python vector DB.
**Entry criteria:** PHASE-1 complete.
**Exit criteria / QA checklist:**
- [ ] `SKILL.md` files are properly formatted.
- [ ] `route_task.ts` successfully parses skills and returns an ID.
**Proposed PR title:** feat: implement dual-mode semantic matchmaker
**Proposed commit message:** feat: add route_task tool and structured agent skills (Refs #1)

**Tasks:**
<!-- TASK:T-3.2.1 -->
- **T-3.2.1** (Refs #1): Create foundational specialized skills following OpenCode constraints. Create `.opencode/skills/frontend-specialist/SKILL.md` and `.opencode/skills/backend-specialist/SKILL.md` with detailed descriptions. Touch points: `.opencode/skills/*/SKILL.md`
<!-- TASK:T-3.2.2 -->
- **T-3.2.2** (Refs #1): Create `.opencode/tools/matchmaker.ts`. Implement "Mode 1" (LLM Routing) that reads all `SKILL.md` files and uses the OpenCode SDK to ask an LLM which skill best fits a given task description. Touch points: `.opencode/tools/matchmaker.ts`
<!-- TASK:T-3.2.3 -->
- **T-3.2.3** (Refs #1): Define the declarative state machine by creating `.opencode/pipelines.yml` to orchestrate the flow from Triage -> Implementation -> Review. Touch points: `.opencode/pipelines.yml`

---

## PHASE-4: Deterministic Quality Gates
<!-- PHASE:4 -->
**Goal:** Strip implementation agents of raw git capabilities and force all code through the `submit_implementation.ts` quality gate.

### SUBPHASE-4.1: The Black Box Gate
<!-- SUBPHASE:4.1 -->
**Goal:** Build a custom tool that enforces linting and testing.
**Entry criteria:** PHASE-1 complete.
**Exit criteria / QA checklist:**
- [ ] Tool uses Zod for input validation.
- [ ] Failed tests return stderr to the agent; passed tests result in a Git commit.
**Proposed PR title:** feat: implement deterministic quality gate
**Proposed commit message:** feat: add submit_implementation tool enforcing lint and test passes (Refs #1)

**Tasks:**
<!-- TASK:T-4.1.1 -->
- **T-4.1.1** (Refs #1): Create `.opencode/tools/submit_implementation.ts` using `@opencode-ai/plugin` and Zod for the schema (requiring a valid commit message). Touch points: `.opencode/tools/submit_implementation.ts`
<!-- TASK:T-4.1.2 -->
- **T-4.1.2** (Refs #1): Implement execution logic inside the tool to run `npm run lint` and `npm run test` using Bun shell (`$`). Catch non-zero exit codes and return the stack trace. If successful, execute the atomic `git commit` and `push`. Touch points: `.opencode/tools/submit_implementation.ts`

---

## PHASE-5: End-to-End Validation & v1.0 Release
<!-- PHASE:5 -->
**Goal:** Run a complete lifecycle test on a dummy issue, finalize project documentation, and release the template.

### SUBPHASE-5.1: Documentation & Final Polish
<!-- SUBPHASE:5.1 -->
**Goal:** Prepare the repository for public consumption as a template.
**Entry criteria:** Phases 1-4 complete.
**Exit criteria / QA checklist:**
- [ ] `README.md` clearly explains the `npm install` bootstrap process.
**Proposed PR title:** docs: finalize v1 template documentation
**Proposed commit message:** docs: add bootstrap instructions and env examples for v1 release (Refs #1)

**Tasks:**
<!-- TASK:T-5.1.1 -->
- **T-5.1.1** (Refs #1): Create `.env.example` containing placeholders for Discord webhook URLs, Bot Tokens, and required MCP API keys. Touch points: `.env.example`
<!-- TASK:T-5.1.2 -->
- **T-5.1.2** (Refs #1): Write the final `README.md` and `USAGE.md`, explaining how a user injects Demonlord into their repository and the required bootstrap step (`cd .opencode && npm install`). Touch points: `README.md`, `USAGE.md`
<!-- TASK:T-5.1.3 -->
- **T-5.1.3** (Refs #1): Create a generic `package.json` at the repository root with dummy `npm run lint` and `npm run test` scripts that simply `exit 0`, so the quality gate works out-of-the-box before the user adds real code. Touch points: `package.json`

### SUBPHASE-5.2: Validation Pipeline
<!-- SUBPHASE:5.2 -->
**Goal:** Execute the full lifecycle and tag the release.
**Entry criteria:** SUBPHASE-5.1 complete.
**Exit criteria / QA checklist:**
- [ ] End-to-end task flows successfully from `/triage` to PR creation.
**Proposed PR title:** release: demonlord v1.0.0
**Proposed commit message:** release: finalize end-to-end validation and tag v1.0.0 (Refs #1)

**Tasks:**
<!-- TASK:T-5.2.1 -->
- **T-5.2.1** (Refs #1): Execute the full Triage -> Implement -> Review pipeline on a dummy "Hello World" task to verify worktree spawning and the deterministic quality gate. (Manual Execution Task).
<!-- TASK:T-5.2.2 -->
- **T-5.2.2** (Refs #1): Clean up any test branches/worktrees, tag the repository as a GitHub Template, and draft the `v1.0.0` GitHub Release notes. (Manual Execution Task).