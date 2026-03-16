System Architecture Specification: Demonlord V1 Reboot

1. Product Definition

Demonlord V1 is an installable OpenCode automation layer for a target repository. It is not primarily a live self-hosted workspace. The Demonlord source repository exists to define, test, and package the assets that are installed into another OpenCode project repository.

The near-term goal is a semi-automatic, manual-first development loop that is reliable, understandable, and cheap to validate:

plan -> implement -> review -> repair -> final phase review -> push

The system must prove this loop in bounded fresh sessions before any broader orchestration ambitions are reintroduced.

2. Near-Term Scope

V1 must provide these capabilities:

* install Demonlord into a target repository using a deterministic installer
* expose explicit workflow commands whose names match the operator's mental model
* keep each workflow step bounded enough to run correctly in its own fresh session
* support explicit agent roles for planning, orchestration, implementation, and review
* support configurable model selection, including cheaper implementer tiers for low-complexity work
* allow users to extend the base system with additional agents later without rewriting core architecture

Canonical V1 command path:

* `/plan`
* `/implement`
* `/creview`
* `/repair`
* `/phreview`

Supporting review command:

* `/mreview`

3. Explicit Non-Goals for V1

The following are intentionally deferred until the bounded-session loop is stable:

* Discord integration for remote approvals, notifications, and planning operations
* Parallel pipeline/worktree execution for long-horizon development loops
* Shared `/run-review` dispatcher as an optional review abstraction after direct review commands are stable
* Large-scale autonomous operation beyond one controlled phase loop
* required persisted review artifact pipelines as a hard dependency for normal operation
* hidden plugin interception layers that alter core review behavior behind the operator's back

4. Workflow Contract

The V1 workflow is phase-scoped and manual-first.

1. `/plan`
   - reads requirements and creates or updates a bounded plan/tasklist
   - does not implement code
2. `/implement`
   - executes one bounded scope only, typically one subphase
   - runs relevant verification
   - may create one local commit
3. `/creview`
   - reviews the bounded implementation scope directly
   - produces structured findings and a machine-readable marker
4. `/repair`
   - applies fixes only for in-scope review findings
   - runs relevant verification
   - may create one local commit
5. `/phreview`
   - performs explicit final phase closeout
   - uses direct evidence and available review outputs
   - does not depend on hidden review infrastructure

The operator may repeat `/creview` and `/repair` until the review gate passes. Only then should `/phreview` be used to close the phase.

5. Bounded Session Requirement

Each workflow step must be designed to succeed in a fresh bounded session.

This means:

* each command must explicitly read its required source files and context
* commands must not rely on large accumulated chat history
* handoff between steps must happen through explicit repo state, plan/tasklist state, and machine-readable markers
* commands must end with deterministic final markers when the contract requires them

V1 does not require automatic step spawning yet. Manual command invocation is acceptable and preferred for proving the contracts. Automatic session launch may be added later through a thin plugin only after the direct commands are proven reliable.

Bounded-session command handoff contract:

* `/plan`
  - reads: requirements input, existing `agents/<codename>_Plan.md`, existing `agents/<codename>_Tasklist.md`
  - emits: updated planning/tasklist artifacts + `CYCLE_PLAN_RESULT` marker
* `/implement`
  - reads: `agents/<codename>_Plan.md`, `agents/<codename>_Tasklist.md`, selected subphase tasks/criteria
  - emits: code/doc changes for one subphase, updated task checkboxes, local commit, `CYCLE_IMPLEMENT_RESULT` marker
* `/creview`
  - reads: plan/tasklist/spec plus git diff/commits and relevant verification evidence
  - emits: structured findings/backlog + `CYCLE_CREVIEW_RESULT` marker
* `/repair`
  - reads: explicit review findings (`/creview` or `/mreview` output and optional evidence path), plan/tasklist
  - emits: bounded fixes, updated verifications, local commit, `CYCLE_REPAIR_RESULT` marker
* `/phreview`
  - reads: plan/tasklist, in-phase review outputs, git history, optional persisted artifacts
  - emits: phase gate verdict, optional closeout line update, `CYCLE_PHREVIEW_RESULT` marker

Handoff invariants:

* each command can run in a fresh session using only repo state and explicit inputs
* markers and tasklist state are the canonical cross-step handoff channel
* plugin automation must remain a thin launcher over these same read/emit contracts (never a hidden replacement)

6. Agent Roles and Model Tiers

V1 keeps explicit agent roles because they are central to Demonlord's usability and cost control.

Required base roles:

* planner
* orchestrator
* reviewer
* implementer-lite
* implementer-standard
* implementer-pro

Requirements:

* role and model selection must be explicit in configuration
* lower-cost implementers must be available for low-complexity tasks
* stronger implementers may be selected for heavier tasks
* users must be able to add agents later through configuration and documented extension points

Configuration contract:

* `.opencode/opencode.jsonc` defines agent IDs, descriptions, model IDs, and variants
* `demonlord.config.json` maps role/tier requests to ordered agent pools under `orchestration.agent_pools`
* role/tier resolution should follow deterministic first-available fallback in pool order

V1 should prefer explicit tier selection or simple task metadata over complex inferred routing.

7. Orchestration Philosophy

The orchestrator is a bounded control component, not the primary intelligence layer.

In V1 it should only be responsible for a small set of actions:

* choosing the appropriate role/tier path when needed
* launching or coordinating one bounded step at a time
* preserving minimal handoff context
* enforcing explicit approval gates when configured

The orchestrator must not become a hidden meta-runner whose failure blocks the entire development loop.

8. Review Architecture

V1 review must remain directly usable and visible.

Required review path:

* `/creview` for bounded implementation scope review
* `/mreview` for supporting module-level review
* `/phreview` for explicit phase closeout

Future direction:

* a shared `/run-review {type} ...` dispatcher may be reintroduced later as a thin explicit routing layer over direct review contracts

For V1, direct review commands are the source of truth. Phase closeout must not depend on an unstable shared review dispatcher or mandatory persisted review artifact generation.

9. Installable Payload Model

The Demonlord source repository should evolve toward a packaging model where the install payload is clearly separate from the operator's own working environment.

Near-term expectations:

* this repository contains the installable OpenCode payload, support files, installer, docs, and validation fixtures
* target repositories receive a materialized `.opencode` directory and related Demonlord files from the installer
* the operator's personal `opencode-dev` environment remains separate from this product repository

First migration lock:

* move source `/.opencode` to `payload/dot-opencode/`
* keep install target output as `.opencode/`
* keep `agents/`, `doc/`, and `scripts/` at repo root for the first migration wave

10. Validation Strategy

The proving ground for V1 is a cheap, resettable sample project.

Validation requirements:

* installer must inject Demonlord into a clean sample project predictably
* the direct manual workflow must be usable in that installed target
* docs, command contracts, and actual behavior must stay aligned

The fixture/sandbox loop is therefore part of the product definition, not just test scaffolding.

11. Recovery Direction from Current State

The previous architecture accumulated too much coupling between automation layers. Recovery should therefore favor simplification instead of compatibility.

Immediate recovery direction:

* disable or remove broken overbuilt paths from the active workflow story
* preserve useful ideas from the old architecture only when they directly support the V1 loop
* treat the previous system as reference material, not as a binding design to preserve wholesale

12. Definition of Success

Demonlord V1 is successful when:

* the repository clearly acts as an install-source product
* a target repo can install Demonlord and run the direct command loop normally
* the direct loop works manually first
* command contracts are bounded enough for fresh-session execution
* agent roles and model tiers are configurable
* review and phase closeout are reliable without hidden artifact dependencies
* a future thin orchestration plugin can be added on top of proven direct commands instead of compensating for unstable ones
