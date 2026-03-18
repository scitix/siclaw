---
name: session-feedback
description: Interactive session feedback — reviews the diagnostic process with the user, identifies decision points, and saves structured feedback to improve diagnostic capabilities.
tags: [feedback, meta, improvement]
---

# Session Feedback Protocol

You are conducting an interactive feedback review of the current diagnostic session. Follow these phases. Be concise — don't over-ask.

**Language: Always follow the user's language (from their profile or recent messages). All output — phase titles, timeline, options, report — must be in the user's language.**

## Phase 1 — Compressed Timeline with Self-Reflection

Analyze the Session Diagnostic Timeline and present a **compressed timeline** as a regular markdown numbered list (NOT a code block):

**Compression rules:**
- Group consecutive same-purpose tool calls into one line, marked with `(N steps)`
- Routine successful steps get a `✓` and stay as one-liners
- Decision points or anomalies get a `⚠️` with a brief self-reflection on what might be questionable
- Target: **5-8 lines max**, regardless of how many raw steps exist

Example (adapt to user's language, output as plain markdown list — never use code fences):

1. 集群连接 — credential_list → 连接 roce-test ✓
2. 组件扫描 (6 步) — pods/nodes/daemonsets → 发现 3 节点 NotReady ✓
3. ⚠️ 网卡识别 — 从 ConfigMap tag 推断厂商，未在节点上验证
4. 节点诊断 (4 步) — node_exec 尝试 → debug 镜像拉取失败
5. ⚠️ 日志分析转向 — exporter 无设备 vs rdma-qos 60+ VF，数据矛盾
6. 报告生成 ✓

After presenting, tell the user they can ask to expand any step by its number.

## Phase 2 — Interactive Evaluation

Present options using **letters**, each on its own line:

- **A.** 整体方向 — 调查路径是否正确？
- **B.** 具体步骤 — 指出上面时间线的编号，或描述
- **C.** 遗漏检查 — 有重要诊断被跳过？
- **D.** 结论准确性 — 最终诊断是否正确？
- **E.** 全部满意 — 直接生成报告
- **F.** 其他意见

(The above is a Chinese example. Translate to match the user's language.)

**Rules:**
- User selects a letter → ask ONE follow-up to get the details (what was wrong + what should have been done). Do NOT ask multiple questions one by one — let the user explain in their own words.
- If user references a timeline number (e.g. "B 3"), expand that step's details from the raw timeline and discuss it.
- After each feedback item, show a brief **running tally** (e.g. "已记录 2 项") and ask: **"继续 (选字母) 还是生成报告 (R)？"**
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

Ask user to confirm or request adjustments.

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
