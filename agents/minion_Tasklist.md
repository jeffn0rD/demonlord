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
- **T-1.1.1** (Refs #1): Create `.opencode/opencode.jsonc`. Define the base agents (`planner`, `orchestrator`, `minion`, `reviewer`) with appropriate `mode` (primary/subagent), model selections, and **`description` (REQUIRED)**. Note: Use singular keys (`agent`, `permission`) not plural. Touch points: `.opencode/opencode.jsonc`
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
**Goal:** Build a plugin to handle outbound webhooks and inbound slash commands with worktree visibility, including Party Mode support.
**Entry criteria:** PHASE-1 complete. `.env` file available with Discord tokens.
**Exit criteria / QA checklist:**
- [x] Plugin cleanly maps OpenCode session events to Discord webhook payloads using mapped personas.
- [x] Discord messages include worktree mapping information for agent development sessions.
- [x] Worktree creation requires approval based on `demonlord.config.json` settings.
- [x] Party Mode commands (`/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export`) are properly parsed and handled.
**Proposed PR title:** feat: implement discord command center bot with worktree visibility and party mode
**Proposed commit message:** feat: add two-way discord communication plugin with worktree tracking, approval, and party mode support (Refs #1)

**Tasks:**
<!-- TASK:T-2.1.1 -->
- **T-2.1.1** (Refs #1): Initialize `.opencode/package.json` with required dependencies (e.g., `discord.js` or generic fetch libraries). Touch points: `.opencode/package.json`
<!-- TASK:T-2.1.2 -->
- **T-2.1.2** (Refs #1): Create `.opencode/plugins/communication.ts`. Implement an event listener for `session.idle` and `session.error` that reads `demonlord.config.json` to assign the correct Discord persona (name/avatar) and posts a summary. Include worktree mapping information in messages. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-2.1.3 -->
- **T-2.1.3** (Refs #1): Implement lightweight inbound `/slash` command parsing (e.g., `/approve`, `/park`, `/handoff`, `/party`) that utilizes the OpenCode SDK (`client.session.prompt()`) to unpause or redirect sessions. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-2.1.4 -->
- **T-2.1.4** (Refs #1): Implement worktree approval gating based on `demonlord.config.json` worktree approval settings. Require approval for agents configured with `approval_required: true`. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-2.1.5 -->
- **T-2.1.5** (Refs #1): Implement Party Mode command handlers for round-based discussion control (`/continue`, `/halt`, `/focus [agent]`, `/add-agent [type]`, `/export`). Touch points: `.opencode/plugins/communication.ts`

### SUBPHASE-2.2: GitHub Automation
<!-- SUBPHASE:2.2 -->
**Goal:** Automate project board movement based on agent labels.
**Entry criteria:** None.
**Exit criteria / QA checklist:**
- [x] Valid GitHub Action YAML exists.
**Proposed PR title:** chore: add github kanban automation
**Proposed commit message:** chore: implement label-based github project board routing (Refs #1)

**Tasks:**
<!-- TASK:T-2.2.1 -->
- [x] **T-2.2.1** (Refs #1): Create `.github/workflows/project-board.yml` to trigger on `issues: [labeled]` and move cards to respective columns. Touch points: `.github/workflows/project-board.yml`

---

## PHASE-3: Matchmaker, Worktree Isolation & Event Orchestration
<!-- PHASE:3 -->
**Goal:** Implement the dual-mode semantic routing tool, build the worktree spawning script, and create the event-driven orchestration plugin.

### SUBPHASE-3.1: Worktree Infrastructure
<!-- SUBPHASE:3.1 -->
**Goal:** Create scripts for headless isolation with tracking and approval, including project context management.
**Entry criteria:** None.
**Exit criteria / QA checklist:**
- [x] Script successfully executes `git worktree add`.
- [x] Worktree creation includes agent type and purpose metadata.
- [x] Worktree tracking is maintained for cleanup and monitoring.
- [x] `project-context.md` file is created/loaded in each worktree for agent consistency.
**Proposed PR title:** feat: add git worktree provisioning with tracking and project context
**Proposed commit message:** feat: implement spawn_worktree script with agent tracking, approval support, and project context management (Refs #1)

**Tasks:**
<!-- TASK:T-3.1.1 -->
- [x] **T-3.1.1** (Refs #1): Create `/agents/tools/spawn_worktree.sh` (or TS equivalent) taking a task ID to run `git worktree add ../worktrees/task-<id>`. Touch points: `/agents/tools/spawn_worktree.sh`
<!-- TASK:T-3.1.2 -->
- [x] **T-3.1.2** (Refs #1): Create worktree tracking and cleanup mechanism. Maintain metadata about which agent is using each worktree and implement cleanup for orphaned worktrees. Touch points: `/agents/tools/worktree_manager.ts`
<!-- TASK:T-3.1.3 -->
- [x] **T-3.1.3** (Refs #1): Implement `project-context.md` generation and loading in worktrees. Create default context file and ensure agents load it before execution. Touch points: `/agents/tools/spawn_worktree.sh`, `_bmad-output/project-context.md`
<!-- TASK:T-3.1.3 -->
- [x] **T-3.1.3** (Refs #1): Implement `project-context.md` generation and loading in worktrees. Create default context file and ensure agents load it before execution. Touch points: `/agents/tools/spawn_worktree.sh`, `_bmad-output/project-context.md`

### SUBPHASE-3.2: The Dual-Mode Matchmaker
<!-- SUBPHASE:3.2 -->
**Goal:** Build the tool that maps tasks to Agent Skills without requiring a Python vector DB, including Party Mode agent coordination.
**Entry criteria:** PHASE-1 complete.
**Exit criteria / QA checklist:**
- [x] `SKILL.md` files are properly formatted with required `name` and `description` frontmatter.
- [x] `matchmaker.ts` successfully parses skills and returns an ID.
- [x] `orchestrator.ts` plugin compiles and responds to session events.
- [x] Party Mode can coordinate multiple agents in shared worktree sessions.
**Proposed PR title:** feat: implement dual-mode semantic matchmaker with party mode support
**Proposed commit message:** feat: add route_task tool, structured agent skills, and party mode coordination (Refs #1)

**Tasks:**
<!-- TASK:T-3.2.1 -->
- [x] **T-3.2.1** (Refs #1): Create foundational specialized skills following OpenCode constraints. Create `.opencode/skills/frontend-specialist/SKILL.md` and `.opencode/skills/backend-specialist/SKILL.md` with detailed descriptions. Touch points: `.opencode/skills/*/SKILL.md`
<!-- TASK:T-3.2.2 -->
- [x] **T-3.2.2** (Refs #1): Create `.opencode/tools/matchmaker.ts`. Implement "Mode 1" (LLM Routing) that reads all `SKILL.md` files and uses the OpenCode SDK to ask an LLM which skill best fits a given task description. Touch points: `.opencode/tools/matchmaker.ts`
<!-- TASK:T-3.2.3 -->
- [x] **T-3.2.3** (Refs #1): Implement event-driven orchestration by creating `.opencode/plugins/orchestrator.ts`. Use `session.idle` and `session.error` hooks to coordinate the Triage -> Implementation -> Review flow. The plugin should use the OpenCode SDK (`client.session.create()`, `client.session.prompt()`) to spawn and direct agent sessions. Touch points: `.opencode/plugins/orchestrator.ts`
<!-- TASK:T-3.2.4 -->
- [x] **T-3.2.4** (Refs #1): Create `.opencode/tools/party_mode.ts` for multi-agent collaborative session orchestration. Implement round-based discussion management and agent coordination in shared worktrees. Touch points: `.opencode/tools/party_mode.ts`

### SUBPHASE-3.3: Orchestrator Determinism & Isolated Execution Handoff
<!-- SUBPHASE:3.3 -->
**Goal:** Eliminate orchestration race conditions/loops and enforce deterministic routing plus isolated worktree spawning before implementation execution.
**Entry criteria:** SUBPHASE-3.2 complete.
**Exit criteria / QA checklist:**
- [x] Repeated `session.idle` events do not spawn duplicate child sessions.
- [x] Pipeline transitions are deterministic and idempotent (`triage` -> `implementation` -> `review`) with terminal handling for review completion.
- [x] Orchestrator performs actual Matchmaker routing (not prompt-only instructions) and records selected skill context.
- [x] Implementation sessions are created in newly provisioned isolated worktrees via `spawn_worktree.sh` (or TS equivalent).
- [x] Error-path behavior produces deterministic recovery prompts without re-trigger loops.
**Proposed PR title:** fix: harden orchestrator state machine and deterministic routing handoff
**Proposed commit message:** fix: enforce idempotent orchestration with matchmaker routing and isolated worktree execution (Refs #1)

**Tasks:**
<!-- TASK:T-3.3.1 -->
- [x] **T-3.3.1** (Refs #1): Refactor `.opencode/plugins/orchestrator.ts` to maintain explicit per-session pipeline state and transition guards, preventing duplicate child session creation on repeated idle events. Touch points: `.opencode/plugins/orchestrator.ts`
<!-- TASK:T-3.3.2 -->
- [x] **T-3.3.2** (Refs #1): Implement terminal review-stage handling that avoids self-trigger idle loops (e.g., no-reply status signaling or parent-session notification pattern). Touch points: `.opencode/plugins/orchestrator.ts`
<!-- TASK:T-3.3.3 -->
- [x] **T-3.3.3** (Refs #1): Integrate deterministic Matchmaker invocation in orchestration flow to resolve selected skill before implementation spawn; include robust fallback behavior when LLM output is invalid. Touch points: `.opencode/plugins/orchestrator.ts`, `.opencode/tools/matchmaker.ts`
<!-- TASK:T-3.3.4 -->
- [x] **T-3.3.4** (Refs #1): Wire worktree provisioning into implementation spawning so child sessions execute in task-specific isolated directories and carry traceable metadata (task ID, skill, parent session). Touch points: `.opencode/plugins/orchestrator.ts`, `agents/tools/spawn_worktree.sh`
<!-- TASK:T-3.3.5 -->
- [x] **T-3.3.5** (Refs #1): Add deterministic error recovery prompts and guard conditions for `session.error` handling to prevent recursive orchestration failures. Touch points: `.opencode/plugins/orchestrator.ts`

### SUBPHASE-3.4: Party Mode Security Hardening & State Convergence
<!-- SUBPHASE:3.4 -->
**Goal:** Eliminate path traversal/file safety risks in Party Mode and converge command handling onto a single source of truth.
**Entry criteria:** SUBPHASE-3.3 complete.
**Exit criteria / QA checklist:**
- [ ] `session_id` and export path inputs are validated/sanitized and cannot escape `context.worktree`.
- [ ] Party Mode state is unified (no split-brain between plugin in-memory state and tool persisted state).
- [ ] `/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export` act on the same deterministic state machine.
- [ ] Export behavior is deterministic and writes consistent transcript format.
- [ ] Invalid inputs return explicit, actionable errors without partial state corruption.
**Proposed PR title:** fix: secure party mode paths and unify command state handling
**Proposed commit message:** fix: harden party mode file safety and consolidate shared state orchestration (Refs #1)

**Tasks:**
<!-- TASK:T-3.4.1 -->
- **T-3.4.1** (Refs #1): Add strict validation for Party Mode identifiers/inputs (including safe `session_id` constraints) before file access. Touch points: `.opencode/tools/party_mode.ts`
<!-- TASK:T-3.4.2 -->
- **T-3.4.2** (Refs #1): Enforce path containment for exports and state files so resolved paths remain under `context.worktree`; reject traversal attempts deterministically. Touch points: `.opencode/tools/party_mode.ts`
<!-- TASK:T-3.4.3 -->
- **T-3.4.3** (Refs #1): Refactor `.opencode/plugins/communication.ts` Party Mode slash-command handlers to use unified Party Mode state/tooling instead of separate in-memory control flow. Touch points: `.opencode/plugins/communication.ts`, `.opencode/tools/party_mode.ts`
<!-- TASK:T-3.4.4 -->
- **T-3.4.4** (Refs #1): Standardize transcript export naming/content and ensure command responses reflect persisted state transitions. Touch points: `.opencode/plugins/communication.ts`, `.opencode/tools/party_mode.ts`

### SUBPHASE-3.5: Type Safety, Test Coverage & Pre-Push Verification
<!-- SUBPHASE:3.5 -->
**Goal:** Make Phase-3.2+ hardening push-ready with strict type safety, test coverage, and deterministic verification.
**Entry criteria:** SUBPHASE-3.4 complete.
**Exit criteria / QA checklist:**
- [ ] TypeScript validation for `.opencode` passes with strict settings.
- [ ] Unit tests cover Matchmaker parsing/routing, Party Mode state transitions, and path safety controls.
- [ ] Integration tests validate orchestrator lifecycle transitions and duplicate-spawn prevention.
- [ ] Error-path tests cover invalid router output, session errors, and Party Mode invalid input handling.
- [ ] Pre-push verification commands run successfully and results are documented in commit/PR notes.
**Proposed PR title:** test: add orchestration hardening coverage and type-safe pre-push gates
**Proposed commit message:** test: add tool/plugin coverage and enforce type-safe pre-push verification for phase 3 hardening (Refs #1)

**Tasks:**
<!-- TASK:T-3.5.1 -->
- **T-3.5.1** (Refs #1): Resolve `.opencode` TypeScript compatibility issues (module resolution/import typings/strictness) and ensure all new plugin/tool files typecheck cleanly. Touch points: `.opencode/tsconfig.json`, `.opencode/plugins/orchestrator.ts`, `.opencode/tools/matchmaker.ts`, `.opencode/tools/party_mode.ts`, `.opencode/plugins/communication.ts`
<!-- TASK:T-3.5.2 -->
- **T-3.5.2** (Refs #1): Create unit tests for Matchmaker skill parsing, naming validation, JSON parse fallback behavior, and deterministic heuristic fallback. Touch points: `.opencode/tests/tools/matchmaker.test.ts`
<!-- TASK:T-3.5.3 -->
- **T-3.5.3** (Refs #1): Create unit tests for Party Mode actions (`start`, `continue`, `halt`, `focus`, `add-agent`, `note`, `export`) including path traversal rejection. Touch points: `.opencode/tests/tools/party_mode.test.ts`
<!-- TASK:T-3.5.4 -->
- **T-3.5.4** (Refs #1): Add orchestrator plugin tests for idle/error lifecycle transitions, idempotency guards, and terminal stage behavior. Touch points: `.opencode/tests/plugins/orchestrator.test.ts`
<!-- TASK:T-3.5.5 -->
- **T-3.5.5** (Refs #1): Add integration-style verification for end-to-end stage transitions and no-duplicate spawn behavior under repeated idle events. Touch points: `.opencode/tests/integration/orchestration-flow.test.ts`
<!-- TASK:T-3.5.6 -->
- **T-3.5.6** (Refs #1): Execute pre-push validation suite (`typecheck`, tool/plugin tests, integration tests) and record pass/fail evidence. (Manual Execution Task). Touch points: `.opencode/package.json`, `.opencode/tests/`

---

## PHASE-4: Deterministic Quality Gates
<!-- PHASE:4 -->
**Goal:** Strip implementation agents of raw git capabilities and force all code through the `submit_implementation.ts` quality gate.

### SUBPHASE-4.1: The Black Box Gate
<!-- SUBPHASE:4.1 -->
**Goal:** Build a custom tool that enforces linting and testing, enhanced with simplified testing strategy.
**Entry criteria:** PHASE-1 complete.
**Exit criteria / QA checklist:**
- [ ] Tool uses Zod for input validation.
- [ ] Failed tests return stderr to the agent; passed tests result in a Git commit.
- [ ] Test generation and auto-fix capabilities are integrated.
**Proposed PR title:** feat: implement deterministic quality gate with simplified testing
**Proposed commit message:** feat: add submit_implementation tool enforcing lint and test passes with simplified testing strategy (Refs #1)

**Tasks:**
<!-- TASK:T-4.1.1 -->
- **T-4.1.1** (Refs #1): Create `.opencode/tools/submit_implementation.ts` using `@opencode-ai/plugin` and Zod for the schema (requiring a valid commit message). Touch points: `.opencode/tools/submit_implementation.ts`
<!-- TASK:T-4.1.2 -->
- **T-4.1.2** (Refs #1): Implement execution logic inside the tool to run `npm run lint` and `npm run test` using Bun shell (`$`). Catch non-zero exit codes and return the stack trace. If successful, execute the atomic `git commit` and `push`. Touch points: `.opencode/tools/submit_implementation.ts`
<!-- TASK:T-4.1.3 -->
- **T-4.1.3** (Refs #1): Integrate simplified test generation inspired by BMAD's Quinn approach. Add automatic test framework detection from package.json and implement API/E2E test generation with semantic locators. Touch points: `.opencode/tools/submit_implementation.ts`
<!-- TASK:T-4.1.3 -->
- **T-4.1.3** (Refs #1): Integrate simplified test generation inspired by BMAD's Quinn approach. Add automatic test framework detection from package.json and implement API/E2E test generation with semantic locators. Touch points: `.opencode/tools/submit_implementation.ts`

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
**Goal:** Execute the full lifecycle and tag the release, including Party Mode and simplified testing validation.
**Entry criteria:** SUBPHASE-5.1 complete.
**Exit criteria / QA checklist:**
- [ ] End-to-end task flows successfully from `/triage` to PR creation within 5 minutes
- [ ] All unit and integration tests pass with 95%+ coverage
- [ ] Error handling scenarios properly managed (network timeouts, disk full, invalid configs)
- [ ] Bootstrap completes in <60 seconds on standard hardware
- [ ] Party Mode round-based discussion functions correctly with user control
- [ ] Simplified test generation succeeds >90% of time with auto-fix capabilities
**Proposed PR title:** release: demonlord v1.0.0
**Proposed commit message:** release: finalize end-to-end validation including party mode and simplified testing, tag v1.0.0 (Refs #1)

**Tasks:**
<!-- TASK:T-5.2.1 -->
- **T-5.2.1** (Refs #1): Execute the full Triage -> Implement -> Review pipeline on a dummy "Hello World" task to verify worktree spawning and the deterministic quality gate. (Manual Execution Task).
<!-- TASK:T-5.2.2 -->
- **T-5.2.2** (Refs #1): Implement comprehensive test suite including unit tests for custom tools, integration tests for plugins, and end-to-end workflow validation. Touch points: `.opencode/tests/`
<!-- TASK:T-5.2.3 -->
- **T-5.2.3** (Refs #1): Validate error handling scenarios: simulate network timeouts, disk full conditions, and invalid configurations to ensure graceful degradation. Touch points: `.opencode/tests/error-handling/`
<!-- TASK:T-5.2.4 -->
- **T-5.2.4** (Refs #1): Test Party Mode functionality with multi-agent collaboration and user control via Discord commands. (Manual Execution Task).
<!-- TASK:T-5.2.5 -->
- **T-5.2.5** (Refs #1): Validate simplified test generation and auto-fix loop with various test frameworks and failure scenarios. Touch points: `.opencode/tests/testing/`
<!-- TASK:T-5.2.6 -->
- **T-5.2.6** (Refs #1): Clean up any test branches/worktrees, tag the repository as a GitHub Template, and draft the `v1.0.0` GitHub Release notes. (Manual Execution Task).
