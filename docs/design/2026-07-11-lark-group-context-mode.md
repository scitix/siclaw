# Lark Group Context Mode: Shared vs Per-User

**Date**: 2026-07-11
**Status**: Design approved, implementation pending
**Branch**: `investigate/lark-group-context-mode`

## Problem

A group-chat agent serves two contradictory scenarios:

- **Incident / war-room groups**: the whole group works one problem. The agent
  must see the ENTIRE group discussion — including messages that never @-mention
  it — so that when someone @s it, it answers from full context.
- **Customer-support groups**: members ask unrelated questions. Each sender
  needs an isolated conversation — no context bleed, no queueing behind other
  people's turns, `/new` resets only yourself.

Today the scoping is fixed per binding path (PAIR groups → per-sender
`open_id:` sessions; open personal bots → group-shared `chat:` sessions) with
no user-facing choice, and non-@ group messages are dropped unconditionally
(`lark.ts` mention gate), so even a "shared" session only contains @-turns.

## Decisions

1. **Mode is per group, stored server-side on the binding row** — a
   `context_mode` field (`shared` | `per_user`) on the group's binding record
   (`channel_bindings` in the built-in Portal; the equivalent record in any
   external portal adapter). NOT runtime config, NOT per agent (one agent
   serves many groups).
2. **A NEW group defaults to `shared`** — written explicitly at pair/auto-bind
   time. But a NULL/legacy row resolves to `per_user` (grandfathering; see
   Migration below), interpreted in ONE place server-side — do NOT read this as
   "NULL means shared". Rationale: the primary use is support/incident groups; a
   user who wants isolation creates their own group with the bot and manually
   switches it to `per_user`.
3. **The decision point stays `channel.resolveBinding`.** The server picks the
   session-key formula from the mode — `shared` → `chat:{route_key}`,
   `per_user` → a per-sender key (`open_id:{sender}`, or whatever per-user
   identity the portal adapter maintains — the runtime treats the key as
   opaque) — and additionally returns `context_mode` on
   `ResolvedChannelBinding`. The runtime keeps using the returned `sessionKey`
   verbatim for both session identity and the serialization queue (unchanged
   contract); it must NOT infer mode from the key shape.
4. **Full-context ingestion (shared mode only)** — *buffer-and-inject*:
   - A non-@ group message in a `shared` group is appended to a per-session
     **discussion buffer** (sender + text + time). It runs no agent turn and
     MUST NOT touch the AgentBox (no wake-up of idle-destructed pods).
   - When the bot is @-mentioned, the un-consumed buffer is rendered as an
     attributed transcript block (`[name]: text` lines) and prepended to that
     turn's prompt. Snapshot+clear happens inside the queued task (atomic
     w.r.t. the binding queue). The discussion thus enters the agent's pi
     session organically and accumulates turn over turn.
   - Rationale for this shape: agent context is the AgentBox-side pi session
     (JSONL), NOT rebuilt from `chat_messages` — writing passive rows to the DB
     alone would be invisible to the model. Per-message injection into the
     AgentBox was rejected (wakes/keeps pods alive on every group chatter).
   - Bounds: the per-turn injected transcript is capped (newest-first retention,
     e.g. ~100 messages / ~8k chars, with an explicit truncation note). The
     buffer itself is bounded the same way.
5. **Privacy discipline (hard rule)**: a non-@ message in a `per_user` group is
   discarded immediately — never buffered, never persisted, never entered into
   any context. The receive-all-group-messages permission is app-level, so the
   bot receives chatter from ALL groups; only `shared` groups may consume it.
6. **Sender attribution**: in `shared` mode every injected line and every
   @-turn is prefixed with the sender (display name via contact API + cache
   when the permission exists; open_id tail as fallback; a portal adapter that
   maintains its own user identities may supply better display names).
   Without attribution a multi-user shared context is ambiguous
   ("check MY cluster").
7. **Graceful degradation**: without the Feishu receive-all permission, non-@
   messages never arrive; `shared` degrades to "shared @-turns only" (multiple
   senders share one session but the agent doesn't hear the chatter). This is
   functional, not an error.

## Feishu permission matrix

| Permission | per_user | shared (full context) |
|---|---|---|
| Receive @bot group messages (default bot capability) | required | required |
| `im:message.group_any_msg:readonly` (receive ALL group messages) | not needed | **required for full context**; sensitive, tenant-admin approved, app-level |
| `contact:user.base:readonly` (open_id → name) | not needed | recommended (attribution) |
| `im:message:readonly` (fetch history — optional cold-start backfill) | not needed | optional |

The privacy discipline in Decision 5 is the standing answer to the security
review that the sensitive scope will trigger.

## Message-flow contract (runtime)

```
group message arrives
 ├─ @bot        → resolveBinding (existing path) → enqueue agent turn on the
 │                returned sessionKey; in shared mode, prepend the drained
 │                discussion buffer to the prompt
 └─ no mention  → look up the group's context_mode (short-TTL cache, no RPC
                  per message)
                   ├─ shared   → append {sender, text, ts} to the session's
                   │             discussion buffer; no agent run
                   └─ per_user → drop immediately (today's behavior)
```

- The mode cache is invalidated by the existing channel-reload notification
  (also the propagation path for console edits) and by TTL expiry. A switch
  originating from the group's own card additionally busts the local cache
  immediately (no notify round-trip).
- `/new` in a shared group is REJECTED, not honored: the group shares one
  session, so one member's reset would wipe everyone's context. The runtime
  replies a short notice pointing at `/mode` (switch to per_user) or a new
  group; a confirmation-gated "reset the whole room" is deferred. per_user
  groups and personal chats reset the caller's own session as before.
- Serialization: shared groups keep the single per-session queue (desirable
  for incident coherence); per_user groups keep per-sender concurrent queues.
- Mode switch mid-life = subsequent messages resolve to the OTHER key formula
  (a different session), it does NOT reset a session. So a per_user→shared
  switch-back reuses the group's prior `chat:` session and its history
  resurfaces — the announcement therefore states the behavior change ("messages
  are now handled as one shared conversation" / "each person talks separately"),
  NOT a "fresh start" it can't guarantee. The runtime does drop its buffered
  non-@ chatter on a detected mode change so stale chatter can't cross a switch.
- The discussion buffer is runtime-process memory, keyed by session. A channel
  app holds ONE long connection from one runtime process, so the buffer is
  local by construction; a runtime restart drops un-consumed chatter (bounded,
  documented loss). Persistence is a follow-up if it matters.

## Product surfaces

1. **In-group switch card** (MVP, channels-only): a command summons an
   interactive card showing the current mode with switch buttons. The
   *capability* is channel-generic (see below); the card UI is per-channel,
   **Feishu first**.
   - Summon: `/mode` in the group (command-word, recognized like `/new` /
     `PAIR` — exact match, works with or without @bot).
   - Card: current mode + two buttons (Team / Personal), reusing the
     `card.action.trigger` callback chain (same infra as the 👍/👎 feedback
     buttons; `action.value` is SELF-CONTAINED — binding/channel/chat ids +
     locale embedded, no server-side card-id mapping).
   - On switch: update `context_mode` via the generic RPC, invalidate the
     runtime mode cache + drop the buffered chatter, update the card in place,
     and post a visible group announcement stating the new behavior — audit
     trail + everyone learns the change. The copy states the behavior change,
     not a guaranteed reset.
   - Permission: MVP allows any group member to switch, with the visible
     announcement as the social control (groups are self-governed — the
     "user creates their own group and flips it" flow must not require a
     console admin). Tightening (binding creator / chat admin via
     `im:chat:readonly` role query) is a follow-up knob, not MVP.
2. **Bind-time notice** (MVP): the PAIR-success / auto-bind greeting states the
   current mode in scenario language and embeds the same switch buttons. Copy
   avoids "session/context" jargon (shared = "Team mode: the bot follows the
   whole group's discussion"; per_user = "Personal mode: each person talks to
   the bot privately"). The localized strings live in the channel's locale maps.
3. **Management-plane switch**: the Portal channel-binding list gets a per-row
   mode selector (admin-scoped; same RPC underneath). External portal
   implementations expose the same selector in their own management UI.

## Channel-generic switch contract

The mode switch is a **channels-layer capability**, not a Feishu feature:

- One generic server RPC — `channel.setContextMode(channel_id, route_key,
  mode)` — updates the binding row and fires the existing channel-reload
  notification. Management UIs and every channel's in-group card call the
  SAME RPC.
- The command word (`/mode`), the mode vocabulary (`shared` | `per_user`), the
  self-governance rule, and the announcement requirement are channel-agnostic
  contract; only the presentation (interactive card vs. text menu) is
  per-channel.
- Applies to channel-origin group bindings only (web/TUI sessions have no
  binding row and no mode concept).
- Rollout: Feishu implements the full surface now; DingTalk (once its groups
  gain persistent sessions) and future channels implement the same contract
  with their native UI affordance.

## Portal-adapter wire contract

The runtime works against ANY portal that implements the channel RPC
vocabulary. For this feature a portal MUST provide:

1. **Vocabulary**: `context_mode ∈ {"shared","per_user"}`; a NEW group is
   written `"shared"`, while NULL/legacy rows resolve to `"per_user"`
   (grandfathering), interpreted server-side in one place. (Do not read NULL
   as shared.)
2. **`channel.resolveBinding`**: honors the group's stored mode when choosing
   the session key (`shared` → `chat:{route_key}`; `per_user` → a stable
   per-sender key) and returns `context_mode` on the binding object. Any
   per-sender access control the portal enforces is orthogonal: in `shared`
   mode the access check still runs per sender, and the shared key is returned
   only AFTER the sender passes.
3. **`channel.setContextMode(channel_id, route_key, mode)`**: updates the
   binding row, answers `{success}`, and triggers the channel-reload
   notification so every serving runtime drops its mode cache.

## Migration & compatibility

- **Grandfathering (built-in Portal)**: existing PAIR groups behave per-sender
  today, so a blind NULL → `shared` would regress them (merge separate contexts
  into one). Instead:
  1. `normalizeContextMode` resolves **NULL → `per_user`** (the one place the
     default is interpreted), so any legacy row keeps its per-sender behavior.
  2. `pairChannelBinding` **writes `context_mode="shared"` on INSERT** (not on a
     re-pair conflict), so a freshly-bound group gets the product default
     (shared) while a group already switched to per_user keeps its choice.
  This needs no run-once data backfill (which siclaw's idempotent-DDL migration
  couldn't express safely) — NULL only ever means "pre-upgrade row", and those
  are exactly the ones to grandfather. The runtime mirrors the same NULL-safety:
  an absent `contextMode` on the wire is treated as per_user (never buffer
  chatter for an unconfirmed-shared group).
- **Open-bot groups**: `resolveOpenGroupBinding` materializes a
  `channel_bindings` row on first service (see the open-bot group fix that
  landed alongside this) and stamps it `context_mode='shared'` — the fresh-group
  default, matching open bots' historical shared behavior. It reports
  `contextMode:"shared"` on that first turn; every subsequent message resolves
  the same row via `selectChannelBinding` (same `chat:{route_key}` session), so
  open-bot groups are first-class: listed in the Portal, mode-switchable via
  `/mode` and the selector, exactly like PAIR groups. The runtime never infers
  the mode from the key shape — it reads the returned `contextMode`.

## Non-goals

- Thread-level scoping (Lark group events carry no thread/root id).
- Migrating existing session history across a mode switch.
- Cross-group or cross-channel shared contexts.
- DingTalk (groups are ephemeral-per-message by design; adopts the contract
  when its groups gain persistent sessions).
