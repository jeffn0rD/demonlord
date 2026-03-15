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
LAST_APPLY_ERROR=""

EXIT_USAGE=2
EXIT_PREFLIGHT=10
EXIT_SOURCE=20
EXIT_BACKUP=30
EXIT_APPLY=40
EXIT_APPLY_ROLLED_BACK=41
EXIT_APPLY_ROLLBACK_FAILED=42
EXIT_BOOTSTRAP=50
EXIT_ROLLBACK=60

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

Managed asset policy:
  - Preserve unmanaged paths outside this installer's managed set.
  - Backup existing managed assets to .demonlord-install-backup/latest before replacement.
  - Replace managed assets from source after backup succeeds.

Deterministic exit codes:
  2   usage error
  10  preflight/target validation error
  20  source resolution/validation error
  30  backup snapshot failure
  40  apply failure without rollback
  41  apply failure with successful automatic rollback
  42  apply failure and rollback failure
  50  bootstrap failure after sync
  60  rollback command failure

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

fail_with_code() {
  local code="$1"
  shift
  printf 'Error [E%s]: %s\n' "$code" "$*" >&2
  exit "$code"
}

fail_usage() {
  fail_with_code "$EXIT_USAGE" "$*"
}

fail_preflight() {
  fail_with_code "$EXIT_PREFLIGHT" "$*"
}

fail_source() {
  fail_with_code "$EXIT_SOURCE" "$*"
}

fail_backup() {
  fail_with_code "$EXIT_BACKUP" "$*"
}

fail_apply() {
  fail_with_code "$EXIT_APPLY" "$*"
}

fail_apply_rolled_back() {
  fail_with_code "$EXIT_APPLY_ROLLED_BACK" "$*"
}

fail_apply_rollback_failed() {
  fail_with_code "$EXIT_APPLY_ROLLBACK_FAILED" "$*"
}

fail_bootstrap() {
  fail_with_code "$EXIT_BOOTSTRAP" "$*"
}

fail_rollback() {
  fail_with_code "$EXIT_ROLLBACK" "$*"
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

require_tool() {
  local tool_name="$1"
  command -v "$tool_name" >/dev/null 2>&1 || fail_preflight "required tool '$tool_name' not found on PATH"
}

validate_target_path_safety() {
  local target="$1"

  [[ -n "$target" ]] || fail_preflight "target path is empty"

  if [[ "$target" == "/" ]]; then
    fail_preflight "refusing to operate on filesystem root '/'"
  fi

  if [[ "$target" == "$HOME" ]]; then
    fail_preflight "refusing to operate on HOME directory '$HOME'"
  fi
}

validate_target_preflight() {
  local target="$1"

  validate_target_path_safety "$target"

  [[ -d "$target" ]] || fail_preflight "target directory does not exist: $target"
  [[ -r "$target" ]] || fail_preflight "target directory is not readable: $target"
  [[ -w "$target" ]] || fail_preflight "target directory is not writable: $target"

  if ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail_preflight "target must be a git repository: $target"
  fi
}

validate_source_assets() {
  local source_root="$1"
  local missing=()
  local asset=""

  [[ -d "$source_root" ]] || fail_source "path does not exist: $source_root"

  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    if [[ ! -e "$source_root/$asset" ]]; then
      missing+=("$asset")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail_source "preflight failed. Missing required asset(s): ${missing[*]}"
  fi
}

validate_dry_run_plan() {
  local target="$1"
  local asset=""

  [[ $DRY_RUN -eq 1 ]] || return 0

  log "[dry-run] validating managed path plan for target: $target"
  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    local destination="$target/$asset"
    local state="absent"
    if [[ -e "$destination" ]]; then
      state="present"
    fi
    log "[dry-run] planned sync target: $destination ($state)"
  done
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
    LAST_APPLY_ERROR="missing source asset for $label: $source_path"
    return 1
  fi

  if ! run_cmd mkdir -p "$(dirname "$destination_path")"; then
    LAST_APPLY_ERROR="failed to prepare destination directory for $label: $destination_path"
    return 1
  fi
  if ! run_cmd rm -rf "$destination_path"; then
    LAST_APPLY_ERROR="failed to replace existing managed asset for $label: $destination_path"
    return 1
  fi
  if ! run_cmd cp -a "$source_path" "$destination_path"; then
    LAST_APPLY_ERROR="failed to copy managed asset for $label from $source_path"
    return 1
  fi
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

  if ! run_cmd mkdir -p "$(dirname "$destination_path")"; then
    LAST_APPLY_ERROR="failed to prepare destination directory for $label: $destination_path"
    return 1
  fi
  if ! run_cmd rm -rf "$destination_path"; then
    LAST_APPLY_ERROR="failed to replace existing managed directory for $label: $destination_path"
    return 1
  fi
  if ! run_cmd mkdir -p "$destination_path"; then
    LAST_APPLY_ERROR="failed to create destination managed directory for $label: $destination_path"
    return 1
  fi

  shopt -s dotglob nullglob
  entries=("$source_path"/*)
  shopt -u dotglob nullglob

  for entry in "${entries[@]}"; do
    entry_name="$(basename "$entry")"
    if is_transient_entry "$entry_name"; then
      log "  - skipped $label/$entry_name (transient)"
      continue
    fi

    if ! run_cmd cp -a "$entry" "$destination_path/$entry_name"; then
      LAST_APPLY_ERROR="failed to copy $label/$entry_name from source"
      return 1
    fi
  done

  log "  - synced $label (filtered)"
}

backup_existing_assets() {
  local backup_root="$1"
  local manifest_file="$backup_root/manifest.txt"
  local policy_file="$backup_root/policy-manifest.txt"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] would refresh backup snapshot at $backup_root"
    log "[dry-run] managed asset policy: existing assets are backup+replace, missing assets are preserve-absent+replace"
    return 0
  fi

  if ! run_cmd rm -rf "$backup_root"; then
    return 1
  fi
  if ! run_cmd mkdir -p "$backup_root"; then
    return 1
  fi

  if ! : > "$manifest_file"; then
    return 1
  fi
  if ! : > "$policy_file"; then
    return 1
  fi

  printf '# managed asset policy\n' >> "$policy_file"
  printf '# format: <asset>|<existing-policy>|<apply-policy>\n' >> "$policy_file"

  local asset=""
  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    local destination="$TARGET_DIR/$asset"
    if [[ -e "$destination" ]]; then
      if ! run_cmd mkdir -p "$backup_root/$(dirname "$asset")"; then
        return 1
      fi
      if ! run_cmd cp -a "$destination" "$backup_root/$asset"; then
        return 1
      fi
      printf '%s\n' "$asset" >> "$manifest_file"
      printf '%s|backup|replace\n' "$asset" >> "$policy_file"
    else
      printf '%s|preserve-absent|replace\n' "$asset" >> "$policy_file"
    fi
  done

  log "Backup snapshot written to $backup_root"
  log "Managed asset policy manifest written to $policy_file"
}

restore_from_backup() {
  local backup_root="$1"
  local manifest_file="$backup_root/manifest.txt"

  [[ -d "$backup_root" ]] || return 1
  [[ -f "$manifest_file" ]] || return 1

  log "Restoring managed assets from backup..."

  local asset=""
  for asset in "${ASSET_DIRS[@]}" "${ASSET_FILES[@]}"; do
    if ! run_cmd rm -rf "$TARGET_DIR/$asset"; then
      return 1
    fi
  done

  while IFS= read -r asset; do
    [[ -n "$asset" ]] || continue
    if ! run_cmd mkdir -p "$TARGET_DIR/$(dirname "$asset")"; then
      return 1
    fi
    if ! run_cmd cp -a "$backup_root/$asset" "$TARGET_DIR/$asset"; then
      return 1
    fi
  done < "$manifest_file"

  log "Rollback complete."
}

handle_apply_failure() {
  local asset="$1"
  local backup_root="$TARGET_DIR/.demonlord-install-backup/latest"
  local detail="${LAST_APPLY_ERROR:-unknown apply error}"

  if [[ ! -d "$backup_root" ]]; then
    fail_apply "partial apply failed while syncing '$asset' and no rollback snapshot is available. detail: $detail"
  fi

  if restore_from_backup "$backup_root"; then
    fail_apply_rolled_back "partial apply failed while syncing '$asset'. automatic rollback restored previous managed assets. detail: $detail"
  fi

  fail_apply_rollback_failed "partial apply failed while syncing '$asset' and rollback failed. detail: $detail. run ./scripts/install-demonlord.sh --rollback after fixing permissions"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || fail_usage "--source requires a value"
      SOURCE_ARG="$2"
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || fail_usage "--target requires a value"
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
      fail_usage "unknown argument: $1"
      ;;
  esac
done

if [[ ! -d "$TARGET_DIR" ]]; then
  fail_preflight "target directory does not exist: $TARGET_DIR"
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

require_tool git
require_tool bash
require_tool cp
require_tool rm
require_tool mkdir
require_tool mktemp

validate_target_preflight "$TARGET_DIR"

if [[ $ROLLBACK_ONLY -eq 1 ]]; then
  if ! restore_from_backup "$TARGET_DIR/.demonlord-install-backup/latest"; then
    fail_rollback "unable to restore from $TARGET_DIR/.demonlord-install-backup/latest (missing backup or unreadable managed asset snapshot)"
  fi
  exit 0
fi

if [[ -z "$SOURCE_ARG" ]]; then
  if SOURCE_ARG="$(resolve_local_source)"; then
    log "Using local Demonlord source: $SOURCE_ARG"
  else
    fail_source "no source provided. Use --source <path-or-git-url> when running from stdin or non-template paths"
  fi
fi

if is_git_source "$SOURCE_ARG"; then
  SOURCE_FROM_GIT=1
  if git ls-remote --exit-code "$SOURCE_ARG" HEAD >/dev/null 2>&1; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log "[dry-run] validated remote source reachability: $SOURCE_ARG"
    fi
  else
    fail_source "unable to reach remote source: $SOURCE_ARG"
  fi

  TEMP_SOURCE_DIR="$(mktemp -d)"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "[dry-run] cloning remote source into temporary preflight workspace"
    git clone --depth 1 "$SOURCE_ARG" "$TEMP_SOURCE_DIR/source" >/dev/null 2>&1 || fail_source "unable to clone remote source for dry-run validation: $SOURCE_ARG"
  else
    if ! run_cmd git clone --depth 1 "$SOURCE_ARG" "$TEMP_SOURCE_DIR/source"; then
      fail_source "unable to clone remote source: $SOURCE_ARG"
    fi
  fi
  SOURCE_ARG="$TEMP_SOURCE_DIR/source"
fi

[[ -d "$SOURCE_ARG" ]] || fail_source "path does not exist: $SOURCE_ARG"
SOURCE_ARG="$(cd "$SOURCE_ARG" && pwd)"

validate_source_assets "$SOURCE_ARG"
validate_dry_run_plan "$TARGET_DIR"

if [[ "$SOURCE_ARG" == "$TARGET_DIR" ]]; then
  log "Source and target are the same directory; skipping asset sync."
else
  log "Preparing rollback snapshot..."
  if ! backup_existing_assets "$TARGET_DIR/.demonlord-install-backup/latest"; then
    fail_backup "failed to create backup snapshot at $TARGET_DIR/.demonlord-install-backup/latest"
  fi

  log "Syncing Demonlord assets into $TARGET_DIR"
  log "Managed asset policy: preserve unmanaged paths, backup existing managed paths, replace managed assets from source"

  asset=""
  for asset in "${ASSET_DIRS[@]}"; do
    if [[ "$asset" == ".opencode" ]]; then
      if ! copy_filtered_directory "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"; then
        handle_apply_failure "$asset"
      fi
    else
      if ! copy_asset "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"; then
        handle_apply_failure "$asset"
      fi
    fi
  done
  for asset in "${ASSET_FILES[@]}"; do
    if ! copy_asset "$SOURCE_ARG/$asset" "$TARGET_DIR/$asset" "$asset"; then
      handle_apply_failure "$asset"
    fi
  done
fi

if [[ $RUN_BOOTSTRAP -eq 1 ]]; then
  log "Running bootstrap workflow..."
  if [[ $DRY_RUN -eq 1 ]]; then
    if ! run_cmd bash "$TARGET_DIR/scripts/bootstrap.sh" --dry-run; then
      fail_bootstrap "bootstrap dry-run failed. run ./scripts/bootstrap.sh manually after correcting the environment"
    fi
  else
    if ! bash "$TARGET_DIR/scripts/bootstrap.sh"; then
      fail_bootstrap "bootstrap failed after asset sync. run ./scripts/install-demonlord.sh --rollback if you want to restore managed assets, then rerun"
    fi
  fi
else
  log "Skipping bootstrap (--skip-bootstrap)."
fi

log "Demonlord installer completed successfully."
log "If anything looks wrong, run: ./scripts/install-demonlord.sh --rollback"
