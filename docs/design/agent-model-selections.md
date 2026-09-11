# Shared Agent model selection

The control plane owns a shared Agent's model selection. A selection version is
a non-negative safe integer, independent of the release and model fingerprint.
It distinguishes repeated selections such as A → B → A within one release.

## Dispatch contract

A `chat.send` carrying `modelSelectionVersion` resolves its binding after taking
the turn lock, on every turn. The current binding owns the model, routing policy,
sub-agent candidates and Agent Addendum. A caller's earlier routing or Addendum
must not override that binding. Control planes that omit `binding.systemPrompt`
continue to supply the current Addendum through `config.getAgent`.

If the current binding cannot be resolved, the turn reports an error before
prompt dispatch. Reusing the caller's older binding could silently undo an
acknowledged selection. An uncontended lock does not prove that the caller's
binding is current: a save may commit after the caller resolved it but before
Runtime dispatches it. Reload notifications are therefore an optimization, not
the source of next-turn correctness.

Callers without selection metadata retain their existing prompt and routing
behavior. Already dispatched turns retain their captured configuration.

## Rollout and observations

1. Upgrade Runtime and AgentBox to support versioned selection metadata.
2. Upgrade the complete control-plane deployment so `config.getModelBinding`
   returns the version, including zero, before selection writes or versioned
   reload notifications are enabled. Do not serve selection-aware traffic from
   mixed old and new control-plane replicas.
3. Enable the selection interface after those prerequisites are satisfied.

Bindings without a version represent legacy version zero. They cannot
acknowledge a reload expecting a nonzero version. Invalid version types produce
an input error; mismatched valid identities produce a stale-binding error.

An older AgentBox cannot prove it ran a nonzero selection. During a mixed box
rollout, an unversioned observation and a nonzero observation remain
inconsistent, even if their release and model fingerprint match. Do not turn
missing evidence into a successful consistency receipt. Recycle old boxes
through normal operations after their active work finishes, and obtain a real
turn observation from the upgraded boxes. A reload acknowledgement alone is
not that observation.

Once a box has observed a nonzero selection, a later versionless prompt cannot
replace that evidence. This protects against delayed legacy traffic; new
selection-aware entrypoints must forward the version.
