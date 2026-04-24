---
title: "Deep Investigation Mode — Refactor Design"
sidebarTitle: "DP Mode Refactor (2026-04-24)"
description: "Replace the DP state machine + specialized cards with checkpoint action chips and same-agent sub-agent delegation, simplifying maintenance and preserving a clean path to future expert teams."
---

# Deep Investigation Mode — Refactor Design

> **Status**: Phase 1 implementation active (2026-04-24). Current target is the single-agent DP + same-agent sub-agent loop, including async notify-style same-agent delegation; cross-agent expert teams are deliberately deferred.
> **Supersedes**: The current `src/core/extensions/deep-investigation.ts` state-machine + `propose_hypotheses` / `deep_search` / `end_investigation` tool family + `HypothesesCard` / `InvestigationCard` / `DpChecklistCard` React components.

---

## 0. Why

After shipping DP persistence fixes in late April 2026, ~70% of the bugs we hit traced back to DP's heavy architecture (specialized state machine, tool trio, three bespoke cards, `[DP_CONFIRM]` / `[DP_ADJUST]` markers, `dp_status` SSE events). The product value users actually get from this complexity is thin — mostly "a visual signal that the agent is doing structured investigation". Plain markdown already conveys that.

This refactor strips DP down to what it *is*:

1. **A prompting enhancement** that makes a single agent reason more divergently and chase details.
2. **A same-agent sub-agent primitive** so the model can run focused, isolated investigations when they materially improve evidence quality.
3. **A generic "action chips" primitive** so users can quickly respond to checkpoint moments without losing the ability to add free-form context.

The primitives are intentionally reusable. Phase 2 (future) builds on the same data model and card surface to support gateway-routed multi-agent expert teams.

---

## 1. Scope

### In scope (Phase 1 — this refactor)

- Replace DP state machine with a simple mode flag (`dpActive`).
- New generic tool `delegate_to_agent(agent_id="self")` replacing `deep_search`.
- Minimal runtime executor that creates a same-agent child session and returns a structured tool result.
- Unify existing "suggested-replies" chips and "Dig deeper" chip under one `ActionChip` abstraction.
- Render DP steering chips only at explicit Hypothesis Checkpoints, not on every DP assistant turn.
- Collapsed Agent Work Card rendering for same-agent sub-agent delegations.
- Delete `HypothesesCard`, `InvestigationCard`, `DpChecklistCard`, `propose_hypotheses`, `end_investigation`, `deep_search`, `dp_status` event, `dpStatus` enum, `dpChecklist` / `dpProgress` / `dpFocus` hook state, `parseHypotheses` (both frontend and backend copies).

### Explicitly deferred (Phase 2+)

- Multi-agent expert teams (`delegate_to_agent(agent_id=<other>)`).
- Domain sweep phase (parallel specialist exploration before hypothesis).
- Permission gate, approval persistence, and tool-level "always allow" settings.
- Visual multi-agent sidebar / timeline.
- Gateway/portal routing to target agent AgentBoxes.

---

## 2. Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│  DP Mode = Prompt Enhancement + Two Generic Primitives          │
│                                                                   │
│  [System prompt]                                                  │
│    "Be more divergent, propose multiple hypotheses, chase        │
│     details, structure your answer, don't rush."                 │
│                                                                   │
│  [Primitive 1 — Checkpoint ActionChip]                            │
│    DP only shows Proceed / Refine / Summarize at explicit        │
│    Hypothesis Checkpoints. Buttons create hidden prompt pills,   │
│    not raw A/B/C text.                                            │
│                                                                   │
│  [Primitive 2 — Same-agent Delegation]                            │
│    `delegate_to_agent(agent_id="self")` creates a focused child  │
│    session and returns a structured summary.                      │
│    `delegate_to_agents_async` starts 1-3 child sessions in the   │
│    background and notifies the parent session when complete.      │
│    The frontend renders both as collapsed Agent Work cards.       │
└─────────────────────────────────────────────────────────────────┘
```

No state machine. No specialized cards. No DP-specific markers other than the existing `[Deep Investigation]` prefix and `[DP_EXIT]` marker.

---

## 3. Primitive 1: ActionChip

### Unified abstraction

A single `ActionChip` config powers `suggested-replies`, `Dig deeper`, and checkpoint-only DP steering chips:

```ts
interface ActionChip {
  id: string
  label: string           // what user sees on the chip
  kind: "fill" | "prefix" // two interaction variants
  insertText: string      // goes into input on click
  expandTo?: string       // kind=prefix only: template expanded on send
  appendUserLabel?: string // kind=prefix only: prefix for user-typed addition
}
```

### Two variants

**`fill`** (inserts visible text into input box):

```
User clicks [Use example query]
  → input box now contains the chip text
  → user can press send immediately, OR edit the text before sending
  → send dispatches the raw text
```

Used by:
- Model-generated suggested replies (existing; `detectOptionReplies` regex catches `A. xxx / B. yyy` in assistant output)
- Non-DP suggested replies that should remain directly editable

**`prefix`** (atomic pill in input that expands on send):

```
User clicks [Dig deeper]
  → input box shows an atomic pill "[Dig deeper]"
  → user can type additional direction after the pill
  → on send: pill is replaced by the full expandTo template, user text appended under appendUserLabel
```

Used by:
- `Dig deeper` button (existing)
- DP Hypothesis Checkpoint chips (`Proceed` / `Refine` / `Summarize`)

### DP hypothesis checkpoint chip configuration

DP no longer renders fixed chips just because `dpActive === true`. The model must
emit an explicit checkpoint marker when it has a real hypothesis fork or
breakthrough:

```md
<!-- hypothesis-checkpoint -->
<!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->
```

Display rule:

```ts
const showDpCheckpointChips =
  dpActive &&
  latestMessage?.role === "assistant" &&
  !isStreaming &&
  hasHypothesisCheckpointMarker
```

This keeps normal DP turns quiet. The user only sees steering chips when the
agent has written H1/H2/H3-style hypotheses and wants directional input. Outside
DP, the generic suggested-replies parser still works as before.

### Semantics: fully in the model's hands

The chips are pure frontend UI sugar. When clicked:
- `Proceed` creates an input pill and sends the hidden instruction to continue validating the leading hypothesis.
- `Refine` creates an input pill and sends the hidden instruction to revise or add hypotheses based on user direction.
- `Summarize` creates an input pill and sends the hidden instruction to stop deeper validation and summarize the current best answer.

The visible user bubble shows only the compact chip label plus any user-added text. The backend strips the marker before forwarding to the model, preserving the hidden instruction body. The DP system prompt also accepts legacy protocol replies:

> When the user's reply starts with `A` alone — proceed with your current plan.
> When the user's reply starts with `B` — they want to adjust your direction; read what follows.
> When the user's reply starts with `C` — wrap up with your current best conclusion.
> If the user types anything else — interpret naturally.

No state machine is needed to enforce these semantics — the LLM handles context-sensitive interpretation, while the UI avoids exposing protocol letters as the primary experience.

### Dynamic suggested replies (retained)

The existing `<!-- suggested-replies: ... -->` HTML comment and `A. xxx / B. yyy` pattern detection are preserved. Model may emit them freely in non-DP turns; frontend renders them identically. In DP turns, suggested replies render only when the message also carries the explicit `<!-- hypothesis-checkpoint -->` marker.

---

## 4. Primitive 2: Same-agent Delegation Now, Permission Later

Phase 1 validates the DP loop with direct same-agent delegation:

- `delegate_to_agent(agent_id="self")` creates a focused child session under the same agent/runtime identity.
- `delegate_to_agents` batches 1-3 independent same-agent checks into one parent-visible tool call and blocks until those checks finish.
- `delegate_to_agents_async` starts 1-3 independent same-agent checks in the background, returns a running batch card immediately, and lets the runtime notify the parent session after the batch finishes.
- Delegation tools are exposed to the model only while Deep Investigation is visibly active (`[Deep Investigation]` marker or restored DP-active state). Normal chat sessions do not receive the delegation executor, so the registry does not include these tool schemas.
- The child receives only the model-written `scope` and `context_summary`, not the whole parent transcript.
- Synchronous delegation results return to the parent model as normal tool results and render as Agent Work Cards.
- Async delegation writes the final batch result back to the original tool row, persists a hidden `delegation_event` row in the parent chat session, then injects a synthetic parent turn so the parent model sees the completed capsules without having to remember to poll.
- The async UI polls persisted chat history while an async batch is running. This keeps the user input unlocked while preserving the visible card and the follow-up parent synthesis across refreshes.
- Delegated sessions are first-class hidden chat sessions for audit: their child tool calls and final reports are persisted with lineage (`parent_session_id`, `delegation_id`, `target_agent_id`) while the left navigation can keep them out of the normal chat list.
- Delegated sessions deliberately do not receive delegation tools, preventing recursive fan-out in the first implementation.
- Child session timeout is activity-based: the runtime aborts a delegated child after 60 seconds without model/tool activity, while long-running tool calls are allowed to continue up to a wide 10-minute max-runtime guard.

Cross-agent expert collaboration (`agent_id !== "self"`) is intentionally not implemented here. It must route through gateway/portal to the target agent's AgentBox so model config, system prompt, tools, credentials, and future permission boundaries are real.

The permission-gate design below is retained as the next layer, but it is not part of the current single-agent DP acceptance path.

### Tool declaration

Tools opt in via a property in the tool definition:

```ts
{
  name: "delegate_to_agent",
  parameters: Type.Object({ ... }),
  requiresUserApproval: true,  // reserved metadata for later permission gate
  execute: async (...) => { ... },
}
```

### Future permission-gate runtime flow

This flow is intentionally deferred until after the single-agent DP loop is validated. Phase 1 keeps the metadata on the tool contract but does not pause `delegate_to_agent(agent_id="self")` behind an approval UI.

1. Model's turn produces a tool call to `delegate_to_agent` (or any other future `requiresUserApproval` tool).
2. Tool runtime intercepts **before** invoking `execute`:
   - Writes a new row to `chat_messages` with `role="permission"`:
     ```json
     {
       "role": "permission",
       "tool_name": "delegate_to_agent",
       "tool_args": { "agent_id": "self", "scope": "..." },
       "status": "pending"
     }
     ```
   - Streams this message to the frontend via existing SSE channel.
3. Frontend renders the permission message (§6.2). User clicks `Allow`, `Deny`, or `Always allow this session`.
4. Frontend POSTs decision to a new endpoint: `POST /api/v1/siclaw/agents/:agentId/chat/sessions/:sid/permissions/:permissionId/decide` with body `{ decision: "allow" | "deny" | "always_allow" }`.
5. Backend updates the permission row's status, then releases the paused tool call:
   - `allow` / `always_allow`: invoke `execute()`, return result to model normally.
   - `deny`: return a structured error to the model (see §4.3).

### Future denial payload (encourages model to adjust)

```json
{
  "denied": true,
  "message": "The user denied this tool call. Consider another approach: ask them what they'd like you to do instead, refine your plan, or give them your current best answer. Do not retry this tool without explicit user permission."
}
```

The model sees this as the tool result and adjusts its next turn. This is more robust than the model "noticing" a rejection through natural language.

### Future anti-nagging: three layered defenses

**Layer 1 — Session always-allow**

When the user clicks `Always allow this session`, the backend persists `(session_id, tool_name)` in a new table `session_tool_permissions`. Subsequent calls of the same tool in the same session skip the permission prompt and execute directly.

**Layer 2 — Tool-level always-allow**

User settings UI lets users pre-approve tools globally (e.g., "always allow `delegate_to_agent`").

**Layer 3 — Consecutive-denial cooldown**

Backend tracks `(session_id, tool_name) → consecutive_deny_count`. On 3 consecutive denies for the same tool in the same session, subsequent tool-call-attempt results (whether allowed or denied) are prefixed with an injected system message:

```
"[system] The user has denied this tool 3+ times consecutively. Do not attempt to call it again unless they explicitly request it. Respond to their needs directly."
```

This gets the model to stop trying, without requiring the user to keep clicking Deny.

### Cancel delegation while running

Even after `allow`, a long-running delegation (sub-agent burning tokens) should be cancellable. During sub-agent execution, the UI shows a `Cancel delegation` button on the sub-agent block. Click aborts the child session and returns a structured error to the parent model:

```json
{ "cancelled": true, "message": "User cancelled this delegation mid-run. Give them your current best understanding and ask how they'd like to proceed." }
```

---

## 5. `delegate_to_agent` Tool Contract

### Signature

```ts
delegate_to_agent({
  agent_id: "self" | string,   // Phase 1 only supports "self"
  scope: string,                // specific task for the sub-agent
  context_summary?: string,     // optional — model writes a tight summary of relevant context
}) → {
  summary: string,              // sub-agent's final answer
  session_id: string,           // child session id for traceability
  tool_calls: number,           // number of tool calls the sub-agent made
  duration_ms: number,
}
```

### Behavior

1. Spawns a new `chat_session` with `parent_session_id` pointing to the caller session.
2. If `context_summary` is provided, it's injected as the first user message of the child session. If omitted, the sub-agent runs with only `scope` as input (model is responsible for passing enough context via the parameter).
3. Sub-agent runs independently until it produces a final assistant message or hits a turn limit.
4. Sub-agent's messages stream back to the parent session's SSE channel in real time, tagged with `parent_session_id` so the frontend groups them correctly.
5. On completion, the tool returns the structured result to the parent model.

### Why `context_summary` is model-written (not auto-extracted)

The model knows which parts of the current conversation are relevant to the sub-task. Auto-extraction (e.g., "last N messages") risks sending too much (token bloat) or too little (sub-agent lacks context). Letting the model write a tight paragraph is simpler and semantically better.

### What happens to `deep_search`

Deleted. `delegate_to_agent` covers the same functional territory (invoke a sub-agent to investigate) with a simpler contract (one task per call, not "N hypotheses in parallel"). In Phase 1 the parent may call the tool directly for bounded same-agent checks. Permission gating is intentionally deferred until the DP loop and Agent Work Card UX are validated.

---

## 6. Frontend Display

### 6.1 Data model additions

Phase 1 stores delegation lineage. Permission rows are a future Phase 2 addition.

```sql
ALTER TABLE chat_messages ADD COLUMN from_agent_id TEXT;       -- null = user / system / main-agent; else sub-agent id
ALTER TABLE chat_messages ADD COLUMN parent_session_id TEXT;    -- non-null ⇒ this message belongs inside a sub-agent block
ALTER TABLE chat_messages ADD COLUMN delegation_id TEXT;         -- stable grouping id for delegated work
ALTER TABLE chat_messages ADD COLUMN target_agent_id TEXT;       -- "self" now; external agent id later
```

### 6.2 Future permission message block

Rendered inline in the chat, between the preceding agent message and the forthcoming tool execution:

```
┌─── 🔔 Permission requested ─────────────────────┐
│ Tool: delegate_to_agent                          │
│ Scope: Check mlx5 driver status on              │
│        nodepool-061 and nodepool-062            │
│                                                   │
│ [✓ Allow]  [✗ Deny]  [✓ Always allow session] │
└──────────────────────────────────────────────────┘
```

After decision:

```
✅ Allowed at 15:32:47   (or ❌ Denied)
```

The row persists in history — a full audit trail of every tool gated by the permission system.

### 6.3 Sub-agent nested block (collapsed by default)

**Default (collapsed):**

```
┌───┐
│ ▌ ┃ 🔍 Delegated to sub-agent · scope: "Check mlx5 driver..."
│ ▌ ┃ ✅ 8 tool calls · 45s · [▸ Expand]
└───┘
```

**Expanded (on click):**

```
┌───┐
│ ▌ ┃ 🔍 Delegated to sub-agent · scope: "Check mlx5 driver..."
│ ▌ ┃ [▾ Collapse]
│ ▌ ┃────────────────────────────────────────────────────
│ ▌ ┃ 🤖 sub-agent
│ ▌ ┃ I will first inspect mlx5 driver state on the affected nodes.
│ ▌ ┃
│ ▌ ┃ [tool: bash] kubectl get nodes -o wide
│ ▌ ┃ [tool output] NAME          STATUS   ROLES   ...
│ ▌ ┃
│ ▌ ┃ 🤖 sub-agent
│ ▌ ┃ nodepool-061 and nodepool-062 show mlx5_core firmware resets.
│ ▌ ┃ 
│ ▌ ┃ ...
│ ▌ ┃────────────────────────────────────────────────────
│ ▌ ┃ ✅ Completed · 8 tool calls · 45s
└───┘
```

### 6.4 Running sub-agent block

While the sub-agent is still running:

```
┌───┐
│ ▌ ┃ 🔍 Delegated to sub-agent · scope: "..."
│ ▌ ┃ ⏳ Running · 3 tool calls so far · 00:23 · [Cancel]
└───┘
```

Clicking `Cancel` sends the cancel request described in §4.4.

### 6.5 Grouping rule

Any chat message with `parent_session_id === X` is visually grouped into a single sub-agent block for that parent-session-delegation. Rendered via:

- A shared wrapper `<div class="sub-agent-block">` with left border and padding
- Start marker (synthetic) inserted by frontend: the `🔍 Delegated to ...` header
- End marker (synthetic) inserted by frontend when the child session closes or hits its summary message
- The contained messages render with their normal `MessageItem` component — no special rendering logic, just the visual grouping wrapper

### 6.6 What gets deleted

Components:
- `src/components/chat/HypothesesCard.tsx`
- `src/components/chat/InvestigationCard.tsx`
- `src/components/chat/DpChecklistCard.tsx`
- `parseHypotheses` (frontend copy in HypothesesCard.tsx is deleted when the component is deleted)

Hook state in `usePilotChat.ts`:
- `dpProgress`, `dpChecklist`, `dpFocus`, `dpChecklistActive` state
- `InvestigationProgress`, `DpChecklistItem` types — kept in `types.ts` only if used elsewhere; otherwise deleted
- DP rebuild logic in `loadHistory` (the entry-exit scan is kept but simplified — just derives `dpActive`; no progress/checklist reconstruction)

SSE event handling:
- `dp_status` event handler — deleted
- `tool_progress` event handler's deep_search-specific branch — deleted

Backend:
- `src/core/extensions/deep-investigation.ts` — shrinks from ~900 lines to ~100. Keeps: `[Deep Investigation]` / `[DP_EXIT]` marker handling, system-prompt enhancement injection, `dpActive` boolean tracking. Removes: state machine, `dpHypothesesDraft`, `dpConfirmedHypotheses`, `dpRound`, `DpStatus` enum, `setDpStatus`, checklist sync, TUI widget rendering (if not used), agent_end nudge.
- `src/tools/workflow/dp-tools.ts` — `propose_hypotheses` and `end_investigation` tools removed.
- `src/tools/workflow/deep-search/` — entire directory deleted.
- `parseHypotheses` in `deep-investigation.ts` — deleted.

Schema:
- No migrations remove columns (data retention). New columns added per §6.1.

---

## 7. System Prompt Changes

### DP mode prompt addendum

Injected when `dpActive === true` (i.e., session has a `[Deep Investigation]` marker not followed by `[DP_EXIT]`):

```
You are in Deep Investigation mode. Approach the user's question with the
rigor of a senior SRE running an incident post-mortem:

1. Don't rush to conclusions. Gather multiple pieces of evidence before
   forming hypotheses.
2. Work autonomously by default. Do not ask the user to choose after every
   message.
3. When a focused check would reduce hallucination or gather independent
   evidence, call `delegate_to_agent` with `agent_id="self"`. When there are
   2-3 independent checks, prefer one `delegate_to_agents` batch call. Keep
   each scope bounded and pass only the `context_summary` the sub-agent needs.
   Do not target another agent unless the runtime explicitly exposes that
   capability.
4. When you have enough context to hypothesize, write 2–5 candidate
   hypotheses in plain markdown (numbered list), each with your estimated
   confidence.
5. At a Hypothesis Checkpoint only, append hidden UI hints:
     <!-- hypothesis-checkpoint -->
     <!-- suggested-replies: A|Proceed, B|Refine, C|Summarize -->
6. When the user replies with "Proceed" / "A", continue validating the
   strongest hypothesis. "Refine" / "B <text>" means revise or add
   hypotheses. "Summarize" / "C" means wrap up with your current best answer.
   Any other text — interpret naturally.
7. Document evidence as you collect it. Structure your final answer with
   clear sections: Findings, Root Cause, Recommendation, Caveats.
```

Model is expected to follow points 1–6 but is not blocked by a DP state machine. If the model forgets the checkpoint marker, normal DP turns stay quiet; the user can still type free-form steering text, but the frontend will not show DP steering chips for that message.

### Non-DP sessions

Delegation tools are hidden in ordinary chat: `delegate_to_agent` and `delegate_to_agents` are registered in the codebase but are not exposed to the model unless the AgentBox creates the session with `enableDelegationTools=true`. The HTTP prompt path sets that flag only for a visible `[Deep Investigation]` activation, a restored active DP session, or keeps it off for `[DP_EXIT]` and normal prompts. DP steering chips still require both `dpActive === true` and an explicit Hypothesis Checkpoint marker.

---

## 8. Migration Plan

### Pre-work
- Verify current DP persistence PR (the three commits on `feat/portal-port-from-sicore`) is merged to main.
- Snapshot user preferences / settings that might reference DP features (there aren't many; main one is the `[Deep Investigation]` prefix).

### Step 1 — Land ActionChip unification (no behavior change)
- Refactor existing `suggested-replies` and `Dig deeper` chip code into a single `ActionChip` renderer.
- Existing behaviors unchanged. This is a pure refactor for future reuse.

### Step 2 — Add DP Hypothesis Checkpoint steering
- Prompt asks the model to stay autonomous by default and emit checkpoint markers only at meaningful hypothesis forks.
- Frontend renders DP steering chips only when `dpActive` and the latest assistant message includes `<!-- hypothesis-checkpoint -->`.
- Cards + state machine stay deleted; checkpoint steering uses the existing suggested-replies primitive.

### Step 3 — Validate DP checkpoint base with the real model
- Prompt asks the model not to render visible A/B/C markdown; hidden comments drive the UI chips.
- Frontend strips a trailing visible A/B/C option block when the hidden `suggested-replies` comment is present, so Kimi-style duplicated options do not leak into the message body.
- Smoke against local Kimi-backed Portal verifies the model emits both `<!-- hypothesis-checkpoint -->` and `<!-- suggested-replies: ... -->`.

### Step 4 — Add `delegate_to_agent` contract + Agent Work Card foundation
- New tool contract with `requiresUserApproval: true` metadata reserved for the later permission gate, but availability-gated until a runtime executor is injected.
- Sub-agent / future multi-agent output renders through one collapsed Agent Work Card (`delegate_to_agent` tool rows + lineage fields).
- Permission gate is deliberately deferred so early DP validation does not add approval-click burden.

### Step 5 — Add real same-agent sub-agent executor
- Runtime injects `delegateToAgentExecutor` into web sessions.
- `delegate_to_agent(agent_id="self")` creates a real child pi-agent session and returns `{ summary, session_id, tool_calls, duration_ms }`.
- Child sessions inherit the active model provider/model/config from the parent prompt request.
- Child sessions do not receive `delegate_to_agent` to avoid recursive fan-out in the first DP implementation.

### Step 6 — Validate single-agent DP closed loop
- Real Kimi-backed DP session emits hypothesis checkpoints.
- User-visible checkpoint controls are English-first `Proceed / Refine / Summarize`.
- Clicking a checkpoint control creates a hidden prompt pill in the input, not raw `A/B/C` text.
- Same-agent `delegate_to_agent` renders as a collapsed `Delegated investigation` Agent Work Card in real history.

### Step 7 — Discuss and design multi-agent expert collaboration
- Reuse the same Agent Work Card model for `target_agent_id !== self`.
- Do not fake non-self target agents inside the current AgentBox.
- Route through gateway/portal to the target agent's AgentBox so the target's system prompt, model, tools, credentials, and future permission boundaries are real.
- Open design questions: agent discovery, context handoff shape, cost/latency display, cancellation, and how expert traces aggregate.

### Step 7.5 — Future: async Notify scheduler
- Keep synchronous `delegate_to_agents` as the Phase 1 DP baseline.
- Add a parent-session input queue that can serialize real user messages, cron/task events, and `delegation_event` notifications.
- Async child sessions should outlive the parent turn; child completion enqueues a small capsule instead of relying on the parent model to poll for results.
- Persist the synthetic notification with `role="user"` for model compatibility and metadata `kind="delegation_event"` / `source="system_notification"` so UI never renders it as a real user-authored message.
- Feed only the budgeted capsule to the parent model; full child traces stay in hidden `origin="delegation"` sessions for audit.

### Step 8 — Future: add permission gate infrastructure
- New `role="permission"` message type.
- Tool-runtime interception logic.
- Permission decision endpoint.
- Frontend permission block rendering.
- Enable this only after checkpoint UX and Agent Work Card UX are validated.

### Step 9 — Future: gateway-routed expert delegation
- Add a gateway/portal route that can invoke a target agent's AgentBox instead of faking non-self work inside the caller's runtime.
- Preserve the same `delegate_to_agent` tool contract where possible.
- Reuse Agent Work Card rendering with `target_agent_id !== "self"`.

### Step 10 — Continue deleting dead code as the replacement proves stable
- Remove `HypothesesCard`, `InvestigationCard`, `DpChecklistCard`, `propose_hypotheses`, `end_investigation`, `deep_search`, `parseHypotheses`.
- Shrink `deep-investigation.ts` to just marker handling + prompt injection + `dpActive` flag.
- Remove DP state from hook and SSE handlers.
- Update tests.

### Step 11 — Verify current Phase 1
- Manual test: full DP session end-to-end with a couple of real SRE questions.
- Regression: non-DP sessions unchanged.
- Test: checkpoint chips, hidden prompt pills, same-agent delegation, Agent Work Card rendering, and migration compatibility.

Steps 1–6 are the current Phase 1 acceptance path. Steps 7–9 are future design/implementation work and should not block the single-agent DP closed loop.

---

## 9. Open Questions for Phase 2

These are not blockers for Phase 1 but should be noted:

- **Expert-agent `agent_id`**: How does the main agent discover which specialist agents exist and which to delegate to? Candidate: a new `list_available_agents()` tool or a static catalog in the system prompt.
- **Cross-agent context**: When agent A delegates to B, does B see A's conversation history or only the `context_summary`? Probably the latter (cheaper), with an optional "full context" flag for debugging.
- **Settings-level tool permission policies**: UI for users to pre-approve/pre-deny specific tools.
- **Cost visibility**: Should the permission prompt show estimated token cost / latency? Probably yes for `delegate_to_agent` (it's expensive), probably not for cheap tools.

---

## 10. Success Criteria

Phase 1 is done when:

- A new Deep Investigation session runs end-to-end without any `HypothesesCard` / `InvestigationCard` / `DpChecklistCard` rendering (they're deleted).
- DP steering chips do not appear on every turn; they appear reliably only on explicit Hypothesis Checkpoint messages.
- Checkpoint controls are English-first (`Proceed / Refine / Summarize`) and click into hidden prompt pills instead of raw `A/B/C`.
- `delegate_to_agent(agent_id="self")` runs a real same-agent child session and returns a structured tool result.
- Sub-agent work renders collapsed-by-default with a one-line summary; expand reveals scope, summary, trace/session id, tool calls, and duration.
- Non-self `agent_id` expert collaboration is not faked; it remains a gateway/portal routing design item.
- No `dp_status` SSE events are emitted or handled.
- Non-DP chat sessions are completely unaffected.
- `src/core/extensions/deep-investigation.ts` line count is ≤ 200 (down from ~900).
- All tests pass; the removed-feature tests are deleted, not skipped.

---

## 11. Credits

Design developed in a series of discussions between the project author and Claude over 2026-04-23 to 2026-04-24, after the DP-persistence bug storm surfaced the maintenance cost of the old architecture. Key decisions anchored by the project author:

- "DP state should only toggle off on explicit user or agent exit." → drives the `dpActive` scan-based rebuild (Phase 1 already landed).
- "Reuse the existing suggested-replies text-options primitive; don't invent new protocols." → drives the ActionChip unification.
- "Use a Claude Code-style allow/deny mechanism for sub-agent calls; we don't need a state machine if the gate lives in the tool runtime." → drives Primitive 2.
- "DP steering should be hypothesis-specific, not a generic every-turn control." → drives the checkpoint-only display rule.
- "Sub-agent block default collapsed with a one-line summary; expand on click." → resolves the density/verbosity trade-off.
