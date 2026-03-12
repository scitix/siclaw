#!/bin/bash
# Diagnose Volcano Queue status and resource allocation.
# This script performs read-only operations using kubectl.
set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed. Install it with: apt-get install jq / brew install jq" >&2
  exit 1
fi

show_help() {
  cat <<EOF
Usage: $0 [options]

Diagnose Volcano Queue status, resource allocation, and scheduling bottlenecks.
Checks queue weights, deserved resources, allocated resources, and state.

Options:
  --queue QUEUE     Queue name to diagnose (default: all queues)
  --show-pods       Show PodGroups associated with each queue
  --verbose         Show detailed resource breakdown
  -h, --help        Show this help message

Examples:
  $0                              # Diagnose all queues
  $0 --queue training-queue       # Diagnose specific queue
  $0 --queue training-queue --verbose --show-pods
EOF
  exit 0
}

# Parse arguments
QUEUE=""
SHOW_PODS=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --queue) QUEUE="$2"; shift 2 ;;
    --show-pods) SHOW_PODS=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

echo "=== Volcano Queue Diagnosis ==="
[[ -n "$QUEUE" ]] && echo "Queue: $QUEUE"
echo

# Function to diagnose a single queue
diagnose_queue() {
  local q="$1"

  echo "Queue: $q"
  echo "=================="

  # Get queue details
  local weight state pending running deserved allocated
  weight=$(kubectl get queue "$q" -o jsonpath='{.spec.weight}' 2>/dev/null || echo "N/A")
  state=$(kubectl get queue "$q" -o jsonpath='{.status.state}' 2>/dev/null || echo "Unknown")
  pending=$(kubectl get queue "$q" -o jsonpath='{.status.pending}' 2>/dev/null || echo "0")
  running=$(kubectl get queue "$q" -o jsonpath='{.status.running}' 2>/dev/null || echo "0")

  echo "  Weight: $weight"
  echo "  State: $state"
  echo "  Pending PodGroups: $pending"
  echo "  Running PodGroups: $running"

  # State warnings
  if [[ "$state" == "Closed" ]]; then
    echo "  ⚠️  WARNING: Queue is CLOSED - new jobs will be rejected"
  elif [[ "$state" == "Closing" ]]; then
    echo "  ⚠️  WARNING: Queue is CLOSING - will not accept new jobs soon"
  fi

  # Get resource info
  local deserved_cpu deserved_mem allocated_cpu allocated_mem
  deserved_cpu=$(kubectl get queue "$q" -o jsonpath='{.status.deserved.cpu}' 2>/dev/null || echo "")
  deserved_mem=$(kubectl get queue "$q" -o jsonpath='{.status.deserved.memory}' 2>/dev/null || echo "")
  allocated_cpu=$(kubectl get queue "$q" -o jsonpath='{.status.allocated.cpu}' 2>/dev/null || echo "")
  allocated_mem=$(kubectl get queue "$q" -o jsonpath='{.status.allocated.memory}' 2>/dev/null || echo "")

  # Handle empty values
  [[ -z "$deserved_cpu" ]] && deserved_cpu="0"
  [[ -z "$deserved_mem" ]] && deserved_mem="0"
  [[ -z "$allocated_cpu" ]] && allocated_cpu="0"
  [[ -z "$allocated_mem" ]] && allocated_mem="0"

  echo
  echo "  Resources:"
  echo "    CPU:"
  echo "      Deserved:   $deserved_cpu"
  echo "      Allocated:  $allocated_cpu"

  # Calculate CPU ratio if possible
  if [[ "$deserved_cpu" =~ ^[0-9]+\.?[0-9]*$ && "$allocated_cpu" =~ ^[0-9]+\.?[0-9]*$ ]]; then
    if awk "BEGIN {exit !($deserved_cpu > 0)}" 2>/dev/null; then
      local cpu_ratio
      cpu_ratio=$(awk "BEGIN {printf \"%.1f\", $allocated_cpu * 100 / $deserved_cpu}" 2>/dev/null || echo "N/A")
      echo "      Ratio:      ${cpu_ratio}%"

      if awk "BEGIN {exit !($allocated_cpu > $deserved_cpu)}" 2>/dev/null; then
        echo "      ⚠️  OVER-ALLOCATED: Queue using more than deserved"
      elif [[ "$cpu_ratio" != "N/A" ]] && awk "BEGIN {exit !($cpu_ratio >= 90)}" 2>/dev/null; then
        echo "      ⚠️  NEAR CAPACITY: ${cpu_ratio}% of deserved resources used"
      fi
    fi
  fi

  echo "    Memory:"
  echo "      Deserved:   $deserved_mem"
  echo "      Allocated:  $allocated_mem"

  # Check capability if set
  local cap_cpu cap_mem
  cap_cpu=$(kubectl get queue "$q" -o jsonpath='{.spec.capability.cpu}' 2>/dev/null || echo "")
  cap_mem=$(kubectl get queue "$q" -o jsonpath='{.spec.capability.memory}' 2>/dev/null || echo "")

  if [[ -n "$cap_cpu" || -n "$cap_mem" ]]; then
    echo "    Capability (max allowed):"
    [[ -n "$cap_cpu" ]] && echo "      CPU: $cap_cpu"
    [[ -n "$cap_mem" ]] && echo "      Memory: $cap_mem"
  fi

  # Check reclaimable
  local reclaimable
  reclaimable=$(kubectl get queue "$q" -o jsonpath='{.spec.reclaimable}' 2>/dev/null || echo "true")
  [[ "$reclaimable" != "false" ]] && reclaimable="true"
  echo "    Reclaimable: $reclaimable"
  [[ "$reclaimable" == "false" ]] && echo "      ℹ️  Resources cannot be reclaimed from this queue"

  # Show PodGroups if requested
  if [[ "$SHOW_PODS" == "true" ]]; then
    echo
    echo "  PodGroups in this Queue:"
    local pgs
    pgs=$(kubectl get podgroups --all-namespaces -o json 2>/dev/null | \
      jq -r --arg q "$q" '.items[] | select(.spec.queue==$q) | "    \(.metadata.namespace)/\(.metadata.name): \(.status.phase // \"Unknown\")"' 2>/dev/null || echo "")

    if [[ -n "$pgs" ]]; then
      echo "$pgs"
    else
      echo "    No PodGroups found"
    fi

    # Show pending count specifically
    local pending_pgs
    pending_pgs=$(kubectl get podgroups --all-namespaces -o json 2>/dev/null | \
      jq -r --arg q "$q" '.items[] | select(.spec.queue==$q and .status.phase=="Pending") | "\(.metadata.namespace)/\(.metadata.name)"' 2>/dev/null || echo "")

    if [[ -n "$pending_pgs" ]]; then
      echo
      echo "  ⚠️  Pending PodGroups:"
      echo "$pending_pgs" | while read -r pg; do
        echo "    - $pg"
      done
    fi
  fi

  # Verbose output
  if [[ "$VERBOSE" == "true" ]]; then
    echo
    echo "  Raw Queue YAML:"
    kubectl get queue "$q" -o yaml 2>/dev/null | sed 's/^/    /'
  fi

  echo
}

# Main logic
if [[ -n "$QUEUE" ]]; then
  # Diagnose specific queue
  if ! kubectl get queue "$QUEUE" &>/dev/null; then
    echo "Error: Queue '$QUEUE' not found" >&2
    exit 1
  fi
  diagnose_queue "$QUEUE"
else
  # Diagnose all queues
  echo "[1] Listing all queues"
  echo "---------------------"
  kubectl get queue -o custom-columns='NAME:.metadata.name,STATE:.status.state,WEIGHT:.spec.weight,PENDING:.status.pending,RUNNING:.status.running' 2>/dev/null || {
    echo "Error: Failed to list queues" >&2
    exit 1
  }
  echo

  echo "[2] Resource Allocation Summary"
  echo "--------------------------------"
  # Print table header
  printf "%-20s %-8s %-10s %-12s %-15s %-12s\n" "QUEUE" "STATE" "WEIGHT" "CPU_RATIO" "MEM_ALLOC" "PODS(P/R)"
  printf "%-20s %-8s %-10s %-12s %-15s %-12s\n" "--------------------" "--------" "----------" "------------" "---------------" "-----------"
  
  # Helper: convert K8s CPU value (e.g. "500m", "2", "1.5") to millicores
  cpu_to_milli() {
    local v="$1"
    if [[ "$v" =~ ^([0-9]+)m$ ]]; then
      echo "${BASH_REMATCH[1]}"
    elif [[ "$v" =~ ^[0-9]+\.?[0-9]*$ ]]; then
      awk "BEGIN {printf \"%.0f\", $v * 1000}" 2>/dev/null || echo "0"
    else
      echo "0"
    fi
  }

  # Get all queue names and print resource summary
  kubectl get queue -o json 2>/dev/null | jq -r '.items[] |
    [.metadata.name,
     (.status.state // "Unknown"),
     (.spec.weight // 1),
     (.status.deserved.cpu // "0"),
     (.status.allocated.cpu // "0"),
     (.status.allocated.memory // "N/A"),
     (.status.pending // 0),
     (.status.running // 0)] | @tsv' 2>/dev/null | \
  while IFS=$'\t' read -r name state weight deserved_cpu_raw alloc_cpu_raw mem_alloc pending running; do
    ratio=0
    deserved_m=$(cpu_to_milli "$deserved_cpu_raw")
    alloc_m=$(cpu_to_milli "$alloc_cpu_raw")
    if [[ "$deserved_m" -gt 0 ]]; then
      ratio=$((alloc_m * 100 / deserved_m))
    fi

    status_indicator=""
    if [[ "$state" == "Closed" ]]; then
      status_indicator="🚫"
    elif [[ "$state" == "Closing" ]]; then
      status_indicator="⚠️"
    elif [[ "$ratio" -ge 90 ]]; then
      status_indicator="🔴"
    elif [[ "$ratio" -ge 75 ]]; then
      status_indicator="🟡"
    fi

    printf "%-20s %-8s %-10s %-12s %-15s %-12s %s\n" \
      "$name" "$state" "${weight:-1}" "${ratio}%" "${mem_alloc:-N/A}" "${pending:-0}/${running:-0}" "$status_indicator"
  done
  echo
  echo "Legend: 🚫=Closed ⚠️=Closing 🔴=>=90% 🟡=>=75%"
  echo

  echo "[3] Detailed Queue Analysis"
  echo "--------------------------"
  # Get all queue names
  kubectl get queue -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | while read -r q; do
    [[ -n "$q" ]] && diagnose_queue "$q"
  done
fi

# Summary
echo "=== Diagnosis Summary ==="

# Count queues by state
total=0
open_count=0
closed_count=0
closing_count=0

while read -r q; do
  [[ -z "$q" ]] && continue
  total=$((total + 1))
  state=$(kubectl get queue "$q" -o jsonpath='{.status.state}' 2>/dev/null || echo "Unknown")
  [[ "$state" == "Open" ]] && open_count=$((open_count + 1))
  [[ "$state" == "Closed" ]] && closed_count=$((closed_count + 1))
  [[ "$state" == "Closing" ]] && closing_count=$((closing_count + 1))
done < <(kubectl get queue -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n')

echo "Total Queues: $total"
echo "  Open: $open_count"
echo "  Closed: $closed_count"
echo "  Closing: $closing_count"

# Find queues with high pending
high_pending=$(kubectl get queue -o json 2>/dev/null | jq -r '.items[] | select(.status.pending > 5) | "\(.metadata.name) (\(.status.pending) pending)"' 2>/dev/null || echo "")
if [[ -n "$high_pending" ]]; then
  echo
  echo "⚠️  Queues with high pending (>5):"
  echo "$high_pending" | sed 's/^/  - /'
fi

echo
echo "=== Diagnosis Complete ==="
