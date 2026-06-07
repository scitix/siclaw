#!/bin/bash
set -euo pipefail

# Execution-path smoke: sleep a few seconds, then echo a marker line.
# Side-effect-free — proves a target is reachable and that script execution
# (incl. background execution) completes and reports back. No cluster calls.

SLEEP_SECONDS=2
MARKER="EXEC_SMOKE_OK"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seconds) SLEEP_SECONDS="${2:-2}"; shift 2 ;;
    --marker)  MARKER="${2:-EXEC_SMOKE_OK}"; shift 2 ;;
    *) shift ;;
  esac
done

echo "exec-smoke: sleeping ${SLEEP_SECONDS}s on $(hostname 2>/dev/null || echo unknown)"
sleep "${SLEEP_SECONDS}"
echo "${MARKER}"
