# Dev Handoff

This document is the starting handoff for continuing the Demonlord V1 reboot from `opencode-dev`.

Primary roadmap:

- `doc/v1_reboot_plan.md`

## Current branch intent

- active branch: `dev`
- reboot goal: simplify Demonlord into an installable, bounded-session, manual-first V1
- archive reference: `snapshot/pre-refactor-20260315`

## North-star documents

Read these first:

1. `README.md`
2. `doc/engineering_spec.md`
3. `doc/v1_reboot_plan.md`
4. `doc/Autonomous_Factory_Summary.md`
5. `doc/restructure_plan.md`
6. `agents/V1_Reboot_Tasklist.md`

## V1 workflow

Canonical loop:

`/plan -> /implement -> /creview -> /repair -> /phreview`

Supporting command:

`/mreview`

Near-term rule:

- commands must work manually first
- each step must be bounded enough for a fresh session
- thin plugin automation comes later

## Current architectural stance

- Demonlord repo = install-source product repo
- target repo = where `.opencode` is installed and OpenCode is run normally
- `opencode-dev` = operator cockpit for ongoing development
- fixture/sandbox loop = cheap proof harness

## Validation loop

Reset sandbox:

```bash
./scripts/reset-test-sandbox.sh --force
```

Run smoke test:

```bash
./scripts/smoke-test-sandbox.sh
```

## Immediate next tasks

Start from `agents/V1_Reboot_Tasklist.md`:

1. `SUBPHASE 1.2` retire `/cycle` and `/run-review`
2. `SUBPHASE 2.1` formalize `/plan`
3. `SUBPHASE 2.2` simplify `/implement`
4. `SUBPHASE 2.3` simplify `/creview` while keeping `/mreview` optional
5. `SUBPHASE 2.4` simplify `/repair` and `/phreview`

Then continue with the structural migration captured in `doc/v1_reboot_plan.md` and Phase 4 of `agents/V1_Reboot_Tasklist.md`.

## Important design rules

- prefer direct visible commands over hidden orchestration
- keep review infrastructure out of the critical path unless proven stable
- keep agent/model selection explicit and configurable
- defer Discord, broad autonomous loops, and parallel pipeline fleets
