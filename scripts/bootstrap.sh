#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${DEMONLORD_BIN_DIR:-$HOME/.local/bin}"
TARGET="$ROOT_DIR/agents/tools/pipelinectl.sh"
OPENCODE_DIR="$ROOT_DIR/.opencode"
CONFIG_FILE="$ROOT_DIR/demonlord.config.json"
CONFIG_TEMPLATE="$ROOT_DIR/.opencode/templates/demonlord.config.default.json"

DRY_RUN=0
SKIP_DEPENDENCY_INSTALL=0

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [options]

Prepare local Demonlord runtime dependencies and command shims.

Options:
  --dry-run              Print planned actions without changes.
  --skip-deps            Skip npm install for .opencode dependencies.
  -h, --help             Show this help message.
EOF
}

run_cmd() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run]'
    for part in "$@"; do
      printf ' %q' "$part"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

write_minimum_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    printf 'Found existing %s\n' "$CONFIG_FILE"
    return 0
  fi

  printf 'No demonlord.config.json found. Creating minimum defaults...\n'

  if [[ -f "$CONFIG_TEMPLATE" ]]; then
    run_cmd cp "$CONFIG_TEMPLATE" "$CONFIG_FILE"
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run] write minimum config at %s\n' "$CONFIG_FILE"
    return 0
  fi

  cat > "$CONFIG_FILE" <<'EOF'
{
  "worktrees": {
    "directory": "../worktrees",
    "prefix": "task-",
    "approval_required": true,
    "agent_approval": {
      "minion": true,
      "reviewer": false
    }
  },
  "orchestration": {
    "enabled": true,
    "mode": "manual",
    "require_approval_before_spawn": true,
    "ignore_aborted_messages": true,
    "pipeline_command_short_circuit": "no_reply",
    "verbose_events": true
  },
  "discord": {
    "enabled": true,
    "personas": {
      "planner": {
        "name": "Planner",
        "avatarUrl": ""
      },
      "orchestrator": {
        "name": "Orchestrator",
        "avatarUrl": ""
      },
      "minion": {
        "name": "Minion",
        "avatarUrl": ""
      },
      "reviewer": {
        "name": "Reviewer",
        "avatarUrl": ""
      }
    }
  }
}
EOF
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    printf '%s\n' "$install_hint" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-deps)
      SKIP_DEPENDENCY_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

printf '[1/4] Validating bootstrap prerequisites...\n'
require_command bash "Install Bash before running bootstrap."

if [[ ! -f "$OPENCODE_DIR/package.json" ]]; then
  printf 'Could not find %s/package.json\n' "$OPENCODE_DIR" >&2
  printf 'Run this script from a repository root containing the Demonlord template.\n' >&2
  exit 1
fi

printf '[2/4] Ensuring minimum config defaults...\n'
write_minimum_config

if [[ $SKIP_DEPENDENCY_INSTALL -eq 1 ]]; then
  printf '[3/4] Skipping .opencode dependency install (--skip-deps).\n'
else
  printf '[3/4] Installing .opencode dependencies...\n'
  require_command node "Install Node.js (v18+) before running bootstrap."
  require_command npm "Install npm (bundled with Node.js) before running bootstrap."
  run_cmd npm --prefix "$OPENCODE_DIR" install
fi

if [[ ! -x "$TARGET" ]]; then
  run_cmd chmod +x "$TARGET"
fi

printf '[4/4] Installing pipeline control shims...\n'
run_cmd mkdir -p "$INSTALL_DIR"
run_cmd ln -sfn "$TARGET" "$INSTALL_DIR/pipelinectl"
run_cmd ln -sfn "$TARGET" "$INSTALL_DIR/piplinectl"

printf 'Installed pipelinectl at %s\n' "$INSTALL_DIR/pipelinectl"
printf 'Installed piplinectl compatibility alias at %s\n' "$INSTALL_DIR/piplinectl"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    printf 'PATH already includes %s\n' "$INSTALL_DIR"
    ;;
  *)
    printf 'Add this to your shell profile, then restart shell:\n'
    printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

printf 'Bootstrap complete.\n'
printf 'Next steps:\n'
printf '  1) Start OpenCode: opencode\n'
printf '  2) Verify controls: pipelinectl status\n'
