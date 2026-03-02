#!/bin/bash
set -euo pipefail

# Show gateway for a network interface in a pod's network namespace.
# Runs via pod_netns_script tool (nsenter -n into pod's netns).
# Network namespace = pod's; mount namespace = host's (host tools available).

DEVICE=""
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface) DEVICE="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    --help) echo "Usage: show-gateway.sh [--interface <dev>] [--json]"; exit 0 ;;
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
     scope: (.scope // "-"),
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

# Output
if [[ "$JSON_OUTPUT" == true ]]; then
  DEVS=$(echo "$PARSED" | jq -r '.[].dev' | sort -u)
  TYPE_MAP_JSON="{"
  first=true
  for d in $DEVS; do
    t=$(lookup_type "$d")
    if $first; then first=false; else TYPE_MAP_JSON="${TYPE_MAP_JSON},"; fi
    TYPE_MAP_JSON="${TYPE_MAP_JSON}\"$d\":\"$t\""
  done
  TYPE_MAP_JSON="${TYPE_MAP_JSON}}"

  MERGED=$(echo "$PARSED" | jq --argjson tmap "$TYPE_MAP_JSON" '
    [.[] | . + {type: ($tmap[.dev] // "-")}]')
  if [[ -n "$DEVICE" ]]; then
    dev_type=$(lookup_type "$DEVICE")
    echo "$MERGED" | jq --arg dev "$DEVICE" --arg dtype "$dev_type" '{device: $dev, type: $dtype, gateways: .}'
  else
    echo "$MERGED" | jq '{gateways: .}'
  fi
else
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
fi
