#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/fixtures/hello-app"
DEFAULT_SANDBOX_DIR="$ROOT_DIR/fixtures-sandbox/hello-app"

SANDBOX_DIR="$DEFAULT_SANDBOX_DIR"
FORCE_RESET=0

usage() {
  cat <<'EOF'
Usage: reset-test-sandbox.sh [options]

Recreate the disposable Demonlord test sandbox from the tracked hello-app fixture.

Options:
  --sandbox <path>   Override sandbox destination path.
  --force            Remove an existing sandbox before recreating it.
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
    --force)
      FORCE_RESET=1
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

if [[ ! -d "$FIXTURE_DIR" ]]; then
  printf 'Fixture directory not found: %s\n' "$FIXTURE_DIR" >&2
  exit 1
fi

if [[ -e "$SANDBOX_DIR" ]]; then
  if [[ $FORCE_RESET -ne 1 ]]; then
    printf 'Sandbox already exists: %s\n' "$SANDBOX_DIR" >&2
    printf 'Re-run with --force to replace it.\n' >&2
    exit 1
  fi
  rm -rf "$SANDBOX_DIR"
fi

mkdir -p "$(dirname "$SANDBOX_DIR")"
cp -a "$FIXTURE_DIR" "$SANDBOX_DIR"

printf 'Reset sandbox from fixture.\n'
printf 'Fixture: %s\n' "$FIXTURE_DIR"
printf 'Sandbox: %s\n' "$SANDBOX_DIR"
printf 'Next steps:\n'
printf '  1) cd %s\n' "$SANDBOX_DIR"
printf '  2) %s/scripts/install-demonlord.sh --source %s --target %s\n' "$ROOT_DIR" "$ROOT_DIR" "$SANDBOX_DIR"
printf '  3) npm test\n'
