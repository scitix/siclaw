---
name: node-logs
description: >-
  Retrieve logs from a Kubernetes node.
  Supports journalctl (systemd units) and file-based logs.
  Use when you need to inspect node-level logs (containerd, kubelet, etc.).
  Execute via node_script tool.
---

# Node Logs

## Tool

Use the `node_script` tool to run this skill:

```
node_script: node="<node>", skill="node-logs", script="get-node-logs.sh", args="<args>"
```

## Parameters

Required (one of):

| Parameter | Description |
|-----------|-------------|
| `--unit UNIT` | Systemd unit name (e.g. `containerd`, `kubelet`). Use this **or** `--file`. |
| `--file PATH` | Log file path on the node (e.g. `/var/log/messages`). Use this **or** `--unit`. |

Optional:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--since DURATION` | `1h ago` | Time range for journalctl (only with `--unit`), e.g. `30m ago`, `2h ago`, `today` |
| `--grep PATTERN` | — | Case-insensitive grep filter pattern |
| `--tail N` | `200` | Maximum number of output lines |

## Examples

Check containerd logs on a node:
```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--unit containerd --tail 50"
```

Search containerd logs for a specific image:
```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args='--unit containerd --grep "myregistry.com/myapp" --since "2h ago"'
```

Check kubelet logs for errors:
```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args='--unit kubelet --grep "error" --since "30m ago"'
```

Read a log file on the node:
```
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args='--file /var/log/messages --grep "containerd" --tail 100'
```

## Use Cases

### Diagnose container runtime issues
Check containerd or cri-o logs when pods fail to start, images fail to pull, or containers crash unexpectedly.

### Investigate kubelet problems
Check kubelet logs for node-level issues like pod evictions, volume mount failures, or resource pressure.

### Check system logs
Read `/var/log/messages`, `/var/log/syslog`, or other log files for kernel or system-level issues affecting the node.
