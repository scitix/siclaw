---
name: skill-authoring
description: >-
  Guide for writing and improving Siclaw skills. Read this before creating or
  modifying a skill. Covers SKILL.md format, script execution modes, and
  best practices.
---

# Skill Authoring Guide

Read this guide before creating a new skill or improving an existing one.

## When to Use

- User asks to turn a troubleshooting workflow into a reusable skill
- User asks to modify or improve an existing skill
- User asks to create a diagnostic procedure as a skill

## Output

Use the `skill_preview` tool to output the final skill content. Do NOT output raw SKILL.md in your message — it gets rendered as HTML and the user cannot copy it.

**Workflow**: first explain what you built or changed and why, then call `skill_preview` with the complete SKILL.md and scripts.

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

Choose the tool based on WHERE the script needs to run:

| Tool | Runs where | When to use |
|------|-----------|-------------|
| `local_script` | AgentBox (local) | kubectl commands from outside the cluster — **most common** |
| `node_script` | K8s node (host) | Needs host tools, /proc, /sys, devices, nsenter |
| `pod_script` | Inside a pod | Diagnostics running inside a running container |
| `node_script` + `netns` | Node + pod's network ns | Host tools + pod's network view (call `resolve_pod_netns` first) |

## Best Practices

### Structure

- **One skill, one purpose** — a skill should solve one specific problem, not be a Swiss army knife
- **Script over inline commands** — if the procedure has more than 3 steps, write a script. One `local_script` call is better than 5 sequential `restricted_bash` calls
- **Idempotent and read-only** — skills are for diagnosis, not remediation. Never modify cluster state

### SKILL.md

- **Description field is critical** — the agent uses it to decide whether to use this skill. Be specific: "Diagnose NVLink CRC errors on GPU nodes" not "GPU diagnostics"
- **Concrete examples** — always include at least 2 examples with realistic parameters. The agent copies these patterns
- **Explain expected output** — after each command, describe what normal vs abnormal output looks like so the agent can interpret results
- **Scope boundaries** — explicitly state what the skill does NOT cover, to prevent misuse

### Scripts

- **Parse and summarize** — a script that runs 5 commands and outputs structured results is far better than dumping raw output. The agent has limited context window
- **Error handling** — check if commands exist before running them (`command -v nvidia-smi`). Print clear error messages, not cryptic exit codes
- **Arguments** — use positional args or flags, document them in the SKILL.md Parameters section
- **Shebang** — always start with `#!/bin/bash` or `#!/usr/bin/env python3`
- **Exit codes** — exit 0 on success, non-zero on failure. The agent checks exit codes

### Common Mistakes

- **Too much output** — dumping `kubectl describe` or `dmesg` without filtering. Grep/awk for the relevant lines
- **Missing Tool section** — without `## Tool`, the agent doesn't know which execution tool to use
- **Wrong execution mode** — using `node_exec` for kubectl commands (use `local_script`), or `local_script` for host-level tools (use `node_script`)
- **Hardcoded values** — node names, namespaces, pod names should be parameters, not hardcoded
- **No severity guidance** — when checking error counters, give thresholds so the agent can judge severity (e.g., CRC errors: 0 = normal, 1-100 = minor, >1000 = critical)
