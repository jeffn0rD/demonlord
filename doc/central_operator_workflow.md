# Central Operator Workflow

This repository now separates three concerns:

1. `demonlord/` source and installable assets
2. `opencode-dev/` as the operator's reusable OpenCode environment
3. a disposable test sandbox rebuilt from a tracked fixture

## Recommended workspace layout

```text
~/workspace/
  opencode-dev/
  demonlord/
  test-sandbox/
```

The `opencode-dev/` directory is not the Demonlord product. It is your durable operator cockpit where you keep reusable commands, tools, skills, notes, and scripts under your own version control and backup strategy.

## How to work day to day

- Open `demonlord/` in VS Code when editing Demonlord source.
- Run OpenCode from `opencode-dev/` when you want a central operator environment.
- Still run OpenCode from `demonlord/` when repo-local work is simpler.
- Keep Demonlord-specific assets in this repository.
- Keep reusable operator assets in `opencode-dev/`.

## Test fixture and sandbox model

Tracked fixture:
- `fixtures/hello-app/`

Disposable sandbox:
- default local path `fixtures-sandbox/hello-app/` for quick local testing
- or a custom path outside the repo via `scripts/reset-test-sandbox.sh --sandbox /path/to/test-sandbox`

Reset and test loop:

```bash
./scripts/reset-test-sandbox.sh --force
./scripts/smoke-test-sandbox.sh
```

That loop verifies a simple install path against a low-cost sample project.

## Ownership rules

Put assets in `opencode-dev/` when they are reusable across multiple repositories:
- generic commands
- generic skills
- reusable tools
- operator notes and scripts

Put assets in `demonlord/` when they define Demonlord itself:
- install scripts
- project-specific commands and tools
- templates and fixtures required by Demonlord
- product documentation

## Preservation strategy for `opencode-dev`

Use both:
- a git repository for history and rollback
- Dropbox or another synced backup for disaster recovery

Git answers "what changed and when?". Backup answers "how do I recover if the machine or folder is lost?".
