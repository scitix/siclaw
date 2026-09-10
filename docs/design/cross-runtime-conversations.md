# Cross-Runtime conversation ingress

The external portal-managed channels and scheduled tasks submit to the control plane's
`conversation.start` RPC. They subscribe to `conversation.event` before dispatch
and correlate by session ID plus the persisted original user-message ID.

The control plane owns handoff sequencing and sends `chat.send` to each existing
destination Agent on its own Runtime. `handoffSupported` flows through the prompt
options and session factory. The transfer tool is enabled only for managed main
turns in web/channel/task mode with a permitted roster; delegated/subagent work
cannot transfer its parent's conversation. Changing this capability rebuilds a
cached session so tool availability never lags behind transport policy.

A destination uses its own model configuration, system prompt, skills and
resources. The source channel handler does not call its local AgentBox manager
for managed conversations and does not forward source model credentials.

Channel collectors retain real narration and display the destination's answer
on the existing card. They do not persist a second copy of messages already
written by the destination Runtime. Scheduled runs preserve their original
run/schedule identity, wait for the logical terminal, then record the result.
`agent_switch` clears source answer/task-report buffers. An error never becomes
a successful source progress paragraph.

Stop is sent to `conversation.abort`, which resolves and fences the current
executor. Feishu `/new` also uses it for the old conversation instead of creating
a local AgentBox just to close a session that now lives elsewhere.

Older standalone Portals may explicitly report this protocol unsupported. They
keep the local path without handoff. A transport failure or uncertain submission
must not fall back to a second local execution.

## Delivery and recovery boundary

After transfer the destination execution is independent of the source Agent or
Runtime. The original bot Runtime still owns channel delivery, and scheduled
completion recording remains with its scheduler. A source transport outage can
therefore prevent delivery without stopping destination execution. Control-plane
restart recovery and durable offline redelivery are not provided by this change.
Inspect authoritative session/trace status before retrying an uncertain request.
Feishu detached background execution remains disabled.

Strict product-result `/run` and developer MCP Preview use their existing fixed
executor contract. API Key reassignment and production Coordinator retirement
are separate migrations, not automatic consequences of enabling handoff.

## Verification

The affected factory/session/tool/HTTP server/channel/task/consumer suites passed
(756 tests, 1 skipped in the broad run), followed by 417 passing channel/task
checks including managed `/new`; TypeScript build passed. The external portal race tests cover
cross-Runtime handoff, source loss after transfer, deduplicated dispatch, RPC
ownership checks and logical A2A completion. No production channel sends or
production configuration changes were performed.

## Per-request handoff convergence

The controller constructs `handoffPolicy` with two remaining transfers, the initial executor in `visitedAgentIds`, and empty history. It is not copied from caller extras. Accepted transfers decrement the budget and append the source, destination, brief and optional `newEvidence`. The next user request gets a fresh policy; shared Agent configuration stores no execution policy.

Runtime passes a validated snapshot through chat.send → AgentBox → getOrCreate → factory/tool refs. An idle session rebuilds when the policy changes; a busy session retains its current policy. `transfer_to_agent.new_evidence` is required for a revisit. Runtime rejects missing or exactly repeated evidence before evicting context or emitting an ownership event, so the model can finish normally. At zero budget the tool is removed and the compiled context explicitly requests an honest answer/clarification. Resource authorization remains separate.

The controller repeats the budget/self-transfer/revisit checks. Evidence comparisons normalize case and whitespace; they are not semantic truth validation. A model could fabricate or paraphrase evidence, so the transfer budget is the unconditional guard.

After an incompatible executor emits a refused handoff and a confirmed terminal, the controller advances the same owner's epoch using `ResumeForTurn` and dispatches at most one closure continuation. `handoff.recovery=true` distinguishes it from a real transfer; history restoration, skipInitialPersistence and trace propagation use the existing continuation path. It emits no agent_switch or fake user row. It has handoffSupported=false and remaining=0. Cancellation is checked atomically before the new epoch. A second refusal, transport failure or model failure remains an explicit failure; no infinite recovery, fabricated final answer or success downgrade is allowed.

Deployment requires matching the external portal and Runtime versions. The bounded controller fallback supports a refused event from an older executor but cannot make an old model/tool stack obey the closure instruction. No database migration or new public REST endpoint is added.
