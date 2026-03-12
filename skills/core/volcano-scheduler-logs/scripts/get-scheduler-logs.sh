#!/bin/bash
# Retrieve and analyze Volcano scheduler logs.
# This script performs read-only operations using kubectl.
set -euo pipefail

show_help() {
  cat <<EOF
Usage: $0 [options]

Retrieve and analyze Volcano scheduler logs.
Filter by keyword, time range, or pod name to debug scheduling decisions.

Options:
  --keyword KEYWORD   Filter logs by keyword (case-insensitive)
  --pod POD           Filter logs related to specific pod name
  --since TIME        Show logs newer than relative time (e.g., 10m, 1h, 1d)
  --lines N           Number of lines to show (default: 100)
  --follow            Stream logs in real-time (Ctrl+C to stop)
  --previous          Show logs from previous container instance
  -h, --help          Show this help message

Environment:
  VOLCANO_SCHEDULER_NS      Scheduler namespace (default: volcano-system)
  VOLCANO_SCHEDULER_LABEL   Pod label selector (default: app=volcano-scheduler)

Examples:
  $0 --keyword error                    # Search for errors
  $0 --pod my-job-0 --since 30m        # Logs for pod in last 30 min
  $0 --lines 500 --since 1h            # Last 500 lines from past hour
  $0 --keyword gang --follow           # Stream gang scheduling logs
  $0 --previous --lines 200            # Logs from previous scheduler instance
EOF
  exit 0
}

# Parse arguments
KEYWORD=""
POD=""
SINCE=""
LINES=100
FOLLOW=false
PREVIOUS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --keyword) KEYWORD="$2"; shift 2 ;;
    --pod) POD="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --lines) LINES="$2"; shift 2 ;;
    --follow) FOLLOW=true; shift ;;
    --previous) PREVIOUS=true; shift ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

# Validate arguments
if [[ "$FOLLOW" == "true" && -n "$SINCE" ]]; then
  echo "Error: --follow and --since cannot be used together" >&2
  exit 1
fi

if [[ "$FOLLOW" == "true" && -n "$SINCE" && "$LINES" != "100" ]]; then
  echo "Warning: --follow ignores --lines, streaming from now" >&2
fi

# Environment settings
SCHEDULER_NS="${VOLCANO_SCHEDULER_NS:-volcano-system}"
SCHEDULER_LABEL="${VOLCANO_SCHEDULER_LABEL:-app=volcano-scheduler}"

echo "=== Volcano Scheduler Logs ==="
echo "Namespace: $SCHEDULER_NS"
echo "Label: $SCHEDULER_LABEL"
[[ -n "$KEYWORD" ]] && echo "Keyword filter: $KEYWORD"
[[ -n "$POD" ]] && echo "Pod filter: $POD"
[[ -n "$SINCE" ]] && echo "Time range: $SINCE"
echo "Lines: $LINES"
[[ "$PREVIOUS" == "true" ]] && echo "Previous instance: yes"
echo

# Check if scheduler pod exists
if ! kubectl get pods -n "$SCHEDULER_NS" -l "$SCHEDULER_LABEL" &>/dev/null; then
  echo "Error: No scheduler pods found in namespace '$SCHEDULER_NS' with label '$SCHEDULER_LABEL'" >&2
  echo "Available pods in $SCHEDULER_NS:" >&2
  kubectl get pods -n "$SCHEDULER_NS" 2>/dev/null | head -10 >&2 || echo "  (failed to list pods)" >&2
  exit 1
fi

# Get scheduler pod name
SCHEDULER_POD=$(kubectl get pods -n "$SCHEDULER_NS" -l "$SCHEDULER_LABEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$SCHEDULER_POD" ]]; then
  echo "Error: Could not determine scheduler pod name" >&2
  exit 1
fi

echo "Scheduler Pod: $SCHEDULER_POD"
echo

# Build kubectl logs command
LOG_CMD="kubectl logs -n $SCHEDULER_NS $SCHEDULER_POD"

# Add options
[[ "$FOLLOW" == "true" ]] && LOG_CMD="$LOG_CMD --follow"
[[ "$PREVIOUS" == "true" ]] && LOG_CMD="$LOG_CMD --previous"
[[ -n "$SINCE" ]] && LOG_CMD="$LOG_CMD --since=$SINCE"
[[ "$FOLLOW" == "false" ]] && LOG_CMD="$LOG_CMD --tail=$LINES"

# Execute command with optional filtering
echo "Executing: $LOG_CMD"
echo "----------------------------------------"
echo

# Build filter pattern
FILTER_PATTERN=""

# If both keyword and pod are specified, combine them
if [[ -n "$KEYWORD" && -n "$POD" ]]; then
  FILTER_PATTERN="$KEYWORD|$POD"
elif [[ -n "$KEYWORD" ]]; then
  FILTER_PATTERN="$KEYWORD"
elif [[ -n "$POD" ]]; then
  FILTER_PATTERN="$POD"
fi

# Execute and filter
if [[ -n "$FILTER_PATTERN" ]]; then
  # Use case-insensitive grep for filtering
  if [[ "$FOLLOW" == "true" ]]; then
    # For follow mode, we need to filter in real-time
    $LOG_CMD 2>&1 | grep -iE "$FILTER_PATTERN" || true
  else
    # For non-follow mode, filter after getting logs
    $LOG_CMD 2>&1 | grep -iE "$FILTER_PATTERN" || {
      echo "(No log lines matched the filter pattern: $FILTER_PATTERN)"
    }
  fi
else
  # No filtering, show all logs
  $LOG_CMD 2>&1 || {
    echo "Error: Failed to retrieve logs" >&2
    exit 1
  }
fi

echo

# If not following, show some helpful hints
if [[ "$FOLLOW" == "false" ]]; then
  echo "----------------------------------------"
  echo "Hints:"
  echo "  - Use --follow to stream logs in real-time"
  echo "  - Use --since 30m for recent logs only"
  echo "  - Use --previous if scheduler recently restarted"
  echo "  - Common keywords: error, FailedScheduling, gang, preempt, reclaim"
fi

echo
echo "=== Log Retrieval Complete ==="
