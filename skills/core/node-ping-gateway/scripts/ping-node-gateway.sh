#!/bin/bash
set -euo pipefail

# Ping a node's gateway for a given network interface.
# Runs ON the node via node_script tool (nsenter into host namespaces).
# Auto-detects gateway IP from the routing table, then pings it.

IFACE=""
SRC_MODE=""
COUNT=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interface)  IFACE="$2";      shift 2 ;;
    --source-ip)  SRC_MODE="ip";   shift ;;
    --source-dev) SRC_MODE="dev";  shift ;;
    --count)      COUNT="$2";      shift 2 ;;
    --help)
      echo "Usage: ping-node-gateway.sh --interface <iface> [--source-ip|--source-dev] [--count <n>]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$IFACE" ]]; then
  echo "Error: --interface is required" >&2
  exit 1
fi

# Get gateway from routing table
GW=$(ip -j route show dev "$IFACE" 2>/dev/null | jq -r '[.[] | select(.gateway != null)] | sort_by(.metric // 0) | .[0].gateway // empty')
if [[ -z "$GW" ]]; then
  echo "No gateway found for interface '$IFACE'" >&2
  exit 1
fi

echo "Gateway for $IFACE: $GW"

# Build ping args
PING_ARGS="-c $COUNT -W 2"
if [[ "$SRC_MODE" == "ip" ]]; then
  SRC_IP=$(ip -4 -j addr show dev "$IFACE" 2>/dev/null | jq -r '.[0].addr_info[0].local // empty')
  if [[ -z "$SRC_IP" ]]; then
    echo "Error: no IPv4 address found on interface '$IFACE'" >&2
    exit 1
  fi
  PING_ARGS="$PING_ARGS -I $SRC_IP"
  echo "Source IP: $SRC_IP"
elif [[ "$SRC_MODE" == "dev" ]]; then
  PING_ARGS="$PING_ARGS -I $IFACE"
  echo "Source dev: $IFACE"
fi

# Ping
PING_OUTPUT=$(ping $PING_ARGS "$GW" 2>&1) || true

# Parse results
TRANSMITTED=$(echo "$PING_OUTPUT" | grep -oP '\d+(?= packets transmitted)' || echo "0")
RECEIVED=$(echo "$PING_OUTPUT" | grep -oP '\d+(?= received)' || echo "0")
AVG_RTT=$(echo "$PING_OUTPUT" | grep -oP 'rtt [^=]+=\s*[\d.]+/([\d.]+)' | grep -oP '[\d.]+' | sed -n '2p' || echo "")

if [[ "$RECEIVED" -gt 0 ]]; then
  if [[ -n "$AVG_RTT" ]]; then
    echo "Result: reachable ($RECEIVED/$TRANSMITTED packets, avg ${AVG_RTT}ms)"
  else
    echo "Result: reachable ($RECEIVED/$TRANSMITTED packets)"
  fi
else
  echo "Result: unreachable ($RECEIVED/$TRANSMITTED packets)"
fi
