# Agentic Execution Tasklist: Demonlord (Beelzebub)

## How to execute

Run `/implement beelzebub` to start this tasklist.  
Execution policy for this codename:
- One **SUBPHASE per PR**
- One **COMMIT per SUBPHASE**
- Complete all entry/exit criteria before moving to the next subphase
- Keep references to issue Refs #123 intact in commit/PR metadata

---

## PHASE-1: Discord Command Center Completion
<!-- PHASE:1 -->
**Goal:** Complete deterministic Discord outbound + inbound command-center functionality with safety and reliability guarantees.  
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->`

### SUBPHASE-1.1: Contract-First Discord/Test Harness
<!-- SUBPHASE:1.1 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.1 -->`  
**Entry criteria:**
- Existing `.opencode` tests pass on current branch.
- No live-network dependency in test runtime.
**Exit criteria / QA checklist:**
- [ ] Deterministic Discord harness utilities exist for outbound/inbound/retry/dedupe scenarios.
- [ ] New tests run offline and deterministically.
- [ ] Test scripts include dedicated Discord/hardening verification target.
**Proposed PR title:** `test: add deterministic discord command-center harness`  
**Proposed commit message:** `test: add deterministic discord harness and fixtures for command-center hardening (Refs #123)`

**Tasks:**
<!-- TASK:T-1.1.1 -->
- **T-1.1.1** (Refs #123): Create shared Discord test harness utilities (mock sender, mock inbound interaction envelope, deterministic timer/backoff helpers). Touch points: `.opencode/tests/harness/`
<!-- TASK:T-1.1.2 -->
- **T-1.1.2** (Refs #123): Add reusable orchestration/session fixture builders for multi-session targeting tests. Touch points: `.opencode/tests/harness/`, `.opencode/tests/integration/`
<!-- TASK:T-1.1.3 -->
- **T-1.1.3** (Refs #123): Add dedicated scripts for Discord and round verification (e.g., `test:discord`, `verify:beelzebub`). Touch points: `.opencode/package.json`
<!-- TASK:T-1.1.4 -->
- **T-1.1.4** (Refs #123): Add tests enforcing "no live network" behavior and deterministic retry timing outcomes. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`

### SUBPHASE-1.2: Outbound Discord Delivery
<!-- SUBPHASE:1.2 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.2 -->`  
**Entry criteria:**
- SUBPHASE-1.1 complete.
**Exit criteria / QA checklist:**
- [ ] Real Discord send path implemented (no no-op placeholder behavior).
- [ ] Deterministic payload mapping exists for required event families.
- [ ] Payload includes persona/worktree/session context.
- [ ] Dedupe/idempotency coverage exists for repeated events.
**Proposed PR title:** `feat: implement deterministic outbound discord delivery`  
**Proposed commit message:** `feat: add real discord outbound notifications for critical orchestration events (Refs #123)`

**Tasks:**
<!-- TASK:T-1.2.1 -->
- **T-1.2.1** (Refs #123): Implement outbound Discord transport adapter with explicit success/failure return semantics. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.2 -->
- **T-1.2.2** (Refs #123): Map and emit deterministic payloads for `session.idle`, `session.error`, approval/transition events, completion/failure summaries. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.3 -->
- **T-1.2.3** (Refs #123): Include persona/worktree/session metadata fields in all outbound payload builders. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.4 -->
- **T-1.2.4** (Refs #123): Implement dedupe/idempotency policy for repeated outbound event emissions. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.2.5 -->
- **T-1.2.5** (Refs #123): Add unit/integration tests for payload contract, dedupe behavior, and send failure surfacing. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`

### SUBPHASE-1.3: Inbound Discord Control Routing
<!-- SUBPHASE:1.3 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.3 -->`  
**Entry criteria:**
- SUBPHASE-1.2 complete.
**Exit criteria / QA checklist:**
- [ ] `/approve`, `/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export` are routed deterministically.
- [ ] Multi-session targeting rules are deterministic and fail-closed on ambiguity.
- [ ] Duplicate inbound command handling is idempotent.
**Proposed PR title:** `feat: add deterministic inbound discord control routing`  
**Proposed commit message:** `feat: route discord control commands to target opencode sessions deterministically (Refs #123)`

**Tasks:**
<!-- TASK:T-1.3.1 -->
- **T-1.3.1** (Refs #123): Implement inbound command parsing/dispatch for required Discord commands. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.2 -->
- **T-1.3.2** (Refs #123): Define and implement session targeting policy: explicit target first, single-candidate auto-target, ambiguity fail-closed with actionable message. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.3 -->
- **T-1.3.3** (Refs #123): Route `/approve` through pipeline command path and Party Mode commands through `party_mode` flow with deterministic argument handling. Touch points: `.opencode/plugins/communication.ts`, `.opencode/tools/party_mode.ts`
<!-- TASK:T-1.3.4 -->
- **T-1.3.4** (Refs #123): Add inbound interaction dedupe/idempotency guard keyed by command/session/interaction token. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.3.5 -->
- **T-1.3.5** (Refs #123): Add integration tests for multi-session routing, ambiguity error path, and duplicate suppression. Touch points: `.opencode/tests/integration/`, `.opencode/tests/plugins/`

### SUBPHASE-1.4: Reliability, Safety, Config, and Docs
<!-- SUBPHASE:1.4 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:1 -->` + `<!-- SUBPHASE:1.4 -->`  
**Entry criteria:**
- SUBPHASE-1.2 and SUBPHASE-1.3 complete.
**Exit criteria / QA checklist:**
- [ ] Retry/backoff policy is explicit, bounded, deterministic, and tested.
- [ ] Startup validation fails fast for missing Discord config/env requirements.
- [ ] Secrets are redacted from logs and error surfaces.
- [ ] Discord config schema keys are explicit in config template + `.env.example`.
- [ ] Operator docs include setup, permissions, failure modes, and verification steps.
**Proposed PR title:** `fix: harden discord reliability safety and operator docs`  
**Proposed commit message:** `fix: add bounded retry startup validation and operator docs for discord command center (Refs #123)`

**Tasks:**
<!-- TASK:T-1.4.1 -->
- **T-1.4.1** (Refs #123): Implement deterministic bounded retry/backoff and terminal failure reporting for outbound send and inbound handling errors. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.4.2 -->
- **T-1.4.2** (Refs #123): Add fail-fast startup validation for required Discord env/config keys. Touch points: `.opencode/plugins/communication.ts`, `demonlord.config.json`
<!-- TASK:T-1.4.3 -->
- **T-1.4.3** (Refs #123): Add secret-redaction utility and enforce no token/webhook leakage in logs. Touch points: `.opencode/plugins/communication.ts`
<!-- TASK:T-1.4.4 -->
- **T-1.4.4** (Refs #123): Extend explicit Discord config keys in `demonlord.config.json`, `.opencode/templates/demonlord.config.default.json`, and `.env.example`. Touch points: `demonlord.config.json`, `.opencode/templates/demonlord.config.default.json`, `.env.example`
<!-- TASK:T-1.4.5 -->
- **T-1.4.5** (Refs #123): Update operator docs for Discord setup, permissions, failure modes, and verification. Touch points: `README.md`, `USAGE.md`, `doc/engineering_spec.md`, `doc/engineering_reference.md`
<!-- TASK:T-1.4.6 -->
- **T-1.4.6** (Refs #123): Add deterministic tests for retry exhaustion, startup validation failure, redaction, and error surfacing. Touch points: `.opencode/tests/plugins/`, `.opencode/tests/integration/`

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
- [ ] Dry-run validates all managed assets/paths for both local and remote source modes.
- [ ] Preflight checks fail early with actionable messages for tools/permissions/path safety/source validity.
**Proposed PR title:** `fix: add fail-fast installer preflight and full dry-run validation`  
**Proposed commit message:** `fix: enforce complete installer preflight and dry-run fidelity checks (Refs #123)`

**Tasks:**
<!-- TASK:T-2.1.1 -->
- **T-2.1.1** (Refs #123): Implement consolidated preflight validator for required tools, target git repo, path safety, and source validity. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.2 -->
- **T-2.1.2** (Refs #123): Extend dry-run to validate all required managed directories/files and planned actions without mutation. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.3 -->
- **T-2.1.3** (Refs #123): Ensure dry-run remote mode validates source reachability and required asset manifest deterministically. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.1.4 -->
- **T-2.1.4** (Refs #123): Add integration tests for missing assets and invalid remote source preflight errors. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`

### SUBPHASE-2.2: Deterministic Apply + Rollback Semantics
<!-- SUBPHASE:2.2 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.2 -->`  
**Entry criteria:**
- SUBPHASE-2.1 complete.
**Exit criteria / QA checklist:**
- [ ] Preserve/backup/replace policy is explicit and documented.
- [ ] Partial apply failures trigger rollback-aware behavior.
- [ ] Exit code mapping is deterministic and actionable.
**Proposed PR title:** `feat: make installer apply transactional and rollback-aware`  
**Proposed commit message:** `feat: add deterministic installer apply rollback semantics and explicit exit codes (Refs #123)`

**Tasks:**
<!-- TASK:T-2.2.1 -->
- **T-2.2.1** (Refs #123): Define and implement explicit managed-asset policy (preserve/backup/replace) with manifest guarantees. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.2.2 -->
- **T-2.2.2** (Refs #123): Add rollback-aware apply flow for partial failure conditions with deterministic recovery output. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.2.3 -->
- **T-2.2.3** (Refs #123): Introduce deterministic exit code taxonomy and standardized actionable error messages. Touch points: `scripts/install-demonlord.sh`, `README.md`, `USAGE.md`
<!-- TASK:T-2.2.4 -->
- **T-2.2.4** (Refs #123): Add tests for permission denied and partial failure + rollback behavior. Touch points: `.opencode/tests/integration/installer-bootstrap.test.ts`

### SUBPHASE-2.3: Source Modes + Post-Install Verification
<!-- SUBPHASE:2.3 -->
**Plan reference:** `/agents/beelzebub_Plan.md` `<!-- PHASE:2 -->` + `<!-- SUBPHASE:2.3 -->`  
**Entry criteria:**
- SUBPHASE-2.2 complete.
**Exit criteria / QA checklist:**
- [ ] Local and remote source modes behave robustly and consistently.
- [ ] Deterministic post-install smoke-check command(s) prove ready state.
- [ ] Bootstrap remains idempotent and production-safe on reruns.
**Proposed PR title:** `feat: add deterministic post-install verification and source-mode hardening`  
**Proposed commit message:** `feat: harden installer source modes and add deterministic post-install smoke checks (Refs #123)`

**Tasks:**
<!-- TASK:T-2.3.1 -->
- **T-2.3.1** (Refs #123): Harden source mode control flow and diagnostics for local path and remote git source. Touch points: `scripts/install-demonlord.sh`
<!-- TASK:T-2.3.2 -->
- **T-2.3.2** (Refs #123): Add deterministic post-install verification script/command set for “ready to use” checks. Touch points: `scripts/verify-demonlord.sh`, `scripts/install-demonlord.sh`
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
- **T-3.1.1** (Refs #123): Define strict automated gate list and verification command sequence (single deterministic entrypoint). Touch points: `.opencode/package.json`, `README.md`, `USAGE.md`
<!-- TASK:T-3.1.2 -->
- **T-3.1.2** (Refs #123): Add concise <15-minute manual QA checklist with expected outputs and failure interpretation. Touch points: `README.md`, `USAGE.md`
<!-- TASK:T-3.1.3 -->
- **T-3.1.3** (Refs #123): Document explicit go/no-go criteria for first client-repo adoption. Touch points: `README.md`, `doc/engineering_spec.md`
<!-- TASK:T-3.1.4 -->
- **T-3.1.4** (Refs #123): Add final regression test pass evidence requirements for Discord command center + installer hardening matrix. Touch points: `doc/releases/`, `README.md`
