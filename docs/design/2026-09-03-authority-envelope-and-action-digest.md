# AuthorityEnvelope binding, the effect ceiling, and action-bound approvals

This document describes the runtime half of the trusted-execution contract as
it now stands. It replaces two mechanisms that looked like controls but were not
enforceable: an effect ceiling that a caller could neutralise by omitting an
unrelated field, and an approval that was a bearer token accepted for any
action. It also covers the turn ledger that makes dispatch idempotency survive a
runtime restart.

The management plane implements the other half of each contract here.

---

## 1. The envelope

A governed dispatch carries a signed `authorityEnvelope`. The wire format is
unchanged:

```
base64url(JSON claims) + "." + hex(HMAC-SHA256(claims, SICLAW_AUTHORITY_SECRET))
```

Claims:

```ts
authorityId, issuer, subject, targetAgentId,
segmentId?, taskId?,
resourceScope?: string[], effectCeiling: string,
allowedCapabilities?: string[], deniedCapabilities?: string[],
expiresAt: number, nonce: string, policyRevision?: string
```

`verifyAuthorityEnvelope` checks the signature (constant-time), the expiry, and
the presence of the required fields. It returns `null` on any failure — callers
fail closed.

### Binding: authentic *for what*

A signature proves an envelope is authentic. It does not prove it was issued for
*this* request. Without a second check, a valid envelope minted for a
low-privilege agent could be presented on a dispatch to a high-privilege one —
replay, using an entirely genuine credential.

`bindingError(claims, ctx)` answers that question separately:

```ts
bindingError(claims, { agentId, segmentId?, taskId? }): string | null
```

It returns a reason (else `null`) when:

- `claims.targetAgentId !== ctx.agentId`;
- `claims.segmentId` is set and differs from `ctx.segmentId`;
- `claims.taskId` is set and differs from `ctx.taskId`.

Two deliberate properties:

- **Only what the issuer stated binds.** `segmentId` and `taskId` are optional.
  An envelope that names neither is checked on the agent alone, so a broad
  envelope is never weakened by a caller that lacks context — and a narrow one
  can never be satisfied by a caller that simply omits it.
- **It is a separate function.** The signature check needs only the token and
  the secret; binding needs the request context. Folding them together would
  force every caller to supply a context, and a caller without one would end up
  passing something plausible.

`/api/prompt` enforces both, fail-closed:

| Condition | Response |
|---|---|
| envelope present, signature/expiry invalid | 403 `AUTHORITY_ENVELOPE_INVALID` |
| envelope present, verifies, misbound | 403 `AUTHORITY_ENVELOPE_MISBOUND` |
| no envelope | runs exactly as before |

The agent identity compared against is the **box's own** configured identity,
never a value from the request body — a presenter that supplied its own
`agentId` could otherwise choose one that matches. A box with no configured
identity refuses a governed dispatch rather than guessing.

---

## 2. The effect ceiling

### What was wrong

The guard gated a call only when `allowedCapabilities` was non-empty. So an
envelope reading `effectCeiling: "observe"` with no allow-list permitted every
tool, `bash` included. A ceiling that stops being enforced when a second,
unrelated field is omitted is not a control — and the omission was the natural
case, since an allow-list is the more laborious field to author.

### Declared effects

Enforcement now compares the ceiling against each tool's declared effect,
because how far a tool goes cannot be inferred from its name (`k8s_inspect`
reads; `pod_exec` does not).

```ts
type ToolEffect = "observe" | "local_write" | "external_write" | "destructive" | "credential_read";

EFFECT_RANK = { observe: 0, local_write: 1, external_write: 2, destructive: 3 };

effectExceedsCeiling(effect, ceiling): boolean
```

- `credential_read` is **not on the scale** and always exceeds, at every
  ceiling. Reading a secret is not "more writing", so it can never be unlocked
  by raising a ceiling, and the guard blocks it outright rather than gating it:
  no human approval issued through the proposal flow is an authorization to read
  a credential.
- An **unknown ceiling string is treated as `observe`**, the most restrictive
  value. A control plane shipping a ceiling this runtime predates must not
  thereby widen what the runtime allows.

Tools declare `effect` on their registration (`ToolEntry.effect`), which
`ToolRegistry.resolve()` carries onto the resolved definition the same way it
carries `requiresUserApproval`. The guard's by-name lookup is
`effectForTool(name)`, backed by `TOOL_EFFECTS` in `src/core/tool-registry.ts`.

Both exist because not every name the guard sees comes from a registration:
`write` and `edit` are harness built-ins with no `ToolEntry`, yet they mutate
the workspace. A test asserts the two never disagree for a registered tool.

Declared today: `write` / `edit` / `skill_preview` → `local_write`;
`bash` / `node_exec` / `pod_exec` / `host_exec` and all four `*_script` tools →
`external_write`; `spawn_subagent` / `delegate_to_agent` / `manage_schedule` →
`external_write` (each makes *another* agent act, so its own effect is at least
that of what it can start); `job_stop` → `local_write`. Read, query, knowledge,
memory and task tools are undeclared.

**An undeclared tool defaults to `observe`.** That permissive default is only
safe because the map above is complete for mutating built-ins, and
`tool-registry.test.ts` asserts that every tool in the mutating capability
groups (`write_sandbox`, `run_commands`, `run_scripts`, `spawn_subagents`,
`delegate_agents`, `scheduling`) declares a non-`observe` effect. A new mutating
tool that forgets the declaration fails the build rather than running freely
under an observe-only envelope.

> **Known limitation.** Tools reached by dynamic name — MCP servers,
> filesystem-defined tools — cannot be enumerated in a static map and therefore
> resolve to `observe`. Constrain those with `allowedCapabilities` /
> `deniedCapabilities`, which match by name and glob. The ceiling alone does not
> bound them.

### The guard's decision, in order

1. `propose_execution` / `request_input` / `report_findings` → **allow**,
   always. Ending a turn to ask must stay possible under any ceiling, or a
   governed agent deadlocks.
2. matches `deniedCapabilities` → **block**.
3. effect is `credential_read` → **block**, never gated.
4. effect exceeds `effectCeiling`, **or** `allowedCapabilities` is non-empty and
   the tool is outside it → **gated** (§3).
5. otherwise → **allow**.

The allow-list now *narrows further*; it is no longer the switch that turns
enforcement on.

---

## 3. Approvals without a token

### What was wrong

The approval was a bearer token. The runtime minted a signed receipt; the
management plane delivered it inside a natural-language resume message — so it
entered the model context, the transcript, and the dispatch outbox — and the
guard accepted it for **any** gated tool. An approval for "scale deployment A"
therefore authorised one call to "delete namespace B".

Both halves are fixed by removing the token and binding the consumption to the
action.

### The action digest

```ts
// src/shared/action-digest.ts
actionDigest(toolName, args): string   // sha256 hex over `${toolName}\n${canonicalJson(args)}`
DIGEST_STRIPPED_ARGS = ["approval_proposal_id", "approval_receipt"]
```

`canonicalJson` sorts object keys recursively, keeps array order (a list is part
of the action), drops `undefined` members, and emits no whitespace. Keys are
ordered by **UTF-8 byte order**, not JavaScript's default string comparison: the
default compares UTF-16 code units, which orders non-BMP characters differently
from their bytes, so two implementations could canonicalise the same object two
ways.

The control arguments are stripped from the **top level only**. A nested key of
the same name is payload the approver saw, and removing it would digest a
different action than the one about to run.

### Only the runtime computes it

The management plane stores `actionDigest` **opaquely** and compares it
byte-for-byte. It never recomputes one. This is deliberate: recomputation would
require two languages to agree forever on a canonical JSON encoding, and a
silent disagreement there would either wave through mismatched actions or reject
every legitimate one. One producer, one encoder, no cross-language contract to
drift.

### The flow

1. `propose_execution` additionally takes the exact intended call:
   `tool_name: string` and `tool_args: object` — both required, because an
   approval that is not bound to an action is the bearer token this design
   removes. It computes the digest locally and sends it with the proposal
   (alongside `effect`, `resources`, `diff`, `reason`, `risk`, `rollback`, and
   optional `evidence_refs`).
2. The agent ends its turn. If approved, the decision message carries the
   **proposal id** as plain text. It is an identifier, not a credential:
   holding it authorises nothing.
3. The gated re-invocation passes `approval_proposal_id: "<id>"` as a tool
   argument. The guard:
   - reads and **strips** it from `event.input` (pi-agent exposes `input` as
     mutable), so it never reaches the tool, its output, or the transcript;
   - computes `actionDigest(toolName, event.input)` **after** stripping;
   - calls `consumeApproval({ proposalId, actionDigest })`;
   - resolve → the call proceeds; reject → blocked with the reason.
4. A gated call with no `approval_proposal_id` is blocked with the path spelled
   out: propose the exact change, end the turn, re-invoke with the id from the
   decision message.

Transport: box → Runtime `/api/internal/authority/consume` with
`{ proposalId, actionDigest }` → control-plane RPC `authority.consumeReceipt`
with `{ proposalId, actionDigest, subject }`. The RPC method name is retained
for compatibility; only the params changed. **No token field anywhere.**

Consumption stays atomic and one-time, so a retried call is refused rather than
executed twice — and now a *different* call under the same approval is refused
as well.

---

## 4. The turn ledger

`chat.send`'s `dispatchId` de-duplication lives in a process-local map, so after
a Runtime restart the same dispatch is unknown again and the turn executes a
second time. The AgentBox is the right authority for that question: it is what
actually runs the turn, and it outlives the Runtime.

`/api/prompt` therefore keeps a per-session ledger of accepted `turnId`s, stored
next to the session's JSONL history on the volume that already carries session
state (the `.plan-ledger.json` and `.model-route-state.json` precedents). A
`turnId` already in the ledger is answered
`{ ok: true, sessionId, turnId, duplicate: true }` **without starting a turn**.

- The record is written when the turn is *accepted* — the session claimed and
  about to run — and before the acknowledgement, since a record landing after
  the ack would leave the window it exists to close. A 409 (busy) or 412
  (context unavailable) returns earlier and deliberately records nothing.
- Bounded to the most recent 200 entries: a retry arrives seconds to minutes
  after the original, so that is far more history than de-duplication needs.
- **Non-fatal by design.** A missing file is the normal first-turn case; a
  corrupt or unreadable one yields an empty ledger. An empty ledger degrades to
  a duplicate turn — the pre-existing behaviour — whereas refusing the prompt
  would turn an unreadable bookkeeping file into an outage.

On the Runtime side the reservation became a *reserve → confirm / release*
lifecycle; see `2026-09-02-session-resume-and-input-requests.md`.

---

## 5. Compatibility

A prompt with no `authorityEnvelope` behaves exactly as it did: no binding
check, no guard extension, no gating. Everything above activates only for a
governed dispatch.
