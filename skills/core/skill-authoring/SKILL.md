---
name: skill-authoring
description: >-
  Guide for writing and improving Siclaw skills. Read this when creating or
  modifying a skill. Covers SKILL.md format, script execution modes, and
  best practices.
---

# Skill Authoring Guide

Read this guide before creating a new skill or improving an existing one.

## SKILL.md Format

```yaml
---
name: <kebab-case-name>
description: >-
  One-line summary. Mention the execution tool if the skill uses scripts.
---
```

Followed by markdown body:

```markdown
# <Title>

## Purpose
What problem this skill solves and when to use it.

## Tool
<execution tool invocation — required for script-based skills>
Example: local_script: skill="check-pod-oom", script="check.sh", args="<ns> <pod>"

## Parameters
| Parameter | Required | Description |
|-----------|----------|-------------|
| `<arg1>`  | Yes      | ...         |

## Procedure
Step-by-step actions with concrete commands.

## Examples
Concrete tool invocations with realistic parameters.
```

## Script Execution Modes

| Tool | Runs where | When to use |
|------|-----------|-------------|
| `local_script` | AgentBox (local) | kubectl commands from outside the cluster — **most common** |
| `node_script` | K8s node (host) | Needs host tools, /proc, /sys, devices, nsenter |
| `pod_script` | Inside a pod | Diagnostics inside a running container |
| `node_script` + `netns` | Node + pod's network ns | Host tools + pod's network view (call `resolve_pod_netns` first) |

## Best Practices

- **One skill, one purpose** — don't make Swiss army knives
- **Script over inline commands** — if the procedure has more than 3 steps, write a script
- **Idempotent and read-only** — skills are for diagnosis, not remediation
- **Description is critical** — the agent uses it to decide whether to use this skill
- **Concrete examples** — at least 2 examples with realistic parameters
- **Explain expected output** — describe what normal vs abnormal output looks like
- **Severity thresholds** — when checking error counters, give thresholds so the agent can judge

## Common Mistakes

- **Too much raw output** — dump kubectl describe without filtering. Grep for relevant lines
- **Missing Tool section** — without it, the agent doesn't know which execution tool to use
- **Wrong execution mode** — using `local_script` for host-level tools (use `node_script`)
- **Hardcoded values** — node names, namespaces should be parameters
- **No severity guidance** — e.g., CRC errors: 0 = normal, 1-100 = minor, >1000 = critical
