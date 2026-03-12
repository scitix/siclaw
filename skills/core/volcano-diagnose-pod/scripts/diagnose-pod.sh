#!/bin/bash
# Diagnose Volcano-managed Pod scheduling issues.
# This script performs read-only operations using kubectl.
set -euo pipefail

show_help() {
  cat <<EOF
Usage: $0 --pod <pod> [options]

Diagnose Volcano-managed Pod scheduling issues.
Checks Pod status, PodGroup, events, and Queue configuration.

Options:
  --pod POD         Pod name to diagnose (required)
  --namespace NS    Namespace (default: default)
  --verbose         Show detailed output including node resources
  -h, --help        Show this help message

Environment:
  VOLCANO_NAMESPACE     Override default namespace
  VOLCANO_SCHEDULER_NS  Scheduler namespace (default: volcano-system)

Examples:
  $0 --pod my-job-0
  $0 --pod my-job-0 --namespace training
  $0 --pod my-job-0 --namespace training --verbose
EOF
  exit 0
}

# Parse arguments
POD=""
NS="${VOLCANO_NAMESPACE:-default}"
SCHEDULER_NS="${VOLCANO_SCHEDULER_NS:-volcano-system}"
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --pod) POD="$2"; shift 2 ;;
    --namespace) NS="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

[[ -z "$POD" ]] && { echo "Error: --pod is required. Use --help for usage." >&2; exit 1; }

echo "=== Volcano Pod Diagnosis: $NS/$POD ==="
echo

# 1. Pod Status
echo "[1/5] Pod Status"
echo "----------------"
if ! kubectl get pod "$POD" -n "$NS" -o wide 2>/dev/null; then
  echo "Error: Pod '$POD' not found in namespace '$NS'" >&2
  exit 1
fi
echo

# Get Pod phase
POD_PHASE=$(kubectl get pod "$POD" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
echo "Pod Phase: $POD_PHASE"
echo

# 2. PodGroup Information
echo "[2/5] PodGroup Information"
echo "--------------------------"
PG=$(kubectl get pod "$POD" -n "$NS" -o jsonpath='{.metadata.annotations.scheduling\.volcano\.sh/pod-group}' 2>/dev/null || true)

if [[ -n "$PG" ]]; then
  echo "PodGroup: $PG"
  echo
  if kubectl get podgroup "$PG" -n "$NS" 2>/dev/null; then
    echo
    PG_PHASE=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    PG_MINMEMBER=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.spec.minMember}' 2>/dev/null || echo "0")
    PG_RUNNING=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.running}' 2>/dev/null || echo "0")
    PG_PENDING=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.pending}' 2>/dev/null || echo "0")
    PG_QUEUE=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.spec.queue}' 2>/dev/null || echo "default")

    echo "PodGroup Phase: $PG_PHASE"
    echo "MinMember: $PG_MINMEMBER"
    echo "Running: $PG_RUNNING"
    echo "Pending: $PG_PENDING"
    echo "Queue: $PG_QUEUE"
  else
    echo "Warning: PodGroup '$PG' not found"
  fi
else
  echo "⚠️  No PodGroup annotation found — this Pod is NOT managed by Volcano scheduler."
  echo "   Recommended: Use 'pod-pending-debug' skill for standard kube-scheduler issues."
  echo ""
  echo "   Continuing with basic event analysis..."
fi
echo

# 3. Events Analysis
echo "[3/5] Recent Events"
echo "-------------------"
kubectl get events -n "$NS" --field-selector "involvedObject.name=$POD" --sort-by='.lastTimestamp' 2>/dev/null | tail -15 || echo "No events found"
echo

# 4. Queue Status (if PodGroup exists and has a queue)
if [[ -n "$PG" ]]; then
  PG_QUEUE=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.spec.queue}' 2>/dev/null || echo "")
  if [[ -n "$PG_QUEUE" ]]; then
    echo "[4/5] Queue Status: $PG_QUEUE"
    echo "------------------------------"
    if kubectl get queue "$PG_QUEUE" 2>/dev/null; then
      echo
      QUEUE_STATE=$(kubectl get queue "$PG_QUEUE" -o jsonpath='{.status.state}' 2>/dev/null || echo "Unknown")
      QUEUE_WEIGHT=$(kubectl get queue "$PG_QUEUE" -o jsonpath='{.spec.weight}' 2>/dev/null || echo "N/A")
      echo "Queue State: $QUEUE_STATE"
      echo "Queue Weight: $QUEUE_WEIGHT"
      echo
      echo "Deserved Resources:"
      kubectl get queue "$PG_QUEUE" -o jsonpath='{.status.deserved}' 2>/dev/null || echo "  N/A"
      echo
      echo "Allocated Resources:"
      kubectl get queue "$PG_QUEUE" -o jsonpath='{.status.allocated}' 2>/dev/null || echo "  N/A"
    else
      echo "Warning: Queue '$PG_QUEUE' not found"
    fi
    echo
  else
    echo "[4/5] Queue Status"
    echo "------------------"
    echo "No queue specified in PodGroup"
    echo
  fi
else
  echo "[4/5] Queue Status"
  echo "------------------"
  echo "Skipping (no PodGroup found)"
  echo
fi

# 5. Node Resources (verbose mode)
if [[ "$VERBOSE" == "true" ]]; then
  echo "[5/5] Node Resources"
  echo "--------------------"
  echo "Node Allocatable Resources:"
  kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory,GPU:.status.allocatable.nvidia\.com/gpu' 2>/dev/null | head -10
  echo

  echo "Node Resource Usage (if metrics available):"
  kubectl top nodes 2>/dev/null | head -10 || echo "Metrics not available (requires metrics-server)"
  echo
fi

# Summary
echo "=== Diagnosis Summary ==="
echo "Pod: $NS/$POD"
echo "Phase: $POD_PHASE"
if [[ -n "$PG" ]]; then
  echo "PodGroup: $PG (Phase: ${PG_PHASE:-Unknown})"
  if [[ -n "${PG_QUEUE:-}" ]]; then
    echo "Queue: $PG_QUEUE (State: ${QUEUE_STATE:-Unknown})"
  fi
else
  echo "PodGroup: Not found"
fi

if [[ "$POD_PHASE" == "Pending" ]]; then
  echo
  echo "Recommendations:"
  echo "1. Check events above for 'FailedScheduling' reasons"
  echo "2. If PodGroup phase is 'Pending', check Queue capacity"
  echo "3. If minMember is not satisfied, use volcano-gang-scheduling skill"
  echo "4. Check scheduler logs with volcano-scheduler-logs skill"
fi

echo
echo "=== Diagnosis Complete ==="
