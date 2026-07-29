# Feishu `/apikey` — self-service API key issuing

**Status**: Implemented, 2026-07-28
**Related**: `docs/features/channels.mdx`, `src/gateway/channels/lark.ts`,
`src/gateway/channel-manager.ts`, `helm/siclaw/values.yaml` (Standalone vs Upstream mode)

## Motivation

a2a / mcp calls need an API key, but obtaining one used to have exactly one path: register a
control-plane account → join an org → hold write scope → create a key in the console. The same person
needs **nothing** to DM the agent in Feishu.

That asymmetry blocked adoption: onboarding N non-SRE users to MCP meant either one shared key
(audit collapses to one identity, revocation is all-or-nothing) or N people granted write access
far beyond "I just want to call it". Whoever can DM the bot should be able to get its key —
admission decided by **one** rule, not two that must be kept in sync.

## Division of labour

The frontend owns every credential decision; the runtime owns only message plumbing.

| Concern | Owner |
|---|---|
| Admission (`open` vs authorized access mode), one-key-per-requester, hashing, sliding 30-day expiry, per-call re-authorization, single-use pickup page | Frontend (Upstream mode) |
| Deterministic command recognition, identity forwarding, localized reply | Runtime (this repo) |

The runtime stores no key material, never sees plaintext, and does not read `api_access_mode`.

## Contracts

### Personal chat only

`/apikey` is handled **only** on the Feishu personal-bot (p2p) path. In a group it is
intercepted and dropped **silently** — before the @-mention gate, so an `@bot /apikey` cannot
reach the agent either. A group reply is visible to everyone present and this flow returns a
credential pickup link; answering at all (even "DM me") turns one person's provisioning into
group noise. DingTalk has no personal-bot concept, so it is out of scope.

### Deterministic parsing, never an agent tool

The command is matched with a plain regex at the top of the p2p branch and always returns
there. It must never become a model-callable tool: an LLM in the issuing loop makes one prompt
injection an issuing primitive. The frontend correspondingly exposes no such tool.

### Only a bare `/apikey` may rotate

The runtime claims the whole `/apikey …` namespace. Exactly two forms act:

| Input | Effect |
|---|---|
| `/apikey` | issue or **rotate** (the requester's previous key dies) |
| `/apikey status` | read-only status |
| anything else (`/apikey statu`, `/apikeys`, `/apikey foo`) | usage help, **no RPC issued** |

A typo must not destroy the key the user was trying to inspect, so an unrecognised subcommand
never falls through to issuing. `/apikey status` is therefore load-bearing, not a nicety:
without it, "do I still have a key?" could only be asked destructively.

`API_KEY_COMMAND_RE` deliberately carries **no trailing word boundary**: with `\b`, `/apikeys`
escapes the namespace and reaches the model — which in a group is exactly the credential-adjacent
routing this feature must prevent. Both dispatch sites (personal handler, group drop-gate) go
through the same `parseApiKeyCommand`, so the two can never claim different sets.

### Issuing is single-flight per sender

`/apikey` deliberately bypasses the per-binding queue that serialises ordinary messages, so it
needs its own guard: a second request for the same `(channel, sender)` while one is in flight is
rejected with a "still running" notice. Without it a double-tap — or a Feishu at-least-once
redelivery — mints two keys, and the user opens the first link they see to collect a key the
second rotation already invalidated, with nothing in the chat explaining the 401s.

### Timestamps must never break the reply

`expiresAt` / `lastUsedAt` come from the frontend as epoch ms and are rendered defensively:
a non-number, `<= 0`, or out-of-Date-range value simply omits the line. This is not
belt-and-braces — `Intl.DateTimeFormat.format` **throws RangeError** past ±8.64e15 (a frontend
emitting nanoseconds), `Number.isFinite` passes such a value, and the throw would be caught by
the surrounding handler and reported as "service unavailable" *after* the key was already
rotated, leaving the user unable to ever reach a pickup link. Likewise `exists` is optional on
the wire, so "you have no key" is only claimed when the frontend says so or no `keyPrefix` came
back — the advice attached to that branch is the destructive command.

### Runtime copy must not restate the frontend's TTLs

Replies name no durations. Expiry policy belongs to the frontend, and a sentence like "open
within 5 minutes" silently starts lying the moment that TTL changes — while the runtime has no
way to notice. The pickup line therefore states only "opens once, expires shortly" plus the
**derived** absolute `expiresAt`, and status renders the derived date with the sliding mechanism
("using the key pushes this out") rather than the window length. If a duration must ever be
shown, derive it from the wire values instead of hard-coding it here.

### Issuing needs idempotency, which the runtime cannot provide alone

The in-process single-flight guard only collapses *overlapping* requests. It cannot span a
sequential redelivery of the same inbound message, nor a second gateway replica — and because
issuing rotates by invalidating the previous key, a duplicate makes the first pickup link resolve
to a dead key. The runtime therefore forwards the inbound Feishu `message_id` as `request_id`;
**durable deduplication is the frontend's half of this contract** (replay the same pending result
instead of rotating again). Until the frontend honours it, the field is inert and duplicate
issuing remains possible.

### Rotation commits before delivery, so a lost reply is escalated

The frontend rotates before the runtime can reply, and `replyToLark` swallows both thrown send
failures and non-zero Feishu API codes — so delivery is **checked**, never inferred from the
absence of an exception. When a committed rotation's reply fails, the send is retried once and, if
still lost, an audit line names the affected sender: their previous key is already invalid and the
replacement link never arrived. What keeps this recoverable rather than a lost credential is that
the command is safely retryable — another `/apikey` rotates again and returns a fresh link.
Removing the window entirely (defer invalidation until the pickup is consumed, or replay a pending
pickup for an idempotent request) is a frontend-side change.

### Plaintext never enters the chat log

Replies carry only the frontend's short-lived, single-use `pickupUrl` — never the key. Feishu
chat history is retained, searchable, and exportable; the entire point of a link is that the
transcript keeps nothing but a URL that dies in minutes. Do not "helpfully" echo the key.

### `rotated` must be surfaced

When the frontend reports `rotated: true`, the reply must state that the previous key is now
invalid. Any MCP client configured with it breaks instantly, and an unexplained break gets
filed as a bug.

### Failure is spoken, not swallowed

`error` from the frontend is user-facing wording and is surfaced verbatim inside a localized
frame (do not rewrite it into a generic "operation failed" — the reason is the useful part). An
RPC that *throws* — or a missing frontend client — still produces a localized "try again later"
reply. This deliberately differs from the neighbouring PAIR path, whose failures escape to the
top-level catch: here the user is waiting on a link, and silence reads as a broken bot.

**Known gap**: the upstream frontend's refusal strings are currently English, so a zh-CN user
sees a Chinese frame around an English reason. Localizing belongs on the frontend (it owns the
admission logic and therefore its wording); mapping those strings here would couple the runtime
to the frontend's exact copy and rot on the first rewording.

### The runtime must not hard-depend on the control plane

`channel.issueApiKey` and `channel.apiKeyStatus` are Upstream-mode capabilities, but the runtime
calls them unconditionally. The Portal adapter therefore registers **graceful stubs** returning
`{ success: false, error: "… only available in Upstream mode" }` — mirroring the existing
`channel.pairPersonal` stub. Without them a Standalone deployment would hit
method-not-found, the rejection would escape into a swallowed catch, and the user would get no
reply at all. **Adding either RPC to the runtime requires a matching stub in
`src/portal/adapter.ts`.**

## Wire shape

Both RPCs take the same params — `channel_id` is the personal-bot **config id** (the same value
`channel.pairPersonal` receives, not a Feishu chat_id), and `sender_open_id` is the sole
identity source:

```json
{ "channel_id": "<personal bot config id>", "sender_open_id": "<open_id>" }
```

`channel.issueApiKey` → `{ success, agentId?, pickupUrl?, expiresAt?, rotated?, error? }`
`channel.apiKeyStatus` → `{ success, agentId?, exists?, keyPrefix?, lastUsedAt?, expiresAt?, error? }`

`expiresAt` on status is a **sliding** deadline (last use + 30 days), not a fixed issue term.

## Presentation

Replies are localized via the channel's existing `locale` (`localeForDomain`), zh-CN and en-US.
Timestamps render through `Intl.DateTimeFormat("sv-SE", …)` for a stable ISO-like
`YYYY-MM-DD HH:mm` with an explicit time zone (zh-CN → `Asia/Shanghai`, en-US → `UTC`); the
`sv-SE` locale is chosen only for its format, so copy does not drift with the host locale and
stays assertable in tests.
