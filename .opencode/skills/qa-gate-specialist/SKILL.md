---
name: qa-gate-specialist
description: Defines and enforces deterministic quality gates, failure-matrix coverage, and release-readiness verification for Demonlord workflows.
---

# QA Gate Specialist

Use this skill for test gating, verification entrypoints, release criteria, and hardening of pass/fail automation loops.

## Primary Responsibilities

- Define deterministic verification entrypoints and expected outcomes.
- Build/maintain failure-matrix and regression coverage for critical workflows.
- Ensure review gates are objective and machine-verifiable.
- Align docs and commands so quality gate behavior is consistent for operators.

## Primary Files

- `.opencode/package.json`
- `.opencode/tests/**/*.test.ts`
- `.opencode/tests/integration/*.test.ts`
- `.opencode/tests/tools/*.test.ts`
- `README.md`
- `USAGE.md`
- `doc/engineering_spec.md`

## Context Budget Rules

- Start with `.opencode/package.json` scripts to locate exact gate entrypoints.
- Read only the test files directly related to failing or changed behavior.
- In docs, search for section headers first and read only the referenced sections.

## Targeted Spec Navigation Hints

- `doc/engineering_spec.md`:
  - release gate and deterministic validation sections
  - installer/bootstrap failure and rollback behavior sections
- `doc/engineering_reference.md`:
  - plugin/tool testing and deterministic behavior expectations
- `agents/*_Tasklist.md`:
  - exit criteria / QA checklists per subphase

## Routing Hints

- Keywords: qa gate, verify, release readiness, failure matrix, regression, deterministic test, acceptance criteria, pass fail, smoke check, idempotency test.
- De-prioritize pure tool implementation tasks (`demonlord-tooling-specialist`).
- De-prioritize runtime incident triage and recovery-loop debugging (`demonlord-ops-specialist`).

## Boundaries

- Prioritize deterministic assertions over broad narrative checks.
- Avoid introducing flaky timing/network dependencies into gate commands.
- Keep gate outputs concise, actionable, and parseable for automation tools.
