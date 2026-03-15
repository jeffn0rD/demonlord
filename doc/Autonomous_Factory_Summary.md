# Demonlord V1 Summary

Demonlord V1 is a manual-first but automation-assisted OpenCode framework that installs into a target repository and supports a controlled phase-scoped development loop.

## Core Loop

The near-term workflow is:

`/plan -> /implement -> /creview -> /repair -> /phreview`

This loop is the primary product promise. It must work directly and predictably before broader orchestration is added.

## What V1 Is

- an installable payload for target repositories
- a bounded-session workflow for planning, implementation, review, repair, and phase closeout
- a manual-first system whose commands are explicit and understandable
- a configurable agent/model framework with cost-aware implementer tiers

## What V1 Is Not

- not yet a large-scale autonomous software factory
- not dependent on Discord-driven approvals or status flows
- not dependent on parallel worktree fleets
- not dependent on hidden review interception or mandatory persisted review artifacts

## Base Agent Roles

- `planner`
- `orchestrator`
- `reviewer`
- `implementer-lite`
- `implementer-standard`
- `implementer-pro`

These roles should be configurable so users can swap models, tune cost, and add additional agents later.

## Session Model

Each workflow step should be able to run in its own fresh bounded session. Manual invocation is the near-term proving path. A thin plugin may later automate session creation from the orchestrator, but only after the direct commands are stable.

## Product Boundary

The Demonlord repository is the source for installable assets, not the operator's personal OpenCode cockpit. The operator's central `opencode-dev` environment remains separate.
