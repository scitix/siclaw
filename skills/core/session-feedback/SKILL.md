---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are conducting an interactive feedback review of the current diagnostic session. Follow these phases. Be concise — don't over-ask.

**Language: Always follow the user's language (from their profile or recent messages). All output — phase titles, timeline, options, report — must be in the user's language.**

**Clickable options:** Whenever you present choices for the user, append this comment at the end of the message — it enables clickable chips in the web UI:
`<!-- suggested-replies: KEY|Label, KEY|Label -->`
The visible list format is flexible — write naturally. The comment is the machine contract.

## Phase 0 — Scope Selection

Scan the conversation history and identify distinct tasks or investigations performed in this session. Summarize each as a one-liner with what was done and the outcome.

- If **1 task**: state what will be reviewed and proceed directly to Phase 1.
- If **2+ tasks**: present them as numbered options, most recent first. Let user pick which to review.

Example (3 tasks in session):

1. Node NotReady diagnosis on roce-test — found 3 nodes down, RDMA config mismatch suspected
2. Pod crash loop analysis on envoy-gateway — identified OOM, suggested resource limits
3. Review entire session

<!-- suggested-replies: 1|Node NotReady diagnosis, 2|Pod crash loop, 3|Entire session -->

After user selects (or if only 1 task), proceed to Phase 1 scoped to that task only.

## Phase 1 — Compressed Timeline with Self-Reflection

Analyze the selected task's diagnostic steps and present a **compressed timeline** as a regular markdown numbered list (NOT a code block):

**Compression rules:**
- Group consecutive same-purpose tool calls into one line, marked with `(N steps)`
- Routine successful steps get a `✓` and stay as one-liners
- Decision points or anomalies get a `⚠️` with a brief self-reflection on what might be questionable
- Target: **5-8 lines max**, regardless of how many raw steps exist

Example (output as plain markdown list — never use code fences):

1. Cluster connect — credential_list → connected to roce-test ✓
2. Component scan (6 steps) — pods/nodes/daemonsets → found 3 nodes NotReady ✓
3. ⚠️ NIC detection — inferred vendor from ConfigMap tag, not verified on node
4. Node diagnostics (4 steps) — node_exec attempt → debug image pull failed
5. ⚠️ Log analysis pivot — exporter shows no devices vs rdma-qos 60+ VFs, data contradiction
6. Report generation ✓

After presenting, tell the user they can ask to expand any step by its number. Then immediately present Phase 2.

## Phase 2 — Interactive Evaluation

Present a top-level menu mixing "Specific steps" (a single entry) with cross-cutting observations generated from the session. Use **letters** for top-level, **numbers** for sub-levels, **0** to go back.

Top-level structure:
- **A** — Specific steps (review a step from the timeline)
- **B, C, D...** — 1-3 cross-cutting observations: concrete, session-grounded issues about overall direction, missing checks, or conclusion accuracy. Frame each with self-critical tension.
- **E** — All good (skip to report)
- **O** — Other

Example top-level:

A. Specific steps — review a step from the timeline
B. Overall priority — 3 nodes NotReady but RDMA config investigated first, was this the right call?
C. Missing check — no hardware-level diagnostics (lspci/dmesg) attempted on NotReady nodes
E. All good — generate report
O. Other

<!-- suggested-replies: A|Specific steps, B|Overall priority, C|Missing check, E|All good, O|Other -->

**Navigation:**

**Selecting A (Specific steps):** Present timeline steps as numbered sub-options. Highlight ⚠️ items:

1. Cluster connect ✓
2. Component scan (6 steps) ✓
3. ⚠️ NIC detection — inferred vendor from ConfigMap, not verified
4. Node diagnostics (4 steps) — image pull failed
5. ⚠️ Log analysis pivot — contradictory data not resolved
0. Back

<!-- suggested-replies: 1|Cluster connect, 2|Component scan, 3|NIC detection, 4|Node diagnostics, 5|Log analysis, 0|Back -->

**Selecting a specific step or cross-cutting observation:** Present 2-4 concrete alternatives the agent could have taken, plus "Other" and "Back":

1. Should have verified NIC model on node directly (SSH / node_exec)
2. Should have cross-checked with lspci or driver logs
3. Other
0. Back

<!-- suggested-replies: 1|Verify on node, 2|Cross-check lspci, 3|Other, 0|Back -->

If the selection is already a positive assessment (e.g. a ✓ step or "direction was correct"), confirm and record directly.

**After recording:** Show running tally (e.g. "Noted 2 items"), return to top-level menu with discussed items removed. Add R (Generate report) after the first recorded item.

**User input handling:**
- Any selection can include supplementary text — e.g. `1 and also the annotation source was wrong`. Capture both the selection AND the extra context when recording.
- "Other" means the user will type their own feedback. Do NOT ask a follow-up question — just wait for their input and record it directly.

**Other rules:**
- 0 (Back) appears at every sub-level — user can always return.
- If user selects **E**, skip directly to Phase 3.
- After **3 feedback items**, proactively suggest generating the report.
- When user says "没了", "done", "就这些", "R", or similar → move to Phase 3 immediately.

**Rating:** Do NOT ask per-item ratings. Infer the overall rating in Phase 3 based on severity of issues discussed.

## Phase 3 — Report Generation

Synthesize a structured report. Present it to the user for confirmation:

- **Strengths**: What the agent did well (2-4 bullet points)
- **Improvements**: What should change (2-4 bullet points)
- **Decision Points**: Each evaluated step with `wasCorrect`, `comment`, `idealAction`
- **Tags**: Categorize issues (e.g. `wrong-inference`, `missing-check`, `slow-path`, `wrong-order`, `correct-diagnosis`)
- **Overall Rating**: Infer 1-5 based on the discussion (1=mostly wrong, 3=ok with gaps, 5=excellent)

Present two options:

Y. Confirm & save
N. Request adjustments

<!-- suggested-replies: Y|Confirm & save, N|Request adjustments -->

## Phase 4 — Save

After user confirms (or says ok/好/确认/save), call `save_feedback` immediately:

```
save_feedback({
  overallRating: <1-5>,
  summary: "<brief summary>",
  decisionPoints: "<JSON array>",
  strengths: "<JSON array>",
  improvements: "<JSON array>",
  tags: "<JSON array>",
  feedbackConversation: "<JSON summary of this dialogue>"
})
```

After saving, thank the user briefly. Done — do not continue the feedback loop.
