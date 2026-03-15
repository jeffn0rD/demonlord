# Demonlord V1 Reboot Tasklist

Goal: reboot `dev` into a simpler, installable Demonlord V1 that proves a bounded-session manual-first development loop in target repositories.

## PHASE 1: Scope Reset and Active Path Simplification

### SUBPHASE 1.1: Reset docs to the V1 story
- [ ] Update `README.md` so the primary workflow is `/plan -> /implement -> /creview -> /repair -> /phreview`
- [ ] Remove or demote claims that Discord, parallel pipelines, or artifact-heavy review infrastructure are part of the current core path
- [ ] Ensure `doc/engineering_spec.md` and `doc/Autonomous_Factory_Summary.md` align with the same V1 definition
- [ ] Add one concise deferred-features section so future ideas remain visible without driving current architecture

Exit criteria:
- [ ] Top-level docs all describe the same V1 scope and non-goals

Proposed commit message: `docs: reset demonlord scope to bounded-session v1 loop`

### SUBPHASE 1.2: Retire broken commands from the active path
- [ ] Disable `/cycle` with a deterministic deprecation message
- [ ] Disable `/run-review` with a deterministic deprecation message
- [ ] Remove any orchestrator interception path that automatically routes `/run-review`
- [ ] Update docs so those commands are not presented as current core workflow

Exit criteria:
- [ ] Broken automation paths cannot be triggered accidentally
- [ ] Active docs no longer present them as required V1 behavior

Proposed commit message: `fix: retire broken cycle and run-review paths from v1 workflow`

## PHASE 2: Direct Command Contract Reset

### SUBPHASE 2.1: Formalize `/plan`
- [ ] Create or rewrite the planning command contract around bounded phase/subphase planning
- [ ] Ensure planning output updates a tasklist/plan artifact without implementing code
- [ ] Define the required final marker or artifact contract for planning handoff

Exit criteria:
- [ ] `/plan` is the documented and implementable planning entrypoint for V1

Proposed commit message: `feat: define bounded planning contract for v1`

### SUBPHASE 2.2: Simplify `/implement`
- [ ] Keep `/implement` bounded to one explicit subphase or the first incomplete one
- [ ] Remove dependencies on `cycle_runner`, `run_review`, or hidden meta-orchestration
- [ ] Keep verification, tasklist update, local commit, and final marker behavior

Exit criteria:
- [ ] `/implement` is directly usable in the V1 loop

Proposed commit message: `fix: simplify implement command for bounded v1 loop`

### SUBPHASE 2.3: Simplify `/creview` and preserve `/mreview`
- [ ] Keep `/creview` direct and evidence-based
- [ ] Remove dependence on shared review runner infrastructure and persisted review artifacts
- [ ] Confirm `/mreview` remains an optional supporting review path, not a required loop step

Exit criteria:
- [ ] Direct code review works without hidden infrastructure

Proposed commit message: `fix: simplify direct review commands for v1`

### SUBPHASE 2.4: Simplify `/repair` and `/phreview`
- [ ] Keep `/repair` bounded to in-scope findings and explicit review inputs
- [ ] Remove hard dependence on artifact-generated review state from `/phreview`
- [ ] Define direct evidence hierarchy for phase closeout

Exit criteria:
- [ ] Review/repair loop and final phase closeout work without fragile artifact infrastructure

Proposed commit message: `fix: simplify repair and phase closeout flow`

## PHASE 3: Agent and Session Architecture

### SUBPHASE 3.1: Define base agent roles and configurable model tiers
- [ ] Define planner, orchestrator, reviewer, implementer-lite, implementer-standard, and implementer-pro as the V1 base set
- [ ] Document how model selection is configured for each role/tier
- [ ] Ensure users can add another agent later through config and documented extension rules

Exit criteria:
- [ ] V1 has an explicit, documented, user-extensible agent/model contract

Proposed commit message: `feat: define v1 agent and model tier contract`

### SUBPHASE 3.2: Define bounded-session handoff contract
- [ ] Specify what each command reads and emits so each step can run in a fresh session
- [ ] Ensure handoff relies on explicit repo state, artifacts, and markers rather than accumulated chat context
- [ ] Document thin-plugin automation as a later layer over the same contracts

Exit criteria:
- [ ] Bounded fresh-session execution is a documented design rule for every V1 step

Proposed commit message: `docs: define bounded-session handoff contract`

## PHASE 4: Install-Source Product Boundary

### SUBPHASE 4.1: Define install payload contract
- [ ] Document exactly which assets Demonlord installs into a target repository
- [ ] Distinguish product payload from the operator's personal `opencode-dev` environment
- [ ] Lock the first structural migration to `/.opencode -> payload/dot-opencode/`
- [ ] Keep `agents/`, `doc/`, and `scripts/` in place for the first migration to avoid unnecessary churn

Exit criteria:
- [ ] Product boundary is documented clearly enough to guide the later layout refactor

Proposed commit message: `docs: define demonlord install payload boundary`

### SUBPHASE 4.2: Validate the fixture/sandbox proving loop
- [ ] Keep the hello-app fixture current with the installer contract
- [ ] Ensure the resettable sandbox remains the standard cheap validation path
- [ ] Document how the V1 loop will be validated against the sandbox after command resets

Exit criteria:
- [ ] The sample-project proving loop is part of the documented V1 validation story

Proposed commit message: `test: align fixture sandbox with v1 validation loop`

### SUBPHASE 4.3: Migrate source `/.opencode` into tracked payload layout
- [ ] Move source `/.opencode` into `payload/dot-opencode/`
- [ ] Update repo references that assume source assets live at repo-root `/.opencode`
- [ ] Preserve the installed target path as `.opencode/`

Exit criteria:
- [ ] Source install assets live in an explicit tracked payload directory
- [ ] The repo no longer relies on repo-root `/.opencode` as the long-term source layout

Proposed commit message: `refactor: move source opencode assets into payload layout`

### SUBPHASE 4.4: Update installer for payload-source mapping
- [ ] Update `scripts/install-demonlord.sh` to source OpenCode assets from `payload/dot-opencode/`
- [ ] Keep target install output as `.opencode/`
- [ ] Verify backup, rollback, and bootstrap behaviors still work after the source-path change

Exit criteria:
- [ ] Installer uses the payload source layout while target repos still receive the expected `.opencode/` directory

Proposed commit message: `fix: map payload source to installed opencode directory`

## PHASE 5: Thin Orchestration Follow-On

### SUBPHASE 5.1: Design thin session-launch automation
- [ ] Design a minimal plugin/orchestrator layer that launches proven direct commands in fresh sessions
- [ ] Keep approval-gated semi-automation explicit and inspectable
- [ ] Avoid reintroducing a hidden meta-runner or mandatory external process architecture

Exit criteria:
- [ ] Thin orchestration is designed as a follow-on layer over proven direct commands

Proposed commit message: `docs: design thin session launcher follow-on`

## Deferred Features
- [ ] Discord integration for remote approvals, notifications, and planning operations
- [ ] Parallel pipeline/worktree execution for long-horizon development loops
- [ ] Shared `/run-review` dispatcher as an optional review abstraction after direct review commands are stable
- [ ] Large-scale autonomous operation beyond one controlled phase loop
