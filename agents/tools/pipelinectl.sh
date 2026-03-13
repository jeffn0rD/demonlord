#!/usr/bin/env bash

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  if [[ "$SOURCE" != /* ]]; then
    SOURCE="$LINK_DIR/$SOURCE"
  fi
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
exec node --experimental-strip-types "$SCRIPT_DIR/pipelinectl.ts" "$@"
