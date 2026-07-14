# KB Authoring Command Protocol

## Decision

Product actions that drive KB authoring use a versioned `capability.command`
envelope. Free-form conversation continues to use `capability.message`.
Human-language text is never used to select an execution path.

This protocol is owned by Siclaw because it is part of the reusable capability
execution surface. Sicore is one consumer and owns the knowledge-domain
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
4. `command_id` is idempotent within a live run. Repeating an accepted command
   returns the prior acceptance and does not start a second turn.
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
   status remains the execution truth and Sicore's authoring operation remains
   the domain mutation truth.

## Authoring actions v1

| Action | Required parameters | Meaning |
| --- | --- | --- |
| `compile.scout` | optional `brief` | Inspect sources and propose a plan; do not compile pages |
| `compile.generate` | optional `brief` | Initial full generation, immediately authorized |
| `compile.regenerate` | optional `brief` | Replace-generation into consumer-owned staging |
| `compile.approve_plan` | `plan_id` | Execute the exact currently proposed plan |
| `compile.incremental` | optional `brief` | Use the materialized structured changeset |
| `compile.resume` | none | Resume an interrupted compiler-owned batch plan |
| `compile.submit_decisions` | `decisions[]` | Apply owner decisions and propose the resulting plan |
| `compile.apply_rulings` | `dispatch_nonce`, `rulings[]` | Apply contradiction rulings and emit per-ticket receipts |
| `compile.repair_test` | `question`, `reference_answer`, `verdict` | Repair the minimum draft scope for a failed test |

## Layer responsibilities

### Sicore

- authorizes the user and repository;
- validates the product action payload;
- creates the correct authoring operation/attempt;
- fills `operation_id`, `generation`, and `command_id`;
- persists an optional display message separately;
- materializes source drift and other consumer-owned inputs;
- rejects stale artifact writes through the existing generation fence.

### Siclaw Runtime

- validates the common command envelope;
- finds/adopts the addressed run;
- forwards the command unchanged to `/command/{run_id}`;
- updates run activity/status exactly as for an accepted model turn;
- does not render prompts or understand KB action parameters.

### KB compile-box

- validates the action-specific schema;
- enforces live-run command idempotency and operation pinning;
- validates artifact-bound references such as `plan_id`;
- writes structured brief data deterministically;
- renders the action into a model directive using the run's prompt locale;
- selects full, batch, incremental, resume, or repair execution from the action,
  never from rendered text.

## Rolling migration

Existing message-prefix detection remains a temporary compatibility adapter for
older Sicore deployments. New Sicore buttons use `capability.command`. Legacy
hits must be observable and can be removed after the paired deployment has been
stable for one release window.
