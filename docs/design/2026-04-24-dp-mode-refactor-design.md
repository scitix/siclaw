---
title: "Deep Investigation Mode — Refactor Design"
sidebarTitle: "DP Mode Refactor (2026-04-24)"
description: "Replace the DP state machine + specialized cards with two generic primitives (action chips + permission-gated tool calls), simplifying maintenance and unlocking future agent-team work."
---

# Deep Investigation Mode — Refactor Design

> **Status**: Design approved (2026-04-24). Implementation pending.
> **Supersedes**: The current `src/core/extensions/deep-investigation.ts` state-machine + `propose_hypotheses` / `deep_search` / `end_investigation` tool family + `HypothesesCard` / `InvestigationCard` / `DpChecklistCard` React components.

---

## 0. Why

After shipping DP persistence fixes in late April 2026, ~70% of the bugs we hit traced back to DP's heavy architecture (specialized state machine, tool trio, three bespoke cards, `[DP_CONFIRM]` / `[DP_ADJUST]` markers, `dp_status` SSE events). The product value users actually get from this complexity is thin — mostly "a visual signal that the agent is doing structured investigation". Plain markdown already conveys that.

This refactor strips DP down to what it *is*:

1. **A prompting enhancement** that makes a single agent reason more divergently and chase details.
2. **A generic permission primitive** so the model cannot run away with expensive sub-agent calls without user consent.
3. **A generic "action chips" primitive** so users can quickly respond to the agent without losing the ability to add free-form context.

Neither primitive is DP-specific — both are reusable across the product. Phase 2 (future) builds on these to support multi-agent expert teams.

---

## 1. Scope

### In scope (Phase 1 — this refactor)

- Replace DP state machine with a simple mode flag (`dpActive`).
- New generic tool `delegate_to_agent` replacing `deep_search`.
- New tool-runtime primitive: `requiresUserApproval` + user permission flow.
- Unify existing "suggested-replies" chips and "Dig deeper" chip under one `ActionChip` abstraction.
- Add three fixed DP action chips (`Confirm` / `Adjust` / `Skip`) displayed when `dpActive && latest-is-assistant && !streaming && !pendingToolCall`.
- Inline nested rendering for sub-agent delegations (collapsed-by-default, one-line summary).
- Delete `HypothesesCard`, `InvestigationCard`, `DpChecklistCard`, `propose_hypotheses`, `end_investigation`, `deep_search`, `dp_status` event, `dpStatus` enum, `dpChecklist` / `dpProgress` / `dpFocus` hook state, `parseHypotheses` (both frontend and backend copies).

### Explicitly deferred (Phase 2+)

- Multi-agent expert teams (`delegate_to_agent(agent_id=<other>)`).
- Domain sweep phase (parallel specialist exploration before hypothesis).
- Tool-level "always allow" setting in user preferences (Phase 1 only supports session-level).
- Visual multi-agent sidebar / timeline.
- Collapsible sub-agent block *expansion optimizations* (Phase 1 ships simple collapse/expand only).

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
│  [Primitive 1 — ActionChip]                                       │
│    A reusable click-to-fill-input button.                         │
│    DP mode shows three fixed chips (Confirm / Adjust / Skip)     │
│    whenever the agent is waiting for user input.                  │
│    Model-emitted suggestions (A. xxx / B. yyy) keep working.     │
│                                                                   │
│  [Primitive 2 — Permission-gated Tool Call]                       │
│    Tools declared `requiresUserApproval: true` pause at runtime   │
│    and emit a permission_request message. User clicks Allow /    │
│    Deny / Always-allow-this-session to release the call.          │
│    DP uses this for `delegate_to_agent`.                          │
└─────────────────────────────────────────────────────────────────┘
```

No state machine. No specialized cards. No DP-specific markers other than the existing `[Deep Investigation]` prefix and `[DP_EXIT]` marker.

---

## 3. Primitive 1: ActionChip

### Unified abstraction

A single `ActionChip` config powers three existing use-cases (`suggested-replies`, `Dig deeper`) plus the new DP chips:

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
User clicks [A. Confirm hypotheses]
  → input box now contains "A"
  → user can press send immediately, OR add context like "A — also check kubelet logs"
  → send dispatches the raw text
```

Used by:
- Model-generated suggested replies (existing; `detectOptionReplies` regex catches `A. xxx / B. yyy` in assistant output)
- DP three fixed chips

**`prefix`** (atomic pill in input that expands on send):

```
User clicks [Dig deeper]
  → input box shows an atomic pill "[Dig deeper]"
  → user can type additional direction after the pill
  → on send: pill is replaced by the full expandTo template, user text appended under appendUserLabel
```

Used by:
- `Dig deeper` button (existing)

### DP fixed chip configuration

```ts
const DP_CONFIRM: ActionChip = {
  id: "dp-confirm",
  label: "按当前方向继续",
  kind: "fill",
  insertText: "A",
}

const DP_ADJUST: ActionChip = {
  id: "dp-adjust",
  label: "调整方向",
  kind: "fill",
  insertText: "B ",  // trailing space invites user to type
}

const DP_SKIP: ActionChip = {
  id: "dp-skip",
  label: "直接给我结论",
  kind: "fill",
  insertText: "C",
}
```

### Display rule for DP chips

```ts
const showDpChips =
  dpActive &&
  latestMessage?.role === "assistant" &&
  !isStreaming &&
  !hasPendingToolCall
```

No content detection. No state machine phase check. Three booleans AND'd together — that's the entire rule.

Chips render below the latest assistant message as buttons, identical in appearance and interaction to the existing `suggested-replies` chips.

### Semantics: fully in the model's hands

The chips are pure frontend UI sugar. When clicked:
- `A` → user message is just the string `"A"` (or `"A user-added context"`)
- `B ...` → user message is `"B ..."` 
- `C` → user message is just `"C"`

The backend agent has no knowledge of "chips". It receives natural user text and interprets via the DP system prompt, which says:

> When the user's reply starts with `A` alone — proceed with your current plan.
> When the user's reply starts with `B` — they want to adjust your direction; read what follows.
> When the user's reply starts with `C` — wrap up with your current best conclusion.
> If the user types anything else — interpret naturally.

No state machine is needed to enforce these semantics — the LLM handles context-sensitive interpretation.

### Dynamic suggested replies (retained)

The existing `<!-- suggested-replies: ... -->` HTML comment and `A. xxx / B. yyy` pattern detection are preserved. Model may emit them freely in non-DP turns; frontend renders them identically. No cross-interaction with DP chips (they're scoped to different conditions).

---

## 4. Primitive 2: Permission-gated Tool Calls

### Tool declaration

Tools opt in via a new property in the tool definition:

```ts
{
  name: "delegate_to_agent",
  parameters: Type.Object({ ... }),
  requiresUserApproval: true,  // new
  execute: async (...) => { ... },
}
```

### Runtime flow

1. Model's turn produces a tool call to `delegate_to_agent` (or any other `requiresUserApproval` tool).
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

### Denial payload (encourages model to adjust)

```json
{
  "denied": true,
  "message": "The user denied this tool call. Consider another approach: ask them what they'd like you to do instead, refine your plan, or give them your current best answer. Do not retry this tool without explicit user permission."
}
```

The model sees this as the tool result and adjusts its next turn. This is more robust than the model "noticing" a rejection through natural language.

### Anti-nagging: three layered defenses

**Layer 1 — Session always-allow**

When the user clicks `Always allow this session`, the backend persists `(session_id, tool_name)` in a new table `session_tool_permissions`. Subsequent calls of the same tool in the same session skip the permission prompt and execute directly.

**Layer 2 — Tool-level always-allow** (deferred to Phase 2)

User settings UI lets users pre-approve tools globally (e.g., "always allow `delegate_to_agent`"). Not implemented in Phase 1.

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

Deleted. `delegate_to_agent` covers the same functional territory (invoke a sub-agent to investigate) with a simpler contract (one task per call, not "N hypotheses in parallel"). If the model wants parallel validation, it calls `delegate_to_agent` multiple times — each of which requires user approval, which is the correct behavior given cost.

---

## 6. Frontend Display

### 6.1 Data model additions

```sql
ALTER TABLE chat_messages ADD COLUMN from_agent_id TEXT;       -- null = user / system / main-agent; else sub-agent id
ALTER TABLE chat_messages ADD COLUMN parent_session_id TEXT;    -- non-null ⇒ this message belongs inside a sub-agent block
-- chat_messages.role enum gains "permission"

CREATE TABLE session_tool_permissions (
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name)
);
```

### 6.2 Permission message block

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
│ ▌ ┃ 让我先看各节点的 mlx5 驱动状态
│ ▌ ┃
│ ▌ ┃ [tool: bash] kubectl get nodes -o wide
│ ▌ ┃ [tool output] NAME          STATUS   ROLES   ...
│ ▌ ┃
│ ▌ ┃ 🤖 sub-agent
│ ▌ ┃ 发现 nodepool-061 和 062 的 mlx5_core 固件有异常 reset
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
2. When you have enough context to hypothesize, write 2–5 candidate
   hypotheses in plain markdown (numbered list), each with your estimated
   confidence.
3. After listing hypotheses, present three options on new lines:
     A. Proceed with current direction
     B. Adjust — (user will elaborate)
     C. Skip validation and give me the best answer now
4. If you need to delegate deeper investigation to a sub-agent, call the
   `delegate_to_agent` tool. This requires user approval — do not expect
   it to run silently. Write a tight `context_summary` so the sub-agent
   has what it needs.
5. When the user replies with "A", proceed as they've agreed to your plan.
   "B <text>" means redirect based on what they wrote. "C" means wrap up
   with your current best answer. Any other text — interpret naturally.
6. Document evidence as you collect it. Structure your final answer with
   clear sections: Findings, Root Cause, Recommendation, Caveats.
```

Model is expected to follow points 1–6 but is not blocked by the frontend if it doesn't (no state machine). If the model forgets to emit A/B/C, the user still sees the three DP chips below the message (§3) and can click them — the model will receive the user's raw text response and interpret.

### Non-DP sessions

No system prompt changes. `delegate_to_agent` tool is still available in non-DP sessions (permission gate applies regardless). DP chips are only shown when `dpActive === true`.

---

## 8. Migration Plan

### Pre-work
- Verify current DP persistence PR (the three commits on `feat/portal-port-from-sicore`) is merged to main.
- Snapshot user preferences / settings that might reference DP features (there aren't many; main one is the `[Deep Investigation]` prefix).

### Step 1 — Land ActionChip unification (no behavior change)
- Refactor existing `suggested-replies` and `Dig deeper` chip code into a single `ActionChip` renderer.
- Existing behaviors unchanged. This is a pure refactor for future reuse.

### Step 2 — Add DP three-chip display
- Frontend-only change. Model/backend untouched.
- DP chips appear below latest assistant message when conditions match.
- Cards + state machine still present (DP mode still partially uses the old machinery; chips coexist).

### Step 3 — Add permission gate infrastructure
- New `role="permission"` message type.
- Tool-runtime interception logic.
- Permission decision endpoint.
- Frontend permission block rendering.
- No tools use `requiresUserApproval` yet — just the plumbing.

### Step 4 — Add `delegate_to_agent` tool (initially with `deep_search` still alive)
- New tool with `requiresUserApproval: true`.
- Sub-agent block rendering on frontend (collapsed by default).
- Tested alongside existing `deep_search` — both present.

### Step 5 — Swap DP over
- Update DP system prompt to use `delegate_to_agent` (and remove references to `propose_hypotheses`).
- Model now uses the new tool in DP sessions.
- Old `deep_search` still callable but DP doesn't trigger it.

### Step 6 — Delete dead code
- Remove `HypothesesCard`, `InvestigationCard`, `DpChecklistCard`, `propose_hypotheses`, `end_investigation`, `deep_search`, `parseHypotheses`.
- Shrink `deep-investigation.ts` to just marker handling + prompt injection + `dpActive` flag.
- Remove DP state from hook and SSE handlers.
- Update tests.

### Step 7 — Verify
- Manual test: full DP session end-to-end with a couple of real SRE questions.
- Regression: non-DP sessions unchanged.
- Test: permission gate denied, allowed, always-allowed, cancel-mid-run paths.

Steps 1–6 can each be a separate commit; Step 5 is the flip point. Steps 1–4 are purely additive (no user-visible breakage); Step 6 is deletion after the swap is verified.

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
- The DP chips (`Confirm` / `Adjust` / `Skip`) appear reliably when the agent is waiting for user input.
- `delegate_to_agent` pauses for user approval; the user can Allow, Deny, Always-allow-session, or Cancel mid-run.
- Sub-agent work renders collapsed-by-default with a one-line summary; expand reveals the full transcript.
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
- "Three DP chips are generic conversation controls, not hypothesis-specific." → drives the "always show when waiting" display rule.
- "Sub-agent block default collapsed with a one-line summary; expand on click." → resolves the density/verbosity trade-off.
