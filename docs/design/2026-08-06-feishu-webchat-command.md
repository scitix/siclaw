# Feishu `/webchat` — personal browser-chat handoff

**Status**: Implemented, 2026-08-06
**Related**: `src/gateway/channels/lark.ts`, `src/gateway/channel-manager.ts`,
`src/portal/adapter.ts`

## Motivation

A user may already be allowed to talk to an agent through its Feishu personal bot but still lack
a direct path to the browser chat surface. `/webchat` bridges those surfaces without asking the
model to mint links and without moving admission policy into the Runtime.

The resulting browser conversation is new and empty. It does not continue the Feishu transcript.

## Division of labour

| Concern | Owner |
|---|---|
| Agent admission, account binding, one-live-link policy, token expiry, redemption, session creation, durable request deduplication | Upstream frontend |
| Exact command recognition, sender identity and request-id forwarding, safe link delivery, localized copy | Runtime |
| Readable unsupported response when no upstream frontend exists | Standalone Portal adapter |

The Runtime stores no redemption token and does not decide whether the sender may use the agent.

## Runtime contracts

### What the link confers — the Runtime's single assumption

This is the one statement of the link's authority. Code comments must defer to it rather than
restate it; three comments asserting three different semantics is what this section replaces.

**The Runtime treats `actionUrl` as bearer authority over a chat session.** Whoever opens it first
is assumed to obtain the session, without proving any identity.

That is an assumption, not knowledge. The Runtime cannot see whether redemption requires the
visitor to already be signed in — it holds no account model, stores no token, and never contacts
the redemption endpoint. So it assumes the strongest thing the link could be, which makes every
handling rule below correct under either implementation:

- if the frontend does issue a true bearer link, the handling is exactly right;
- if the frontend requires an authenticated visitor, the handling is merely conservative.

Getting this backwards is the failure that matters. `/webchat` is dispatched before
`resolvePersonalBinding`, so the Runtime applies no binding gate and the frontend is the only
admission control. Under the assumption above, a wrongly-approved mint hands a session-granting
link to someone who never passed that gate — which is why the delivery rules are stricter than
the ones a mere navigation URL would need.

Everything downstream derives from this: personal chat only, never logged, a card button rather
than unfurlable text, and withheld once expired.

The redemption and consumption semantics themselves are the upstream frontend's to define and
document. A frontend that makes redemption weaker than this assumption does not violate the
contract; it only means the Runtime was stricter than it had to be.

### Personal chat only

The command is accepted only in a Feishu personal-bot conversation. In a group it is dropped
silently before the @-mention gate, including `@bot /webchat`. A group response would expose a
personal redemption link to everyone in the room, where the first person to open it could claim
the resulting session.

Both the personal dispatcher and group drop-gate use `parseWebChatCommand`; they must never reserve
different input sets.

### Exact command-token boundary

`/webchat` takes no subcommand. The accepted forms are:

| Input | Effect |
|---|---|
| `/webchat` | Request a new redemption link |
| `/webchat` followed by whitespace and any text | Usage help, zero RPC |
| another token sharing the prefix, such as `/webchats` or `/webchatops` | Ordinary agent input |

The boundary is deliberately different from `/apikey`. API-key issuing claims its whole prefix
because a typo near a credential rotation must never reach the model. `/webchat` mints nothing
unless this exact parser accepts it, so claiming unrelated prefix tokens would only break possible
downstream slash commands and ordinary user text.

### Never model-callable

Recognition is deterministic and every command branch returns before binding resolution or agent
routing. The feature must not become an agent tool: placing the model in a link-minting path turns
prompt injection into an issuing primitive.

### Single-flight and durable idempotency are separate

Minting replaces the sender's outstanding link. The Runtime therefore allows only one overlapping
request per `(channel, sender)`, because two simultaneous commands would make the first returned
link dead on arrival.

That in-process guard cannot cover a sequential Feishu redelivery, a Runtime restart, or a second
replica. The Runtime forwards the stable inbound `message_id` as `request_id`; the upstream
frontend must persist the idempotency decision and replay the existing result. Until the frontend
honours it, duplicate minting remains possible.

### Single-use links go through one safe delivery path

A live link is sent through `deliverSingleUseLink`: an `open_url` card button first, with a text
fallback only when card delivery fails. A URL is renderable only when it is an absolute HTTP(S)
URL; relative paths and other schemes fail closed with the localized unavailable response.

The expiry shown to users is derived from `expiresAt`, never hard-coded. If a success result is
already expired at the send boundary, the URL is withheld and the reply explicitly tells the
sender to rerun `/webchat`. It must not combine “link ready” with “link expired”, and an ordinary
chat message is not described as the recovery action.

### Frontend prose is untrusted

Structured denial reasons select Runtime-owned localized templates. Free-form `denied.message`
and `error` are length-capped before interpolation so an upstream stack trace cannot exceed the
Feishu message limit and turn a promised error reply into silence. URLs are never truncated; a
truncated URL is guaranteed to be unusable.

The denial renderer is shared with `/apikey`, while each command retains separate copy tables so
resume instructions cannot direct a `/webchat` user to `/apikey` or vice versa.

### Unsupported frontends still answer

`channel.issueWebChatLink` is called unconditionally. Every Portal implementation must therefore
register the method. The standalone adapter returns `success:false` with a readable Upstream-only
error; an older upstream frontend may return method-not-found, which the Runtime maps to the
localized unavailable response.

## Wire shape

Request:

```json
{
  "channel_id": "<personal bot config id>",
  "sender_open_id": "<Feishu open_id>",
  "request_id": "<Feishu message_id>"
}
```

Responses:

```text
success  { success:true, agentId, actionUrl, expiresAt }
denied   { success:false, denied:{ reason, actionUrl?, expiresAtMs?, message? } }
failure  { success:false, error }
```

`actionUrl` is a short-lived redemption URL. Opening its preview does not consume it; the upstream
frontend owns the confirmation and consumption semantics. For what the Runtime assumes the link
grants — and why it assumes the strongest case — see “What the link confers” above.

## Verification

- Personal bare command calls the RPC once and never reaches the agent.
- `@bot /webchat` in a group reaches neither RPC, binding resolution, reply, nor agent.
- Prefix tokens remain ordinary input; whitespace-delimited suffixes receive usage help.
- Card, text fallback, denial, unknown reason, expired link, invalid URL, long error, and
  overlapping-request paths are covered in `lark.test.ts`.
- Request shape and standalone stub are covered by `channel-manager.test.ts` and
  `adapter-rpc.test.ts`.
