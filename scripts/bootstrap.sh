#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${DEMONLORD_BIN_DIR:-$HOME/.local/bin}"
TARGET="$ROOT_DIR/agents/tools/pipelinectl.sh"
OPENCODE_DIR="$ROOT_DIR/.opencode"

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    printf '%s\n' "$install_hint" >&2
    exit 1
  fi
}

printf '[1/3] Validating bootstrap prerequisites...\n'
require_command node "Install Node.js (v18+) before running bootstrap."
require_command npm "Install npm (bundled with Node.js) before running bootstrap."

if [[ ! -f "$OPENCODE_DIR/package.json" ]]; then
  printf 'Could not find %s/package.json\n' "$OPENCODE_DIR" >&2
  printf 'Run this script from a repository root containing the Demonlord template.\n' >&2
  exit 1
fi

printf '[2/3] Installing .opencode dependencies...\n'
npm --prefix "$OPENCODE_DIR" install

if [[ ! -x "$TARGET" ]]; then
  chmod +x "$TARGET"
fi

printf '[3/3] Installing pipeline control shims...\n'
mkdir -p "$INSTALL_DIR"
ln -sfn "$TARGET" "$INSTALL_DIR/pipelinectl"
ln -sfn "$TARGET" "$INSTALL_DIR/piplinectl"

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
