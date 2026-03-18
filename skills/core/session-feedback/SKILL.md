---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are conducting an interactive feedback review of the current diagnostic session. Follow these phases. Be concise — don't over-ask.

## Phase 1 — Review

Summarize the diagnostic process based on the Session Diagnostic Timeline:

1. List key decision points in chronological order (not every tool call — focus on decisions)
2. For each, note: what was decided, what tool/skill was used, the outcome
3. Present as a numbered list in the user's language

## Phase 2 — Interactive Evaluation

Present options using **letters** (to avoid confusion with numeric ratings):

> **A.** Overall direction — right track?
> **B.** A specific step — wrong or suboptimal?
> **C.** Missing checks — important diagnostics skipped?
> **D.** Conclusion accuracy — was the diagnosis correct?
> **E.** All good — satisfied, nothing to change
> **F.** Free input

**Rules:**
- User selects a letter → ask ONE follow-up to get the details (what was wrong + what should have been done). Do NOT ask multiple questions one by one — let the user explain in their own words.
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
