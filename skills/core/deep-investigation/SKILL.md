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

## Core Discipline (MOST IMPORTANT — read first)

DP mode is fundamentally different from normal mode:
- **Normal mode**: you decide, you execute, you conclude.
- **DP mode**: the USER decides direction, you assist. Every conclusion must be
  validated through the user.

In DP mode you **MUST**:
1. Investigate, then **always call `propose_hypotheses`** to align with the user
2. **NEVER skip `propose_hypotheses` and go straight to a conclusion** — that
   defeats the entire purpose of DP mode
3. Do NOT call `deep_search` directly — it becomes available only after the user
   confirms your hypotheses

Even if the answer seems obvious to you: call `propose_hypotheses` anyway.
The user opened DP mode because the problem is complex and they need to align
understanding with you. Your job is to present findings and hypotheses, not to
present conclusions.

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

Formulate 2-4 ranked hypotheses based on triage findings. Quality over quantity —
every hypothesis must be specific and testable.

1. **BEFORE calling the tool**, write a brief triage summary in your text response
   (2-3 sentences). Summarize what you found, what is abnormal, and what direction
   the hypotheses take. This gives the user context before seeing the card.
   Do NOT skip this — an empty message followed by a card is bad UX.
2. Call `propose_hypotheses` with your hypothesis list AND `triageContext`.
3. **STOP and wait for the user's response.** This is mandatory, not optional.
   - The user may confirm → proceed to Phase 3
   - The user may provide feedback → revise hypotheses, do more triage if needed,
     then call `propose_hypotheses` again (this loop can repeat)
   - The user may ask to skip → present conclusion based on current findings
4. **Do NOT call deep_search without explicit user confirmation.**

**CRITICAL output rule**: Do NOT list or describe hypotheses in your text response.
The `propose_hypotheses` tool renders a dedicated interactive UI card that displays
all hypotheses with confidence scores and action buttons. Repeating them in text
creates ugly duplication. Your text should ONLY contain the triage summary and a
short transition. All hypothesis content goes into the tool call parameters.

The investigate-propose-feedback loop can repeat as many times as needed.
Each round improves hypothesis quality.

**What makes a good hypothesis:**
- One specific, testable statement — not a category or topic
- Good: "Evicted pods exhausted ResourceQuota, blocking new pod creation"
- Bad: "Check resource limits" or "Memory issues"
- Each hypothesis should be independent (not sub-points of the same idea)
- Include confidence based on evidence strength, not gut feeling

### Phase 3: Deep Search Validation (validating)

Only proceed after the user explicitly confirms hypotheses.

1. Call `deep_search` with the investigation question.
   The system automatically provides the confirmed hypotheses and triage context.
2. deep_search validates hypotheses using parallel sub-agents.
3. The system automatically tracks progress in the UI.

### Phase 4: Present Findings (concluding → completed)

After deep_search completes, synthesize results into a focused conclusion.

1. Lead with the **single most likely root cause** — not a list of everything you checked.
2. Support it with the key evidence from deep_search (validated/invalidated hypotheses).
3. Provide actionable recommendations (specific commands or config changes).
4. If multiple root causes are confirmed, prioritize by impact — mention the primary
   cause first, secondary causes briefly after.

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

1. **The card IS your output**: `propose_hypotheses` renders an interactive card — that is the user-facing presentation. Do NOT write hypotheses in your text. No markdown lists, no numbered hypotheses, no "Hypothesis 1: ..." in text. Your text response should be ≤3 sentences: triage summary + transition.
2. **Always include triageContext**: When calling propose_hypotheses, pass your triage findings as the triageContext parameter. This is automatically provided to deep_search when the user confirms.
3. **Wait for user confirmation**: After propose_hypotheses, you MUST wait. Do NOT call deep_search without explicit user approval.
4. **Be cost-aware with deep_search**: It launches parallel sub-agents consuming 30-60 tool calls. The interactive planning loop ensures the investigation direction is right before committing resources.
5. **Avoid redundant validation**: Let deep_search handle hypothesis validation with its parallel sub-agents. Running the same checks manually is inefficient.

## Early Exit

- If triage alone is sufficient to answer the question, present your findings and ask the user before ending.
- Call `end_investigation` to cleanly exit — it marks all remaining items as skipped.
