# Demonlord (Beelzebub) - Implementation Plan

## Executive Summary

This round makes Demonlord operationally ready for real client repositories by closing two critical gaps: (1) complete Discord Command Center functionality (real outbound delivery + deterministic inbound control), and (2) production-safe installer/bootstrap hardening with deterministic dry-run, rollback-aware behavior, and repeatable post-install verification.  
The plan is structured for deterministic execution with one subphase per PR and one commit per subphase, with explicit acceptance gates and no placeholder paths in critical workflows.

## Recommended Option + Alternatives

### Recommended Option

Use a **contract-first implementation strategy** with a deterministic test harness before feature expansion:
- Build reusable offline Discord/integration harness fixtures first.
- Implement real outbound + inbound Discord behavior against strict payload/command contracts.
- Harden reliability/safety (bounded retries, fail-fast startup validation, redaction).
- Harden installer/bootstrap using fail-fast preflight + rollback-aware apply semantics.
- End with release-readiness gates and a <15-minute manual QA checklist.

### Alternatives Considered (Brief)

1. **Feature-first coding, tests afterward**  
   - Faster initial coding, but higher regression risk and weaker confidence under multi-session orchestration.
2. **Outbound-only Discord support**  
   - Simpler implementation, but fails required scope for deterministic inbound controls.
3. **Minimal installer patching only**  
   - Lower effort, but leaves operational risk in partial-failure and repeat-install scenarios.

---

## Phase Breakdown

## PHASE-1: Discord Command Center Completion
<!-- PHASE:1 -->
**Goal:** Deliver complete Discord command-center behavior with deterministic outbound notifications, inbound control routing, and robust reliability/safety controls.  
**Included Issues:** Refs #123  
**Dependencies:** Existing orchestrator pipeline state model and Party Mode state model are present.  
**Risks:** Misrouted session targeting, command duplication, noisy retries, hidden send failures, secrets leakage in logs.

### SUBPHASE-1.1: Contract-First Discord/Test Harness
<!-- SUBPHASE:1.1 -->
**Goal:** Establish deterministic, network-free harnesses for outbound payload mapping, inbound command routing, and retry/idempotency behavior.  
**Dependencies:** None (phase entry).  
**Risks:** Overly narrow fixtures can miss real-state edge conditions.

### SUBPHASE-1.2: Outbound Discord Delivery
<!-- SUBPHASE:1.2 -->
**Goal:** Implement real Discord send path (non-placeholder) for required orchestration events with persona/worktree/session context.  
**Dependencies:** SUBPHASE-1.1  
**Risks:** Event duplication, inconsistent payload structure, webhook failure handling drift.

### SUBPHASE-1.3: Inbound Discord Control Routing
<!-- SUBPHASE:1.3 -->
**Goal:** Deterministically map Discord commands to target OpenCode sessions for `/approve`, `/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export`.  
**Dependencies:** SUBPHASE-1.1, SUBPHASE-1.2  
**Risks:** Incorrect session targeting when multiple pipelines are active; non-idempotent retries.

### SUBPHASE-1.4: Reliability, Safety, Config, and Docs
<!-- SUBPHASE:1.4 -->
**Goal:** Add bounded retry/backoff, explicit startup validation, safe logging, explicit config schema keys, and operator documentation with verification and failure modes.  
**Dependencies:** SUBPHASE-1.2, SUBPHASE-1.3  
**Risks:** Misconfigured environments causing silent degradation if fail-fast is not strict.

---

## PHASE-2: Installer + Bootstrap Hardening
<!-- PHASE:2 -->
**Goal:** Make install/bootstrap deterministic, idempotent, rollback-aware, and safe across local/remote source modes with complete failure-path coverage.  
**Included Issues:** Refs #123  
**Dependencies:** Existing installer/bootstrap scripts and baseline integration tests are present.  
**Risks:** Partial installs, stale backups, weak dry-run fidelity, permission/path safety gaps.

### SUBPHASE-2.1: Dry-Run Fidelity + Preflight
<!-- SUBPHASE:2.1 -->
**Goal:** Validate all managed assets/paths and fail early with actionable diagnostics in dry-run and apply paths.  
**Dependencies:** None (phase entry).  
**Risks:** False-positive passes in dry-run leading to apply-time failures.

### SUBPHASE-2.2: Deterministic Apply + Rollback Semantics
<!-- SUBPHASE:2.2 -->
**Goal:** Explicit preserve/backup/replace policy, rollback-aware behavior on partial failure, and deterministic exit-code/error contract.  
**Dependencies:** SUBPHASE-2.1  
**Risks:** Rollback edge cases when failures occur mid-apply or during bootstrap handoff.

### SUBPHASE-2.3: Source Modes + Post-Install Verification
<!-- SUBPHASE:2.3 -->
**Goal:** Robust local/remote source installation behavior and deterministic smoke-check commands proving ready state.  
**Dependencies:** SUBPHASE-2.2  
**Risks:** Mode-specific regressions and environment-specific verification drift.

### SUBPHASE-2.4: Installer Failure-Matrix Tests
<!-- SUBPHASE:2.4 -->
**Goal:** Deterministic integration coverage for missing assets, invalid remote source, permission denied, partial failure/rollback, and repeat install idempotency.  
**Dependencies:** SUBPHASE-2.1, SUBPHASE-2.2, SUBPHASE-2.3  
**Risks:** Non-deterministic tests if external network/system state leaks into fixtures.

---

## PHASE-3: Release Readiness ("Usable Now")
<!-- PHASE:3 -->
**Goal:** Define and enforce objective go/no-go gates for first real-project adoption.  
**Included Issues:** Refs #123  
**Dependencies:** PHASE-1 and PHASE-2 complete.  
**Risks:** Documentation/test mismatch that allows ambiguous readiness decisions.

### SUBPHASE-3.1: Exit Gates + QA + Adoption Criteria
<!-- SUBPHASE:3.1 -->
**Goal:** Codify strict release gates, <15-minute manual QA checklist, and explicit go/no-go criteria for production onboarding.  
**Dependencies:** All prior subphases complete.  
**Risks:** Incomplete operator runbook or unclear failure interpretation.

---

## Deferred Issues (with reasons)

1. **Advanced Discord interaction UX (threading/embeds customization/visual polish)**  
   Deferred to keep this round focused on deterministic correctness and operational safety.
2. **Cross-repo orchestration and federation controls**  
   Deferred due to expanded coordination complexity beyond single-repo usability target.
3. **Live external E2E Discord integration tests in CI**  
   Deferred to avoid flaky external dependencies; current scope requires deterministic offline automation.
4. **Dynamic autoscaling/tier inference enhancements**  
   Deferred because V1 routing remains explicit and deterministic by task metadata and configured pools.

---

## Open Questions

1. Should inbound Discord command permissions be role-gated at plugin level (e.g., allowed user/role IDs) in this round or the next hardening round?
2. Should post-install smoke verification be a standalone script (`scripts/verify-demonlord.sh`) only, or both script + installer `--verify` flag?
3. What is the canonical retention policy for Discord delivery dedupe state (in-memory TTL vs persisted artifact)?
4. Should "session targeting ambiguity" return top N candidate sessions or require explicit `session_id` always when >1 active pipeline exists?
