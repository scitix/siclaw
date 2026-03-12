#!/bin/bash
# Query cluster node resources for Volcano scheduling.
# This script performs read-only operations using kubectl.
set -euo pipefail

show_help() {
  cat <<EOF
Usage: $0 [options]

Query cluster node resources to understand capacity and availability.
Checks allocatable CPU, memory, GPU, and current usage.

Options:
  --node NODE       Query specific node only
  --label LABEL     Filter nodes by label (e.g., gpu=true)
  --show-usage      Show current resource usage (requires metrics-server)
  --show-pods       Show pods running on each node
  --format FORMAT   Output format: table (default), json, wide
  -h, --help        Show this help message

Examples:
  $0                                  # All nodes
  $0 --node worker-1                  # Specific node
  $0 --label nvidia.com/gpu.present=true  # GPU nodes
  $0 --show-usage --show-pods         # With usage and pods
  $0 --format json                    # JSON output
EOF
  exit 0
}

# Parse arguments
NODE=""
LABEL=""
SHOW_USAGE=false
SHOW_PODS=false
FORMAT="table"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --node) NODE="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --show-usage) SHOW_USAGE=true; shift ;;
    --show-pods) SHOW_PODS=true; shift ;;
    --format) FORMAT="$2"; shift 2 ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

# Validate format
if [[ "$FORMAT" != "table" && "$FORMAT" != "json" && "$FORMAT" != "wide" ]]; then
  echo "Error: Invalid format '$FORMAT'. Use: table, json, or wide" >&2
  exit 1
fi

echo "=== Volcano Node Resources ==="
[[ -n "$NODE" ]] && echo "Node: $NODE"
[[ -n "$LABEL" ]] && echo "Label filter: $LABEL"
echo "Show usage: $SHOW_USAGE"
echo "Show pods: $SHOW_PODS"
echo "Format: $FORMAT"
echo

# Build kubectl get nodes command
NODE_CMD="kubectl get nodes"
[[ -n "$LABEL" ]] && NODE_CMD="$NODE_CMD -l $LABEL"
[[ -n "$NODE" ]] && NODE_CMD="$NODE_CMD $NODE"

# Check if nodes exist
if ! $NODE_CMD -o name &>/dev/null; then
  echo "Error: No nodes found matching criteria" >&2
  exit 1
fi

# Function to get node resources
get_node_resources() {
  local node="$1"

  # Get allocatable resources
  local cpu_alloc mem_alloc gpu_alloc pods_alloc
  cpu_alloc=$(kubectl get node "$node" -o jsonpath='{.status.allocatable.cpu}' 2>/dev/null || echo "N/A")
  mem_alloc=$(kubectl get node "$node" -o jsonpath='{.status.allocatable.memory}' 2>/dev/null || echo "N/A")
  gpu_alloc=$(kubectl get node "$node" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}' 2>/dev/null || echo "0")
  pods_alloc=$(kubectl get node "$node" -o jsonpath='{.status.allocatable.pods}' 2>/dev/null || echo "N/A")

  # Get capacity
  local cpu_cap mem_cap
  cpu_cap=$(kubectl get node "$node" -o jsonpath='{.status.capacity.cpu}' 2>/dev/null || echo "N/A")
  mem_cap=$(kubectl get node "$node" -o jsonpath='{.status.capacity.memory}' 2>/dev/null || echo "N/A")

  # Get status and age
  local status age
  status=$(kubectl get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  # Calculate age in days (cross-platform: GNU date on Linux, BSD date on macOS)
  age=$(kubectl get node "$node" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null | {
    IFS= read -r timestamp
    if [[ -n "$timestamp" ]]; then
      if date -d "$timestamp" +%s &>/dev/null 2>&1; then
        # GNU date (Linux)
        created=$(date -d "$timestamp" +%s 2>/dev/null)
      else
        # BSD date (macOS)
        created=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$timestamp" +%s 2>/dev/null)
      fi
      now=$(date +%s)
      if [[ -n "$created" && -n "$now" ]]; then
        echo $(( (now - created) / 86400 ))
      else
        echo "N/A"
      fi
    else
      echo "N/A"
    fi
  })

  # Get taints
  local taints
  taints=$(kubectl get node "$node" -o jsonpath='{.spec.taints[*].key}' 2>/dev/null || echo "")

  # Get allocated resources (from describe)
  local cpu_req mem_req
  if describe_output=$(kubectl describe node "$node" 2>/dev/null); then
    cpu_req=$(echo "$describe_output" | grep -A 5 "Allocated resources" | grep "cpu-requests" | awk '{print $2}' || echo "N/A")
    mem_req=$(echo "$describe_output" | grep -A 5 "Allocated resources" | grep "memory-requests" | awk '{print $2}' || echo "N/A")
  else
    cpu_req="N/A"
    mem_req="N/A"
  fi

  # Calculate available (rough estimate)
  local cpu_avail="N/A"
  local mem_avail="N/A"

  # Try to calculate if we have numeric values
  if [[ "$cpu_alloc" =~ ^[0-9]+$ && "$cpu_req" =~ ^[0-9]+m?$ ]]; then
    # Convert millicores to cores if needed
    local alloc_val req_val
    alloc_val=$cpu_alloc
    if [[ "$cpu_req" =~ m$ ]]; then
      req_val=$(echo "${cpu_req%m}" | awk '{print $1/1000}')
    else
      req_val=$cpu_req
    fi
    cpu_avail=$(awk "BEGIN {printf \"%.0f\", $alloc_val - $req_val}")
  fi

  # Output based on format
  case "$FORMAT" in
    table)
      echo "Node: $node"
      echo "  Status: $status"
      echo "  Age: ${age}d"
      [[ -n "$taints" ]] && echo "  Taints: $taints"
      echo "  Resources:"
      echo "    CPU:        Allocatable=$cpu_alloc | Requested=$cpu_req | Available=$cpu_avail"
      echo "    Memory:     Allocatable=$mem_alloc | Requested=$mem_req | Available=$mem_avail"
      [[ "$gpu_alloc" != "0" ]] && echo "    GPU:        Allocatable=$gpu_alloc"
      [[ "$SHOW_USAGE" == "true" ]] && echo "    Usage:      (see metrics below)"

      if [[ "$SHOW_USAGE" == "true" ]]; then
        echo
        echo "  Resource Usage (requires metrics-server):"
        if kubectl top node "$node" 2>/dev/null; then
          : # success
        else
          echo "    (Metrics not available)"
        fi
      fi

      if [[ "$SHOW_PODS" == "true" ]]; then
        echo
        echo "  Running Pods:"
        kubectl get pods --all-namespaces --field-selector spec.nodeName="$node" -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory' 2>/dev/null | head -20 || echo "    (Failed to list pods)"
      fi
      echo
      ;;

    wide)
      echo "$node $cpu_alloc $mem_alloc $gpu_alloc $status ${age}d"
      ;;

    json)
      echo "  {"
      echo "    \"name\": \"$node\","
      echo "    \"status\": \"$status\","
      echo "    \"age_days\": $age,"
      [[ -n "$taints" ]] && echo "    \"taints\": \"$taints\","
      echo "    \"allocatable\": {"
      echo "      \"cpu\": \"$cpu_alloc\","
      echo "      \"memory\": \"$mem_alloc\","
      echo "      \"gpu\": \"$gpu_alloc\","
      echo "      \"pods\": \"$pods_alloc\""
      echo "    },"
      echo "    \"requested\": {"
      echo "      \"cpu\": \"$cpu_req\","
      echo "      \"memory\": \"$mem_req\""
      echo "    },"
      echo "    \"available\": {"
      echo "      \"cpu\": \"$cpu_avail\","
      echo "      \"memory\": \"$mem_avail\""
      echo "    }"
      echo "  }"
      ;;
  esac
}

# Main logic
case "$FORMAT" in
  table|wide)
    if [[ "$FORMAT" == "wide" ]]; then
      echo "NAME CPU_ALLOC MEM_ALLOC GPU_ALLOC STATUS AGE"
      echo "==== ========= ========= ========= ====== ===="
    fi

    if [[ -n "$NODE" ]]; then
      get_node_resources "$NODE"
    else
      # Use process substitution instead of pipe to avoid subshell
      while read -r n; do
        [[ -n "$n" ]] && get_node_resources "$n"
      done < <(kubectl get nodes ${LABEL:+-l $LABEL} -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n')
    fi
    ;;

  json)
    echo "{"
    echo "  \"nodes\": ["

    # Use process substitution to avoid subshell issue with 'first' variable
    first=true
    if [[ -n "$NODE" ]]; then
      get_node_resources "$NODE"
    else
      while read -r n; do
        if [[ -n "$n" ]]; then
          [[ "$first" == "false" ]] && echo ","
          get_node_resources "$n"
          first=false
        fi
      done < <(kubectl get nodes ${LABEL:+-l $LABEL} -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n')
    fi

    echo
    echo "  ]"
    echo "}"
    ;;
esac

# Summary for table format
if [[ "$FORMAT" == "table" ]]; then
  echo "=== Summary ==="

  # Count nodes by status
  total=$(kubectl get nodes ${LABEL:+-l $LABEL} 2>/dev/null | wc -l)
  total=$((total - 1))  # Subtract header
  ready=$(kubectl get nodes ${LABEL:+-l $LABEL} 2>/dev/null | grep -c " Ready " || echo "0")
  not_ready=$((total - ready))

  echo "Total Nodes: $total"
  echo "  Ready: $ready"
  echo "  NotReady: $not_ready"

  # Check for GPU nodes
  gpu_nodes=$(kubectl get nodes ${LABEL:+-l $LABEL} -o jsonpath='{.items[*].status.allocatable.nvidia\.com/gpu}' 2>/dev/null | tr ' ' '\n' | grep -v "^0$" | grep -v "^$" | wc -l)
  if [[ "$gpu_nodes" -gt 0 ]]; then
    echo "  GPU Nodes: $gpu_nodes"
  fi

  # Check metrics availability
  if [[ "$SHOW_USAGE" == "true" ]]; then
    echo
    if kubectl top nodes &>/dev/null; then
      echo "Metrics-server: Available"
    else
      echo "Metrics-server: Not Available (kubectl top nodes failed)"
    fi
  fi
fi

echo
echo "=== Query Complete ==="
