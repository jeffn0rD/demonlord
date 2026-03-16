# Demonlord V1 Reboot Tasklist

**How to execute:** Run `/implement reboot` to start the process.

---

## PHASE 1: Scope Reset and Active Path Simplification
<!-- PHASE:1 -->
*Ref: reboot_Plan.md <!-- PHASE:1 -->*

### SUBPHASE 1.1: Reset docs to the V1 story
<!-- SUBPHASE:1.1 -->
*Ref: reboot_Plan.md <!-- PHASE:1 -->*

**Entry Criteria:**
- Repository checked out on `dev`.

**Exit Criteria:**
- Top-level docs describe the same V1 scope and non-goals.

**PR Title:** `docs: reset demonlord scope to bounded-session v1 loop`
**Commit Message:** `docs: reset demonlord scope to bounded-session v1 loop`

**Tasks:**
1.  Update `README.md` so the primary workflow is `/plan -> /implement -> /creview -> /repair -> /phreview`
    <!-- TASK:T-1.1.1 --> [X]
2.  Remove or demote claims that Discord, parallel pipelines, or artifact-heavy review infrastructure are part of the current core path
    <!-- TASK:T-1.1.2 --> [X]
3.  Ensure `doc/engineering_spec.md` and `doc/Autonomous_Factory_Summary.md` align with the same V1 definition
    <!-- TASK:T-1.1.3 --> [X]
4.  Add one concise deferred-features section so future ideas remain visible without driving current architecture
    <!-- TASK:T-1.1.4 --> [X]

### SUBPHASE 1.2: Retire broken commands from the active path
<!-- SUBPHASE:1.2 -->
*Ref: reboot_Plan.md <!-- PHASE:1 -->*

**Entry Criteria:**
- Documentation updated in 1.1.

**Exit Criteria:**
- Broken automation paths cannot be triggered accidentally.
- Active docs no longer present them as required V1 behavior.

**PR Title:** `fix: retire broken cycle and run-review paths from v1 workflow`
**Commit Message:** `fix: retire broken cycle and run-review paths from v1 workflow`

**Tasks:**
1.  Disable `/cycle` with a deterministic deprecation message in `.opencode/commands/cycle.md`
    <!-- TASK:T-1.2.1 --> [X]
2.  Disable `/run-review` with a deterministic deprecation message in `.opencode/commands/run-review.md`
    <!-- TASK:T-1.2.2 --> [X]
3.  Remove any orchestrator interception path that automatically routes `/run-review` in `.opencode/plugins/orchestrator.ts`
    <!-- TASK:T-1.2.3 --> [X]
4.  Update docs so those commands are not presented as current core workflow
    <!-- TASK:T-1.2.4 --> [X]
5.  Remove or disable `cycle_runner.test.ts` and `run_review.test.ts` as they test retired tools
    <!-- TASK:T-1.2.5 --> [X]
6.  Update `orchestration-flow.test.ts` to remove `/run-review` interception tests
    <!-- TASK:T-1.2.6 --> [X]

---

## PHASE 2: Direct Command Contract Reset
<!-- PHASE:2 -->
*Ref: reboot_Plan.md <!-- PHASE:2 -->*

### SUBPHASE 2.1: Formalize `/plan`
<!-- SUBPHASE:2.1 -->
*Ref: reboot_Plan.md <!-- PHASE:2 -->*

**Entry Criteria:**
- Broken commands retired in 1.2.

**Exit Criteria:**
- `/plan` is the documented and implementable planning entrypoint for V1.

**PR Title:** `feat: define bounded planning contract for v1`
**Commit Message:** `feat: define bounded planning contract for v1`

**Tasks:**
1.  Create or rewrite the planning command contract around bounded phase/subphase planning in `.opencode/commands/plan.md`
    <!-- TASK:T-2.1.1 --> [X]
2.  Ensure planning output updates a tasklist/plan artifact without implementing code
    <!-- TASK:T-2.1.2 --> [X]
3.  Define the required final marker or artifact contract for planning handoff
    <!-- TASK:T-2.1.3 --> [X]

### SUBPHASE 2.2: Simplify `/implement`
<!-- SUBPHASE:2.2 -->
*Ref: reboot_Plan.md <!-- PHASE:2 -->*

**Entry Criteria:**
- `/plan` formalized in 2.1.

**Exit Criteria:**
- `/implement` is directly usable in the V1 loop.

**PR Title:** `fix: simplify implement command for bounded v1 loop`
**Commit Message:** `fix: simplify implement command for bounded v1 loop`

**Tasks:**
1.  Keep `/implement` bounded to one explicit subphase or the first incomplete one in `.opencode/commands/implement.md`
    <!-- TASK:T-2.2.1 --> [X]
2.  Remove dependencies on `cycle_runner`, `run_review`, or hidden meta-orchestration
    <!-- TASK:T-2.2.2 --> [X]
3.  Keep verification, tasklist update, local commit, and final marker behavior
    <!-- TASK:T-2.2.3 --> [X]
4.  Remove `cycle_runner.ts` tool file if no longer used
    <!-- TASK:T-2.2.4 --> [X]

### SUBPHASE 2.3: Simplify `/creview` and preserve `/mreview`
<!-- SUBPHASE:2.3 -->
*Ref: reboot_Plan.md <!-- PHASE:2 -->*

**Entry Criteria:**
- `/implement` simplified in 2.2.

**Exit Criteria:**
- Direct code review works without hidden infrastructure.

**PR Title:** `fix: simplify direct review commands for v1`
**Commit Message:** `fix: simplify direct review commands for v1`

**Tasks:**
1.  Keep `/creview` direct and evidence-based in `.opencode/commands/creview.md`
    <!-- TASK:T-2.3.1 --> [X]
2.  Remove dependence on shared review runner infrastructure and persisted review artifacts
    <!-- TASK:T-2.3.2 --> [X]
3.  Confirm `/mreview` remains an optional supporting review path, not a required loop step
    <!-- TASK:T-2.3.3 --> [X]
4.  Remove `run_review.ts` tool file if no longer used
    <!-- TASK:T-2.3.4 --> [X]

### SUBPHASE 2.4: Simplify `/repair` and `/phreview`
<!-- SUBPHASE:2.4 -->
*Ref: reboot_Plan.md <!-- PHASE:2 -->*

**Entry Criteria:**
- Direct review commands simplified in 2.3.

**Exit Criteria:**
- Review/repair loop and final phase closeout work without fragile artifact infrastructure.

**PR Title:** `fix: simplify repair and phase closeout flow`
**Commit Message:** `fix: simplify repair and phase closeout flow`

**Tasks:**
1.  Keep `/repair` bounded to in-scope findings and explicit review inputs in `.opencode/commands/repair.md`
    <!-- TASK:T-2.4.1 --> [X]
2.  Remove hard dependence on artifact-generated review state from `/phreview` in `.opencode/commands/phreview.md`
    <!-- TASK:T-2.4.2 --> [X]
3.  Define direct evidence hierarchy for phase closeout
    <!-- TASK:T-2.4.3 --> [X]

---

## PHASE 3: Agent and Session Architecture
<!-- PHASE:3 -->
*Ref: reboot_Plan.md <!-- PHASE:3 -->*

### SUBPHASE 3.1: Define base agent roles and configurable model tiers
<!-- SUBPHASE:3.1 -->
*Ref: reboot_Plan.md <!-- PHASE:3 -->*

**Entry Criteria:**
- Command contracts reset in Phase 2.

**Exit Criteria:**
- V1 has an explicit, documented, user-extensible agent/model contract.

**PR Title:** `feat: define v1 agent and model tier contract`
**Commit Message:** `feat: define v1 agent and model tier contract`

**Tasks:**
1.  Define planner, orchestrator, reviewer, implementer-lite, implementer-standard, and implementer-pro as the V1 base set in `.opencode/opencode.jsonc`
    <!-- TASK:T-3.1.1 --> [X]
2.  Document how model selection is configured for each role/tier
    <!-- TASK:T-3.1.2 --> [X]
3.  Ensure users can add another agent later through config and documented extension rules
    <!-- TASK:T-3.1.3 --> [X]

### SUBPHASE 3.2: Define bounded-session handoff contract
<!-- SUBPHASE:3.2 -->
*Ref: reboot_Plan.md <!-- PHASE:3 -->*

**Entry Criteria:**
- Agent roles defined in 3.1.

**Exit Criteria:**
- Bounded fresh-session execution is a documented design rule for every V1 step.

**PR Title:** `docs: define bounded-session handoff contract`
**Commit Message:** `docs: define bounded-session handoff contract`

**Tasks:**
1.  Specify what each command reads and emits so each step can run in a fresh session
    <!-- TASK:T-3.2.1 --> [X]
2.  Ensure handoff relies on explicit repo state, artifacts, and markers rather than accumulated chat context
    <!-- TASK:T-3.2.2 --> [X]
3.  Document thin-plugin automation as a later layer over the same contracts
    <!-- TASK:T-3.2.3 --> [X]

---

## PHASE 4: Install-Source Product Boundary
<!-- PHASE:4 -->
*Ref: reboot_Plan.md <!-- PHASE:4 -->*

### SUBPHASE 4.1: Define install payload contract
<!-- SUBPHASE:4.1 -->
*Ref: reboot_Plan.md <!-- PHASE:4 -->*

**Entry Criteria:**
- Handoff contract documented in 3.2.

**Exit Criteria:**
- Product boundary is documented clearly enough to guide the later layout refactor.

**PR Title:** `docs: define demonlord install payload boundary`
**Commit Message:** `docs: define demonlord install payload boundary`

**Tasks:**
1.  Document exactly which assets Demonlord installs into a target repository
    <!-- TASK:T-4.1.1 --> [X]
2.  Distinguish product payload from the operator's personal `opencode-dev` environment
    <!-- TASK:T-4.1.2 --> [X]
3.  Lock the first structural migration to `/.opencode -> payload/dot-opencode/`
    <!-- TASK:T-4.1.3 --> [X]
4.  Keep `agents/`, `doc/`, and `scripts/` in place for the first migration to avoid unnecessary churn
    <!-- TASK:T-4.1.4 --> [X]

### SUBPHASE 4.2: Validate the fixture/sandbox proving loop
<!-- SUBPHASE:4.2 -->
*Ref: reboot_Plan.md <!-- PHASE:4 -->*

**Entry Criteria:**
- Install payload contract defined in 4.1.

**Exit Criteria:**
- The sample-project proving loop is part of the documented V1 validation story.

**PR Title:** `test: align fixture sandbox with v1 validation loop`
**Commit Message:** `test: align fixture sandbox with v1 validation loop`

**Tasks:**
1.  Keep the hello-app fixture current with the installer contract
    <!-- TASK:T-4.2.1 --> [X]
2.  Ensure the resettable sandbox remains the standard cheap validation path
    <!-- TASK:T-4.2.2 --> [X]
3.  Document how the V1 loop will be validated against the sandbox after command resets
    <!-- TASK:T-4.2.3 --> [X]

### SUBPHASE 4.3: Migrate source `/.opencode` into tracked payload layout
<!-- SUBPHASE:4.3 -->
*Ref: reboot_Plan.md <!-- PHASE:4 -->*

**Entry Criteria:**
- Fixture validated in 4.2.

**Exit Criteria:**
- Source install assets live in an explicit tracked payload directory.
- The repo no longer relies on repo-root `/.opencode` as the long-term source layout.

**PR Title:** `refactor: move source opencode assets into payload layout`
**Commit Message:** `refactor: move source opencode assets into payload layout`

**Tasks:**
1.  Move source `/.opencode` into `payload/dot-opencode/`
    <!-- TASK:T-4.3.1 --> [X]
2.  Update repo references that assume source assets live at repo-root `/.opencode`
    <!-- TASK:T-4.3.2 --> [X]
3.  Preserve the installed target path as `.opencode/`
    <!-- TASK:T-4.3.3 --> [X]

### SUBPHASE 4.4: Update installer for payload-source mapping
<!-- SUBPHASE:4.4 -->
*Ref: reboot_Plan.md <!-- PHASE:4 -->*

**Entry Criteria:**
- Source layout migrated in 4.3.

**Exit Criteria:**
- Installer uses the payload source layout while target repos still receive the expected `.opencode/` directory.

**PR Title:** `fix: map payload source to installed opencode directory`
**Commit Message:** `fix: map payload source to installed opencode directory`

**Tasks:**
1.  Update `scripts/install-demonlord.sh` to source OpenCode assets from `payload/dot-opencode/`
    <!-- TASK:T-4.4.1 --> [X]
2.  Keep target install output as `.opencode/`
    <!-- TASK:T-4.4.2 --> [X]
3.  Verify backup, rollback, and bootstrap behaviors still work after the source-path change
    <!-- TASK:T-4.4.3 --> [X]

---

## PHASE 5: Thin Orchestration Follow-On
<!-- PHASE:5 -->
*Ref: reboot_Plan.md <!-- PHASE:5 -->*

### SUBPHASE 5.1: Design thin session-launch automation
<!-- SUBPHASE:5.1 -->
*Ref: reboot_Plan.md <!-- PHASE:5 -->*

**Entry Criteria:**
- Installer updated in 4.4.

**Exit Criteria:**
- Thin orchestration is designed as a follow-on layer over proven direct commands.

**PR Title:** `docs: design thin session launcher follow-on`
**Commit Message:** `docs: design thin session launcher follow-on`

**Tasks:**
1.  Design a minimal plugin/orchestrator layer that launches proven direct commands in fresh sessions
    <!-- TASK:T-5.1.1 --> [X]
2.  Keep approval-gated semi-automation explicit and inspectable
    <!-- TASK:T-5.1.2 --> [X]
3.  Avoid reintroducing a hidden meta-runner or mandatory external process architecture
    <!-- TASK:T-5.1.3 --> [X]

---

## Deferred Features
<!-- PHASE:DEFERRED -->
*Ref: reboot_Plan.md <!-- Deferred Issues -->*

- [ ] Discord integration for remote approvals, notifications, and planning operations (#136)
- [ ] Parallel pipeline/worktree execution for long-horizon development loops (#137)
- [ ] Shared `/run-review` dispatcher as an optional review abstraction after direct review commands are stable (#138)
- [ ] Large-scale autonomous operation beyond one controlled phase loop
