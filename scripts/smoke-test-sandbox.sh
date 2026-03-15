#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_SANDBOX_DIR="$ROOT_DIR/fixtures-sandbox/hello-app"

SANDBOX_DIR="$DEFAULT_SANDBOX_DIR"

usage() {
  cat <<'EOF'
Usage: smoke-test-sandbox.sh [options]

Run a minimal install verification against the disposable hello-app sandbox.

Options:
  --sandbox <path>   Override sandbox path.
  -h, --help         Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox)
      [[ $# -ge 2 ]] || {
        printf 'Missing value for --sandbox\n' >&2
        exit 1
      }
      SANDBOX_DIR="$2"
      shift 2
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

if [[ ! -d "$SANDBOX_DIR" ]]; then
  printf 'Sandbox directory not found: %s\n' "$SANDBOX_DIR" >&2
  printf 'Run scripts/reset-test-sandbox.sh first.\n' >&2
  exit 1
fi

printf '[1/4] Installing fixture dependencies...\n'
npm --prefix "$SANDBOX_DIR" install

printf '[2/4] Running fixture tests before install...\n'
npm --prefix "$SANDBOX_DIR" test

printf '[3/4] Installing Demonlord into sandbox...\n'
"$ROOT_DIR/scripts/install-demonlord.sh" --source "$ROOT_DIR" --target "$SANDBOX_DIR"

printf '[4/4] Verifying injected assets...\n'
[[ -d "$SANDBOX_DIR/.opencode" ]]
[[ -d "$SANDBOX_DIR/agents" ]]
[[ -f "$SANDBOX_DIR/demonlord.config.json" ]]

printf 'Smoke test complete for %s\n' "$SANDBOX_DIR"
