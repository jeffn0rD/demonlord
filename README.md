# Demonlord

Demonlord is an installable OpenCode framework for a target repository. Its near-term goal is a manual-first but automation-assisted development loop that is reliable enough to prove the larger vision without depending on heavy orchestration.

## V1 Loop

The primary workflow is:

`/plan -> /implement -> /creview -> /repair -> /phreview`

This loop is phase-scoped and bounded. It must work directly before thinner orchestration automation is added on top.

## What Demonlord V1 Provides

- installable OpenCode assets for a target repository
- explicit commands whose names match the real development steps
- bounded command contracts designed to work in fresh sessions
- configurable agent roles and model tiers
- cheap validation through a resettable sample-project sandbox

## Deferred Features

- Discord integration for remote approvals, notifications, and planning operations
- Parallel pipeline/worktree execution for long-horizon development loops
- Shared `/run-review` dispatcher as an optional review abstraction after direct review commands are stable
- Large-scale autonomous operation beyond one controlled phase loop

## Quick Start

### Install Into a Target Repository

From your target repository root, run the installer and let it inject assets plus bootstrap dependencies and local shims:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-demonlord.sh | bash -s -- --source https://github.com/<owner>/<repo>.git
```

Local source example:

```bash
/path/to/demonlord/scripts/install-demonlord.sh --source /path/to/demonlord --target .
```

Preflight and recovery options:

- `--dry-run`: preview changes without writing files
- `--skip-bootstrap`: inject assets only
- `--rollback`: restore managed paths from `.demonlord-install-backup/latest`

### Installed Asset Set

The installer manages these Demonlord assets in the target repository:

- `.opencode/`
- `agents/`
- `doc/`
- `scripts/`
- `demonlord.config.json`
- `.env.example`

Payload-source contract (V1 reboot):

- Source-of-truth path for OpenCode assets in this repo is `payload/dot-opencode/`.
- Installer output path in target repositories remains `.opencode/`.
- First migration scope is intentionally narrow: only source `/.opencode` moves to `payload/dot-opencode/`.
- `agents/`, `doc/`, and `scripts/` remain in place in this first migration to minimize churn.

This repository is the product install source. The operator's personal `opencode-dev` workspace is a separate environment and is not part of the installed payload.

### Bootstrap After Install

After installation:

```bash
cd .opencode && npm install
```

Then from the target repository root:

```bash
./scripts/bootstrap.sh
```

### Configure Environment

- Copy `.env.example` to `.env`
- Add required local credentials such as `GITHUB_PAT`
- Review `demonlord.config.json`
- Adjust agent/model settings in `.opencode/opencode.jsonc` as needed

## Base Commands

Primary V1 commands:

- `/plan`
- `/implement`
- `/creview`
- `/repair`
- `/phreview`

Supporting review command:

- `/mreview`

These commands are intended to remain directly usable by a human operator. Later automation should call the same proven command contracts rather than replacing them.

## Agent Roles and Cost Control

Demonlord V1 keeps explicit agent roles and configurable model selection. The base role set is:

- `planner`
- `orchestrator`
- `reviewer`
- `implementer-lite`
- `implementer-standard`
- `implementer-pro`

This allows cheaper models to handle lower-complexity work while reserving stronger models for harder implementation steps. Users should be able to add more agents later through configuration and documented extension points.

Model/tier selection is configured in `.opencode/opencode.jsonc` and `demonlord.config.json`:

- `.opencode/opencode.jsonc`: defines each agent ID, model, and variant.
- `demonlord.config.json` -> `orchestration.agent_pools`: maps role+tier requests to preferred agent IDs in deterministic fallback order.

Extension rules:

1. Add a new agent entry under `.opencode/opencode.jsonc` with a required `description`.
2. Add that agent ID to the correct `orchestration.agent_pools` tier list in `demonlord.config.json`.
3. Keep at least one working fallback agent ID per role/tier list.

## Bounded Session Design

Each workflow step should be able to run in a fresh bounded session. Near-term validation is manual-first: operators invoke the commands directly and confirm they work with explicit file-based handoff. A thin plugin may later create those fresh sessions automatically, but only after the direct loop is proven stable.

## Validation Loop

This repository includes a cheap proving loop built around a tracked fixture project and a disposable sandbox.

Reset the sandbox:

```bash
./scripts/reset-test-sandbox.sh --force
```

Run the installer smoke test:

```bash
./scripts/smoke-test-sandbox.sh
```

The fixture lives at `fixtures/hello-app/`. The default disposable sandbox lives at `fixtures-sandbox/hello-app/` and can be recreated at any time.

Use this loop as the default proof path after command-contract resets and installer/source-layout changes.

## Documentation Map

- `doc/engineering_spec.md` - V1 architecture contract
- `doc/v1_reboot_plan.md` - complete reboot roadmap from current state to V1
- `doc/Autonomous_Factory_Summary.md` - concise V1 summary
- `doc/central_operator_workflow.md` - how `opencode-dev` fits with this repo
- `doc/restructure_plan.md` - current regrouping direction
- `doc/dev_handoff.md` - starting point when continuing from `opencode-dev`
- `doc/thin_session_launcher_follow_on.md` - Phase 5 thin automation design
- `agents/reboot_Tasklist.md` - active reboot work queue for `dev`
