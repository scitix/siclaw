#!/bin/bash
set -euo pipefail

# Show gateway for a network interface on the current node.
# Runs ON the node via node_script tool (nsenter into host namespaces).

DEVICE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface) DEVICE="$2"; shift 2 ;;
    --help) echo "Usage: show-node-gateway.sh [--interface <dev>]"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Collect route JSON
if [[ -n "$DEVICE" ]]; then
  if ! ip -j link show dev "$DEVICE" >/dev/null 2>&1; then
    echo "Error: interface '$DEVICE' not found" >&2
    echo "Available interfaces:" >&2
    ip -o link show 2>/dev/null | awk -F': ' '{print "  " $2}' >&2
    exit 1
  fi
  ROUTE_JSON=$(ip -j route show dev "$DEVICE" 2>/dev/null)
else
  ROUTE_JSON=$(ip -j route show 2>/dev/null)
fi

# Interface type detection using rdma link + sysfs
RDMA_OUT=$(rdma link 2>/dev/null || true)

lookup_type() {
  local dev="$1"
  local type_num
  type_num=$(cat "/sys/class/net/$dev/type" 2>/dev/null || echo "1")
  if [ "$type_num" = "32" ]; then echo "IB"
  elif [ -n "$RDMA_OUT" ] && echo "$RDMA_OUT" | grep -qw "netdev $dev"; then echo "RoCE"
  else echo "Ethernet"; fi
}

# Parse gateways from route table
PARSED=$(echo "$ROUTE_JSON" | jq -r --arg fallback_dev "$DEVICE" '
  [.[] | select(.gateway != null) |
   {
     dst: .dst,
     gateway: .gateway,
     dev: (.dev // $fallback_dev),
     protocol: (.protocol // "-"),
     metric: (.metric // 0)
   }
  ] | sort_by(.metric) | unique_by(.dev + .gateway)')

GW_COUNT=$(echo "$PARSED" | jq 'length')

if [[ "$GW_COUNT" -eq 0 ]]; then
  ROUTE_COUNT=$(echo "$ROUTE_JSON" | jq 'length')
  if [[ "$ROUTE_COUNT" -eq 0 ]]; then
    if [[ -n "$DEVICE" ]]; then
      echo "No routes found for device '$DEVICE'"
    else
      echo "No routes found"
    fi
  else
    if [[ -n "$DEVICE" ]]; then
      echo "No gateway found for device '$DEVICE'"
      echo ""
      echo "Routes exist but are all directly connected (no 'via' gateway):"
      echo "$ROUTE_JSON" | jq -r '.[] | "  \(.dst) dev \(.dev) scope \(.scope // "link")"'
    else
      echo "No gateway found in any route"
    fi
  fi
  exit 0
fi

# Output table
if [[ -n "$DEVICE" ]]; then
  echo "Gateway for device '$DEVICE':"
else
  echo "Gateways:"
fi
echo ""
printf '  %-20s %-16s %-12s %-10s %-10s %-8s\n' "DESTINATION" "GATEWAY" "DEVICE" "TYPE" "PROTOCOL" "METRIC"
printf '  %-20s %-16s %-12s %-10s %-10s %-8s\n' "-----------" "-------" "------" "----" "--------" "------"
echo "$PARSED" | jq -r '.[] | "\(.dst)\t\(.gateway)\t\(.dev)\t\(.protocol)\t\(.metric)"' | \
  while IFS=$'\t' read -r dst gw dev proto metric; do
    itype=$(lookup_type "$dev")
    printf '  %-20s %-16s %-12s %-10s %-10s %-8s\n' "$dst" "$gw" "$dev" "$itype" "$proto" "$metric"
  done
