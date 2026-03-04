# Siclaw

AI assistant for Kubernetes cluster analysis and SRE operations.

## Usage
- `siclaw` — Interactive TUI mode
- `siclaw --prompt "check pod status in production"` — Single-shot execution
- `siclaw --continue` — Resume last session

## Custom Tool: kubectl
The kubectl tool enforces read-only access. Allowed subcommands:
get, describe, logs, top, events, api-resources, api-versions,
cluster-info, config, version, explain, auth.

## Custom Tool: bash (restricted)
Restricted shell that only allows kubectl + text processing (grep, awk, jq, etc.).
Additionally, `bash`/`sh` can invoke scripts under `skills/core/` — the path is
resolved via `realpath` to prevent traversal attacks.
**Important**: Before using any skill, read its `SKILL.md` first. Not all skills have
scripts — some are agent-only diagnostic guides. Never guess script names or paths.

## Skill: pod-show-gateway
Show the gateway for a network interface in a Kubernetes pod.
Script: `skills/core/pod-show-gateway/scripts/show-gateway.sh`

Reads the routing table via `ip -j route` inside the pod to find gateways.

Usage: `bash skills/core/pod-show-gateway/scripts/show-gateway.sh --pod <pod> --namespace <ns> [--interface <iface>]`
See `skills/core/pod-show-gateway/SKILL.md` for full options.

## Skill: node-show-gateway
Show the gateway for a network interface on a Kubernetes node.
Script: `skills/core/node-show-gateway/scripts/show-node-gateway.sh`

Reads the routing table via `ip -j route` on the host via debug pod + nsenter.

Usage: `bash skills/core/node-show-gateway/scripts/show-node-gateway.sh --node <node> [--interface <iface>]`
See `skills/core/node-show-gateway/SKILL.md` for full options.

## Skill: pod-ping-gateway
Ping a pod's gateway for a given network interface.
Script: `skills/core/pod-ping-gateway/scripts/ping-gateway.sh`

Auto-detects gateway IP from the routing table, then pings it.
Optional flags: `--source-ip` (auto-detect IP as source) or `--source-dev` (use interface as source).

Usage: `bash skills/core/pod-ping-gateway/scripts/ping-gateway.sh --pod <pod> --namespace <ns> --interface <iface> [--source-ip|--source-dev]`
See `skills/core/pod-ping-gateway/SKILL.md` for full options.

## Skill: node-ping-gateway
Ping a node's gateway for a given network interface.
Script: `skills/core/node-ping-gateway/scripts/ping-node-gateway.sh`

Auto-detects gateway IP from the routing table via debug pod + nsenter, then pings it.
Optional flags: `--source-ip` (auto-detect IP as source) or `--source-dev` (use interface as source).

Usage: `bash skills/core/node-ping-gateway/scripts/ping-node-gateway.sh --node <node> --interface <iface> [--source-ip|--source-dev]`
See `skills/core/node-ping-gateway/SKILL.md` for full options.

## Skill: find-node
Fuzzy-match Kubernetes nodes by keyword (`kubectl get nodes -o wide | grep`).
Script: `skills/core/find-node/scripts/find-node.sh`

Usage: `bash skills/core/find-node/scripts/find-node.sh <keyword>`
