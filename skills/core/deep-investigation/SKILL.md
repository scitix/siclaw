---
name: deep-investigation
description: >-
  Structured hypothesis-driven investigation for complex infrastructure issues.
  Triggered by /dp command or [Deep Investigation] UI toggle.
---

# Deep Investigation

A structured workflow for deep-diving into complex issues using hypothesis-driven
validation. When the user explicitly activates Deep Investigation mode (toggle, /dp,
Ctrl+I), follow this recommended structure. Outside of DP mode, use these tools
adaptively based on the situation.

## When to Use

- Complex issues requiring hypothesis-driven investigation with multiple potential root causes
- Issues involving RDMA/RoCE, network, or hardware that need systematic validation
- When the user explicitly requests deep investigation (toggle, /dp, Ctrl+I)
- When initial triage reveals multiple possible root causes

## When NOT to Use

- Simple questions answerable with 1-2 kubectl commands
- When the issue is already clear from initial triage

## Recommended Workflow (4 phases)

The following phases are a recommended structure. You may skip or merge phases
when the situation calls for it — e.g., skip straight to deep_search if the user
gives a clear direction, or end after triage if the answer is already apparent.

### Phase 1: Quick Triage

Gather environment context and confirm the problem exists.

1. Call `manage_checklist` to mark `triage` as `in_progress`.
2. Run targeted kubectl / diagnostic commands to confirm the symptom.
3. Call `manage_checklist` to mark `triage` as `done` with a brief summary.

### Phase 2: Propose Hypotheses

Formulate 3-5 ranked hypotheses based on triage findings.

1. Call `manage_checklist` to mark `hypotheses` as `in_progress`.
2. Call `propose_hypotheses` tool with your formatted hypothesis list.
3. In DP mode, this is a good point to pause for user input — the user may want
   to adjust hypotheses before committing to an expensive deep_search.
   If the user is actively engaged, wait for their confirmation.
   If the user gave a clear directive, you may proceed directly.

### Phase 3: Deep Search Validation

Validate hypotheses using parallel sub-agents.

1. Call `manage_checklist` to mark `deep_search` as `in_progress`.
2. Call `deep_search` tool with triageContext and the hypotheses.
3. When deep_search completes, call `manage_checklist` to mark `deep_search` as `done`.

### Phase 4: Present Findings

Synthesize the deep_search results into a conclusion.

1. Call `manage_checklist` to mark `conclusion` as `in_progress`.
2. Write a clear conclusion with root cause analysis and recommendations.
3. Call `manage_checklist` to mark `conclusion` as `done`.

### Phase 5: Feedback (optional)

After presenting findings, briefly ask if the diagnosis looks accurate.
Do NOT be pushy — a single sentence like "Let me know if this diagnosis
matches what you're seeing" is sufficient.

If the user confirms, corrects, or rejects the diagnosis:
1. Call `investigation_feedback` with the investigationId from deep_search results.
2. This improves future investigations by boosting/suppressing this diagnosis.

## Available Tools

| Tool | Purpose |
|------|---------|
| `manage_checklist` | Update checklist progress (items: triage, hypotheses, deep_search, conclusion) |
| `propose_hypotheses` | Present hypotheses to the user — a communication tool for aligning investigation direction |
| `deep_search` | Launch parallel sub-agent validation of hypotheses |
| `end_investigation` | End early — auto-skips remaining phases |
| `investigation_feedback` | Submit user feedback on diagnosis accuracy (confirmed/corrected/rejected) |

## Guidelines

1. **Use propose_hypotheses for communication**: Always use the tool (not plain text) to present hypotheses — it renders a proper UI card. Think of it as a way to align with the user on investigation direction, not as a mandatory gate.
2. **Be cost-aware with deep_search**: It launches parallel sub-agents consuming 30-60 tool calls. When the investigation direction is uncertain, use propose_hypotheses to get alignment first.
3. **Avoid redundant validation**: Let deep_search handle hypothesis validation with its parallel sub-agents. Running the same checks manually is inefficient.
4. **Use DP-specific tools during DP mode**: Prefer `manage_checklist` over `task_plan` during deep investigation to keep the checklist UI consistent.

## Early Exit

- If triage alone is sufficient to answer the question, present your findings and ask the user before ending.
- Call `end_investigation` to cleanly exit — it marks all remaining items as skipped.
