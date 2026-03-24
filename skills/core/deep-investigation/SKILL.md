---
name: deep-investigation
description: >-
  Structured hypothesis-driven investigation for complex infrastructure issues.
  Triggered ONLY by user action: /dp command, Ctrl+I, or [Deep Investigation] UI toggle.
---

# Deep Investigation

This workflow is ONLY active when the user explicitly triggers Deep Investigation
mode (toggle, /dp, Ctrl+I). deep_search and this workflow are NOT available in
normal mode. Do not attempt to call deep_search outside of DP mode.

## When to Use

- Complex issues requiring hypothesis-driven investigation with multiple potential root causes
- Issues involving RDMA/RoCE, network, or hardware that need systematic validation
- When the user explicitly requests deep investigation (toggle, /dp, Ctrl+I)

## When NOT to Use

- Simple questions answerable with 1-2 kubectl commands
- When the issue is already clear from initial triage
- In normal conversation mode — use standard tools instead

## Workflow: Interactive Investigation Loop + Execution

The workflow has two distinct phases: an interactive planning loop (you + user)
and an execution phase (deep_search sub-agents).

Phase progress is tracked by the system via deterministic events — you do not
need to manage checklist state manually.

### Phase 1: Quick Triage (investigating)

Gather environment context and confirm the problem exists.

1. Run targeted kubectl / diagnostic commands to confirm the symptom.
2. Summarize your findings — this becomes the triageContext.

### Phase 2: Propose Hypotheses (investigating → awaiting_confirmation)

Formulate 3-5 ranked hypotheses based on triage findings.

1. Call `propose_hypotheses` with your hypothesis list AND `triageContext`.
2. **STOP and wait for the user's response.** This is mandatory, not optional.
   - The user may confirm → proceed to Phase 3
   - The user may provide feedback → revise hypotheses, do more triage if needed,
     then call `propose_hypotheses` again (this loop can repeat)
   - The user may ask to skip → present conclusion based on current findings
3. **Do NOT call deep_search without explicit user confirmation.**

The investigate-propose-feedback loop can repeat as many times as needed.
Each round improves hypothesis quality.

### Phase 3: Deep Search Validation (validating)

Only proceed after the user explicitly confirms hypotheses.

1. Call `deep_search` with the investigation question.
   The system automatically provides the confirmed hypotheses and triage context.
2. deep_search validates hypotheses using parallel sub-agents.
3. The system automatically tracks progress in the UI.

### Phase 4: Present Findings (concluding → completed)

After deep_search completes, synthesize results into a conclusion.

1. Write a clear conclusion with root cause analysis and recommendations.

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
| `propose_hypotheses` | Present hypotheses + triage context to the user — blocks until user decides (TUI) or returns immediately (web) |
| `deep_search` | Launch parallel sub-agent validation — only callable after user confirms hypotheses |
| `end_investigation` | End early — auto-skips remaining phases |
| `investigation_feedback` | Submit user feedback on diagnosis accuracy (confirmed/corrected/rejected) |

## Guidelines

1. **Use propose_hypotheses for communication**: Always use the tool (not plain text) to present hypotheses — it renders a proper UI card and saves the triage context for deep_search.
2. **Always include triageContext**: When calling propose_hypotheses, pass your triage findings as the triageContext parameter. This is automatically provided to deep_search when the user confirms.
3. **Wait for user confirmation**: After propose_hypotheses, you MUST wait. Do NOT call deep_search without explicit user approval.
4. **Be cost-aware with deep_search**: It launches parallel sub-agents consuming 30-60 tool calls. The interactive planning loop ensures the investigation direction is right before committing resources.
5. **Avoid redundant validation**: Let deep_search handle hypothesis validation with its parallel sub-agents. Running the same checks manually is inefficient.

## Early Exit

- If triage alone is sufficient to answer the question, present your findings and ask the user before ending.
- Call `end_investigation` to cleanly exit — it marks all remaining items as skipped.
