# Demonlord V1 Reboot Plan

This document is the complete roadmap for regrouping `dev` into a usable Demonlord V1. It is written to stand on its own so work can continue later from `opencode-dev` without relying on prior chat context.

## 1. Starting Point

The previous Demonlord implementation accumulated too much coupling between:

- broad orchestration logic
- hidden review routing
- persisted review artifact expectations
- long-horizon automation goals
- the source repo versus the operator's own OpenCode environment

The current reboot keeps the useful ideas but resets the architecture around a smaller product that can be proven directly.

Archive reference:

- `snapshot/pre-refactor-20260315`

Active reboot branch:

- `dev`

## 2. Product Boundary

The product boundary for V1 is now explicit:

- `demonlord/` = install-source product repository
- target repository = where Demonlord is installed and OpenCode is run normally
- `opencode-dev/` = the operator's separate central cockpit

This repository is not the operator's personal long-lived OpenCode environment. It is the source package that defines what gets installed into a target repository.

## 3. V1 Product Goal

The near-term goal is a manual-first but automation-assisted development loop that works predictably and is bounded enough for fresh-session execution.

Canonical V1 workflow:

`/plan -> /implement -> /creview -> /repair -> /phreview`

Supporting command:

`/mreview`

The loop must work manually first. Thin orchestration may be added later only after the direct commands are proven stable.

## 4. Explicit V1 Non-Goals

Deferred until after the direct loop is stable:

- Discord-driven remote approval, planning, and status operations
- long-horizon autonomous execution
- parallel pipeline fleets and worktree-heavy automation as a required path
- mandatory persisted review-artifact infrastructure
- hidden plugin interception of the core direct review flow
- any architecture that requires broad external process coordination just to use the system

## 5. Base Agent and Model Direction

V1 keeps explicit agent roles and model tiers because they are central to cost control and operator trust.

Base roles:

- `planner`
- `orchestrator`
- `reviewer`
- `implementer-lite`
- `implementer-standard`
- `implementer-pro`

Requirements:

- role and model selection must be explicit in configuration
- lower-cost implementers must be available for lower-complexity work
- stronger implementers may be chosen for heavier tasks
- users must be able to add more agents later through configuration rather than framework surgery

## 6. Bounded-Session Rule

Every workflow step must be designed to work in a fresh bounded session.

That means:

- commands explicitly read required files and context
- commands do not rely on long rolling conversation state
- handoff happens through repo state, tasklists, plans, and machine-readable markers
- each command remains directly usable by a human operator

Near-term proof path:

- manual command invocation

Later follow-on:

- a thin plugin/orchestrator layer may create fresh sessions automatically using the same direct command contracts

## 7. Physical Repository Direction

This is the structural migration target that must be preserved in the plan.

Current transitional state:

- the source repository still stores installable OpenCode assets in literal repo-root `/.opencode`
- the installer copies `/.opencode` directly into the target repository

Target state:

- the source repository stores installable OpenCode assets in a clearly tracked payload directory
- recommended first target path: `payload/dot-opencode/`
- the installer maps `payload/dot-opencode/` into `.opencode/` in the target repository

Important constraint:

- the first physical migration should move only the current source `/.opencode`
- keep `agents/`, `doc/`, and `scripts/` in place initially to reduce churn
- broader payload consolidation can be revisited later after the direct loop is stable

## 8. Validation Strategy

The proving ground for V1 is a tracked cheap sample project plus a disposable sandbox.

Tracked fixture:

- `fixtures/hello-app/`

Disposable sandbox:

- default local path `fixtures-sandbox/hello-app/`

Validation loop:

```bash
./scripts/reset-test-sandbox.sh --force
./scripts/smoke-test-sandbox.sh
```

This loop verifies:

- installer behavior
- bootstrap behavior
- install-source correctness
- the basic target-repo contract

## 9. Phase-by-Phase Execution Roadmap

### Phase A: Reset the story

Goal:

- align docs and repo intent around the smaller V1

Tasks:

- rewrite the product story around the direct command loop
- mark deferred features clearly instead of treating them as active promises
- ensure docs can stand alone for continuation from `opencode-dev`

Status:

- largely in progress and partially completed

### Phase B: Retire broken active-path automation

Goal:

- prevent accidental use of broken or overbuilt paths

Tasks:

- disable `/cycle`
- disable `/run-review` as an active direct path
- remove orchestrator interception that routes `/run-review`
- remove these paths from the active V1 story

Exit condition:

- operators cannot accidentally fall into the broken meta-runner path

### Phase C: Formalize planning

Goal:

- make `/plan` the official planning entrypoint

Tasks:

- define the `/plan` contract
- ensure it updates plan/tasklist artifacts without implementing code
- define the planning handoff marker or artifact contract

Exit condition:

- planning is explicit, bounded, and part of the documented V1 loop

### Phase D: Simplify the direct command loop

Goal:

- make the primary commands directly usable without hidden infrastructure

Tasks:

- simplify `/implement`
- simplify `/creview`
- preserve `/mreview` as optional support
- simplify `/repair`
- simplify `/phreview`

Rules:

- one bounded scope at a time
- no hidden dependence on `cycle_runner`
- no hidden dependence on shared review dispatcher infrastructure
- direct evidence first

Exit condition:

- the direct manual loop is understandable and usable

### Phase E: Define agent and model configuration

Goal:

- make role/tier selection explicit and extensible

Tasks:

- define planner/orchestrator/reviewer/implementer role set
- document model/tier configuration
- document how users add another agent later

Exit condition:

- agent and model configuration is simple, explicit, and user-extensible

### Phase F: Formalize fresh-session handoff

Goal:

- design commands so they work in isolated sessions

Tasks:

- document what each command reads
- document what each command emits
- define handoff through files and markers
- document thin plugin automation as a later layer over the same contracts

Exit condition:

- each step is intentionally designed for fresh-session execution

### Phase G: Migrate source `/.opencode` into tracked payload layout

Goal:

- make the source repository clearly install-source rather than runtime-shaped

Tasks:

- move source `/.opencode` into `payload/dot-opencode/`
- keep target install path as `.opencode/`
- adjust references inside the source repo as needed
- keep broader root layout churn minimal for this first migration

Exit condition:

- the repo clearly stores installable OpenCode assets as source payload rather than pretending to be a live target repo

### Phase H: Update installer to use the payload source

Goal:

- keep target installation behavior stable while cleaning up source layout

Tasks:

- update installer asset-source logic to read from `payload/dot-opencode/`
- keep target output path `.opencode/`
- validate backup/rollback behavior still works

Exit condition:

- installer uses the new source payload path but target repos still receive the expected normal layout

### Phase I: Revalidate the proving loop

Goal:

- ensure the rebooted structure still installs and boots cleanly

Tasks:

- rerun reset/smoke-test scripts
- confirm fixture + sandbox still prove the contract cheaply
- correct docs if validation and docs drift

Exit condition:

- install-source structure and validation loop agree

### Phase J: Thin orchestration follow-on

Goal:

- add optional semi-automation only after the direct loop works

Tasks:

- design a minimal plugin/orchestrator launcher for fresh sessions
- keep approval gates explicit
- avoid reintroducing hidden meta-runner complexity

Exit condition:

- automation is layered on top of a proven manual loop instead of compensating for an unstable one

## 10. Immediate Recommended Execution Order

When continuing from `opencode-dev`, work in this order:

1. retire `/cycle` and `/run-review`
2. formalize `/plan`
3. simplify `/implement`
4. simplify `/creview`
5. simplify `/repair` and `/phreview`
6. define agent/model-tier configuration
7. define bounded-session handoff rules
8. migrate source `/.opencode` to `payload/dot-opencode/`
9. update installer mapping
10. rerun fixture/sandbox validation
11. only then design thin plugin session launching

## 11. Ready-to-Switch Condition

This reboot plan is considered sufficient for switching to `opencode-dev` when:

- the roadmap is fully captured in repo docs
- the active tasklist mirrors the execution order above
- the handoff doc points to this roadmap as the main source of truth
- continuation does not depend on recovering this chat session

That is the purpose of this document.
