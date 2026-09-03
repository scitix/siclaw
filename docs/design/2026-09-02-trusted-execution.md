# Trusted execution: propose_execution, AuthorityEnvelope and bound approvals

The runtime side of the management plane's trusted-execution contract. A write
action (external_write / destructive) is never performed directly by a governed
turn: the agent PROPOSES it with specifics, a human approves it on the
management plane, and the approved action executes exactly once — bound to that
exact action.

> **Superseded in part.** The approval mechanism described here was originally a
> one-time *receipt token*, and the effect ceiling was only enforced when a
> capability allow-list was also present. Both were replaced; see
> **`2026-09-03-authority-envelope-and-action-digest.md`** for the current
> contract (envelope binding, the declared-effect ceiling, and the
> action-digest approval flow). This document keeps the parts that did not
> change.

## The loop

1. **`propose_execution`** (tool; available on delegated turns or turns opted
   in with `allowInputRequest`, exactly like `request_input`): the model
   provides the exact call it intends (`tool_name`, `tool_args`) plus `effect`,
   `resources`, the exact `diff`, `reason`, `risk` and a `rollback` path —
   proposals without specifics are rejected client-side. The tool computes the
   action digest locally and emits a reliable `auth_required` event; the turn
   ends.
2. The management plane runs the approval and, if approved, resumes this same
   session with a message carrying the approved **proposal id** (plain text —
   not a credential).
3. The model re-invokes the same tool with the same arguments plus
   `approval_proposal_id`.
4. The **authority guard** consumes the approval atomically on the management
   plane (box → Runtime internal API `/api/internal/authority/consume`, mTLS →
   control-plane RPC) right before execution, sending the digest of the call
   about to run. A retried call gets "already consumed" and is blocked; a call
   whose digest differs from the approved one is refused as a different action.

## AuthorityEnvelope enforcement (per tool call)

`chat.send` may carry a signed `authorityEnvelope`. Verification is local
(`SICLAW_AUTHORITY_SECRET`, HMAC-SHA256, constant-time compare,
`src/shared/authority-envelope.ts`) and FAIL-CLOSED at two points: `/api/prompt`
admission (present-but-invalid → 403 `AUTHORITY_ENVELOPE_INVALID`;
present-but-misbound → 403 `AUTHORITY_ENVELOPE_MISBOUND`) and session build. A
valid envelope registers the guard extension
(`src/core/extensions/authority-guard.ts`, pi-agent `tool_call` hook — the
chokepoint covering every tool):

- a tool matching `deniedCapabilities` is blocked unconditionally;
- a tool whose DECLARED EFFECT exceeds `effectCeiling` is gated, as is a tool
  outside a non-empty `allowedCapabilities`;
- a `credential_read` tool is blocked outright and never gated;
- `propose_execution` / `request_input` / `report_findings` are never gated —
  ending a turn to ASK must stay possible under any ceiling, or a governed
  agent deadlocks.

The envelope joins the warm-session reuse predicate: a changed envelope
rebuilds the session (context restored from JSONL), so stale claims can never
govern a new turn.

## Tests

`src/shared/authority-envelope.test.ts` (verification matrix, binding rules,
capability globs), `src/shared/tool-effects.test.ts`,
`src/shared/action-digest.test.ts`,
`src/core/extensions/authority-guard.test.ts` (deny / ceiling gating /
credential_read / approval binding / always-allowed),
`src/core/tool-registry.test.ts` (every mutating capability group declares an
effect), `src/tools/workflow/propose-execution.test.ts` (availability,
specifics validation, digest, event shape), and
`src/agentbox/http-server.test.ts` (403 fail-closed paths). Everything compiles
under both tsconfigs.
