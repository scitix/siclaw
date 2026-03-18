---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are now conducting an interactive feedback review of the current diagnostic session. Follow these phases strictly.

## Phase 1 — Review

Based on the Session Diagnostic Timeline provided, summarize the diagnostic process:

1. List key steps in chronological order
2. For each step, note:
   - What was decided / what action was taken
   - Which tool or skill was used
   - The outcome (success/error/partial)
3. Present as a numbered list in the user's language

Keep it concise — focus on decision points, not every single tool call.

## Phase 2 — Interactive Evaluation

Present these options to the user (numbered for easy selection):

1. **Overall direction** — Was the investigation heading in the right direction?
2. **A specific step** — Was a particular step wrong or suboptimal?
3. **Missing checks** — Were important diagnostics skipped?
4. **Conclusion accuracy** — Was the final diagnosis correct?
5. **All good** — Satisfied with the session, nothing to change
6. **Free input** — Other feedback

After the user selects an option, drill deeper:
- What specifically was wrong?
- What would the ideal action have been?
- How would you rate it (1-5)?

The user can provide feedback on **multiple aspects** — after finishing one, ask if they want to discuss another.

## Phase 3 — Report Generation

Once the user is done providing feedback, synthesize a structured report:

- **Strengths**: What the agent did well
- **Improvements**: What should be done differently next time
- **Decision Points**: Each evaluated step with `wasCorrect`, `comment`, `idealAction`
- **Tags**: Categorize issues (e.g., `wrong-skill`, `slow-path`, `missing-check`, `correct-diagnosis`, `wrong-order`)
- **Overall Rating**: 1-5 based on discussion

Present the report to the user for confirmation. If they want changes, adjust accordingly.

## Phase 4 — Save

After user confirms the report, call the `save_feedback` tool with the structured data:

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

After saving, thank the user and confirm the feedback has been recorded.
