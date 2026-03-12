---
name: volcano-scheduler-config
description: >-
  View Volcano scheduler configuration.
  Check scheduler ConfigMap, actions, plugins, and tier settings.
---

# Volcano Scheduler Configuration

View Volcano scheduler configuration to understand scheduling policies, enabled plugins, and actions. This skill helps diagnose configuration-related scheduling behaviors.

**Scope:** This skill is for **diagnosis only**. It retrieves configuration for analysis but does not modify any cluster state.

## Usage

```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh [options]
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--section SECTION` | no | Show specific section: actions, plugins, tiers, all (default: all) |
| `--format FORMAT` | no | Output format: yaml, json, summary (default: summary) |
| `--raw` | no | Show raw ConfigMap data without parsing |

## Examples

Get summary of scheduler configuration:
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh
```

View actions configuration only:
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section actions
```

View plugins configuration:
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section plugins
```

Show full YAML configuration:
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --format yaml
```

Get raw ConfigMap:
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --raw
```

## Understanding Scheduler Configuration

### Configuration Location

The Volcano scheduler configuration is stored in:
- **Namespace:** `volcano-system`
- **ConfigMap:** `volcano-scheduler-configmap`
- **Key:** `volcano-scheduler.conf`

### Configuration Structure

```yaml
actions: "enqueue, allocate, backfill"  # Pipeline order
tiers:
- plugins:
  - name: priority
  - name: gang
  - name: conformance
- plugins:
  - name: overcommit
  - name: drf
  - name: predicates
  - name: proportion
  - name: nodeorder
  - name: binpack
```

### Actions

Actions define the **two-phase scheduling pipeline**:
1. **Enqueue phase** — PodGroup is admitted to the queue based on queue capacity (does the queue have enough deserved resources?)
2. **Allocate phase** — Individual pods are placed on nodes based on node resources, affinity, taints, etc.

A job can pass enqueue (PodGroup moves to `Inqueue`) but fail allocation (pods stay `Pending`) if node-level constraints block placement. This two-phase model explains the common scenario: "queue has capacity but pods won't schedule."

Actions in order:

| Action | Required | Purpose |
|--------|----------|---------|
| `enqueue` | Yes | Admit pod groups to queue |
| `allocate` | Yes | Allocate resources to pods |
| `backfill` | No | Fill idle resources with best-effort pods |
| `preempt` | No | Evict low-priority pods for high-priority |
| `reclaim` | No | Reclaim resources from over-allocated queues |
| `elect` | No | Select target workload (removed in v1.6+) |

### Tiers

Tiers divide plugins into priority levels:
- **Tier 1:** First to evaluate, results cannot be overridden
- **Tier 2:** Second to evaluate, lower priority

Common tier organization:
- **Tier 1:** Critical plugins (priority, gang, conformance)
- **Tier 2:** Resource and optimization plugins

### Plugins

#### Critical Plugins

| Plugin | Function | Critical For |
|--------|----------|--------------|
| `gang` | Gang scheduling | Batch jobs, ML training |
| `priority` | Priority sorting | Workload prioritization |
| `conformance` | Protect critical pods | System stability |

#### Resource Plugins

| Plugin | Function | Use Case |
|--------|----------|----------|
| `proportion` | Fair share allocation | Multi-tenant clusters |
| `drf` | Dominant Resource Fairness | Fair GPU/CPU sharing |
| `overcommit` | Allow overcommit | Resource efficiency |

#### Node Plugins

| Plugin | Function | Use Case |
|--------|----------|----------|
| `predicates` | Node filtering | Resource/affinity matching |
| `nodeorder` | Node ranking | Node selection optimization |
| `binpack` | Dense packing | Reduce fragmentation |
| `numaaware` | NUMA topology | HPC workloads |

#### Queue Plugins

| Plugin | Function | Use Case |
|--------|----------|----------|
| `priority` | Queue ordering | Queue prioritization |
| `proportion` | Proportional share | Fair queue allocation |

## Diagnostic Use Cases

### Case 1: Check If Gang Scheduling is Enabled

```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section plugins
```

Look for `name: gang` in the plugin list. If missing, Gang scheduling will not work.

### Case 2: Verify Reclaim is Enabled

```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section actions
```

Look for `reclaim` in the actions list. If missing, queues cannot reclaim resources.

### Case 3: Check Proportion Plugin Configuration

```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section plugins
```

Look for `name: proportion`. If missing, queue fair-share allocation is disabled.

### Case 4: Compare with Default Configuration

Default configuration:
```yaml
actions: "enqueue, allocate, backfill"
tiers:
- plugins:
  - name: priority
  - name: gang
    enablePreemptable: false
  - name: conformance
- plugins:
  - name: overcommit
  - name: drf
    enablePreemptable: false
  - name: predicates
  - name: proportion
  - name: nodeorder
  - name: binpack
```

If your configuration differs significantly, it may explain scheduling behaviors.

### Case 5: Check Plugin Arguments

Some plugins accept arguments:

```yaml
- name: overcommit
  arguments:
    overcommit-factor: "1.2"
```

Use `--format yaml` or `--raw` to see full plugin configurations including arguments.

## Common Configuration Issues

### Issue 1: Missing Gang Plugin

**Symptom:** PodGroups stay Pending, minMember never satisfied

**Check:**
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section plugins | grep gang
```

**Solution:** Add `gang` plugin to configuration

### Issue 2: Missing Reclaim Action

**Symptom:** Queues cannot reclaim resources from over-allocated queues

**Check:**
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section actions | grep reclaim
```

**Solution:** Add `reclaim` to actions list

### Issue 3: Wrong Action Order

**Symptom:** Unexpected scheduling behavior

**Check:**
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section actions
```

**Common orders:**
- Default: `enqueue, allocate, backfill`
- With preemption: `enqueue, allocate, backfill, preempt`
- With reclaim: `enqueue, allocate, backfill, reclaim`
- Full: `enqueue, allocate, backfill, preempt, reclaim`

**Important:** `enqueue` must come before `allocate`. `allocate` must be present.

### Issue 4: Plugin Tier Misconfiguration

**Symptom:** Priority/preemption not working as expected

**Check:**
```bash
bash skills/core/volcano-scheduler-config/scripts/get-scheduler-config.sh --section tiers
```

**Guideline:**
- Tier 1: Plugins that should not be overridden (priority, gang)
- Tier 2: Resource optimization plugins (proportion, binpack)

## Configuration Options Reference

### Plugin Arguments

| Plugin | Argument | Default | Description |
|--------|----------|---------|-------------|
| `gang` | `enablePreemptable` | `true` | Allow Gang pods to be preempted |
| `overcommit` | `overcommit-factor` | `1.2` | Multiplier for allocatable resources |
| `drf` | `enablePreemptable` | `true` | Allow DRF pods to be preempted |
| `nodeorder` | various weights | `0` | Node scoring weights |
| `proportion` | (none) | - | No arguments |
| `predicates` | `GPUSharingEnable` | `false` | Enable GPU sharing |

### Action-Specific Notes

#### Enqueue
- Evaluates `jobEnqueueableFn` from plugins
- Default `overcommit-factor` of 1.2 means 20% overcommit

#### Allocate
- Main allocation logic
- Calls `allocate` action for each tier

#### Backfill
- Only schedules best-effort pods (no resource requests)
- Ignores queue deserved resources

#### Preempt
- Requires `priority` plugin for comparison
- Requires `preemptableFn` from plugins

#### Reclaim
- Requires `proportion` plugin
- Requires `reclaimableFn` from plugins
- Reclaims from over-allocated queues

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOLCANO_SCHEDULER_NS` | `volcano-system` | Scheduler namespace |
| `VOLCANO_SCHEDULER_CONFIG` | `volcano-scheduler-configmap` | ConfigMap name |

## Output Formats

### Summary Format (default)

Human-readable summary:
```
Scheduler Configuration
=======================
Actions: enqueue, allocate, backfill

Tier 1 Plugins:
  - priority
  - gang
  - conformance

Tier 2 Plugins:
  - overcommit
  - drf
  - predicates
  - proportion
  - nodeorder
  - binpack
```

### YAML Format

Parsed YAML structure:
```yaml
actions: "enqueue, allocate, backfill"
tiers:
  - plugins:
      - name: priority
      - name: gang
```

### JSON Format

Machine-parseable:
```json
{
  "actions": "enqueue, allocate, backfill",
  "tiers": [
    {
      "plugins": [
        {"name": "priority"},
        {"name": "gang"}
      ]
    }
  ]
}
```

### Raw Format

ConfigMap raw output:
```
volcano-scheduler.conf:
---
actions: "enqueue, allocate, backfill"
tiers:
...
```

## See Also

- `volcano-queue-diagnose` - Queue resource analysis
- `volcano-gang-scheduling` - Gang scheduling issues
- `volcano-diagnose-pod` - Pod scheduling diagnosis
- `volcano-scheduler-logs` - Scheduler decision logs
