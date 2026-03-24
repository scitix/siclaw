#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/app/.siclaw/user-data/users"
PREFIX="[memory-cleanup]"

# ── Defaults ────────────────────────────────────────────────────
user_filter=""
workspace_filter=""
older_than_days=""
dry_run=true

# ── Usage ───────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: memory-cleanup.sh [OPTIONS]

Clean up session memory .md files on NFS.

Options:
  --user <userId>          Filter by user (omit for all users)
  --workspace <wsId>       Filter by workspace (requires --user)
  --older-than <days>      Only clean files older than N days (by filename date)
  --dry-run                List matching files without deleting (default)
  --confirm                Actually delete files (no interactive prompt)
  -h, --help               Show this help

Examples:
  memory-cleanup.sh                                        # dry-run, all users
  memory-cleanup.sh --confirm                              # delete all session memories
  memory-cleanup.sh --older-than 30 --confirm              # delete files older than 30 days
  memory-cleanup.sh --user 23ea307e6e6e5a33                # dry-run, one user
  memory-cleanup.sh --user 23ea307e6e6e5a33 --workspace aeaec720 --confirm
EOF
  exit 0
}

# ── Parse args ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      user_filter="$2"; shift 2 ;;
    --workspace)
      workspace_filter="$2"; shift 2 ;;
    --older-than)
      older_than_days="$2"; shift 2 ;;
    --dry-run)
      dry_run=true; shift ;;
    --confirm)
      dry_run=false; shift ;;
    -h|--help)
      usage ;;
    *)
      echo "${PREFIX} Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validate ────────────────────────────────────────────────────
if [[ -n "$workspace_filter" && -z "$user_filter" ]]; then
  echo "${PREFIX} ERROR: --workspace requires --user" >&2
  exit 1
fi

if [[ -n "$older_than_days" ]] && ! [[ "$older_than_days" =~ ^[0-9]+$ ]]; then
  echo "${PREFIX} ERROR: --older-than must be a positive integer" >&2
  exit 1
fi

if [[ ! -d "$BASE_DIR" ]]; then
  echo "${PREFIX} ERROR: Base directory not found: ${BASE_DIR}" >&2
  exit 1
fi

# ── Compute cutoff date ─────────────────────────────────────────
cutoff_date=""
if [[ -n "$older_than_days" ]]; then
  # GNU date (Linux) — gateway pod is Debian-based
  cutoff_date=$(date -d "-${older_than_days} days" +%Y-%m-%d)
  echo "${PREFIX} Cutoff date: ${cutoff_date} (files before this date will match)"
fi

# ── Build glob pattern ──────────────────────────────────────────
if [[ -n "$user_filter" && -n "$workspace_filter" ]]; then
  search_pattern="${BASE_DIR}/${user_filter}/${workspace_filter}*/memory/[0-9]*.md"
elif [[ -n "$user_filter" ]]; then
  search_pattern="${BASE_DIR}/${user_filter}/*/memory/[0-9]*.md"
else
  search_pattern="${BASE_DIR}/*/*/memory/[0-9]*.md"
fi

# ── Collect matching files ──────────────────────────────────────
echo "${PREFIX} Scanning ${BASE_DIR}/..."

mapfile -t all_files < <(compgen -G "$search_pattern" 2>/dev/null || true)

# Filter by date if needed
matched_files=()
for f in "${all_files[@]}"; do
  basename_f=$(basename "$f")

  # Skip non-date-prefixed files (safety net)
  if ! [[ "$basename_f" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
    continue
  fi

  # Apply --older-than filter
  if [[ -n "$cutoff_date" ]]; then
    file_date="${basename_f:0:10}"
    if [[ "$file_date" > "$cutoff_date" || "$file_date" == "$cutoff_date" ]]; then
      continue
    fi
  fi

  matched_files+=("$f")
done

total=${#matched_files[@]}
echo "${PREFIX} Found ${total} session memory file(s)"

if [[ $total -eq 0 ]]; then
  echo "${PREFIX} Nothing to do."
  exit 0
fi

# ── Display grouped by user/workspace ───────────────────────────
echo ""

declare -A ws_files ws_dates
prev_user=""

for f in "${matched_files[@]}"; do
  # Parse path: .../users/<userId>/<wsId>/memory/<file>.md
  rel="${f#${BASE_DIR}/}"
  uid="${rel%%/*}"
  rest="${rel#*/}"
  wsid="${rest%%/*}"
  file_date="$(basename "$f" | head -c 10)"

  key="${uid}|${wsid}"

  ws_files["$key"]=$(( ${ws_files["$key"]:-0} + 1 ))

  # Track date range
  existing_dates="${ws_dates["$key"]:-}"
  if [[ -z "$existing_dates" ]]; then
    ws_dates["$key"]="${file_date}"
  elif [[ "$existing_dates" != *"$file_date"* ]]; then
    ws_dates["$key"]="${existing_dates}, ${file_date}"
  fi
done

# Sort and display
prev_user=""
for key in $(echo "${!ws_files[@]}" | tr ' ' '\n' | sort); do
  uid="${key%%|*}"
  wsid="${key#*|}"

  if [[ "$uid" != "$prev_user" ]]; then
    echo "  User: ${uid}"
    prev_user="$uid"
  fi

  echo "    Workspace: ${wsid}  — ${ws_files[$key]} files (${ws_dates[$key]})"
done

echo ""

# ── Execute or dry-run ──────────────────────────────────────────
if $dry_run; then
  echo "${PREFIX} DRY RUN — no files deleted. Add --confirm to execute."
  exit 0
fi

echo "${PREFIX} Deleting ${total} file(s)..."

# Delete
deleted=0
failed=0
for f in "${matched_files[@]}"; do
  if rm "$f" 2>/dev/null; then
    ((deleted++))
  else
    echo "${PREFIX} WARN: Failed to delete ${f}" >&2
    ((failed++))
  fi
done

echo "${PREFIX} Done. Deleted: ${deleted}, Failed: ${failed}"
echo "${PREFIX} Note: .memory.db index will be cleaned up on next indexer.sync()"
