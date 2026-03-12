#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: spawn_worktree.sh <task-id> [agent-type] [purpose] [parent-session-id] [skill-id]

Creates an isolated git worktree and registers metadata for monitoring.

Arguments:
  task-id     Required task identifier used in worktree naming.
  agent-type  Optional agent type metadata (default: minion).
  purpose     Optional free-text purpose metadata.
  parent-session-id Optional parent session identifier for traceability.
  skill-id    Optional selected skill identifier for traceability.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

TASK_ID="${1:-}"
if [[ -z "$TASK_ID" ]]; then
  usage >&2
  exit 1
fi

AGENT_TYPE="${2:-minion}"
PURPOSE="${3:-General task execution}"
PARENT_SESSION_ID="${4:-}"
SKILL_ID="${5:-}"

PARENT_SESSION_VALUE="${PARENT_SESSION_ID:-unknown}"
SKILL_ID_VALUE="${SKILL_ID:-unrouted}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_PATH="$REPO_ROOT/demonlord.config.json"

WORKTREE_DIRECTORY="../worktrees"
WORKTREE_PREFIX="task-"

if [[ -f "$CONFIG_PATH" ]]; then
  mapfile -t CONFIG_VALUES < <(node - "$CONFIG_PATH" <<'NODE'
const { readFileSync } = require("node:fs");

const configPath = process.argv[2];
const defaults = {
  directory: "../worktrees",
  prefix: "task-",
};

try {
  const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  const directory = parsed?.worktrees?.directory || defaults.directory;
  const prefix = parsed?.worktrees?.prefix || defaults.prefix;
  process.stdout.write(`${directory}\n${prefix}\n`);
} catch {
  process.stdout.write(`${defaults.directory}\n${defaults.prefix}\n`);
}
NODE
)

  WORKTREE_DIRECTORY="${CONFIG_VALUES[0]:-$WORKTREE_DIRECTORY}"
  WORKTREE_PREFIX="${CONFIG_VALUES[1]:-$WORKTREE_PREFIX}"
fi

SAFE_TASK_ID="$(printf '%s' "$TASK_ID" | tr ' ' '-' | tr -cd '[:alnum:]_.-')"
if [[ -z "$SAFE_TASK_ID" ]]; then
  echo "Error: task-id must include at least one alphanumeric character." >&2
  exit 1
fi

WORKTREE_BASE="$(realpath -m "$REPO_ROOT/$WORKTREE_DIRECTORY")"
WORKTREE_NAME="${WORKTREE_PREFIX}${SAFE_TASK_ID}"
WORKTREE_PATH="$WORKTREE_BASE/$WORKTREE_NAME"
BRANCH_NAME="worktree/$WORKTREE_NAME"

CONTEXT_TEMPLATE="$REPO_ROOT/_bmad-output/project-context.md"
CONTEXT_FILE="$WORKTREE_PATH/project-context.md"
REGISTRY_PATH="$REPO_ROOT/agents/tools/worktree-registry.json"
METADATA_FILE="$WORKTREE_PATH/.demonlord-worktree.json"

mkdir -p "$(dirname "$WORKTREE_PATH")"

if git -C "$REPO_ROOT" worktree list --porcelain | grep -Fq "worktree $WORKTREE_PATH"; then
  echo "Worktree already attached: $WORKTREE_PATH"
else
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
  else
    git -C "$REPO_ROOT" worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH"
  fi
fi

if [[ ! -f "$CONTEXT_TEMPLATE" ]]; then
  mkdir -p "$(dirname "$CONTEXT_TEMPLATE")"
  cat > "$CONTEXT_TEMPLATE" <<'EOF'
# Demonlord Project Context

## Mission
You are working inside an isolated git worktree for the Demonlord autonomous factory.

## Operating Rules
- Prefer deterministic, idempotent changes.
- Keep commit scopes small and traceable.
- Run local validation before handing work back.
- Respect OpenCode config constraints in `.opencode/opencode.jsonc`.

## Mandatory Startup Checklist
1. Read this file fully before making edits.
2. Review the current subphase in `agents/minion_Tasklist.md`.
3. Check `agents/minion_Plan.md` for phase context and constraints.
4. Validate with the relevant build/test commands before completion.
EOF
fi

{
  cat "$CONTEXT_TEMPLATE"
  cat <<EOF

## Worktree Session Metadata
- Task ID: $SAFE_TASK_ID
- Agent Type: $AGENT_TYPE
- Purpose: $PURPOSE
- Parent Session ID: $PARENT_SESSION_VALUE
- Skill ID: $SKILL_ID_VALUE
- Worktree Path: $WORKTREE_PATH
- Branch: $BRANCH_NAME
- Generated At: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF
} > "$CONTEXT_FILE"

cat > "$METADATA_FILE" <<EOF
{
  "taskId": "$SAFE_TASK_ID",
  "agentType": "$AGENT_TYPE",
  "purpose": "${PURPOSE//"/\\"}",
  "parentSessionID": "$PARENT_SESSION_VALUE",
  "skillID": "$SKILL_ID_VALUE",
  "worktreePath": "$WORKTREE_PATH",
  "branchName": "$BRANCH_NAME",
  "projectContext": "$CONTEXT_FILE",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

node - "$REGISTRY_PATH" "$SAFE_TASK_ID" "$AGENT_TYPE" "$PURPOSE" "$WORKTREE_PATH" "$BRANCH_NAME" "$PARENT_SESSION_VALUE" "$SKILL_ID_VALUE" <<'NODE'
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

const [registryPath, taskId, agentType, purpose, worktreePath, branchName, parentSessionID, skillID] = process.argv.slice(2);
const now = new Date().toISOString();

const emptyRegistry = {
  version: 1,
  updatedAt: now,
  worktrees: [],
};

let registry = emptyRegistry;
if (existsSync(registryPath)) {
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    if (Array.isArray(parsed.worktrees)) {
      registry = {
        version: 1,
        updatedAt: now,
        worktrees: parsed.worktrees,
      };
    }
  } catch {
    registry = emptyRegistry;
  }
}

const nextRecord = {
  taskId,
  agentType,
  purpose,
  parentSessionID,
  skillID,
  worktreePath,
  branchName,
  createdAt: now,
  updatedAt: now,
  status: "active",
};

const existingIndex = registry.worktrees.findIndex((entry) => entry.worktreePath === worktreePath);
if (existingIndex >= 0) {
  nextRecord.createdAt = registry.worktrees[existingIndex].createdAt || now;
  registry.worktrees[existingIndex] = nextRecord;
} else {
  registry.worktrees.push(nextRecord);
}

registry.updatedAt = now;
mkdirSync(dirname(registryPath), { recursive: true });
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
NODE

printf 'Created worktree: %s\n' "$WORKTREE_PATH"
printf 'Branch: %s\n' "$BRANCH_NAME"
printf 'Agent: %s\n' "$AGENT_TYPE"
printf 'Purpose: %s\n' "$PURPOSE"
printf 'Parent Session ID: %s\n' "$PARENT_SESSION_VALUE"
printf 'Skill ID: %s\n' "$SKILL_ID_VALUE"
printf 'Project context: %s\n' "$CONTEXT_FILE"
printf 'Startup requirement: read `%s` before agent execution.\n' "$CONTEXT_FILE"
