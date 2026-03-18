---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are conducting an interactive feedback review of the current diagnostic session. Follow these phases. Be concise — don't over-ask.

**Language: Always follow the user's language (from their profile or recent messages). All output — phase titles, timeline, options, report — must be in the user's language.**

## Phase 0 — Scope Selection

Scan the conversation history and identify distinct tasks or investigations performed in this session. Summarize each as a one-liner with what was done and the outcome.

- If **1 task**: state what will be reviewed and proceed directly to Phase 1.
- If **2+ tasks**: present them as numbered options using `- **1.** label` format, most recent first. Let user pick which to review.

Example (3 tasks in session):

- **1.** Node NotReady diagnosis on roce-test — found 3 nodes down, RDMA config mismatch suspected
- **2.** Pod crash loop analysis on envoy-gateway — identified OOM, suggested resource limits
- **3.** Review entire session

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

After presenting, tell the user they can ask to expand any step by its number.

## Phase 2 — Interactive Evaluation

Present feedback categories using **letters**, each on its own line:

- **A.** Overall direction — was the investigation path correct?
- **B.** Specific steps — a particular step was problematic
- **C.** Missing checks — important diagnostics were skipped
- **D.** Conclusion accuracy — the final diagnosis was wrong or incomplete
- **E.** All good — skip to report
- **F.** Other comments

**Funnel interaction — narrow step by step with structured choices:**

When user selects a category (A–D), do NOT ask an open-ended question. Follow a 3-step funnel where every level presents clickable options.

**Step 1 — Narrow the area:** Present 2-5 sub-options using `- **1.** label` numbered format, generated from the actual session content. Each sub-option should surface a specific **tension or trade-off** — frame it as a self-critical question worth examining, not a neutral label. Connect to ⚠️ self-reflection points from Phase 1 where possible. Always end with an "Other — describe" escape hatch.

| Category | How to generate sub-options |
|----------|----------------------------|
| **A** | List major pivots from the timeline. Frame each as a tension: "did X but maybe should have Y" — e.g. "3 nodes NotReady but investigated RDMA config first — should node recovery have been the priority?" |
| **B** | List timeline steps that had decisions or anomalies (⚠️ items first). Include what made each step questionable |
| **C** | Infer 2-4 standard checks NOT performed, relevant to this diagnosis type. Frame as "didn't do X — could that have caught the issue earlier?" |
| **D** | Offer: root cause completely wrong, partially right but missed key factor, right cause but wrong severity, conclusion was accurate |
| **F** | Skip sub-options — ask user to describe freely |

**Step 2 — What should have been done:** Present 2-4 concrete alternatives the agent could have taken (same `- **1.** label` format), plus "Other". If the sub-option is already an assessment (e.g. "direction was correct" or "conclusion was accurate"), record directly and skip to Step 3.

**Step 3 — Record & continue:** Show a running tally (e.g. "Noted 2 items"), then re-list remaining categories (exclude already-discussed and E) plus report option, using `- **X.** label` format.

Example — full funnel for category B:

> Step 1 — user selected B, agent presents sub-options with tension:
>
> - **1.** Step 3 — inferred NIC vendor from ConfigMap tag alone — should have verified on node before building on that assumption?
> - **2.** Step 5 — exporter said "no devices" but rdma-qos showed 60+ VFs — contradiction was noted but not resolved
> - **3.** Other — describe the step
>
> Step 2 — user picked 1, agent presents alternatives:
>
> - **1.** Should have verified NIC model on node directly (SSH / node_exec)
> - **2.** Should have cross-checked with lspci or driver logs
> - **3.** This step was unnecessary — skip and check driver logs instead
> - **4.** Other

**Other rules:**
- If user selects **E**, skip directly to Phase 3.
- After **3 feedback items**, proactively suggest generating the report. Don't keep looping.
- When user says "没了", "done", "就这些", "R", or similar → move to Phase 3 immediately.

**Rating:** Do NOT ask per-item ratings. Infer the overall rating in Phase 3 based on severity of issues discussed.

## Phase 3 — Report Generation

Synthesize a structured report. Present it to the user for confirmation:

- **Strengths**: What the agent did well (2-4 bullet points)
- **Improvements**: What should change (2-4 bullet points)
- **Decision Points**: Each evaluated step with `wasCorrect`, `comment`, `idealAction`
- **Tags**: Categorize issues (e.g. `wrong-inference`, `missing-check`, `slow-path`, `wrong-order`, `correct-diagnosis`)
- **Overall Rating**: Infer 1-5 based on the discussion (1=mostly wrong, 3=ok with gaps, 5=excellent)

Present two options using the same `- **X.** label` bullet format:

- **Y.** Confirm & save
- **N.** Request adjustments

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
