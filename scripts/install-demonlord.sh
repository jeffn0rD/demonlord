#!/usr/bin/env bash

set -euo pipefail

ASSET_DIRS=(".opencode" "agents" "doc")
ASSET_FILES=("scripts/bootstrap.sh" "scripts/install-demonlord.sh" "demonlord.config.json" ".env.example")
TRANSIENT_ENTRY_NAMES=("node_modules" ".cache" ".npm" ".pnpm-store" ".turbo")

DRY_RUN=0
RUN_BOOTSTRAP=1
ROLLBACK_ONLY=0
SOURCE_ARG=""
TARGET_DIR="$(pwd)"
TEMP_SOURCE_DIR=""
SOURCE_FROM_GIT=0

cleanup() {
  if [[ -n "$TEMP_SOURCE_DIR" && -d "$TEMP_SOURCE_DIR" ]]; then
    rm -rf "$TEMP_SOURCE_DIR"
  fi
}

trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: install-demonlord.sh [options]

Install or update Demonlord assets in a target repository.

Options:
  --source <path-or-git-url>  Source template path or git URL.
  --target <path>             Target repository root (default: current directory).
  --dry-run                   Print planned actions without modifying files.
  --skip-bootstrap            Skip bootstrap dependency/shim setup.
  --rollback                  Restore assets from .demonlord-install-backup/latest.
  -h, --help                  Show this help message.

Examples:
  ./scripts/install-demonlord.sh --source ../demonlord-template --target .
  ./scripts/install-demonlord.sh --source https://github.com/<owner>/<repo>.git
  ./scripts/install-demonlord.sh --dry-run --source ../demonlord-template
  ./scripts/install-demonlord.sh --rollback
EOF
}

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
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

is_git_source() {
  local value="$1"
  [[ "$value" =~ ^https?:// ]] || [[ "$value" =~ ^git@ ]] || [[ "$value" =~ \.git$ ]]
}

resolve_local_source() {
  local script_path="${BASH_SOURCE[0]}"
  if [[ ! -f "$script_path" ]]; then
    return 1
  fi

  local script_dir
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  local candidate
  candidate="$(cd "$script_dir/.." && pwd)"

  if [[ -d "$candidate/.opencode" && -f "$candidate/scripts/bootstrap.sh" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

copy_asset() {
  local source_path="$1"
  local destination_path="$2"
  local label="$3"

  if [[ ! -e "$source_path" && $DRY_RUN -eq 0 ]]; then
    fail "Missing source asset: $source_path"
  fi

  run_cmd mkdir -p "$(dirname "$destination_path")"
  run_cmd rm -rf "$destination_path"
  run_cmd cp -a "$source_path" "$destination_path"
  log "  - synced $label"
}

is_transient_entry() {
  local entry_name="$1"
  local item=""

  for item in "${TRANSIENT_ENTRY_NAMES[@]}"; do
    if [[ "$entry_name" == "$item" ]]; then
      return 0
    fi
  done

  case "$entry_name" in
    *.tmp|*.swp|*~|.DS_Store)
      return 0
      ;;
  esac

  return 1
}

copy_filtered_directory() {
  local source_path="$1"
  local destination_path="$2"
  local label="$3"
  local entry_name=""
  local entry=""
  local entries=()

  run_cmd mkdir -p "$(dirname "$destination_path")"
  run_cmd rm -rf "$destination_path"
  run_cmd mkdir -p "$destination_path"

  shopt -s dotglob nullglob
  entries=("$source_path"/*)
  shopt -u dotglob nullglob

  for entry in "${entries[@]}"; do
    entry_name="$(basename "$entry")"
    if is_transient_entry "$entry_name"; then
      log "  - skipped $label/$entry_name (transient)"
      continue
    fi

    run_cmd cp -a "$entry" "$destination_path/$entry_name"
  done

  log "  - synced $label (filtered)"
}

backup_existing_assets() {
  local backup_root="$1"
  local manifest_file="$backup_root/manifest.txt"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] would refresh backup snapshot at $backup_root"
    return 0
  fi

  run_cmd rm -rf "$backup_root"
  run_cmd mkdir -p "$backup_root"

  : > "$manifest_file"

  local asset=""
  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    local destination="$TARGET_DIR/$asset"
    if [[ -e "$destination" ]]; then
      run_cmd mkdir -p "$backup_root/$(dirname "$asset")"
      run_cmd cp -a "$destination" "$backup_root/$asset"
      printf '%s\n' "$asset" >> "$manifest_file"
    fi
  done

  log "Backup snapshot written to $backup_root"
}

restore_from_backup() {
  local backup_root="$TARGET_DIR/.demonlord-install-backup/latest"
  local manifest_file="$backup_root/manifest.txt"

  [[ -d "$backup_root" ]] || fail "No backup directory found at $backup_root"
  [[ -f "$manifest_file" ]] || fail "No backup manifest found at $manifest_file"

  log "Restoring managed assets from backup..."

  local asset=""
  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    run_cmd rm -rf "$TARGET_DIR/$asset"
  done

  while IFS= read -r asset; do
    [[ -n "$asset" ]] || continue
    run_cmd mkdir -p "$TARGET_DIR/$(dirname "$asset")"
    run_cmd cp -a "$backup_root/$asset" "$TARGET_DIR/$asset"
  done < "$manifest_file"

  log "Rollback complete."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || fail "--source requires a value"
      SOURCE_ARG="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || fail "--target requires a value"
      TARGET_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-bootstrap)
      RUN_BOOTSTRAP=0
      shift
      ;;
    --rollback)
      ROLLBACK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ ! -d "$TARGET_DIR" ]]; then
  fail "Target directory does not exist: $TARGET_DIR"
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

if [[ $ROLLBACK_ONLY -eq 1 ]]; then
  restore_from_backup
  exit 0
fi

if [[ -z "$SOURCE_ARG" ]]; then
  if SOURCE_ARG="$(resolve_local_source)"; then
    log "Using local Demonlord source: $SOURCE_ARG"
  else
    fail "No source provided. Use --source <path-or-git-url> when running from stdin or non-template paths."
  fi
fi

if is_git_source "$SOURCE_ARG"; then
  SOURCE_FROM_GIT=1
  command -v git >/dev/null 2>&1 || fail "git is required to clone source repositories"
  if [[ $DRY_RUN -eq 1 ]]; then
    if git ls-remote --exit-code "$SOURCE_ARG" HEAD >/dev/null 2>&1; then
      log "[dry-run] validated remote source reachability: $SOURCE_ARG"
    else
      fail "Unable to reach remote source: $SOURCE_ARG"
    fi
  else
    TEMP_SOURCE_DIR="$(mktemp -d)"
    run_cmd git clone --depth 1 "$SOURCE_ARG" "$TEMP_SOURCE_DIR/source"
    SOURCE_ARG="$TEMP_SOURCE_DIR/source"
  fi
fi

if [[ $DRY_RUN -eq 1 && $SOURCE_FROM_GIT -eq 1 ]]; then
  log "[dry-run] remote source preflight passed; skipping local asset checks"
else
  [[ -d "$SOURCE_ARG" ]] || fail "Source path does not exist: $SOURCE_ARG"
  SOURCE_ARG="$(cd "$SOURCE_ARG" && pwd)"

  if [[ ! -d "$SOURCE_ARG/.opencode" ]]; then
    fail "Source is missing .opencode directory: $SOURCE_ARG"
  fi

  if [[ ! -f "$SOURCE_ARG/scripts/bootstrap.sh" ]]; then
    fail "Source is missing scripts/bootstrap.sh: $SOURCE_ARG"
  fi

  if [[ ! -f "$SOURCE_ARG/demonlord.config.json" ]]; then
    fail "Source is missing demonlord.config.json: $SOURCE_ARG"
  fi
fi

if [[ "$SOURCE_ARG" == "$TARGET_DIR" ]]; then
  log "Source and target are the same directory; skipping asset sync."
else
  if ! git -C "$TARGET_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "Target must be a git repository: $TARGET_DIR"
  fi

  log "Preparing rollback snapshot..."
  backup_existing_assets "$TARGET_DIR/.demonlord-install-backup/latest"

  log "Syncing Demonlord assets into $TARGET_DIR"

  asset=""
  for asset in "${ASSET_DIRS[@]}"; do
    if [[ "$asset" == ".opencode" ]]; then
      copy_filtered_directory "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"
    else
      copy_asset "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"
    fi
  done
  for asset in "${ASSET_FILES[@]}"; do
    copy_asset "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"
  done
fi

if [[ $RUN_BOOTSTRAP -eq 1 ]]; then
  log "Running bootstrap workflow..."
  if [[ $DRY_RUN -eq 1 ]]; then
    run_cmd bash "$TARGET_DIR/scripts/bootstrap.sh" --dry-run
  else
    bash "$TARGET_DIR/scripts/bootstrap.sh"
  fi
else
  log "Skipping bootstrap (--skip-bootstrap)."
fi

log "Demonlord installer completed successfully."
log "If anything looks wrong, run: ./scripts/install-demonlord.sh --rollback"
