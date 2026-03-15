# Demonlord Restructure Plan

## Current reset direction

The repository is now being regrouped around a simpler V1 reboot.

The working assumptions are:

1. this repository is the Demonlord product/source repository
2. it exists to define installable assets for a target OpenCode repo
3. `opencode-dev` is the operator's separate central environment
4. the near-term goal is a bounded-session manual-first loop, not broad autonomous execution

## Preserved snapshot

The pre-reboot state was preserved on:

- `snapshot/pre-refactor-20260315`

That branch remains the forensic/archive reference point while `dev` becomes the reboot branch.

## Target operating model

- `opencode-dev/`: central operator cockpit
- `demonlord/`: install-source product repo
- `test-sandbox/`: disposable live test target

## V1 product direction

The V1 loop is:

`/plan -> /implement -> /creview -> /repair -> /phreview`

This loop must be proven manually first, with each step bounded enough to run in a fresh session. Only after that should a thin plugin be added to create those sessions automatically.

## Install-source direction

Near-term:

- this repository still contains source assets in the current layout
- the installer materializes `.opencode` into the target repository
- the hello-app fixture and resettable sandbox prove the install path cheaply

Later:

- the source repository may move to a more explicit payload-oriented layout for install assets
- that layout change should happen after the command and session contracts are stable

## Current proving loop

Reset the sandbox from the tracked fixture:

```bash
./scripts/reset-test-sandbox.sh --force
```

Run the smoke-test installer loop:

```bash
./scripts/smoke-test-sandbox.sh
```

## Immediate next execution path

Use `agents/V1_Reboot_Tasklist.md` as the active work queue on `dev`.
Use `doc/v1_reboot_plan.md` as the complete execution roadmap.

Highest-priority next steps:

1. retire broken `/cycle` and `/run-review` paths from the active workflow
2. define `/plan` as the planning entrypoint
3. simplify the direct command loop around `/implement`, `/creview`, `/repair`, and `/phreview`
4. define explicit agent/model-tier configuration for V1
