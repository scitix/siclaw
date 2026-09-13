# KB Authoring Command Protocol

## Decision

Product actions that drive KB authoring use a versioned `capability.command`
envelope. Free-form conversation continues to use `capability.message`.
Human-language text is never used to select an execution path.

This protocol is owned by Siclaw because it is part of the reusable capability
execution surface. ControlPlane is one consumer and owns the knowledge-domain
operation, generation fence, product authorization, and UI.

## Language

**Authoring action**:
A stable machine identifier for one product intent, such as
`compile.generate`, `compile.incremental`, or `compile.repair_test`.
_Avoid_: prompt, button text, magic prefix

**Authoring command**:
One versioned invocation of an authoring action with typed parameters and a
consumer-owned operation reference.
_Avoid_: chat message, instruction string

**Display message**:
Optional localized prose shown in the conversation timeline. It is audit and
presentation data only and is never forwarded as the machine command.
_Avoid_: command text

**Content locale**:
The requested language of the compiled knowledge content. `auto` means infer it
from the source set and prior owner conversation. It is an authoring parameter,
not a routing key.
_Avoid_: UI locale, protocol language

**Prompt locale**:
The locale of model-facing command rendering and compiler prompt packs. It may
default from the consumer, but changing it cannot change action semantics.
_Avoid_: content locale

## Wire interface

```json
{
  "run_id": "runtime-run-id",
  "command_id": "consumer-operation-id",
  "command": {
    "version": 1,
    "action": "compile.incremental",
    "operation_id": "consumer-operation-id",
    "generation": 12,
    "parameters": {
      "brief": {
        "intent": "troubleshoot",
        "audience": "internal-eng",
        "depth": "full",
        "redaction": "none",
        "content_locale": "auto",
        "note": "Prefer operational examples"
      }
    }
  }
}
```

The runtime validates the common envelope and transports it opaquely to the
box. The selected BoxProfile implementation validates the action and its
parameters. Unknown versions and unknown actions fail closed.

## Invariants

1. In the v1 product contract, `capability.message` is conversation only. It may
   influence content through the model, but it cannot select batch,
   incremental, approval, resume, or repair control paths. The legacy
   fixed-prefix adapter described under Rolling migration is the temporary,
   observable exception for older deployments.
2. `capability.command` is machine control only. The box renders any model-facing
   instruction from its prompt locale after validation.
3. The consumer supplies `operation_id` and `generation`; the box never invents
   domain lifecycle identity. Artifact persistence remains fenced by the
   consumer's attempt and generation.
4. `command_id` binds one canonical command payload. Runtime checkpoints recent
   `{id, digest}` receipts in the consumer-backed run record, and the live box
   keeps the same protection across Runtime acknowledgement gaps. Repeating the
   same payload returns the prior acceptance; reusing the id for another payload
   fails closed.
5. One run is pinned to one `(operation_id, generation)` command context. A
   command for another context is rejected.
6. `content_locale`, prompt locale, display message, and free-form notes cannot
   alter action dispatch, idempotency, plan binding, or fencing.
7. Plan approval carries `plan_id`, the SHA-256 of the exact
   `authoring/PROPOSED_PLAN.json` artifact. The box rejects stale approval.
8. Parameter-bearing repairs carry structured facts. The renderer may translate
   labels and connective prose, but ticket IDs, affected pages, nonces,
   reference answers, and verdicts are transported without interpretation.
9. A command is an intent/receipt, not another lifecycle state machine. Run
   status remains the execution truth and ControlPlane's authoring operation remains
   the domain mutation truth.
10. A consumer that has already selected an immutable source revision supplies
    `input_revision` on `capability.start`. Runtime persists that revision in the
    run's initial checkpoint before any box spawn or materialization, then asks
    every fresh/recovered box for that exact revision. Consumers that omit the
    field retain the rolling-compatible fetch-then-checkpoint flow.

## Authoring actions v1

| Action | Required parameters | Meaning |
| --- | --- | --- |
| `compile.scout` | optional `brief` | Inspect sources and propose a plan; do not compile pages |
| `compile.generate` | optional `brief` | Initial full generation, immediately authorized |
| `compile.regenerate` | optional `brief` | Replace-generation into consumer-owned staging |
| `compile.approve_plan` | `plan_id` | Execute the exact currently proposed plan |
| `compile.incremental` | optional `brief` | Use the materialized structured changeset |
| `compile.resume` | none from the caller; the control plane injects `recovery_mode` (`resume`/`complete`/`restart`), `produced_count`, `produced_pages_ref` (= `authoring/RECOVERY_PROVENANCE.json`, the complete produced-page set in the workspace, with POSIX paths relative to `candidate/`) and an inline `produced_pages` preview only up to 200. In `complete` mode the box classifies pages from the file and refuses (409) when it is missing/mismatched and no whole inline list exists | Continue an interrupted compile from its workspace. The injected decision wins over local inference — a regeneration clones the stable draft, so file existence cannot tell inherited pages from this lineage's output: a pending compiler-owned batch plan (or a reset marker) resumes the batch train; landed candidate pages without a plan finish the coverage ledger; an empty candidate/ re-runs the full compile over the same raw/. A recovered incremental lineage (RAW_CHANGES.json with changes, no plan) takes the scoped incremental path. Missing batch plans are accepted; incomplete provenance is refused |
| `compile.submit_decisions` | `decisions[]` | Apply owner decisions and propose the resulting plan |
| `compile.apply_rulings` | `dispatch_nonce`, `rulings[]` | Apply contradiction rulings and emit per-ticket receipts |
| `compile.repair_test` | `question`, `reference_answer`, `verdict` | Repair the minimum draft scope for a failed test |
| `compile.apply_proposal` | `proposal_id`, `title`, `instruction`; optional `rationale`, `affected_pages` | Execute an owner-approved brief proposal; `brief`/`renew` and unknown keys are refused |

The optional brief uses stable identifiers. In particular,
`intent=understand|execute|troubleshoot` selects whether the compiled structure
prioritizes concepts/relationships, procedures/checks, or symptoms/evidence/
remediation. It changes content organization only; it never changes protocol
routing or lifecycle state.

`KBC_BATCH_MODE=off` disables automatic batching for new compile work. It does
not discard a persisted batch plan or its reset marker: `compile.resume` still
continues that existing batch train. Without a plan/reset marker, resume uses
the recovery decision and available workspace described above.

## Layer responsibilities

### ControlPlane

- authorizes the user and repository;
- validates the product action payload;
- creates the correct authoring operation/attempt;
- fills `operation_id`, `generation`, and `command_id`;
- supplies the immutable `input_revision` selected for a new mutation when the
  consumer supports start-time pinning;
- persists an optional display message separately;
- materializes source drift and other consumer-owned inputs;
- rejects stale artifact writes through the existing generation fence.

### Siclaw Runtime

- validates the common command envelope;
- finds/adopts the addressed run;
- checks the durable command receipt before touching the box;
- atomically checkpoints a start-time `input_revision` before touching the box,
  and reuses it for materialization after restart/adoption;
- publishes `running` before POST so a fast `turn_done -> idle` cannot be
  overwritten by a late handler write;
- forwards the command unchanged to `/command/{run_id}` and checkpoints the
  accepted `{command_id, payload digest}` afterward;
- does not render prompts or understand KB action parameters.

### KB compile-box

- validates the action-specific schema;
- enforces live-run command idempotency and operation pinning;
- validates artifact-bound references such as `plan_id`;
- writes structured brief data deterministically;
- renders the action into a model directive using the run's prompt locale;
- selects full, batch, incremental, resume, or repair execution from the action,
  never from rendered text.

## Delivery guarantee

The command path is at-least-once delivery with idempotent acceptance, not a
distributed exactly-once transaction. A process may die after the box accepts a
turn but before Runtime or ControlPlane persists its receipt. Retrying the same id is
therefore required: the surviving layer acknowledges the duplicate and the
missing durable receipt is repaired. If both Runtime and the ephemeral box die
inside that window, ControlPlane's operation/generation and artifact-write fences
remain the safety boundary; the same command may be redelivered to a rehydrated
box, but stale generations cannot commit.

## Cancellation confirmation

The consumer fences its domain operation before sending `capability.cancel`.
Runtime makes the execution terminal before stopping its box, preventing new
commands during cleanup. A terminal run record therefore does not establish
that the box was stopped: deletion can fail after the terminal write succeeds.

The consumer must retry the explicitly addressed run even when it is terminal.
Runtime resolves that run's stored profile on every cleanup retry, including
after restart, without reviving execution or reattaching its relay. Missing
addressing, a store failure, or a failed box stop returns an error. Only a
successful stop of the correctly addressed box, including an already-absent
box, returns `stop_confirmed=true`. These rules apply to either compiler engine.

## Rolling migration

Existing message-prefix detection remains a temporary compatibility adapter for
older ControlPlane deployments. New ControlPlane buttons use `capability.command`. Legacy
hits must be observable and can be removed after the paired deployment has been
stable for one release window.

## Acknowledged run-event delivery

Runtime requests `GET /events/{run_id}?ack=1`; the box announces
`{"type":"relay_ready","event_ack":1}` before sending events. Each
`syncArtifacts`, `turn_done`, `error`, `done` and `end` frame then carries an
`event_id` scoped to that live box run. With `event_ack=1`, the ID is a lowercase
32-character UUID hex epoch, a colon, and a nonzero decimal sequence of 1 to 16
digits without leading zeros (`^[a-f0-9]{32}:[1-9][0-9]{0,15}$`). The epoch is
generated once per live run; replay preserves the original ID. A rehydrated box
starts a new epoch. The box retains one unacknowledged frame
and waits for `POST /events/ack/{run_id}` with that id before consuming the next
frame. A new attachment cancels and waits for the previous consumer to exit,
then replays the pending frame before queued events. Socket-write success alone
never releases the frame. Heartbeat comments continue while awaiting the ACK.

Runtime persists the reply/artifacts and the run-state transition before
acknowledging delivery. The last committed event id is included in the opaque
run checkpoint, so a Runtime restart can acknowledge an already committed turn
without replaying its reply or resetting a newer turn to idle. The consumer's
assistant-turn sink must support adjacent retries after a lost persistence
response; the existing authoring sink provides this deduplication. Artifact
batch ACKs remain independent durability barriers and still precede event ACKs.

Turn and run-checkpoint writes each have a fixed 120-second retry window, with
backoff from 250 milliseconds up to 5 seconds. Only the failed persistence phase
is retried: an already saved artifact batch and its batch ACK are not repeated
after a checkpoint failure, and live turn, summary and lifecycle notifications
are emitted once while those writes retry. An in-flight RPC keeps its existing
transport timeout; no further retry starts after the window expires. Retries
do not refresh run activity or overwrite a newer command's running transition.
Cancellation stops nonterminal retries. If the write still cannot be committed,
delivery fails without an event ACK; a terminal outcome already selected stays
terminal while reconciliation retries its persistence.

A legacy box that omits the handshake keeps its prior stream behavior; Runtime
does not automatically reconnect that stream after a transport failure. Runtime
adoption also requires the handshake before accepting replayed events. A live
legacy stream cannot switch to acknowledged delivery, because its discarded
history cannot be reconstructed. A new Runtime/box pair enables the protocol
without a deployment setting. Reconnect attempts are bounded per run; they are
not reset by replay traffic. Reliable streams ending without an end frame are
transport failures, not evidence of successful completion.

An upgrade or rollback across this protocol boundary cannot safely adopt an
in-flight legacy Runtime/box pair. Drain active compiles before rollout, or plan
for their interruption and recovery from the last persisted workspace in a new
pair. There is no transparent in-place conversion of discarded legacy events.
