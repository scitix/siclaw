---
name: skill-authoring
description: >-
  Guide for writing and improving Siclaw skills. Read this when creating or
  modifying a skill. Covers skill directory layout, SKILL.md format, script
  execution modes, and best practices.
---

# Skill Authoring Guide

Read this guide before creating a new skill or improving an existing one.

## Directory Layout

A skill is a directory package, not a single file. The smallest valid skill is:

```text
<skill-name>/
└── SKILL.md
```

Optional package files can live beside `SKILL.md`:

```text
<skill-name>/
├── SKILL.md
├── scripts/        # executable .sh/.py helpers
├── references/     # markdown docs the agent can read
├── examples/       # example inputs/outputs
└── assets/         # small images or other package assets
```

The directory name must match the `name` field in `SKILL.md`. Use uppercase
`SKILL.md`; lowercase `skill.md` is not canonical.

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
| `host_script` | A host via SSH | Host-level tools on a node reachable via SSH. **Preferred over `node_script`** — runs over SSH with no debug pod (lighter, leaves the node untouched) |
| `node_script` | K8s node (host) | Host tools, /proc, /sys, devices, nsenter. The **fallback** when the node is not an SSH host, or whenever a pod's `netns` is needed |
| `pod_script` | Inside a pod | Diagnostics inside a running container |
| `node_script` + `pod` | Node + pod's network ns | Host tools + pod's network view (pass `pod=` — node + netns resolved automatically) |

**Host vs node for host-level skills.** `host_script` and `node_script` take the **same** `skill`/`script`/`args` — only the target differs (`host="<id>"` vs `node="<name>"`). For a host-level skill, write the `## Tool` line as `host_script` (preferred) / `node_script` (fallback) and keep the Examples in one form — the agent picks the right tool at runtime based on `host_list`. Do **not** duplicate every example across both tools.

**Exception — pod's netns cannot degrade to host.** A skill that enters a pod's network namespace uses `node_script` with `pod=` (a privileged debug pod with `nsenter`). `host_script` has no netns path, so these skills **must** stay on `node_script` — never offer a `host_script` form for them.

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
- **Wrong execution mode** — using `local_script` for host-level tools (use `host_script`/`node_script`)
- **Forcing `node_script` for host-level skills** — prefer `host_script` (SSH, no debug pod); fall back to `node_script`. Exception: pod-`netns` skills must stay on `node_script`
- **Hardcoded values** — node names, namespaces should be parameters
- **No severity guidance** — e.g., CRC errors: 0 = normal, 1-100 = minor, >1000 = critical
