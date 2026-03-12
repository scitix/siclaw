#!/bin/bash
# Diagnose Volcano Job status and issues.
# This script performs read-only operations using kubectl.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed. Install it with: apt-get install jq / brew install jq" >&2
  exit 1
fi

show_help() {
  cat <<EOF
Usage: $0 --job <job-name> [options]

Diagnose Volcano Job (batch.volcano.sh/v1beta1) status and issues.
Checks Job phases, task statuses, PodGroup associations, and overall job health.

Options:
  --job JOB         Job name to diagnose (required)
  --namespace NS    Namespace (default: default)
  --verbose         Show detailed task and pod information
  -h, --help        Show this help message

Environment:
  VOLCANO_NAMESPACE     Override default namespace

Examples:
  $0 --job my-training-job --namespace training
  $0 --job my-training-job --namespace training --verbose
EOF
  exit 0
}

# Parse arguments
JOB=""
NS="${VOLCANO_NAMESPACE:-default}"
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --job) JOB="$2"; shift 2 ;;
    --namespace) NS="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

[[ -z "$JOB" ]] && { echo "Error: --job is required. Use --help for usage." >&2; exit 1; }

echo "=== Volcano Job Diagnosis: $NS/$JOB ==="
echo

# 1. Job Overview
echo "[1/5] Job Overview"
echo "------------------"
if ! kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o wide 2>/dev/null; then
  echo "Error: Job '$JOB' not found in namespace '$NS'" >&2
  exit 1
fi
echo

# Get job details
JOB_PHASE=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.status.state.phase}' 2>/dev/null || echo "Unknown")
JOB_FAILED=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.status.failed}' 2>/dev/null || echo "0")
JOB_SUCCEEDED=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.status.succeeded}' 2>/dev/null || echo "0")
JOB_RUNNING=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.status.running}' 2>/dev/null || echo "0")
JOB_PENDING=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.status.pending}' 2>/dev/null || echo "0")

echo "Job Phase: $JOB_PHASE"
echo "Tasks - Failed: $JOB_FAILED, Succeeded: $JOB_SUCCEEDED, Running: $JOB_RUNNING, Pending: $JOB_PENDING"
echo

# Warning for problematic states
case "$JOB_PHASE" in
  Failed)
    echo "⚠️  WARNING: Job has FAILED"
    ;;
  Pending)
    echo "ℹ️  Job is PENDING - waiting for resources or admission"
    ;;
  Restarting)
    echo "⚠️  WARNING: Job is RESTARTING - check previous failure reasons"
    ;;
  Aborted)
    echo "⚠️  WARNING: Job was ABORTED"
    ;;
esac

# Check minAvailable if set
MIN_AVAILABLE=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.spec.minAvailable}' 2>/dev/null || echo "")
if [[ -n "$MIN_AVAILABLE" ]]; then
  echo "MinAvailable: $MIN_AVAILABLE (Gang constraint)"
fi
echo

# 2. Check Policies
echo "[2/5] Job Policies"
echo "------------------"
POLICIES=$(kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.spec.policies}' 2>/dev/null || echo "")
if [[ -n "$POLICIES" && "$POLICIES" != "[]" && "$POLICIES" != "null" ]]; then
  echo "Configured Policies:"
  kubectl get job.batch.volcano.sh "$JOB" -n "$NS" -o jsonpath='{.spec.policies}' 2>/dev/null | jq -r '.[] | "  - Event: \(.event), Action: \(.action)"' 2>/dev/null || echo "  (Failed to parse policies)"
else
  echo "No policies configured"
fi
echo

# 3. Task Status
echo "[3/5] Task Status"
echo "-----------------"

# Initialize counters with defaults (in case PODS is empty)
PENDING_PODS=0
RUNNING_PODS=0
COMPLETED_PODS=0
FAILED_PODS=0
TOTAL_PODS=0

# Get all pods for this job
PODS=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$PODS" ]]; then
  echo "⚠️  No pods found for this job"
  echo "   Job may be in Pending state or pods may have been cleaned up"
else
  # Count pods by phase (--no-headers avoids header line in count)
  PENDING_PODS=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Pending --no-headers 2>/dev/null | grep -c . || echo "0")
  RUNNING_PODS=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Running --no-headers 2>/dev/null | grep -c . || echo "0")
  COMPLETED_PODS=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Succeeded --no-headers 2>/dev/null | grep -c . || echo "0")
  FAILED_PODS=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Failed --no-headers 2>/dev/null | grep -c . || echo "0")
  
  TOTAL_PODS=$((PENDING_PODS + RUNNING_PODS + COMPLETED_PODS + FAILED_PODS))
  
  echo "Total Pods: $TOTAL_PODS"
  echo "  Pending: $PENDING_PODS"
  echo "  Running: $RUNNING_PODS"
  echo "  Completed: $COMPLETED_PODS"
  echo "  Failed: $FAILED_PODS"
  echo
  
  if [[ "$FAILED_PODS" -gt 0 ]]; then
    echo "⚠️  Failed pods detected - check pod logs and events"
  fi
  
  if [[ "$PENDING_PODS" -gt 0 && "$JOB_RUNNING" -gt 0 ]]; then
    echo "⚠️  Partial scheduling - some pods pending while others running"
    echo "   Possible Gang scheduling issue - use volcano-gang-scheduling skill"
  fi
  
  # Show pod details in verbose mode
  if [[ "$VERBOSE" == "true" ]]; then
    echo
    echo "Pod Details:"
    kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,NODE:.spec.nodeName,AGE:.metadata.creationTimestamp' 2>/dev/null || echo "  (Failed to get pod details)"
  fi
fi
echo

# 4. PodGroup Association
echo "[4/5] PodGroup Association"
echo "----------------------------"

# Try to find PodGroup
PG=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" -o jsonpath='{.items[0].metadata.annotations.scheduling\.volcano\.sh/pod-group}' 2>/dev/null || echo "")

if [[ -n "$PG" ]]; then
  echo "PodGroup: $PG"
  
  if kubectl get podgroup "$PG" -n "$NS" &>/dev/null; then
    PG_PHASE=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    PG_MINMEMBER=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.spec.minMember}' 2>/dev/null || echo "N/A")
    PG_RUNNING=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.running}' 2>/dev/null || echo "0")
    PG_PENDING=$(kubectl get podgroup "$PG" -n "$NS" -o jsonpath='{.status.pending}' 2>/dev/null || echo "0")
    
    echo "PodGroup Phase: $PG_PHASE"
    echo "MinMember: $PG_MINMEMBER | Running: $PG_RUNNING | Pending: $PG_PENDING"
    
    if [[ "$PG_PHASE" == "Pending" ]]; then
      echo "⚠️  PodGroup is Pending - check Queue capacity and resource availability"
    fi
    
    if [[ "$PG_PHASE" == "Inqueue" && "$PENDING_PODS" -gt 0 ]]; then
      echo "⚠️  PodGroup Inqueue but pods Pending - Gang constraint may not be satisfied"
    fi
  else
    echo "Warning: PodGroup '$PG' not found"
  fi
else
  echo "No PodGroup annotation found on job pods"
  echo "This may indicate the job is not using Gang scheduling"
fi
echo

# 5. Events Analysis
echo "[5/5] Recent Events"
echo "-------------------"
kubectl get events -n "$NS" --field-selector "involvedObject.name=$JOB" --sort-by='.lastTimestamp' 2>/dev/null | tail -10 || echo "No events found for job"
echo

# Also check pod events if verbose
if [[ "$VERBOSE" == "true" && -n "$PODS" ]]; then
  echo "Pod Events (first failed/running pod):"
  # Find a failed or running pod to check events
  SAMPLE_POD=$(kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Failed -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || \
               kubectl get pods -n "$NS" -l "volcano.sh/job-name=$JOB" --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -n "$SAMPLE_POD" ]]; then
    kubectl get events -n "$NS" --field-selector "involvedObject.name=$SAMPLE_POD" --sort-by='.lastTimestamp' 2>/dev/null | tail -5 || echo "No events found"
  fi
  echo
fi

# Summary
echo "=== Diagnosis Summary ==="
echo "Job: $NS/$JOB"
echo "Phase: $JOB_PHASE"
echo "Tasks: $JOB_PENDING pending, $JOB_RUNNING running, $JOB_SUCCEEDED succeeded, $JOB_FAILED failed"

if [[ -n "$PG" ]]; then
  echo "PodGroup: $PG (Phase: ${PG_PHASE:-Unknown})"
fi

# Recommendations
echo
echo "Recommendations:"
case "$JOB_PHASE" in
  Pending)
    echo "1. Check PodGroup status (if associated)"
    echo "2. Check Queue capacity with volcano-queue-diagnose"
    echo "3. Check scheduler logs with volcano-scheduler-logs"
    ;;
  Running)
    if [[ "$PENDING_PODS" -gt 0 ]]; then
      echo "1. Partial scheduling detected - use volcano-gang-scheduling for Gang analysis"
      echo "2. Check node resources with volcano-node-resources"
    else
      echo "1. Job is running normally - monitor progress"
    fi
    ;;
  Failed)
    echo "1. Check failed pod logs: kubectl logs <pod> -n $NS"
    echo "2. Check pod events for failure reasons"
    echo "3. Review job policies and restart configuration"
    ;;
  Restarting)
    echo "1. Check previous failure reason in events"
    echo "2. Review container logs for crash reasons"
    echo "3. Verify restart policy is appropriate"
    ;;
esac

echo
echo "=== Diagnosis Complete ==="
