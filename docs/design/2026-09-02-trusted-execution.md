# Trusted execution: propose_execution, AuthorityEnvelope and one-time receipts

The runtime side of the management plane's trusted-execution contract. A write
action (external_write / destructive) is never performed directly by a governed
turn: the agent PROPOSES it with specifics, a human approves it on the
management plane, and the approved action executes exactly once against a
one-time receipt.

## The loop

1. **`propose_execution`** (tool; available on delegated turns or turns opted
   in with `allowInputRequest`, exactly like `request_input`): the model
   provides `effect`, `resources`, the exact `diff`, `reason`, `risk` and a
   `rollback` path — proposals without specifics are rejected client-side. The
   tool emits a reliable `auth_required` event and the turn ends.
2. The management plane runs the approval and, if approved, resumes this same
   session with a message carrying a one-time receipt.
3. The model re-invokes the gated tool passing `approval_receipt`.
4. The **authority guard** consumes the receipt atomically on the management
   plane (box → Runtime internal API `/api/internal/authority/consume`, mTLS →
   control-plane RPC) right before execution. A retried call gets "already
   consumed" and is blocked — never a second execution.

## AuthorityEnvelope enforcement (per tool call)

`chat.send` may carry a signed `authorityEnvelope`. Verification is local
(`SICLAW_AUTHORITY_SECRET`, HMAC-SHA256, constant-time compare,
`src/shared/authority-envelope.ts`) and FAIL-CLOSED at two points: `/api/prompt`
admission (present-but-invalid → 403) and session build. A valid envelope
registers the guard extension (`src/core/extensions/authority-guard.ts`,
pi-agent `tool_call` hook — the chokepoint covering every tool):

- a tool matching `deniedCapabilities` is blocked unconditionally;
- with `allowedCapabilities` present, any tool outside the list requires a
  consumed receipt;
- `propose_execution` / `request_input` / `report_findings` are never gated —
  ending a turn to ASK must stay possible under any ceiling, or a governed
  agent deadlocks.

The envelope joins the warm-session reuse predicate: a changed envelope
rebuilds the session (context restored from JSONL), so stale claims can never
govern a new turn.

## Tests

`src/shared/authority-envelope.test.ts` (verification matrix, capability
globs), `src/core/extensions/authority-guard.test.ts` (deny / allow / receipt
gating / refused receipt / always-allowed), `src/tools/workflow/propose-execution.test.ts`
(availability, specifics validation, event shape), plus the http-server 403
fail-closed path compiles under both tsconfigs.
