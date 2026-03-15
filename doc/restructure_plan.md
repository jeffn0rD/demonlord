# Demonlord Restructure Plan

## Immediate goals

1. Preserve the current pre-refactor tree on a dedicated snapshot branch.
2. Re-establish a central `opencode-dev` operator environment outside the Demonlord repo.
3. Keep Demonlord as the source/product repository.
4. Add a tracked fixture plus resettable sandbox for low-cost live testing.

## Snapshot status

The pre-refactor working tree was preserved on branch:

- `snapshot/pre-refactor-20260315`

Push that branch to origin from a shell that permits git push:

```bash
git push -u origin snapshot/pre-refactor-20260315
```

## Target operating model

- `opencode-dev/`: central operator cockpit
- `demonlord/`: product/source repo
- `test-sandbox/`: disposable live test target

## First implementation steps

1. Create and version `opencode-dev/` separately.
2. Inventory reusable commands, tools, and skills from your other repo workflow.
3. Move only reusable operator assets into `opencode-dev/`.
4. Leave Demonlord-specific assets in this repository.
5. Use the fixture and sandbox scripts in this repo for install verification.

## Current fixture loop

Create a sandbox from the tracked fixture:

```bash
./scripts/reset-test-sandbox.sh --force
```

Run the smoke test loop:

```bash
./scripts/smoke-test-sandbox.sh
```

## Next cleanup direction

After `opencode-dev/` exists and your reusable operator assets are copied there, the next cleanup step in this repo should be to thin any repo-local `.opencode` content down to Demonlord-specific pieces only.
