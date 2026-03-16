# Hello App Fixture

This fixture is the smallest tracked sample project for Demonlord install and smoke-test loops.

It is intentionally simple:
- one package.json
- one runtime module
- one node:test suite

Use `scripts/reset-test-sandbox.sh` to copy this fixture into a disposable sandbox before installing Demonlord there.

V1 validation loop:

1. `./scripts/reset-test-sandbox.sh --force`
2. `./scripts/smoke-test-sandbox.sh`

Run this loop after command-contract resets or installer-path changes.
