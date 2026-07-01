# Channel sender audit attribution & filtering

> Date: 2026-06-29 · Status: approved design, pre-implementation
> Scope: siclaw standalone only. See "Dependency direction" below.

## Problem

A siclaw `channel` agent (Lark / DingTalk) can be used directly by **anyone**
in a group or DM under *open* mode. Every such interaction is persisted to the
audit tables (`chat_sessions` / `chat_messages`) and surfaced in the admin
Metrics UI (Sessions / Tools tabs).

Today the audit cannot tell the senders apart. Ten people taking turns in one
group all collapse into the binding owner — there is no way to isolate "the
sessions and tool calls that came from this one person." Operators need to
**group and filter channel audit by the actual sender**.

## Dependency direction (the rule that shapes this design)

**SiCore depends on siclaw; siclaw must never depend on SiCore.**

Therefore siclaw has **no concept of a "SiCore user."** Mapping a Lark/DingTalk
account to a SiCore identity is solved entirely inside SiCore's own layer and is
out of scope here. Any field that exists only to carry a SiCore identity through
siclaw (`sicore_user_id`, `ResolvedChannelBinding.senderUserId`) is a reverse
dependency and is **removed** by this design.

We attribute channel audit using only identifiers siclaw already owns natively.

## Identity model

For a `channel`-origin session, the actor is the **channel sender**, identified
by:

- **`sender_external_id`** — Lark `open_id` / DingTalk `senderStaffId`. siclaw
  already keys per-sender sessions on this (`open_id:<sender>` session key), so
  it is the stable "same person" key.
- **`channel_id`** — which channel / IM app the sender belongs to. `open_id` is
  scoped per Lark app, so the same human has a different `open_id` per app;
  **`(channel_id, sender_external_id)` is the unique pair**. `channel_id` comes
  from siclaw's own `channels` table.

### Value rules (invariant)

- The channel actor is **the end user, never the binding owner**. We never fall
  back to `created_by`.
- When the sender id cannot be obtained (some open-mode cases), the column is
  `NULL`. We do not substitute the owner to "fill" the row.
- siclaw does **not** resolve the sender's display name. The audit presents the
  raw `sender_external_id`. (See "Future" for the one cheap, dependency-free
  enhancement we deliberately defer.)

`web` / `api` / `a2a` origins are unchanged: their actor remains the owning
`user_id` (logged-in user / API-key owner).

## Data model

`chat_sessions` carries the channel actor:

| column | meaning |
|---|---|
| `sender_external_id` | open_id / staffId of the sender (NULL for non-channel or when absent) |
| `channel_id` | the channel / IM app (NULL for non-channel) |

A channel session is per-sender by construction (session key `open_id:<sender>`),
so **one session = one sender**; the session row alone fully attributes it.

`chat_messages.sender_external_id` is **removed.** It was dead weight: every
audit/tools query already joins `chat_sessions` and filters on
`s.sender_external_id`, never the message-level copy. Removing it eliminates
redundancy and a drift risk (a message's sender disagreeing with its session's).
Tool-level attribution is obtained by joining a message back to its session.

### Removed (SiCore coupling)

- `chat_sessions.sicore_user_id`, `chat_messages.sicore_user_id` — schema,
  `adapter.ts` (`chat.ensureSession` / `chat.appendMessage`), `chat-repo.ts`.
- `ResolvedChannelBinding.senderUserId` — `channel-manager.ts`.
- `actorSicoreUserId` pass-through — `channels/lark.ts`, `channels/dingtalk.ts`.
- The `sicore_user_id` arm of the Metrics user axis and the `sicoreUserId`
  pairing returned by the channel-senders endpoint — `metrics-entry.ts`,
  `siclaw-api.ts`, `portal-web` hooks/components.

## Metrics behavior

The "by user" axis is origin-aware and contains no SiCore concept:

```
actorUserColumn ≡ CASE WHEN origin = 'channel'
                       THEN <alias>.sender_external_id
                       ELSE <alias>.user_id END
```

The "who" axis is **origin-aware in the UI**, not just in SQL. The Sessions /
Tools tabs show exactly one identity filter, chosen by entry:

- **off-channel** (web / api / a2a / all): the **portal-user** dropdown
  ("All Users"), filtering on `user_id`.
- **channel**: the portal-user dropdown is **hidden** (channel actors are
  open_ids, never portal users — applying a portal-user filter would match no
  channel rows), replaced by the two channel filters below. The portal-user
  filter is also not *applied* on the channel entry even if a stale value lingers.

For the `channel` entry, the Sessions and Tools tabs expose two clean filters:

1. **Channel** — pick which channel / IM app (`channel_id`).
2. **Sender** — pick or type a `sender_external_id`; once set, Sessions and
   Tools show only that person's rows.

The sender picker is fed by the channel-senders endpoint, which returns the
**distinct senders seen in the window with an occurrence count and last-seen
timestamp, ordered by recency**. Raw `open_id`s are opaque; the count and
last-seen are what make the list usable ("the one active 5 minutes ago with 30
messages"). The endpoint returns sender ids only — no SiCore pairing, no name.

In the Sessions / Tools tables, a channel row's actor column shows the
`sender_external_id` (truncated, full value on hover), so an operator can spot
the same person across multiple sessions at a glance.

### Response shape: owner and sender are separate fields

Audit row payloads (`audit/sessions`, `metrics/audit`, the session snapshot)
return **`userId` = the owner `user_id` (always a portal user)** and a separate
**`senderId` = `sender_external_id` (channel sender, null off-channel)**. The
actor is NOT overloaded onto a single `userId` field whose meaning flips by
`origin` — a consumer that joins `siclaw_users` on `userId` stays correct for
every row, and the UI simply renders `senderId` for channel rows, `userId`
otherwise. `actorUserColumn` (the origin-aware CASE) is used only for the
actor-based *filter* and the *distinct-actor count*, never as a projected field.

### Metric semantics: NULL senders and the distinct-actor count

`distinctUsers` counts `COUNT(DISTINCT actorUserColumn)` — owners for off-channel
rows, senders for channel rows. Two consequences, both intentional:

- A channel session whose sender is NULL (event omitted it) is **excluded** from
  `distinctUsers` and from any sender-grouped view, while still counting in
  `totalSessions`. So "distinct senders" ≤ "channel sessions"; the two tiles can
  legitimately differ.
- For the `all` entry the distinct set mixes portal UUIDs and channel sender ids.
  They never collide (disjoint formats), so the count is meaningful as "distinct
  actors across all entries".

## Migration

`migrate.ts` is additive (CREATE TABLE IF NOT EXISTS + idempotent
`safeAlterTable`); it does not drop columns. The removed columns
(`sicore_user_id`, message-level `sender_external_id`) were introduced on the
current unmerged branch, so removing them from the branch means fresh databases
never receive them. The only database that already has them is a manually-migrated
test deployment (siclaw-inner), which is disposable and can be recreated. **No
destructive migration is written**; the mainline schema is simply clean.

## Testing

- `chat-repo`: `sender_external_id` write mapping on sessions; no owner fallback;
  removal of `sicore_user_id` / message-level `sender_external_id` reflected in
  assertions.
- `lark` / `dingtalk`: open mode → `sender_external_id` set (NULL when absent),
  never owner; `channel_id` stamped on the session.
- Metrics: filtering sessions and tools by `sender_external_id` + `channel_id`;
  `actorUserColumn` no longer references any SiCore column; channel-senders
  endpoint returns count + last-seen ordered by recency.

## Future (deferred, not in this change)

If `open_id` proves too hard to recognize in practice, capture the sender's
display name **only if it already arrives in the Lark/DingTalk event payload**
(no extra contact-API call, no external dependency) and denormalize it as
`chat_sessions.sender_display_name` — a single point-in-time column, no join
table. This is native channel data, not a SiCore concept, so it does not violate
the dependency-direction rule. Deferred to keep this change minimal.
