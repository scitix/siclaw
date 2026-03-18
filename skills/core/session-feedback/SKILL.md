---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are conducting an interactive feedback review of the current diagnostic session. Follow these phases. Be concise — don't over-ask.

## Phase 1 — Compressed Timeline with Self-Reflection

Analyze the Session Diagnostic Timeline and present a **compressed timeline**:

**Compression rules:**
- Group consecutive same-purpose tool calls into one line, marked with `(N steps)`
- Routine successful steps get `✓` and stay as one-liners
- Decision points or anomalies get `⚠️` with a brief self-reflection on what might be questionable
- Target: **5-8 lines max**, regardless of how many raw steps exist

**Example format:**
```
1. Cluster connection — credential_list → connected to roce-test ✓
2. Component scan (6 steps) — pods/nodes/daemonsets → found 3 nodes NotReady ✓
3. ⚠️ NIC identification — inferred Broadcom from ConfigMap tag, did not verify on node
4. Node diagnostics (4 steps) — node_exec attempts → debug image pull failed
5. ⚠️ Log analysis pivot — exporter shows no devices vs rdma-qos shows 60+ VFs, contradictory
6. Report generation ✓
```

After presenting, tell the user: **"If you want details on any compressed step, just mention its number."**

## Phase 2 — Interactive Evaluation

Present options using **letters** (to avoid confusion with numeric ratings):

> **A.** Overall direction — right track?
> **B.** A specific step — pick a number from the timeline above, or describe it
> **C.** Missing checks — important diagnostics skipped?
> **D.** Conclusion accuracy — was the diagnosis correct?
> **E.** All good — satisfied, nothing to change
> **F.** Free input

**Rules:**
- User selects a letter → ask ONE follow-up to get the details (what was wrong + what should have been done). Do NOT ask multiple questions one by one — let the user explain in their own words.
- If user references a timeline number (e.g. "B 3"), expand that step's details from the raw timeline and discuss it.
- After each feedback item, show a brief **running tally** (e.g. "Noted: 2 items so far") and ask: **"Continue (letter) or generate report (R)?"**
- If user selects **E**, skip directly to Phase 3.
- After **3 feedback items**, proactively suggest generating the report. Don't keep looping.
- When user says anything like "没了", "done", "就这些", "R", or similar → move to Phase 3 immediately.

**Rating:** Do NOT ask per-item ratings. You will infer the overall rating in Phase 3 based on the severity of issues discussed.

## Phase 3 — Report Generation

Synthesize a structured report. Present it to the user for confirmation:

- **Strengths**: What the agent did well (2-4 bullet points)
- **Improvements**: What should change (2-4 bullet points)
- **Decision Points**: Each evaluated step with `wasCorrect`, `comment`, `idealAction`
- **Tags**: Categorize issues (e.g. `wrong-inference`, `missing-check`, `slow-path`, `wrong-order`, `correct-diagnosis`)
- **Overall Rating**: Infer 1-5 based on the discussion (1=mostly wrong, 3=ok with gaps, 5=excellent)

Ask user: **"Confirm to save, or any adjustments?"**

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
