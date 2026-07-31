# Personal-chat access denial — telling a refused sender what to do next

**Status**: Implemented, 2026-07-29
**Related**: `docs/features/channels.mdx`, `docs/design/2026-07-28-feishu-apikey-command.md`,
`src/gateway/channels/lark.ts`, `src/gateway/channel-manager.ts`

## Motivation

Admission tiers gate a personal bot to linked and/or authorized senders. A gated tier is only
usable if refusal explains the next step: with a single generic "no access" line, the refused
user has no way to self-serve and the tier is effectively broken.

Worse, the previous code only recognised two tier spellings. Anything else — including a tier the
frontend introduced after this build shipped — fell to a branch that just logged, so the sender's
message vanished with **no reply at all** and the bot looked dead. That failure mode is silent on
both sides: no error, no user-visible signal.

## Who decides what

| Concern | Owner |
|---|---|
| Whether this sender may use this agent (tier semantics, account linkage, grants, RBAC) | Frontend |
| What the sender is told when refused, in their channel's locale | Runtime (this repo) |

The runtime's entire gate is **"did a binding come back"**. It never interprets the tier to allow
or refuse. A consequence worth stating plainly: if the frontend wrongly returns a binding, the
runtime cannot compensate — it has no independent signal. Admission correctness lives entirely on
the frontend side; everything here is about the refusal experience.

## Contracts

### The refusal reason must survive the wrapper

`resolvePersonalBinding` returns `{ binding, denied? }`. It previously returned `data.binding ??
null`, discarding the rest of the response — which is why the runtime could only ever emit one
generic line. A frontend that does not populate `denied` yields `{ binding: null }` and the caller
falls back to its generic notice, so this stays backward compatible in both directions.

### `reason` is the contract; `message` is a fallback

Copy is rendered from `denied.reason` into localized templates, not taken from the frontend's
prose. The channel's locale is a **runtime** property (derived from the app domain, part of channel
config); the frontend does not know it and should not have to — pushing locale into the frontend
would mean every new channel or language requires a change on both sides. This also matches what
the group path already does with `walledResult`.

`denied.message` is a non-localized fallback, used only when this build has no template for the
reason. It may already embed a URL, so the renderer must **not** also append `actionUrl` on that
path — that prints the link twice.

Reasons in use: `binding_required` (not linked), `access_request_required` (linked, unauthorized,
self-service open), `access_denied` (unauthorized, self-service closed — no link exists). The
middle one must never render "go link your account": the sender already did, and being told
otherwise sends them in circles.

### Durations are derived, never hard-coded

`actionUrl` validity renders from `expiresAtMs`. Restating the frontend's TTL as a constant here
starts lying the moment the frontend changes it, with nothing on this side to notice — the same
defect already removed from the `/apikey` copy. Rendering is defensive: non-numeric, `<= 0` and
out-of-`Date`-range values omit the duration (an already-expired link is handled separately, below).
The out-of-range case is load-bearing rather than paranoid — `Intl` throws `RangeError` past
±8.64e15 while `Number.isFinite` passes such a value, and here the throw would replace the user's
only path forward with a generic error.

### Every field of `denied` is untrusted input

`reason` indexes a **Map**, not an object literal: an object lookup walks the prototype chain, so
`reason: "toString"` would return a Function, pass the "do I have a template" check, and be
rendered — or serialize to `{}`, which the platform rejects, silently dropping the reply this
feature exists to deliver.

Only the frontend's free-form **prose** is length-capped — never a URL and never our own lines.
Capping the rendered result severed long links and handed the sender a mutilated dead one with no
hint it was cut, which is precisely what the expired-link rule below exists to prevent; and the
platform's text limit sits far above anything rendered here, so the trade bought nothing.

An `actionUrl` whose `expiresAtMs` has already passed is **withheld**, replaced by "resend to get a
fresh link" — the frontend mints a new one per message, so resending is the real recovery, whereas
handing over a dead URL sends the user to an error page with no hint that anything can be done.
"Already expired" and "no deadline given" must not render identically. Remaining time **floors**
rather than rounds: rounding up overstates a single-use link's life by up to 30s, so a sender who
follows "within 2 minutes" at 1m50s finds it already gone.

### Tier checks must key on open-ness, not on one legacy spelling

Every branch that used to compare against the single legacy gated spelling now asks
`isOpenAccessTier`. Comparing against that literal alone told a bot on a newer gated tier that it
was "open, no PAIR needed" and discarded the sender's pairing code — a gated bot described as
public, with no way to bind. The Portal-side resolver accepts the same alias set, or a `public`
bot never auto-binds, returns no refusal reason, and the sender is answered with silence.

### A refusal we cannot render is still a refusal

The silent branch is gated on there being **no** `denied` at all, not merely on an open tier. An
explicit refusal whose reason has no template and carries no `message` would otherwise be swallowed
on `public`/`open` — the same "bot looks dead" outcome this feature exists to remove. Unrenderable
plus present falls through to the generic notice regardless of tier.

### A link is offered only for a reason that has a self-service step

`rendersActionLink` is the single predicate — the reason has a step (iff it has a button label) AND
the URL is plain `http(s)` — used by every renderer and both card builders. The scheme is checked
because the value lands on a Feishu `open_url` button, where other schemes resolve as deeplinks;
every other field of `denied` is already treated as untrusted, so this one gets the same treatment.
The expired-link notice sits INSIDE that guard: chained onto `actionUrl` alone, a refusal with no
self-service step told the sender their live link had expired and to resend — and the resend refuses
identically, which is the dead-end loop this feature exists to remove. `access_denied` means
"ask the owner": an `actionUrl` arriving on it must not become a "click within N minutes" line under
that sentence, nor a generic button pointing somewhere the sender cannot act. Because a link is only
ever rendered for a labelled reason, no generic fallback label exists.

### Copy must name the action the sender can actually take

When a console URL is configured it is the sender's **own** authorization page, so the copy says to
open it. Naming an admin while dangling that link was a dead end — an admin cannot link someone
else's chat account. "Ask an admin" is used only when there is no URL at all. The same rule applies
to the group-only path.

### An unknown tier is gated, never silent, never admitted

`isOpenAccessTier` recognises only `public` / `open`. Everything else — including tiers this build
has never seen — is treated as gated and always produces a reply. The direction is deliberate: a
frontend can introduce a tier before the runtime learns about it, and the safe failure is "you need
authorization", not silence and not admission. Only the open tiers stay silent when a binding is
missing, because there the frontend auto-binds and a missing binding is an anomaly (deactivated
config, transient error) rather than a refusal — there is nothing useful to tell the sender.

**This is what makes frontend-first deployment safe.** Without it, a frontend that starts emitting
new tier spellings turns every refusal on this path into silence.

### One predicate for the tier, shared across layers

`isOpenAccessTier` is exported from `channel-manager.ts` and used by BOTH the gateway (which picks
refusal copy) and the Portal adapter (which decides whether to auto-bind). It was briefly duplicated
in the two layers; two copies of the same normalization drifting apart produces exactly the failure
this contract prevents — the runtime treats a tier as open while the adapter refuses to bind, and
the sender is answered with silence.

### One-time links must never reach a group

`PersonalAccessDenied.actionUrl` is a single-use personal credential; `ChannelAccessDenied.authorizeUrl`
(group path) is a shareable console address. The two types are kept separate **on purpose**, even
though they overlap: anyone in a group could open a one-time link and bind the sender's chat
identity to their own account, after which the victim's messages execute as the attacker. Separate
types encode "group fields must not carry a one-time token" in the signature instead of relying on
reviewers remembering it. The two renderers sit next to each other so the copy cannot drift.

Only the explicit not-linked reason claims "you haven't linked yet"; every other value — including
one this build has never seen — takes the generic "no access" line, which is never wrong, whereas
telling an already-linked sender to go link loops them with no exit. For the same reason the console
URL is offered as an instruction only on the not-linked path: to a sender who is already linked, the
linking page is somewhere they have been.

Group copy points a refused sender at the **private chat** — but only when the DM can actually
resolve it, i.e. a personal bot exists AND is itself gated. An `open` personal bot binds on first
message and offers no authorization step, so "DM me" would be a dead end while removing the console
URL that was the sender's only path.

To be precise about the rationale: preferring the DM is a **UX** judgement, not a leak fix. The
single-use `actionUrl` lives on `PersonalAccessDenied`, and the type separation already keeps it out
of the group renderer, which only ever carries the shareable console `authorizeUrl`. Telling someone to DM a group-only bot sends them to
a path that answers nothing, so without one the copy names the admin route alone.

### `/apikey` refusals use the same path

`channel.issueApiKey` carries `denied` on its authorization refusal only; other failure exits have
`error` alone. The reply prefers a localized template from `denied.reason` and falls back to
`error` verbatim, so a gated user gets actionable copy instead of an English sentence. The
localized form keeps an "issuing failed" frame in front of it: the access-request link otherwise
reads in the same "opens once, expires shortly" language as the key pickup link, and the sender
opens it expecting the key they just asked for.

## Verification

- `npx tsc --noEmit`; `npm test` — includes 3 reasons × link/no-link × both locales, unknown
  reason → message fallback with no duplicated link, oversized message, missing reason on a gated
  tier (the never-silent regression), open tier staying silent, and re-resolution per message
  (no caching, so linking in another tab is picked up on the next message).
- End-to-end (link → authorize → admitted, request → approve → admitted, closed-tier refusal)
  requires a frontend that emits `denied`; run once against a configured personal bot when that
  lands. Deliberately no test hook is added on this path — a bypass switch in an admission code
  path is worse than waiting.
