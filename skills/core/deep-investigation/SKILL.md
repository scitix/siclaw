---
name: deep-investigation
description: >-
  Structured hypothesis-driven investigation for complex infrastructure issues.
  Triggered by /dp command or [Deep Investigation] UI toggle.
---

# Deep Investigation

A structured 4-phase workflow for deep-diving into complex issues that require
hypothesis-driven validation. This mode provides dedicated tools — you MUST use
them instead of ad-hoc investigation.

## When to Use

- Complex issues requiring hypothesis-driven investigation with multiple potential root causes
- Issues involving RDMA/RoCE, network, or hardware that need systematic validation
- When the user explicitly requests deep investigation (toggle, /dp, Ctrl+I)
- When initial triage reveals multiple possible root causes

## When NOT to Use

- Simple questions answerable with 1-2 kubectl commands
- When the issue is already clear from initial triage

## Workflow (4 phases)

### Phase 1: Quick Triage

Gather environment context and confirm the problem exists.

1. Call `manage_checklist` to mark `triage` as `in_progress`.
2. Run targeted kubectl / diagnostic commands to confirm the symptom.
3. Call `manage_checklist` to mark `triage` as `done` with a brief summary.

### Phase 2: Propose Hypotheses

Formulate 3-5 ranked hypotheses based on triage findings.

1. Call `manage_checklist` to mark `hypotheses` as `in_progress`.
2. Call `propose_hypotheses` tool with your formatted hypothesis list.
3. The tool returns a "waiting for user confirmation" message — **STOP here**.
   Do NOT call any more tools. Do NOT attempt to validate hypotheses yourself.
   Simply tell the user you are waiting for their confirmation.

### Phase 3: Deep Search Validation

After the user confirms (you will see a message saying "User has confirmed the hypotheses"):

1. Call `manage_checklist` to mark `deep_search` as `in_progress`.
2. Call `deep_search` tool with triageContext and the confirmed hypotheses.
   - If the gate blocks you (ERROR: user has not confirmed), STOP and wait.
3. When deep_search completes, call `manage_checklist` to mark `deep_search` as `done`.

### Phase 4: Present Findings

Synthesize the deep_search results into a conclusion.

1. Call `manage_checklist` to mark `conclusion` as `in_progress`.
2. Write a clear conclusion with root cause analysis and recommendations.
3. Call `manage_checklist` to mark `conclusion` as `done`.

## Available Tools

| Tool | Purpose |
|------|---------|
| `manage_checklist` | Update checklist progress (items: triage, hypotheses, deep_search, conclusion) |
| `propose_hypotheses` | Submit hypotheses for user review — renders a UI card |
| `deep_search` | Launch parallel sub-agent validation of confirmed hypotheses |
| `end_investigation` | End early — auto-skips remaining phases |

## Common Mistakes

1. **Text hypotheses**: Never output hypotheses as plain text. Always use `propose_hypotheses` tool — it renders a proper UI card for user interaction.
2. **Skip confirmation**: Never call `deep_search` before the user confirms hypotheses. The tool will return an error if you try.
3. **Manual validation**: Never validate hypotheses yourself with kubectl/bash. That's what `deep_search` does with parallel sub-agents and budget control.
4. **task_plan during DP**: Never call `task_plan` or `update_plan` during deep investigation. Use the DP-specific tools (`manage_checklist`, etc.) instead. `task_plan` is blocked during DP mode.
5. **Continue after propose**: After `propose_hypotheses` returns, STOP. Wait for user confirmation before doing anything else.

## Early Exit

- If triage alone is sufficient to answer the question, present your findings and **ask the user** before ending.
- Call `end_investigation` to cleanly exit — it marks all remaining items as skipped.
- Never silently skip phases without user consent.
