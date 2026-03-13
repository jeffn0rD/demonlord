# Autonomous Software Factory (Demonlord) - Implementation Plan

## Executive Summary
This document outlines the architecture and phased implementation plan for "Demonlord," an automated, multi-agent software factory powered by OpenCode. The system enables a Lead Developer to triage, route, and execute tasks autonomously via a completely isolated Git Worktree architecture. It is designed as a highly portable, stack-agnostic template repository. Key features include a Node/TS-based dual-mode Matchmaker for semantic agent routing, deterministic quality gates (enforcing tests/linting before commits), a comprehensive Discord Command Center for two-way human-in-the-loop communication, and enhanced collaboration capabilities including Party Mode for multi-agent discussions and simplified testing strategy inspired by BMAD-METHOD. Phase-3 hardening also adds a local shell control-plane fallback (`pipelinectl`) for deterministic orchestration control when slash-command UX is constrained by upstream command hook behavior.

## Recommended Option & Alternatives
**Recommended Architecture:**
- **Agent Definitions:** Defined natively in `.opencode/opencode.jsonc` per OpenCode v1 specifications, ensuring fast load times and correct parameter application.
- **Routing (Matchmaker):** A custom dual-mode TypeScript tool (`route_task.ts`). Mode 1 uses fast LLM reasoning; Mode 2 (optional) uses lightweight Node-based embeddings (e.g., `voy-search` or `sqlite-vss`) for true semantic query-key matching without heavy Python dependencies.
- **Quality Gates:** A custom TypeScript tool (`submit_implementation.ts`) combined with OpenCode's native Permission Matrix (`bash: {"git push": "deny"}`) to enforce deterministic testing and linting prior to any code being pushed to the remote.
- **Isolation:** `git worktree` via a custom shell script to spawn headless minion sessions in sibling directories, preventing file-locking.
- **Command & Control:** A lightweight Discord bot built on the OpenCode SDK for two-way communication and `/slash` command orchestration (e.g., `/approve`, `/park`, `/handoff`, `/party`).
- **Enhanced Collaboration:** Party Mode for multi-agent collaborative sessions with round-based discussion and user control via Discord slash commands.
- **Simplified Testing:** Lightweight test generation integrated into Minion workflow with automatic framework detection and auto-fix capabilities.
- **Project Context Management:** `project-context.md` files in each worktree to ensure consistent agent behavior across sessions.

**Alternatives Considered:**
- *Python `txtai` MCP Server (Rejected):* Adds heavy ML dependencies and complicates the bootstrap process of what should be a simple Node/TS template.
- *Markdown files in `.agents/` for Agent definitions (Rejected):* Conflicts with OpenCode's native configuration architecture.
- *LLM Orchestrator scripts (Rejected):* Prone to infinite loops. Replaced with declarative state machines.

---

# Phase Breakdown

## PHASE 1: Factory Foundation & Configuration
<!-- PHASE:1 -->
**Goal:** Establish the core OpenCode configuration, initialize the global permission matrix, and define the base agent personas natively.
- **Included Issues:** Refs #1
- **Dependencies:** None.
- **Risks:** Misconfiguration of the Permission Matrix could inadvertently block necessary read/write tools.

## PHASE 2: The Command Center (Discord & GitHub)
<!-- PHASE:2 -->
**Goal:** Connect the software factory to a Discord bot for two-way communication, implement orchestration slash commands (including Party Mode controls), and automate the GitHub Kanban board.
- **Included Issues:** Refs #1
- **Dependencies:** Phase 1 completion, Discord Bot Token available in `.env`.
- **Risks:** Network timeouts or rate limits from the Discord API if event hooks fire too rapidly during complex session loops.
- **Enhancements:** 
  - Add `/party` command for initiating multi-agent collaborative sessions
  - Implement user control commands (`/continue`, `/halt`, `/focus`, `/add-agent`, `/export`)
  - Support round-based discussion management with user intervention points
- **Enhancements:** 
  - Add `/party` command for initiating multi-agent collaborative sessions
  - Implement user control commands (`/continue`, `/halt`, `/focus`, `/add-agent`, `/export`)
  - Support round-based discussion management with user intervention points

## PHASE 3: Matchmaker, Worktree Isolation & Event Orchestration Hardening
<!-- PHASE:3 -->
**Goal:** Implement deterministic routing/worktree orchestration and harden the pipeline with explicit state persistence, manual-first controls, approval gates, resilient error handling, and a local shell fallback control plane.
- **Included Issues:** Refs #1
- **Dependencies:** Phase 1 completion.
- **Risks:** 
  - LLM routing (Mode 1) may occasionally hallucinate incorrect skill IDs if the `SKILL.md` descriptions are not highly specific. **Mitigation**: Implement strict validation that skill names must exactly match directory names and use regex validation for naming conventions.
  - Plugin event handling requires careful error boundaries to prevent cascade failures. **Mitigation**: Implement try-catch blocks with proper logging and graceful degradation to primary agent mode.
  - Stage inference from session metadata/title text can cause misrouted transitions. **Mitigation**: Persist explicit pipeline state keyed by root session and require deterministic transition checks.
  - Auto-progress behavior can be noisy during testing (aborts, throwaway prompts). **Mitigation**: Default to config-driven manual mode and suppress non-fatal aborted-message recovery prompts.
  - Current OpenCode command hooks may still route slash commands through an LLM request path. **Mitigation**: Add a deterministic shell control-plane fallback (`!pipelinectl ...`) backed by plugin-managed state and command queue files.
  - Worktree creation may fail due to disk space or Git permission issues. **Mitigation**: Pre-validate disk space and Git permissions before attempting worktree creation, with clear error messages and cleanup procedures.
- **Enhancements:**
  - Implement `project-context.md` generation and loading for consistent agent behavior
  - Support Party Mode agent coordination within shared worktrees
  - Add `/pipeline` operational controls (`status`, `advance`, `stop`, `off`) for first-class session tree visibility and explicit stage transitions
  - Add local shell-based `pipelinectl` controls (`status`, `advance`, `approve`, `stop`, `off`, `on`) that operate via deterministic state sync
  - Expose session/worktree shell context through plugin-managed environment variables for fast operator workflows during active agent execution
  - Add config-driven spawn approvals with local command fallback so orchestration remains usable without Discord

## PHASE 4: Deterministic Quality Gates
<!-- PHASE:4 -->
**Goal:** Strip implementation agents of raw git capabilities and force all code through the `submit_implementation.ts` quality gate, enhanced with simplified testing strategy.
- **Included Issues:** Refs #1
- **Dependencies:** Phase 1 completion.
- **Risks:** The generic plugin must be able to gracefully capture and format shell error outputs (stdout/stderr) from various testing frameworks to feed back to the LLM.
- **Enhancements:**
  - Integrate lightweight test generation inspired by BMAD's Quinn approach
  - Add automatic test framework detection from package.json
  - Implement API and E2E test generation with semantic locators
  - Include auto-fix loop for test failures before quality gate submission
- **Enhancements:**
  - Integrate lightweight test generation inspired by BMAD's Quinn approach
  - Add automatic test framework detection from package.json
  - Implement API and E2E test generation with semantic locators
  - Include auto-fix loop for test failures before quality gate submission

## PHASE 5: End-to-End Validation & v1.0 Release
<!-- PHASE:5 -->
**Goal:** Run a complete lifecycle test on a dummy issue, finalize project documentation, and release the template.
- **Included Issues:** Refs #1
- **Dependencies:** Phases 1-4 completion.
- **Risks:** The template must cleanly bootstrap on a fresh machine simply by running `npm install` within the `.opencode` directory.

---

## Deferred Issues
- Complex multi-repository spanning tasks (deferred to V2 to prioritize intra-repo stability first).
- Automated deployment to staging directly from agent output (deferred pending QA maturity and CI/CD integration).
- Advanced Party Mode features like voice integration or video conferencing (deferred to focus on core text-based collaboration first).

## Open Questions
- Should the `voy-search` vector database file be committed to the repository, or strictly generated on-the-fly during a bootstrap step?
- What is the optimal context pruning strategy for the Discord bot to prevent massive message payloads on long-running sessions?

## Pre-Implementation Checklist
**Environment Validation Requirements:**
- Node.js v18+ and Bun runtime available
- Git v2.30+ with worktree support
- Minimum 2GB available disk space for worktree creation
- Network connectivity for npm dependency installation

**Dependency Management Strategy:**
- All critical dependencies (discord.js, voy-search, @opencode-ai/plugin) must be version-pinned
- Bootstrap validation: `cd .opencode && npm install` must complete in <60 seconds on standard hardware
- Security audit required for all external dependencies before inclusion

**Success Metrics by Phase:**
- Phase 1: Configuration loads without errors, all agents appear in command list
- Phase 2: Discord messages send/receive correctly, GitHub actions trigger on label changes, Party Mode commands function properly
- Phase 3: Matchmaker correctly routes 95%+ of test cases, worktree creation succeeds 100% of time, project-context.md loaded consistently
- Phase 4: Quality gates catch 100% of lint/test failures, no bypass possible, test generation succeeds >90% of time
- Phase 5: End-to-end workflow completes within 5 minutes for simple "Hello World" task

**Testing Strategy:**
- Unit tests required for all custom tools (matchmaker.ts, submit_implementation.ts, party_mode.ts)
- Integration tests for plugin event handling and Discord communication
- End-to-end validation using automated dummy issue processing
- Error handling verification for all failure scenarios (network timeouts, disk full, invalid configs)
- Party Mode round-based discussion validation
- Test generation and auto-fix loop verification

## Pre-Implementation Checklist
**Environment Validation Requirements:**
- Node.js v18+ and Bun runtime available
- Git v2.30+ with worktree support
- Minimum 2GB available disk space for worktree creation
- Network connectivity for npm dependency installation

**Dependency Management Strategy:**
- All critical dependencies (discord.js, voy-search, @opencode-ai/plugin) must be version-pinned
- Bootstrap validation: `cd .opencode && npm install` must complete in <60 seconds on standard hardware
- Security audit required for all external dependencies before inclusion

**Success Metrics by Phase:**
- Phase 1: Configuration loads without errors, all agents appear in command list
- Phase 2: Discord messages send/receive correctly, GitHub actions trigger on label changes, Party Mode commands function properly
- Phase 3: Matchmaker correctly routes 95%+ of test cases, worktree creation succeeds 100% of time, project-context.md loaded consistently
- Phase 4: Quality gates catch 100% of lint/test failures, no bypass possible, test generation succeeds >90% of time
- Phase 5: End-to-end workflow completes within 5 minutes for simple "Hello World" task

**Testing Strategy:**
- Unit tests required for all custom tools (matchmaker.ts, submit_implementation.ts, party_mode.ts)
- Integration tests for plugin event handling and Discord communication
- End-to-end validation using automated dummy issue processing
- Error handling verification for all failure scenarios (network timeouts, disk full, invalid configs)
- Party Mode round-based discussion validation
- Test generation and auto-fix loop verification
