# Agentic Execution Tasklist: Demonlord (Beelzebub)

## How to execute

Run `/implement beelzebub` to start this tasklist.  
Execution policy for this codename:
- One **SUBPHASE per PR**
- One **COMMIT per SUBPHASE** (if multiple commits are unavoidable, PR must include `SUBPHASE_PROVENANCE` marker with `multi_commit_rationale`)
- Complete all entry/exit criteria before moving to the next subphase
- Keep references to issue Refs #123 intact in commit/PR metadata

## Cycle decision lock (must be implemented as written)

- Inbound Discord command authorization is required in this cycle and must fail closed for unauthorized callers.
- Post-install verification must be available both as `scripts/verify-demonlord.sh` and installer `--verify`.
- Dedupe retention policy is in-memory TTL for this cycle (`10m`), non-persisted.
- Session targeting policy is fixed: explicit `session_id` first, single-candidate auto-target, ambiguity fail-closed.
- Retry policy constants are fixed: `max_attempts=3`, backoff intervals `0ms, 250ms, 1000ms`, no jitter.
- Verification entrypoint for this cycle is `npm run verify:beelzebub` (introduced in SUBPHASE-1.1 and reused in release gates).

---

## PHASE-1: Discord Command Center Completion
<!-- PHASE:1 -->
**Goal:** Complete deterministic Discord outbound + inbound command-center functionality with safety and reliability guarantees.  
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->`
**Phase closeout gate:** [ ] PHASE-1 closed by /phreview

### SUBPHASE-1.1: Contract-First Discord/Test Harness
<!-- SUBPHASE:1.1 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.1 -->`  
**Entry criteria:**
- Existing `.opencode` tests pass on current branch.
- No live-network dependency in test runtime.
**Exit criteria / QA checklist:**
- [x] Deterministic Discord harness utilities exist for outbound/inbound/retry/dedupe scenarios.
- [x] New tests run offline and deterministically.
- [x] Canonical Discord command/event contract fixtures are defined and versioned.
- [x] Test scripts include dedicated Discord/hardening verification target and the canonical `verify:beelzebub` entrypoint.
**Proposed PR title:** `test: add deterministic discord command-center harness`  
**Proposed commit message:** `test: add deterministic discord harness and fixtures for command-center hardening (Refs #123)`

**Tasks:**
<!-- TASK:T-1.1.1 -->
- [x] **T-1.1.1** (Refs #123): Create shared Discord test harness utilities (mock sender, mock inbound interaction envelope, deterministic timer/backoff helpers). Touch points: `.opencode/tests/harness/`
<!-- TASK:T-1.1.2 -->
- [x] **T-1.1.2** (Refs #123): Add reusable orchestration/session fixture builders for multi-session targeting tests. Touch points: `.opencode/tests/harness/`, `.opencode/tests/integration/`
<!-- TASK:T-1.1.3 -->
- [x] **T-1.1.3** (Refs #123): Add dedicated scripts for Discord and round verification (e.g., `test:discord`, `verify:beelzebub`). Touch points: `.opencode/package.json`
<!-- TASK:T-1.1.4 -->
- [x] **T-1.1.4** (Refs #123): Add tests enforcing "no live network" behavior and deterministic retry timing outcomes. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`
<!-- TASK:T-1.1.5 -->
- [x] **T-1.1.5** (Refs #123): Add versioned contract fixtures for outbound event payloads and inbound command envelopes. Touch points: `.opencode/tests/harness/`, `doc/engineering_spec.md`

### SUBPHASE-1.2: Outbound Discord Delivery
<!-- SUBPHASE:1.2 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.2 -->`  
**Entry criteria:**
- SUBPHASE-1.1 complete.
**Exit criteria / QA checklist:**
- [x] Real Discord send path implemented (no no-op placeholder behavior).
- [x] Deterministic payload mapping exists for locked event families: `session.idle`, `session.error`, approval/transition, completion/failure summary.
- [x] Payload includes persona/worktree/session context.
- [x] Dedupe/idempotency coverage exists for repeated events (fixed ordering to prevent suppression on failure).
**Proposed PR title:** `feat: implement deterministic outbound discord delivery`  
**Proposed commit message:** `feat: add real discord outbound notifications for critical orchestration events (Refs #123)`

**Tasks:**
<!-- TASK:T-1.2.1 -->
- [x] **T-1.2.1** (Refs #123): Implement outbound Discord transport adapter with explicit success/failure return semantics. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.2 -->
- [x] **T-1.2.2** (Refs #123): Map and emit deterministic payloads for `session.idle`, `session.error`, approval/transition events, completion/failure summaries. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.3 -->
- [x] **T-1.2.3** (Refs #123): Include persona/worktree/session metadata fields in all outbound payload builders. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.4 -->
- [x] **T-1.2.4** (Refs #123): Implement dedupe/idempotency policy for repeated outbound event emissions. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.5 -->
- [x] **T-1.2.5** (Refs #123): Add unit/integration tests for payload contract, dedupe behavior, and send failure surfacing. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`
<!-- TASK:T-1.2.6 -->
- [x] **T-1.2.6** (Refs #123): Enforce a strict outbound event allowlist and fail-safe behavior for unmapped events. Touch points: `.opencode/plugins/communication.ts`, `.opencode/tests/plugins/`

### SUBPHASE-1.3: Inbound Discord Control Routing
<!-- SUBPHASE:1.3 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.3 -->`  
**Entry criteria:**
- SUBPHASE-1.2 complete.
**Exit criteria / QA checklist:**
- [x] `/approve`, `/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export` are routed deterministically.
- [x] Multi-session targeting rules are deterministic and fail-closed on ambiguity.
- [x] Duplicate inbound command handling is idempotent.
- [x] Unsupported/legacy commands fail deterministically with migration guidance.
**Proposed PR title:** `feat: add deterministic inbound discord control routing`  
**Proposed commit message:** `feat: route discord control commands to target opencode sessions deterministically (Refs #123)`

**Tasks:**
<!-- TASK:T-1.3.1 -->
- [x] **T-1.3.1** (Refs #123): Implement inbound command parsing/dispatch for required Discord commands. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.2 -->
- [x] **T-1.3.2** (Refs #123): Define and implement session targeting policy: explicit target first, single-candidate auto-target, ambiguity fail-closed with actionable message. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.3 -->
- [x] **T-1.3.3** (Refs #123): Route `/approve` through pipeline command path and Party Mode commands through `party_mode` flow with deterministic argument handling. Touch points: `.opencode/plugins/communication.ts`, `.opencode/tools/party_mode.ts`
<!-- TASK:T-1.3.4 -->
- [x] **T-1.3.4** (Refs #123): Add inbound interaction dedupe/idempotency guard keyed by command/session/interaction token. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.5 -->
- [x] **T-1.3.5** (Refs #123): Add integration tests for multi-session routing, ambiguity error path, and duplicate suppression. Touch points: `.opencode/tests/integration/`, `.opencode/tests/plugins/`
<!-- TASK:T-1.3.6 -->
- [x] **T-1.3.6** (Refs #123): Add deterministic handling for unsupported legacy commands with actionable migration text. Touch points: `.opencode/plugins/communication.ts`, `USAGE.md`

### SUBPHASE-1.4: Reliability, Safety, Config, and Docs
<!-- SUBPHASE:1.4 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.4 -->`  
**Entry criteria:**
- SUBPHASE-1.2 and SUBPHASE-1.3 complete.
**Exit criteria / QA checklist:**
- [x] Retry/backoff policy is explicit, bounded, deterministic, and tested (`max_attempts=3`, `0ms/250ms/1000ms`, no jitter).
- [x] Startup validation fails fast for missing Discord config/env requirements.
- [x] Secrets are redacted from logs and error surfaces.
- [x] Inbound command authorization is enforced via allowlisted user/role/channel rules.
- [x] Discord config schema keys are explicit in config template + `.env.example`.
- [x] Operator docs include setup, permissions, failure modes, and verification steps.
**Proposed PR title:** `fix: harden discord reliability safety and operator docs`  
**Proposed commit message:** `fix: add bounded retry startup validation and operator docs for discord command center (Refs #123)`

**Tasks:**
<!-- TASK:T-1.4.1 -->
- [x] **T-1.4.1** (Refs #123): Implement deterministic bounded retry/backoff and terminal failure reporting for outbound send and inbound handling errors. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.4.2 -->
- [x] **T-1.4.2** (Refs #123): Add fail-fast startup validation for required Discord env/config keys. Touch points: `.opencode/plugins/communication.ts`, `demonlord.config.json`
<!-- TASK:T-1.4.3 -->
- [x] **T-1.4.3** (Refs #123): Add secret-redaction utility and enforce no token/webhook leakage in logs. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.4.4 -->
- [x] **T-1.4.4** (Refs #123): Extend explicit Discord config keys in `demonlord.config.json`, `.opencode/templates/demonlord.config.default.json`, and `.env.example`. Touch points: `demonlord.config.json`, `.opencode/templates/demonlord.config.default.json`, `.env.example`
<!-- TASK:T-1.4.5 -->
- [x] **T-1.4.5** (Refs #123): Update operator docs for Discord setup, permissions, failure modes, and verification. Touch points: `README.md`, `USAGE.md`, `doc/engineering_spec.md`, `doc/engineering_reference.md`
<!-- TASK:T-1.4.6 -->
- [x] **T-1.4.6** (Refs #123): Add deterministic tests for retry exhaustion, startup validation failure, redaction, and error surfacing. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`
<!-- TASK:T-1.4.7 -->
- [x] **T-1.4.7** (Refs #123): Implement inbound command authorization (allowed user IDs, role IDs, optional channel ID) with deterministic deny responses and tests. Touch points: `.opencode/plugins/communication.ts`, `demonlord.config.json`, `.opencode/templates/demonlord.config.default.json`, `.opencode/tests/plugins/`, `.opencode/tests/integration/`

### SUBPHASE-1.5: Unified Review Runner + Phase Closeout Gate
<!-- SUBPHASE:1.5 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.5 -->`  
**Entry criteria:**
- SUBPHASE-1.4 complete.
- Existing `/creview` and `/mreview` command contracts remain unchanged.
**Exit criteria / QA checklist:**
- [x] `/run-review` deterministically executes review commands and persists machine-readable artifacts under `_bmad-output/cycle-state/reviews/`.
- [x] Artifact naming is deterministic and versioned (`round-<n>`), including `creview`, `mreview`, and `phreview` outputs.
- [x] Module review artifacts include phase attribution using explicit phase override or deterministic tasklist/artifact fallback.
- [x] `/run-review` supports optional extra hint text and `dry-run` preview mode.
- [x] `/phreview` validates entire phase scope from persisted review artifacts, enforces fail-fast gate rules, and marks phase closeout state in tasklist on pass.
- [x] Docs and tests are updated for the new review-runner contract.
**Proposed PR title:** `feat: add deterministic run-review tooling and phase closeout gate`  
**Proposed commit message:** `feat: add run-review artifact persistence and phreview phase-closeout workflow (Refs #123)`

**Tasks:**
<!-- TASK:T-1.5.1 -->
- [x] **T-1.5.1** (Refs #123): Implement `.opencode/tools/run_review.ts` to execute any `*review` command via SDK, parse cycle marker output, persist versioned review artifacts, and return structured summaries. Touch points: `.opencode/tools/run_review.ts`
<!-- TASK:T-1.5.2 -->
- [x] **T-1.5.2** (Refs #123): Add `/run-review` command contract with positional review parameters, optional hint, optional phase override, and `dry-run` behavior routed through the new tool. Touch points: `.opencode/commands/run-review.md`
<!-- TASK:T-1.5.3 -->
- [x] **T-1.5.3** (Refs #123): Add `/phreview` command contract for phase-scoped gate review using persisted artifacts, fail-fast criteria, and deterministic `CYCLE_PHREVIEW_RESULT` output marker. Touch points: `.opencode/commands/phreview.md`
<!-- TASK:T-1.5.4 -->
- [x] **T-1.5.4** (Refs #123): Add deterministic tool tests for marker parsing, artifact round versioning, module phase inference fallback, and dry-run non-mutation behavior. Touch points: `.opencode/tests/tools/run_review.test.ts`
<!-- TASK:T-1.5.5 -->
- [x] **T-1.5.5** (Refs #123): Update user/operator docs with `/run-review` and `/phreview` usage plus persisted review artifact conventions. Touch points: `README.md`, `USAGE.md`, `doc/engineering_spec.md`, `doc/engineering_reference.md`
<!-- TASK:T-1.5.6 -->
- [x] **T-1.5.6** (Refs #123): Scan forward tasklist phases and add integration notes where review execution should route through `/run-review` (especially future cycle/orchestrator refactors removing REST dependence). Touch points: `/agents/beelzebub_Tasklist.md`, `.opencode/commands/cycle.md`, `doc/engineering_spec.md`
<!-- TASK:T-1.5.7 -->
- [x] **T-1.5.7** (Refs #123): Add deterministic `/run-review` command interception in plugin pre-hook (`command.execute.before`) so execution does not depend on agent prompt interpretation. Route through the shared review executor and short-circuit LLM reply path. Touch points: `.opencode/plugins/orchestrator.ts`, `.opencode/tools/run_review.ts`
<!-- TASK:T-1.5.8 -->
- [x] **T-1.5.8** (Refs #123): Update `/run-review` command contract docs to state plugin-handled deterministic control-plane routing (no agent-instruction dependency) while preserving existing direct review command contracts. Touch points: `.opencode/commands/run-review.md`
<!-- TASK:T-1.5.9 -->
- [x] **T-1.5.9** (Refs #123): Add integration coverage proving `/run-review` is pre-hook handled, bypasses agent reasoning turn, and persists deterministic review artifacts. Touch points: `.opencode/tests/integration/orchestration-flow.test.ts`, `.opencode/tests/tools/run_review.test.ts`
<!-- TASK:T-1.5.10 -->
- [x] **T-1.5.10** (Refs #123): Add compatibility tests confirming direct `/creview`, `/mreview`, and `/phreview` remain callable and are not blocked by the deterministic `/run-review` routing path. Touch points: `.opencode/tests/integration/orchestration-flow.test.ts`, `.opencode/tests/integration/`
<!-- TASK:T-1.5.11 -->
- [x] **T-1.5.11** (Refs #123): Update docs again with routing guidance for deterministic `/run-review`, retained direct `/creview` `/mreview` `/phreview` usage, and artifact persistence expectations. Touch points: `README.md`, `USAGE.md`, `doc/engineering_spec.md`, `doc/engineering_reference.md`

---

## PHASE-2: Installer + Bootstrap Hardening
<!-- PHASE:2 -->
**Goal:** Deliver deterministic, idempotent, rollback-aware installer/bootstrap behavior across source modes with complete failure-matrix coverage.  
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->`

### SUBPHASE-2.1: Dry-Run Fidelity + Preflight
<!-- SUBPHASE:2.1 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.1 -->`  
**Entry criteria:**
- PHASE-1 complete.
**Exit criteria / QA checklist:**
- [x] Dry-run validates all managed assets/paths for both local and remote source modes.
- [x] Preflight checks fail early with actionable messages for tools/permissions/path safety/source validity.
**Proposed PR title:** `fix: add fail-fast installer preflight and full dry-run validation`  
**Proposed commit message:** `fix: enforce complete installer preflight and dry-run fidelity checks (Refs #123)`

**Tasks:**
<!-- TASK:T-2.1.1 -->
- [x] **T-2.1.1** (Refs #123): Implement consolidated preflight validator for required tools, target git repo, path safety, and source validity. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.2 -->
- [x] **T-2.1.2** (Refs #123): Extend dry-run to validate all required managed directories/files and planned actions without mutation. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.3 -->
- [x] **T-2.1.3** (Refs #123): Ensure dry-run remote mode validates source reachability and required asset manifest deterministically. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.4 -->
- [x] **T-2.1.4** (Refs #123): Add focused integration tests for missing assets and invalid remote source preflight errors (full matrix remains SUBPHASE-2.4). Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`

### SUBPHASE-2.2: Deterministic Apply + Rollback Semantics
<!-- SUBPHASE:2.2 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.2 -->`  
**Entry criteria:**
- SUBPHASE-2.1 complete.
**Exit criteria / QA checklist:**
- [x] Preserve/backup/replace policy is explicit and documented.
- [x] Partial apply failures trigger rollback-aware behavior.
- [x] Exit code mapping is deterministic and actionable.
**Proposed PR title:** `feat: make installer apply transactional and rollback-aware`  
**Proposed commit message:** `feat: add deterministic installer apply rollback semantics and explicit exit codes (Refs #123)`

**Tasks:**
<!-- TASK:T-2.2.1 -->
- [x] **T-2.2.1** (Refs #123): Define and implement explicit managed-asset policy (preserve/backup/replace) with manifest guarantees. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.2.2 -->
- [x] **T-2.2.2** (Refs #123): Add rollback-aware apply flow for partial failure conditions with deterministic recovery output. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.2.3 -->
- [x] **T-2.2.3** (Refs #123): Introduce deterministic exit code taxonomy and standardized actionable error messages. Touch points: `scripts/install-demonlord.sh`, `README.md`, `USAGE.md`
<!-- TASK:T-2.2.4 -->
- [x] **T-2.2.4** (Refs #123): Add focused tests for permission denied and partial failure + rollback behavior (full matrix remains SUBPHASE-2.4). Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`

### SUBPHASE-2.3: Source Modes + Post-Install Verification
<!-- SUBPHASE:2.3 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.3 -->`  
**Entry criteria:**
- SUBPHASE-2.2 complete.
**Exit criteria / QA checklist:**
- [ ] Local and remote source modes behave robustly and consistently.
- [ ] Deterministic post-install smoke checks are exposed both as `scripts/verify-demonlord.sh` and installer `--verify`.
- [ ] Bootstrap remains idempotent and production-safe on reruns.
**Proposed PR title:** `feat: add deterministic post-install verification and source-mode hardening`  
**Proposed commit message:** `feat: harden installer source modes and add deterministic post-install smoke checks (Refs #123)`

**Tasks:**
<!-- TASK:T-2.3.1 -->
- **T-2.3.1** (Refs #123): Harden source mode control flow and diagnostics for local path and remote git source. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.3.2 -->
- **T-2.3.2** (Refs #123): Add deterministic post-install verification as both `scripts/verify-demonlord.sh` and installer `--verify` for “ready to use” checks with aligned exit semantics. Touch points: `scripts/verify-demonlord.sh`, `scripts/install-demonlord.sh`
<!-- TASK:T-2.3.3 -->
- **T-2.3.3** (Refs #123): Harden bootstrap preflight and rerun-idempotency guarantees. Touch points: `scripts/bootstrap.sh`
<!-- TASK:T-2.3.4 -->
- **T-2.3.4** (Refs #123): Document source modes, verification steps, and expected outputs. Touch points: `README.md`, `USAGE.md`

### SUBPHASE-2.4: Installer Failure-Matrix Tests
<!-- SUBPHASE:2.4 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.4 -->`  
**Entry criteria:**
- SUBPHASE-2.1 through SUBPHASE-2.3 complete.
**Exit criteria / QA checklist:**
- [ ] Automated deterministic tests cover all required success/failure paths.
- [ ] Repeat install on same target proves idempotent behavior.
- [ ] Rollback-only and backup-integrity failure paths are covered deterministically.
- [ ] No test requires live network dependencies.
**Proposed PR title:** `test: add installer hardening failure-matrix regression coverage`  
**Proposed commit message:** `test: validate installer deterministic failure matrix and rerun idempotency (Refs #123)`

**Tasks:**
<!-- TASK:T-2.4.1 -->
- **T-2.4.1** (Refs #123): Add integration test for missing assets failure path with actionable errors. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`
<!-- TASK:T-2.4.2 -->
- **T-2.4.2** (Refs #123): Add integration test for invalid remote source path and deterministic exit behavior. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`
<!-- TASK:T-2.4.3 -->
- **T-2.4.3** (Refs #123): Add integration test for permission denied during install/apply/backup flow. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`
<!-- TASK:T-2.4.4 -->
- **T-2.4.4** (Refs #123): Add integration test for partial failure with rollback/recovery assertions. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`
<!-- TASK:T-2.4.5 -->
- **T-2.4.5** (Refs #123): Add integration test for repeat install on same target to verify idempotent deterministic outcome. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`
<!-- TASK:T-2.4.6 -->
- **T-2.4.6** (Refs #123): Add integration tests for rollback-only behavior and missing/corrupted backup manifest handling. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`

---

## PHASE-3: Release Readiness ("Usable Now")
<!-- PHASE:3 -->
**Goal:** Enforce strict exit gates, rapid manual QA, and explicit go/no-go criteria for first real-project adoption.  
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:3 -->`

### SUBPHASE-3.1: Exit Gates + QA + Go/No-Go Criteria
<!-- SUBPHASE:3.1 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:3 -->` + `<!-- SUBPHASE:3.1 -->`  
**Entry criteria:**
- PHASE-1 and PHASE-2 complete with passing tests.
**Exit criteria / QA checklist:**
- [ ] All relevant automated tests pass.
- [ ] Setup and operator docs are complete and current.
- [ ] No placeholder implementation remains in Discord or installer critical paths.
- [ ] Install + first-run validation is reproducible.
- [ ] Manual QA checklist completes in <15 minutes.
- [ ] Explicit go/no-go criteria documented for real-project adoption.
**Proposed PR title:** `docs: define usable-now release gates and adoption checklist`  
**Proposed commit message:** `docs: add strict release gates manual qa checklist and go-no-go criteria (Refs #123)`

**Tasks:**
<!-- TASK:T-3.1.1 -->
- **T-3.1.1** (Refs #123): Wire strict automated gate list behind `npm run verify:beelzebub` and document it as the single deterministic entrypoint. Touch points: `.opencode/package.json`, `README.md`, `USAGE.md`
<!-- TASK:T-3.1.2 -->
- **T-3.1.2** (Refs #123): Add concise <15-minute manual QA checklist with expected outputs and failure interpretation. Touch points: `README.md`, `USAGE.md`
<!-- TASK:T-3.1.3 -->
- **T-3.1.3** (Refs #123): Document explicit go/no-go criteria for first client-repo adoption. Touch points: `README.md`, `doc/engineering_spec.md`
<!-- TASK:T-3.1.4 -->
- **T-3.1.4** (Refs #123): Add final regression test pass evidence requirements for Discord command center + installer hardening matrix. Touch points: `doc/releases/`, `README.md`

---

## PHASE-4: Internal Cycle Orchestration (Plugin-Native)
<!-- PHASE:4 -->
**Goal:** Move cycle execution into orchestrator plugin control flow to remove external SDK server dependency while preserving deterministic implement-review-repair behavior.  
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:4 -->`

### SUBPHASE-4.1: Pipeline Command Surface + Persisted Cycle State
<!-- SUBPHASE:4.1 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:4 -->` + `<!-- SUBPHASE:4.1 -->`  
**Entry criteria:**
- PHASE-3 complete.
**Exit criteria / QA checklist:**
- [ ] Pipeline control plane includes deterministic cycle actions (`start`, `status`, `resume`, `stop`).
- [ ] Cycle state persists atomically in orchestration state files and survives restart.
- [ ] Cycle command semantics are explicit and fail closed on invalid phase/subphase targets.
**Proposed PR title:** `feat: add plugin-native cycle control surface and persisted state`  
**Proposed commit message:** `feat: add orchestrator-native cycle command surface and durable cycle state (Refs #123)`

**Tasks:**
<!-- TASK:T-4.1.1 -->
- **T-4.1.1** (Refs #123): Extend orchestrator state schema with cycle metadata (phase, current subphase, repair round counters, stop reason) and atomic persistence. Touch points: `.opencode/plugins/orchestrator.ts`
<!-- TASK:T-4.1.2 -->
- **T-4.1.2** (Refs #123): Add deterministic `/pipeline cycle` action parsing and validation (`start|status|resume|stop`). Touch points: `.opencode/plugins/orchestrator.ts`, `.opencode/commands/pipeline.md`
<!-- TASK:T-4.1.3 -->
- **T-4.1.3** (Refs #123): Add focused tests for invalid selectors, restart/resume behavior, and stop/resume state transitions. Touch points: `.opencode/tests/plugins/orchestrator.test.ts`

### SUBPHASE-4.2: Deterministic Implement-Review-Repair Loop Integration
<!-- SUBPHASE:4.2 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:4 -->` + `<!-- SUBPHASE:4.2 -->`  
**Entry criteria:**
- SUBPHASE-4.1 complete.
**Exit criteria / QA checklist:**
- [ ] Plugin-native loop executes in-order per subphase: implement -> review -> repair -> review.
- [ ] Review remains read-only and cannot mutate implementation artifacts.
- [ ] Bounded repair rounds are enforced with deterministic stop reason on exhaustion.
- [ ] Subphase advancement only occurs on review `pass`.
**Proposed PR title:** `feat: integrate bounded cycle loop into orchestrator plugin`  
**Proposed commit message:** `feat: implement plugin-native bounded implement-review-repair cycle loop (Refs #123)`

**Tasks:**
<!-- TASK:T-4.2.1 -->
- **T-4.2.1** (Refs #123): Wire cycle loop transitions into orchestrator stage handling using existing manual-gate controls and task traversal metadata, routing review execution through the shared `/run-review` path. Touch points: `.opencode/plugins/orchestrator.ts`, `.opencode/tools/run_review.ts`, `.opencode/commands/run-review.md`
<!-- TASK:T-4.2.2 -->
- **T-4.2.2** (Refs #123): Enforce strict loop stop conditions (max repair rounds, malformed review marker/artifact, blocked implementation). Touch points: `.opencode/plugins/orchestrator.ts`
<!-- TASK:T-4.2.3 -->
- **T-4.2.3** (Refs #123): Add deterministic tests for pass path, fail-repair-pass path, and round-exhaustion failure path, including review artifact persistence through `/run-review`. Touch points: `.opencode/tests/plugins/orchestrator.test.ts`, `.opencode/tests/tools/run_review.test.ts`

### SUBPHASE-4.3: Migration, Compatibility, and Verification
<!-- SUBPHASE:4.3 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:4 -->` + `<!-- SUBPHASE:4.3 -->`  
**Entry criteria:**
- SUBPHASE-4.1 and SUBPHASE-4.2 complete.
**Exit criteria / QA checklist:**
- [ ] `/cycle` operator behavior remains backward-compatible (or explicit migration guidance is documented).
- [ ] Documentation clearly states server-dependent vs plugin-native cycle paths and recommended default.
- [ ] Verification includes deterministic parity checks between legacy and plugin-native cycle outcomes.
**Proposed PR title:** `docs: migrate cycle workflow to plugin-native orchestration path`  
**Proposed commit message:** `docs: document cycle migration and validate plugin-native parity behavior (Refs #123)`

**Tasks:**
<!-- TASK:T-4.3.1 -->
- **T-4.3.1** (Refs #123): Update command docs and operator runbooks for plugin-native cycle usage and fallback behavior. Touch points: `.opencode/commands/cycle.md`, `README.md`, `USAGE.md`
<!-- TASK:T-4.3.2 -->
- **T-4.3.2** (Refs #123): Add regression checks proving parity between existing cycle runner and plugin-native cycle for a representative phase. Touch points: `.opencode/tests/integration/`, `doc/releases/`
<!-- TASK:T-4.3.3 -->
- **T-4.3.3** (Refs #123): Define deprecation guardrails/timeline for any superseded cycle command path if migration is complete. Touch points: `README.md`, `doc/engineering_spec.md`
