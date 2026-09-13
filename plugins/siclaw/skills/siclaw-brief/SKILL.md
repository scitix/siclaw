---
name: siclaw-brief
description: How to brief the Siclaw SRE agent (siclaw_investigate) — fill target / time_window / open_question, keep side evidence and assumptions out of the target, declare caller_product, then read the understood/warnings echo before waiting. Load before any siclaw_investigate call.
when_to_use: The user asks to investigate, diagnose, troubleshoot or root-cause an infrastructure, Kubernetes, GPU, network, storage, model-gateway or service problem and a Siclaw MCP server (siclaw_investigate) is available; or the user says 排查 / 诊断 / 告警 / 根因 / siclaw.
metadata:
  contract_version: "1"
  source: caller contract (generated — do not edit)
---

# Briefing Siclaw (caller contract v1)

Siclaw is an investigator, not a script runner. You hand it a **brief**; it owns
the plan (data sources, queries, order, stopping conditions). Your job is to make
the brief unambiguous about one thing above all: **what the alert is about**.

## The fields of `siclaw_investigate`

| Field | Required | Fill with |
|---|---|---|
| `target` | **yes** | The entity this investigation must explain — one line: entity kind + the identifiers that pin it down + the observed symptom. It is what the alert or question is ABOUT. It is NOT a suspected cause (→ assumptions), NOT something you happened to notice (→ side_evidence), and NOT an investigation step (→ open_question, or leave it out). Example: "vendor=aws model=claude-fable-5 external TPOT>2s/token alert". Not: "Bedrock/Novita upstream timeouts (Novita is side evidence; Bedrock overload is an assumption)". |
| `time_window` | **yes** | Absolute UTC window the question is about, RFC 3339 (e.g. 2026-09-03T01:45:00Z → 2026-09-03T02:30:00Z). Never relative words. |
| `open_question` | **yes** | The unresolved question Siclaw must answer, stated as a question about the target — not as steps to run. |
| `caller_product` | **yes** | The product composing this request — the one you are running in — e.g. claude-code, codex, cursor, feishu-bot. Required for usage attribution; not the model name. |
| `scope` | no | Identifiers already known: cluster (name or id), namespace, workloads (pod/deployment names). Optional. |
| `known_facts` | no | Verified facts, one per item, with numbers and timestamps. Optional. |
| `already_checked` | no | Data sources or checks already done and their result; Siclaw will not repeat them. Optional. |
| `side_evidence` | no | Things noticed that are NOT the target (other vendors, other models, neighbouring symptoms). They inform but must not redirect the investigation. Optional. |
| `assumptions` | no | Suspected causes or uncertain context, clearly separated from known_facts. Optional. |
| `constraints` | no | Explicit user constraints: read-only, no changes, scope limits, deadlines. Optional. |
| `freshness_note` | no | Anything about evidence age (events past TTL, pods replaced). The control plane fills this in when the window is older than 24h. Optional. |
| `context_id` | no | Optional context_id from a prior task to continue the same Siclaw investigation session. |
| `question` | no | DEPRECATED free-text brief. Prefer the structured fields; a text-only brief is accepted but returns MISSING_TARGET / MISSING_QUESTION warnings and gives Siclaw's sub-agents no anchor. |

`target`, `time_window` and `open_question` are required *together*: sending some structured fields but missing one of them is rejected with the missing names. `question` alone still works (legacy) but returns MISSING_TARGET warnings and gives Siclaw's sub-agents no anchor — do not use it for new calls.

## What `target` means

> The entity this investigation must explain — one line: entity kind + the identifiers that pin it down + the observed symptom. It is what the alert or question is ABOUT. It is NOT a suspected cause (→ assumptions), NOT something you happened to notice (→ side_evidence), and NOT an investigation step (→ open_question, or leave it out).

| | Example | Why |
|---|---|---|
| Good | `vendor=aws model=claude-fable-5 external TPOT>2s/token alert` | entity + identifiers + symptom |
| Good | `node cetus-c-013 GPU#3 Xid 79 alert` | same shape |
| Bad | `Bedrock/Novita upstream timeouts (Novita is side evidence; Bedrock overload is an assumption)` | the vendor you *noticed* is side_evidence; the cause you *suspect* is an assumption |
| Bad | `did the three model-api pods restart?` | that is a step, not the object; it belongs in open_question or nowhere |

## Three things never to do

1. **Do not promote side evidence into the target or the question.** Anything you
   saw that is not the alert object (another vendor, another model, a neighbouring
   symptom) goes into `side_evidence`. Siclaw and its sub-agents treat that list
   as context, never as a lead.
2. **Do not prescribe the investigation.** No "first run kubectl…, then check
   events". State what is unresolved; Siclaw decides how to find out.
3. **Do not use relative time.** "Last night" is not a window. Give `time_window`
   as absolute UTC RFC 3339. If the window is older than a day, expect a
   STALE_WINDOW warning: Kubernetes events are past TTL, pods may have been replaced,
   logs rotated — ask Siclaw to report "evidence unavailable" rather than "no anomaly".

## `caller_product`

Always pass the product you are running in, for example: `claude-code` / `codex` / `cursor` / `feishu-bot` / `siclaw`
(other values are accepted and stored as declared). This is how usage is attributed;
it is not the model name.

## After the call: read the echo before you wait

The result carries `understood` (the brief the control plane understood: target, window, caller)
and `warnings`. Check them before calling `siclaw_wait_task`:

| Warning | Meaning | Do |
|---|---|---|
| `MISSING_TARGET` | no target field (legacy text brief) | resend with the structured fields |
| `MISSING_WINDOW` | no absolute UTC window found | add time_window |
| `MISSING_QUESTION` | no open_question field | state the unresolved question |
| `MISSING_CALLER` | caller_product not declared | pass the product you run in |
| `UNKNOWN_CALLER` | caller_product not in the known table | fine if intentional; check spelling |
| `LEGACY_QUESTION` | free-text `question` used | migrate to structured fields |
| `CONTRADICTORY_CHECKED` | a source is described as both checked and not checked | fix already_checked / open_question |
| `SIDE_EVIDENCE_IN_TARGET` | a side_evidence entity appears in target/open_question | move it out of the target |
| `STALE_WINDOW` | window ended more than 24h ago | expect evidence gaps; ask for 'unavailable' not 'no anomaly' |
| `RELATIVE_TIME` | relative time words without absolute timestamps | give RFC 3339 UTC |
| `PRESCRIBED_PLAN` | the brief dictates steps or commands | state the question, drop the steps |
| `OVERSIZE` | brief over 16 KiB | reference bulk evidence instead of pasting it |

If `understood.target` is not what you meant, cancel (`siclaw_cancel_task`) and resend a
corrected brief — do not let a misread brief run for minutes.

## Following up and challenging

- Continue the same investigation with `context_id` from the previous task; do not
  restate the whole brief, add the new fact or the new question.
- While a task is working, call `siclaw_wait_task` repeatedly; never resubmit the
  same brief because it is slow.
- When the report arrives, check that its conclusion is about **your target**. A
  report that pivots to a side_evidence entity has drifted — say so in the follow-up
  and restate the target.
- Ask for the evidence chain, not just the verdict: which source, which time, which
  identifier. "Looks right" is not verified.
