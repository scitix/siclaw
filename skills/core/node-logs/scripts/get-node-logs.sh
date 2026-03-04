#!/bin/bash
set -euo pipefail

# Retrieve logs from the current node.
# Runs ON the node via node_script tool (nsenter into host namespaces).
# Supports journalctl (--unit) and file-based logs (--file).

UNIT=""
FILE=""
SINCE="1h ago"
GREP=""
TAIL=200

usage() {
  cat <<'USAGE'
Usage: get-node-logs.sh [OPTIONS]

Required (one of):
  --unit UNIT        Systemd unit name (e.g. containerd, kubelet)
  --file PATH        Log file path on the node (e.g. /var/log/messages)

Optional:
  --since DURATION   Time range for journalctl (default: "1h ago"), e.g. "30m ago", "2h ago"
  --grep PATTERN     Case-insensitive grep filter
  --tail N           Max output lines (default: 200)
  --help             Show this help

Examples (via node_script tool):
  node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--unit containerd --tail 50"
  node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args='--unit containerd --grep "myimage" --since "2h ago"'
  node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--file /var/log/messages --grep error --tail 100"
USAGE
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit)  UNIT="$2";  shift 2 ;;
    --file)  FILE="$2";  shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --grep)  GREP="$2";  shift 2 ;;
    --tail)  TAIL="$2";  shift 2 ;;
    --help)  usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$UNIT" && -z "$FILE" ]]; then
  echo "Error: one of --unit or --file is required" >&2
  exit 1
fi
if [[ -n "$UNIT" && -n "$FILE" ]]; then
  echo "Error: specify --unit or --file, not both" >&2
  exit 1
fi

# Build and execute the command
CMD=""
if [[ -n "$UNIT" ]]; then
  CMD="journalctl -u '$UNIT' --since '$SINCE' --no-pager"
else
  CMD="cat '$FILE'"
fi

[[ -n "$GREP" ]] && CMD="$CMD | grep -i '$GREP'"
CMD="$CMD | tail -$TAIL"

OUTPUT=$(sh -c "$CMD" 2>&1) || true

if [[ -z "$OUTPUT" ]]; then
  if [[ -n "$UNIT" ]]; then
    echo "No logs found for unit '$UNIT' (since: $SINCE${GREP:+, grep: $GREP})"
  else
    echo "No logs found in '$FILE'${GREP:+ (grep: $GREP)}"
  fi
else
  echo "$OUTPUT"
fi
