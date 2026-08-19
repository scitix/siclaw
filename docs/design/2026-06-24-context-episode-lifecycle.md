# Context Episode Lifecycle

> Status: design (no implementation yet)
> Author: discussion-driven (lrli)
> Supersedes nothing; complements `guards.md` (compaction) and the per-agent
> idle-timeout work (PR #350 / #357).

---

## 1. Problem

SRE diagnostics are **episodic**: a user asks "why is `cart-service` 502ing",
the agent investigates, the incident closes. The next question ("check disk on
cluster B") is usually a *different* problem. But users keep typing into the
**same** chat session and never start a new one, so every new question replays
the entire accumulated history into the model.

Consequences:

- Context fills up; the model is forced into **compaction** (lossy, slow, and
  carrying the risks catalogued in `guards.md` — estimator divergence, possible
  data loss under pressure).
- The new, unrelated question is answered against a context polluted by an old,
  irrelevant investigation.
- Cost and latency grow turn over turn for no benefit.

The existing defenses (`context-pruning.ts`, `compaction-safeguard.ts`) fight
the *symptom* — one ever-growing context. They never insert a **boundary**
between two logically independent problems.

Channels already solve the extreme case: **group chats are stateless** (each
message independent) and **1:1 chats expose `/new`**. Portal Web, TUI, and
`/api/v1/run` with a reused `sessionId` have no automatic boundary at all.

### Goal

Insert **episode boundaries** so independent questions do not share raw context,
carry only a small bounded **bridge** across a boundary, and surface the whole
mechanism into the four product surfaces: **dashboard, sessions, tools,
feedback**.

### Non-goals

- Replacing compaction. Compaction remains the in-episode safety net for a
  single genuinely-long investigation. This design reduces how often it fires.
- Changing group-chat or stateless-API semantics (already correct).

---

## 2. Core model: the *episode*

An **episode** is a bounded span of conversation within one logical thread. It
is the unit the model's context is scoped to.

**Contract E1 — episode is a sub-unit of a session.**
Every session has ≥1 episode. A boundary *closes* the current episode and
*opens* a new one **within the same session row**. We do NOT proliferate
session rows. This keeps the model uniform across surfaces and integrates with
the existing `chat_sessions` table and session-list UI.

**Contract E2 — context spans only the current episode.**
When the brain is prompted, the messages it sees are: the **bridge** of the
just-closed episode (if any) + the current episode's own turns. Prior episodes'
raw turns are NOT in context. They remain fully persisted and readable in the
session history; they are simply not replayed to the model.

**Contract E3 — a boundary never destroys history.**
Closing an episode produces a bounded **bridge summary** and (optionally) a
Memory record. The raw turns stay in the DB / JSONL. "Forgetting" is scoped to
the *model's working context*, never to the durable record. This is the
explicit inverse of the compaction failure mode where summarized turns are lost.

### 2.1 The bridge

On boundary close, summarize the closing episode into a **bounded** note
(reuse the `compaction-safeguard` summarizer / `session-summarizer.ts`):

- It is small (target ≤ ~500 tokens) and capped.
- The next episode starts with `{bridge, new user question}`.
- If the new question *is* a continuation, the bridge gives continuity cheaply.
- If unrelated, the bridge is small and ages out within the new episode.

This is what makes the design **robust to imperfect boundary detection**: a
mis-split costs at most one small bridge, never the raw history and never a
ballooned context.

---

## 3. Where the decision lives

All surfaces funnel through one choke point:

```
Portal chat-gateway ─┐
Feishu / DingTalk   ─┤
/api/v1/run         ─┼─► gateway/agentbox/client.ts ─► POST /api/prompt
                     │      (http-server.ts:570) ─► agentbox session ─► brain.prompt()
TUI (in-process)    ─┘      (same core session/brain)
```

**Contract D1 — boundary DECISION at the prompt-routing layer.**
The decision "continue the current episode or open a new one" is made when a
prompt *arrives*, by a shared **policy engine**. It must use the **durable**
`last_active_at` from the DB, because on K8s the AgentBox pod may have
idle-destructed between turns (PR #350) — the pod's in-memory `lastActiveAt`
(`agentbox/session.ts:77`) is gone, but the conversation's boundary is a
property of the *conversation*, not of pod liveness.

**Contract D2 — boundary ACTION in the agentbox session.**
Once told "new episode", the session performs the close: summarize → bridge →
scope context to the new episode. The brain is then prompted with the
episode-scoped context.

This split is why the solution is uniform: the *policy* is shared; only the
*presentation* of a boundary differs per surface (§7).

---

## 4. The policy engine: layered triggers

Evaluated cheapest-first; first match wins. All thresholds are per-agent
configurable (§8).

| Tier | Trigger | Cost | Default | Rationale |
|---|---|---|---|---|
| **0** | **Explicit** (`/new`, "New Session", `end_episode` tool) | none | always on | User/agent intent is authoritative; never removed. |
| **1** | **Idle-gap**: `now − last_active_at > episode_idle_window` | none (zero LLM) | 20 min | Matches episodic SRE; deterministic; reuses durable `last_active_at`. **Primary workhorse.** |
| **2** | **Topic-shift classifier**: one cheap LLM yes/no on the new prompt vs. current episode | 1 small call | OFF | For back-to-back questions inside the active window; opt-in for teams wanting tighter separation. |
| **B** | **Backstop cap**: `turn_count > cap` OR `context_pct > cap%` | none | turn 40 / 80% | Bounds even a continuous session so nothing runs away. |

**Contract P1 — guard against breaking live work.**
Tier 1/2/B are suppressed while the session has live state: an active turn,
queued steer/followUp, pending subagents, or non-idle activity status
(`session.getActivityStatus()` / background-work count). A boundary may only
open on a *fresh* prompt to an *idle* session.

**Contract P2 — resident escape hatch.**
`episode_idle_window = 0` ⇒ never auto-break (continuous session). This mirrors
exactly the `normalizeIdleTimeoutSec` `0`-resident semantics shipped in
#350/#357 — reuse that normalizer shape for the new field.

**Contract P3 — soft boundary on single-thread surfaces.**
On channels/TUI, the close emits a recoverable notice ("旧上下文已归档,回复可继续
上一个问题" / `/resume`) so a user who stepped away mid-incident can re-merge the
prior episode's bridge. The merge re-seeds the prior bridge into the current
episode; it does not un-persist anything.

---

## 5. Data model

### 5.1 New table `chat_episodes` (Gateway/Portal DB)

Single DDL in `src/portal/migrate.ts`, MySQL + SQLite compatible (no
`TIMESTAMP(3)`, no `JSON`, no `ON UPDATE` — per invariants §5).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT/VARCHAR PK | episode id |
| `session_id` | FK → `chat_sessions.id` | |
| `agent_id` | FK | denormalized for dashboard queries |
| `seq` | INT | 1-based ordinal within the session |
| `started_at` | DATETIME | |
| `ended_at` | DATETIME NULL | NULL = current/open episode |
| `end_reason` | VARCHAR | `explicit` / `idle` / `topic` / `cap` / NULL |
| `turn_count` | INT | turns in this episode |
| `context_tokens_at_end` | INT | for dashboard "context-at-break" |
| `title` | VARCHAR | auto-derived from first user ask |
| `bridge_summary` | TEXT | bounded; the cross-boundary carry |

`chat_messages` gains an `episode_id` FK (nullable for legacy rows; a backfill
maps existing messages to a single synthetic episode per session).

### 5.2 Session-level derived fields

`chat_sessions` (or a view) exposes, for the session list:
`episode_count`, `active_episode_context_pct`, `last_active_at`.

---

## 6. Integration with the four surfaces

### 6.1 Sessions

The session detail (`AgentChat.tsx`) renders a session as **episode segments**:

- Closed episodes render **collapsed** with their `title`, turn count, and
  end-reason chip (`⏱ idle` / `🔀 topic` / `🛑 cap` / `✋ manual`). Expanding one
  shows its raw turns (read from history — not in model context).
- The current episode renders expanded.
- A boundary divider shows the `bridge_summary` on hover/expand, with an "继续
  这个话题" action (Contract P3 re-merge).

Session list (`AgentChat` left rail) shows per session: `episode_count`,
`active_episode_context_pct` as a small meter (a passive nudge — data already
available via `GET /api/sessions/:id/context`), and `last_active_at`.

**API:** `GET …/chat/sessions/:id/episodes` (read-only, returns the
`chat_episodes` rows + bridge). `POST …/chat/sessions/:id/episodes/new`
(explicit boundary — the server-side equivalent of the "New Session" button,
but it opens an episode in place rather than a new row).

### 6.2 Tools

Two touch-points in the tools surface:

1. **Agent-invokable boundary tool `end_episode`.** A capability-gated tool the
   agent calls when it judges the current problem *resolved* ("incident closed,
   rolled back #4821"). This is the proactive form you asked about earlier — the
   agent closes the episode itself instead of waiting for the next prompt's
   idle-gap. Registered in the tool registry (`src/tools/all-entries.ts`) and
   added to a `CAPABILITY_GROUPS` entry (`src/core/tool-capabilities.ts`) so it
   appears in `CapabilityGroupSelector` and can be toggled per agent.
   - `end_episode({ resolution_summary })` → writes the bridge, closes the
     episode. Idempotent; no-op if the current episode has no real turns.

2. **The boundary policy is configured in the same per-agent area** as tool
   capabilities (`AgentSettings.tsx`), not a separate page (§8).

**Contract T1 — `end_episode` shares the boundary action path (Contract D2).**
Agent-driven and policy-driven closes produce identical `chat_episodes` rows and
bridges, so dashboard/feedback see one uniform event type.

### 6.3 Feedback

Extend the existing `save_feedback` tool / Gateway feedback store with
**episode-boundary correctness** so the policy can be tuned from real usage:

- Each closed episode gets a lightweight, optional **👍/👎 on the boundary**
  rendered at the divider in Sessions: "切对了 / 应该续上一个问题". This writes a
  feedback row tagged `episode-boundary` with `{episode_id, end_reason,
  idle_gap_sec, verdict}`.
- `save_feedback` (`src/tools/workflow/save-feedback.ts`) gains an optional
  `episodeId` + a `boundaryVerdict` tag so the agent's own feedback review can
  comment on whether segmentation helped.

**Contract F1 — feedback closes the tuning loop.**
Aggregated `episode-boundary` feedback (false-split rate by `idle_gap_sec`
bucket) is what justifies moving the default `episode_idle_window` or enabling
the Tier-2 classifier. The dashboard (§6.4) surfaces this aggregation.

### 6.4 Dashboard

Feed episode telemetry into the Metrics surface (`Metrics.tsx` / `useMetrics`,
Grafana). New panels (sourced from `chat_episodes` + the feedback rows):

- **Episodes per session** (distribution) — are users actually multi-topic?
- **Auto-break rate & end-reason mix** (`idle` / `topic` / `cap` / `explicit`).
- **Context utilization at break** (`context_tokens_at_end` / window) — are we
  breaking early enough to avoid compaction?
- **Compactions per episode** — should trend toward ~0 as boundaries do the job.
- **False-split rate** — from `episode-boundary` 👎 feedback, by idle-gap bucket
  (drives the tuning loop, Contract F1).
- **Tokens saved** — estimated raw-history tokens NOT replayed because of
  episode scoping (the headline cost win).

Emit these as metrics through the existing metrics pipeline (the same one behind
`metrics?: { port?, token?, includeUserId? }` in `config.ts`), so prod
Prometheus/Grafana federation picks them up with no new infra.

---

## 7. Per-surface behavior matrix

| Surface | Shape | Boundary materialization | Notice |
|---|---|---|---|
| **Portal Web** | session-list | episode segment in the same session row; auto-title; collapse old | context meter + divider with re-merge action |
| **1:1 Feishu/DingTalk** | single-thread | in-place collapse; reuse existing `/new` plumbing | subtle "🔄 新话题(已归档,回复可继续)" card |
| **TUI** | single-thread | auto-`/new` with a printed divider; `/resume` to undo | divider line |
| **/api/v1/run** | single-thread | **stateless per call by default**; episodes only when `sessionId` is explicitly reused | n/a (documented) |
| **Group channels** | stateless | unchanged — each message already independent | none |

---

## 8. Configuration (per-agent, Portal Basic)

Following the #350 precedent (per-agent column + a shared `normalizeXxx`
normalizer applied at both the write boundary and the consumer):

| Field | Default | `0` / unset meaning |
|---|---|---|
| `episode_idle_window_sec` | `1200` (20 min) | `0` = continuous (never auto-break); reuse `normalizeIdleTimeoutSec` shape |
| `episode_turn_cap` | `40` | `0` = no turn backstop |
| `episode_context_pct_cap` | `80` | `0` = no context backstop |
| `episode_topic_classifier` | `false` | Tier-2 opt-in |

Rendered in `AgentSettings.tsx` near the idle-timeout field, with the same help
-text discipline (state the floor / the `0`-disables escape hatch explicitly).

---

## 9. Guards, risks, open questions

- **G1 — never break live work** (Contract P1). The single biggest correctness
  requirement; an episode must never split a turn or orphan background jobs.
- **G2 — bridge quality.** A bad bridge degrades a *related* follow-up. Mitigate
  by reusing the audited summarizer (required sections, identifier preservation)
  and capping bridge size; a related follow-up that needs more can re-merge
  (P3) or the agent re-investigates (cheap, the data is still in the cluster).
- **G3 — estimator consistency.** Reuse ONE token estimate for the context
  meter, the `context_pct_cap` backstop, and `context_tokens_at_end` — do not
  add a fourth estimator (the divergence already flagged in `guards.md`).
- **OQ1** — Portal: do we ever still want a *new session row* (not just a
  segment) for very long-lived sessions? Default: no (segments only); revisit if
  segment lists get unwieldy.
- **OQ2** — Memory flush of closed episodes is gated on `SICLAW_MEMORY_ENABLED`;
  when off, bridges live only in `chat_episodes`. Acceptable.

---

## 10. Phased rollout (each phase independently shippable, feature-flagged)

1. **P1 — boundary engine + Sessions (zero LLM).**
   `chat_episodes` table + episode_id on messages; Tier-0/1/B policy at the
   prompt router; episode-scoped context in the agentbox session; Sessions UI
   segments + context meter; per-agent `episode_idle_window_sec`. **Highest ROI,
   no model cost.**
2. **P2 — single-thread surfaces + bridge.** In-place collapse + bridge summary
   for channels/TUI/API; soft re-merge (P3).
3. **P3 — tools + feedback + dashboard.** `end_episode` tool + capability group;
   `save_feedback` episode fields + per-boundary 👍/👎; Grafana panels; optional
   Tier-2 classifier driven by the feedback loop.

P1 alone removes the cause for the dominant case (Portal, idle-separated SRE
questions) at zero model cost, reusing `last_active_at` and the #350 per-agent
config + normalizer pattern.

---

## 11. Out of scope

The Audit dashboard's **entry-surface breakdown** (splitting metrics by
web / api / a2a / channels, and aligning with control-plane's monitoring system) is a
**separate observability concern**, orthogonal to context compaction. It is
intentionally NOT covered here and should be designed on its own if pursued.
The episode-observability touch-points in §6.1–§6.4 (episode counts,
end-reasons, context-at-break, compactions avoided, per-boundary feedback) are
in scope because they are intrinsic to this feature; the cross-surface metrics
taxonomy is not.

