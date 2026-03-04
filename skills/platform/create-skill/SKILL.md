---
name: create-skill
description: >-
  Guide for creating new Siclaw skills from troubleshooting conversations.
  When a user asks to save a workflow as a skill, follow this guide to produce
  a well-structured skill definition using the create_skill tool.
---

# Create Skill

## When to Use

Use this skill when the user asks you to:
- Turn a troubleshooting session into a reusable skill
- Create a new skill for a specific operational procedure
- Save a diagnosis workflow as a skill

## Skill Structure

A skill is a directory under `skills/` containing:

```
skills/<scope>/<skill-name>/
  SKILL.md          # Skill definition (required)
  scripts/          # Helper scripts (optional)
    run.sh
    diagnose.py
```

### SKILL.md Format

```markdown
---
name: <kebab-case-name>
description: >-
  One-line summary of what this skill does.
  Mention the execution tool if the skill uses scripts.
---

# <Skill Title>

## Purpose
What problem this skill solves and when to use it.

## Tool
<execution tool invocation syntax — required for script-based skills>

## Parameters
Required and optional inputs in table format.

## Procedure
Step-by-step actions to perform, with concrete commands.

## Examples
Multiple concrete invocation examples with realistic parameters.
```

For skills WITHOUT scripts (pure kubectl guidance), omit the `## Tool` section and put commands directly in `## Procedure`.

### Simple Skill Example (no scripts)

A skill that guides the bot through kubectl commands — no scripts needed, no `## Tool` section:

```markdown
---
name: check-oom
description: >-
  Find pods that were OOMKilled and analyze their memory usage patterns
---

# Check OOM

## Purpose
Identify pods terminated due to Out-Of-Memory (OOMKilled) and suggest fixes.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| namespace | no | Target namespace. If omitted, search all namespaces |

## Procedure
1. Find OOMKilled pods:
   ```bash
   kubectl get pods -A -o json | jq '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled") | {namespace: .metadata.namespace, name: .metadata.name, container: .status.containerStatuses[] | select(.lastState.terminated.reason == "OOMKilled") | .name}'
   ```
2. For each affected pod, check current memory limits:
   ```bash
   kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].resources}'
   ```
3. Check actual memory usage before OOM:
   ```bash
   kubectl top pod <pod> -n <ns> --containers
   ```
4. Present findings in a table and recommend memory limit adjustments.

## Examples
- "Check for OOM killed pods in namespace prod"
- "Find pods that ran out of memory in the last hour"
- "Which pods got OOMKilled recently across all namespaces?"
```

### Script-based Skill Example (run_skill)

A skill with a helper script. Reference scripts using tool invocation syntax, NOT direct file paths:

```markdown
---
name: find-node
description: >-
  Fuzzy-match Kubernetes nodes by keyword
---

# Find Node

## Tool
run_skill: skill="find-node", script="find-node.sh", args="<keyword>"

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| keyword | yes | Search keyword — matches against node name, labels, and IP addresses |

## Examples
run_skill: skill="find-node", script="find-node.sh", args="gpu"
run_skill: skill="find-node", script="find-node.sh", args="192.168.1"
run_skill: skill="find-node", script="find-node.sh", args="worker-zone-a"
```

### Script-based Skill Example (node_script)

A skill that runs on a K8s node:

```markdown
---
name: node-logs
description: >-
  Retrieve logs from a Kubernetes node.
  Execute via node_script tool.
---

# Node Logs

## Tool
Use the `node_script` tool to run this skill:
node_script: node="<node>", skill="node-logs", script="get-node-logs.sh", args="<args>"

## Parameters

Required (one of):

| Parameter | Description |
|-----------|-------------|
| `--unit UNIT` | Systemd unit name (e.g. `containerd`, `kubelet`) |
| `--file PATH` | Log file path on the node (e.g. `/var/log/messages`) |

Optional:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--since DURATION` | `1h ago` | Time range for journalctl |
| `--grep PATTERN` | — | Case-insensitive grep filter |
| `--tail N` | `200` | Maximum number of output lines |

## Examples
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--unit containerd --tail 50"
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--unit kubelet --grep error --since 30m ago"
node_script: node="node-1", skill="node-logs", script="get-node-logs.sh", args="--file /var/log/messages --grep containerd --tail 100"
```

## How to Create a Skill

### Step 0: Check Completeness — Ask Before You Build

Before calling `create_skill`, review what you know and identify gaps. A good skill needs **all** of the following. If any are missing or vague, ask the user to clarify before proceeding:

| Required Info | What to check | Example question to ask |
|---|---|---|
| **Purpose** | Do you know exactly what problem this skill solves? | "This skill is for checking OOM pods — is it just detection, or should it also suggest fixes?" |
| **Scope / Target** | Is the target clear (namespace, cluster, service)? | "Should this skill work across all namespaces, or a specific one?" |
| **Concrete commands** | Do you have the actual commands/queries to run? | "What kubectl command do you use to check this? Can you share the exact steps?" |
| **Parameters** | Are the inputs well-defined (required vs optional, types)? | "Does this need a namespace parameter, or should it default to the current namespace?" |
| **Success criteria** | How should the output be interpreted? | "What does a healthy result look like vs an unhealthy one?" |
| **Edge cases** | Any special handling needed? | "What should happen if no pods are found? Should it check all containers or just the main one?" |

**Do NOT create a skill with placeholder procedures like "check the status" or "analyze the logs" — every step must have a concrete, executable action.** If the user describes the workflow vaguely (e.g. "make a skill that checks if the service is healthy"), guide them to specify the exact commands and criteria.

### Step 1–5: Build the Skill

1. **Identify the workflow** — What steps did you just perform? What commands were useful?
2. **Name it** — Use kebab-case: `check-pod-oom`, `analyze-network-latency`, `diagnose-crashloop`
3. **Write the specs** — Follow the SKILL.md format above. Include:
   - Clear purpose statement
   - `## Tool` section with invocation syntax (for script-based skills — see Script Execution Modes)
   - `## Parameters` table with required/optional columns
   - Step-by-step procedure with actual commands
   - Multiple concrete examples with realistic parameters
4. **Add scripts if needed** — If the workflow involves complex bash/python logic, create helper scripts
5. **Call `create_skill`** — Use the tool to output the structured definition:

```
create_skill({
  name: "check-pod-oom",
  description: "Find OOMKilled pods and analyze memory usage",
  type: "Monitoring",
  specs: "---\nname: check-pod-oom\n...",
  scripts: [{ name: "check-oom.sh", content: "#!/bin/bash\n..." }]
})
```

### Referencing User-Uploaded Scripts

If the user has uploaded scripts via the chat, you can reference them by filename — no need to read or embed the content:

```
create_skill({
  name: "custom-check",
  description: "Run user's custom check script",
  type: "Custom",
  specs: "---\nname: custom-check\n...",
  scripts: [{ name: "check.sh" }]
})
```

The server automatically copies the uploaded file into the skill's `scripts/` directory.

## Script Execution Modes

When a skill includes scripts, choose the correct execution tool based on **where** the script needs to run. Using the wrong tool will cause the script to fail or produce incorrect results.

| Tool | Runs where | When to use |
|------|-----------|-------------|
| `run_skill` | Local (AgentBox) | Scripts that call kubectl from outside the cluster (most common) |
| `node_script` | On a K8s node (host namespaces) | Scripts needing host tools, filesystem, /proc, /sys, devices |
| `pod_script` | Inside a pod (kubectl exec) | Scripts running diagnostics inside a running pod |
| `pod_netns_script` | Node + pod's network namespace | Network diagnostics needing host tools + pod's network view |

### Decision Guide

1. **Does the script just run kubectl commands?** → `run_skill` (default choice)
2. **Does it need access to a node's filesystem, processes, or hardware?** → `node_script`
3. **Does it need to run inside a specific pod's container?** → `pod_script`
4. **Does it need host network tools (tcpdump, ip, ss) scoped to a pod's network?** → `pod_netns_script`

### Examples for each mode

#### run_skill — local execution (most common)
```markdown
## Tool
run_skill: skill="find-node", script="find-node.sh", args="<keyword>"
```

#### node_script — execute on a K8s node
```markdown
## Tool
Use the `node_script` tool:
node_script: node="<node>", skill="node-logs", script="get-node-logs.sh", args="--unit containerd"
```

#### pod_script — execute inside a pod
```markdown
## Tool
Use the `pod_script` tool:
pod_script: pod="<pod>", namespace="<ns>", skill="pod-diagnose", script="check.sh"
```

#### pod_netns_script — pod network namespace + host tools
```markdown
## Tool
Use the `pod_netns_script` tool:
pod_netns_script: pod="<pod>", namespace="<ns>", skill="pod-ping-gateway", script="ping-gateway.sh", args="--interface net1"
```

**Important**: Always document the chosen tool in a `## Tool` section within the SKILL.md so users and the bot know how to invoke the skill correctly.

## Best Practices

- **kebab-case names**: `check-pod-oom` not `checkPodOom`
- **Concise descriptions**: one line, no period at end
- **Specific procedures**: include actual kubectl commands, not vague instructions
- **`## Tool` for script skills**: always include a `## Tool` section with invocation syntax; never use raw file paths
- **`## Parameters` table**: list required and optional parameters with descriptions
- **Actionable examples**: show multiple real tool invocations with realistic parameters
- **Category selection**: choose from Monitoring, Network, Security, Database, Core, Utility, Automation, Custom
- **Scripts are optional**: simple skills that just guide the bot's kubectl usage don't need scripts
- **One concern per skill**: keep skills focused on a single task
- **User scripts by name**: when referencing uploaded scripts, just pass `{name: "file.sh"}` without content
