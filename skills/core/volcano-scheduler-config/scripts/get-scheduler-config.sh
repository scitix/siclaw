#!/bin/bash
# View Volcano scheduler configuration.
# This script performs read-only operations using kubectl.
set -euo pipefail

show_help() {
  cat <<EOF
Usage: $0 [options]

View Volcano scheduler configuration.
Check scheduler ConfigMap, actions, plugins, and tier settings.

Options:
  --section SECTION   Show specific section: actions, plugins, tiers, all (default: all)
  --format FORMAT     Output format: yaml, json, summary (default: summary)
  --raw               Show raw ConfigMap data without parsing
  -h, --help          Show this help message

Environment:
  VOLCANO_SCHEDULER_NS      Scheduler namespace (default: volcano-system)
  VOLCANO_SCHEDULER_CONFIG  ConfigMap name (default: volcano-scheduler-configmap)

Examples:
  $0                              # Summary of all config
  $0 --section actions            # Actions only
  $0 --section plugins            # Plugins only
  $0 --format yaml                # Full YAML output
  $0 --raw                        # Raw ConfigMap data
EOF
  exit 0
}

# Parse arguments
SECTION="all"
FORMAT="summary"
RAW=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) show_help ;;
    --section) SECTION="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --raw) RAW=true; shift ;;
    *) echo "Unknown option: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

# Validate arguments
if [[ "$SECTION" != "all" && "$SECTION" != "actions" && "$SECTION" != "plugins" && "$SECTION" != "tiers" ]]; then
  echo "Error: Invalid section '$SECTION'. Use: all, actions, plugins, or tiers" >&2
  exit 1
fi

if [[ "$FORMAT" != "summary" && "$FORMAT" != "yaml" && "$FORMAT" != "json" ]]; then
  echo "Error: Invalid format '$FORMAT'. Use: summary, yaml, or json" >&2
  exit 1
fi

# Environment settings
SCHEDULER_NS="${VOLCANO_SCHEDULER_NS:-volcano-system}"
CONFIG_NAME="${VOLCANO_SCHEDULER_CONFIG:-volcano-scheduler-configmap}"

echo "=== Volcano Scheduler Configuration ==="
echo "Namespace: $SCHEDULER_NS"
echo "ConfigMap: $CONFIG_NAME"
echo "Section: $SECTION"
echo "Format: $FORMAT"
echo

# Check if ConfigMap exists
if ! kubectl get cm "$CONFIG_NAME" -n "$SCHEDULER_NS" &>/dev/null; then
  echo "Error: ConfigMap '$CONFIG_NAME' not found in namespace '$SCHEDULER_NS'" >&2
  echo "Available ConfigMaps in $SCHEDULER_NS:" >&2
  kubectl get cm -n "$SCHEDULER_NS" 2>/dev/null | head -10 >&2 || echo "  (failed to list ConfigMaps)" >&2
  exit 1
fi

# Get raw configuration
CONFIG_DATA=$(kubectl get cm "$CONFIG_NAME" -n "$SCHEDULER_NS" -o jsonpath='{.data.volcano-scheduler\.conf}' 2>/dev/null || echo "")

if [[ -z "$CONFIG_DATA" ]]; then
  echo "Error: Config key 'volcano-scheduler.conf' not found in ConfigMap" >&2
  echo "Available keys:" >&2
  kubectl get cm "$CONFIG_NAME" -n "$SCHEDULER_NS" -o jsonpath='{.data}' 2>/dev/null | jq 'keys' 2>/dev/null || echo "  (could not list keys)" >&2
  exit 1
fi

# If raw mode, just output the raw data
if [[ "$RAW" == "true" ]]; then
  echo "Raw ConfigMap Data:"
  echo "===================="
  echo "$CONFIG_DATA"
  echo
  echo "=== Query Complete ==="
  exit 0
fi

# Parse configuration
# Extract actions line
ACTIONS_LINE=$(echo "$CONFIG_DATA" | grep "^actions:" | head -1 || echo "")
ACTIONS=$(echo "$ACTIONS_LINE" | sed 's/^actions:[[:space:]]*//' | sed 's/^"//;s/"$//')

# Extract tier and plugin information
# This is a simple parser - for complex YAML, we'd need yq
parse_plugins() {
  local tier_num=$1
  local in_tier=false
  local tier_count=0
  local plugins=""

  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*plugins: ]]; then
      if [[ "$in_tier" == "true" ]]; then
        break
      fi
      tier_count=$((tier_count + 1))
      if [[ $tier_count -eq $tier_num ]]; then
        in_tier=true
      fi
      continue
    fi

    if [[ "$in_tier" == "true" && "$line" =~ "name:" ]]; then
      local plugin_name
      plugin_name=$(echo "$line" | grep -o 'name:[[:space:]]*[^[:space:]]*' | sed 's/name:[[:space:]]*//' || echo "")
      if [[ -n "$plugin_name" ]]; then
        plugins="$plugins$plugin_name "
      fi
    fi
  done <<< "$CONFIG_DATA"

  echo "$plugins"
}

# Count number of tiers
TIER_COUNT=$(echo "$CONFIG_DATA" | grep -c "^[[:space:]]*- plugins:" || echo "0")

# Output based on format and section
case "$FORMAT" in
  summary)
    echo "Scheduler Configuration Summary"
    echo "================================"
    echo

    if [[ "$SECTION" == "all" || "$SECTION" == "actions" ]]; then
      echo "Actions:"
      echo "--------"
      if [[ -n "$ACTIONS" ]]; then
        echo "  $ACTIONS"
        echo

        # Explain each action
        IFS=',' read -ra action_list <<< "$ACTIONS"
        for action in "${action_list[@]}"; do
          action=$(echo "$action" | tr -d ' ')  # Remove spaces
          case "$action" in
            enqueue)
              echo "  - enqueue: Admit pod groups to queue"
              ;;
            allocate)
              echo "  - allocate: Allocate resources to pods"
              ;;
            backfill)
              echo "  - backfill: Fill idle resources (best-effort pods)"
              ;;
            preempt)
              echo "  - preempt: Evict low-priority pods"
              ;;
            reclaim)
              echo "  - reclaim: Reclaim over-allocated queue resources"
              ;;
            elect)
              echo "  - elect: Select target workload (removed in v1.6+)"
              ;;
          esac
        done
      else
        echo "  (Actions not found in configuration)"
      fi
      echo
    fi

    if [[ "$SECTION" == "all" || "$SECTION" == "plugins" || "$SECTION" == "tiers" ]]; then
      echo "Tiers and Plugins:"
      echo "------------------"
      echo "Total Tiers: $TIER_COUNT"
      echo

      for ((i=1; i<=TIER_COUNT; i++)); do
        tier_plugins=$(parse_plugins $i)
        echo "Tier $i Plugins:"
        if [[ -n "$tier_plugins" ]]; then
          for plugin in $tier_plugins; do
            echo "  - $plugin"
          done
        else
          echo "  (No plugins found)"
        fi
        echo
      done
    fi

    # Plugin explanations
    if [[ "$SECTION" == "all" || "$SECTION" == "plugins" ]]; then
      echo "Critical Plugins:"
      echo "-----------------"
      echo "  - gang: Gang scheduling (required for batch workloads)"
      echo "  - priority: Priority handling"
      echo "  - conformance: Protect critical pods"
      echo "  - proportion: Fair queue resource allocation"
      echo "  - drf: Dominant Resource Fairness"
      echo "  - predicates: Node filtering"
      echo

      # Check for missing critical plugins
      all_plugins=$(parse_plugins 1)$(parse_plugins 2)
      echo "Configuration Check:"
      echo "-------------------"

      if [[ "$all_plugins" =~ "gang" ]]; then
        echo "  ✓ Gang plugin: enabled"
      else
        echo "  ⚠ Gang plugin: NOT FOUND (Gang scheduling will not work)"
      fi

      if [[ "$all_plugins" =~ "proportion" ]]; then
        echo "  ✓ Proportion plugin: enabled"
      else
        echo "  ⚠ Proportion plugin: NOT FOUND (Queue fair-share disabled)"
      fi

      if [[ "$ACTIONS" =~ "reclaim" ]]; then
        echo "  ✓ Reclaim action: enabled"
      else
        echo "  ℹ Reclaim action: not enabled (resource reclaim disabled)"
      fi

      if [[ "$ACTIONS" =~ "preempt" ]]; then
        echo "  ✓ Preempt action: enabled"
      else
        echo "  ℹ Preempt action: not enabled (priority preemption disabled)"
      fi
    fi
    ;;

  yaml)
    echo "Scheduler Configuration (YAML):"
    echo "=============================="
    echo
    echo "$CONFIG_DATA"
    ;;

  json)
    # Simple JSON conversion (basic structure)
    echo "{"
    echo "  \"namespace\": \"$SCHEDULER_NS\","
    echo "  \"configmap\": \"$CONFIG_NAME\","

    if [[ -n "$ACTIONS" ]]; then
      echo "  \"actions\": ["
      IFS=',' read -ra action_list <<< "$ACTIONS"
      first=true
      for action in "${action_list[@]}"; do
        action=$(echo "$action" | tr -d ' ')
        [[ "$first" == "false" ]] && echo ","
        echo -n "    \"$action\""
        first=false
      done
      echo
      echo "  ],"
    fi

    echo "  \"tiers\": ["
    for ((i=1; i<=TIER_COUNT; i++)); do
      [[ $i -gt 1 ]] && echo ","
      tier_plugins=$(parse_plugins $i)
      echo "    {"
      echo "      \"tier\": $i,"
      echo "      \"plugins\": ["
      pfirst=true
      for plugin in $tier_plugins; do
        [[ "$pfirst" == "false" ]] && echo ","
        echo -n "        \"$plugin\""
        pfirst=false
      done
      echo
      echo "      ]"
      echo -n "    }"
    done
    echo
    echo "  ]"
    echo "}"
    ;;
esac

echo
echo "=== Query Complete ==="
