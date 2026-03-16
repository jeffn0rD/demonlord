# Thin Session Launcher Follow-On

## Purpose

Design a minimal automation layer that launches proven direct V1 commands in fresh sessions without changing command contracts.

## Scope

- launch `/plan`, `/implement`, `/creview`, `/repair`, and `/phreview` in fresh sessions
- keep manual invocation as first-class and always available
- provide explicit, inspectable approval gates before each automated launch when configured

## Non-Goals

- no hidden meta-runner that rewrites command behavior
- no mandatory external daemon or long-running sidecar process
- no replacement of command-level markers, tasklists, or repo-state handoff

## Minimal Contract

1. Input: requested next command, codename, target subphase/phase, and current repository path.
2. Validation: verify required artifacts exist before launch (plan/tasklist/markers as needed).
3. Gate: if approval is enabled, emit a deterministic pending-approval event and wait.
4. Launch: spawn exactly one fresh session and run exactly one direct command.
5. Output: write a concise launch record including command, session ID, and terminal marker status.

## Inspectability Requirements

- every launch decision is logged to a plain-text or NDJSON artifact in `_bmad-output/`
- every blocked launch includes explicit reason text and missing prerequisite list
- every operator override is captured with timestamp and acting identity when available

## Safety Rules

- never chain multiple phase steps in one hidden command
- never auto-repair or auto-review without explicit command-level launch
- preserve deterministic failure states; do not silently retry across multiple commands

## Rollout Recommendation

1. keep direct manual loop as baseline
2. add launcher in dry-run/preview mode first
3. enable command-by-command launch with approval gate
4. evaluate reliability before considering any broader orchestration
