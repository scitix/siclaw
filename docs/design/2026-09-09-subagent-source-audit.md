# Subagent source audit: Codex, Claude snapshot, and Siclaw

Date: 2026-09-09. Scope: read-only source review; no runtime changes.

## Source versions and limits

- Official OpenAI Codex, cloned from https://github.com/openai/codex into
  `/private/tmp/codex-subagent-source-review`, commit
  `8afccec87aa15f73ee7fc35a3a4e7834afc5ef62`. This is the inspected public main snapshot,
  not a claim about every installed release or hosted product.
- User-provided `/Users/lrli/project/claude-code-init`, commit
  `9d051eaed03c7d426dec7b4e4cc40fa6f29cd565`. Its README describes an unofficial
  source-map reconstruction. Behavior below is attributed to that local snapshot;
  provenance and equivalence to a current Anthropic release have not been verified.
- Siclaw worktree `feat/siclaw-a2a-runtime-p1`, commit
  `d4c39923c6a4da7e1e3382be751ba87800d52172`.

## 1. Assignment is free text; role, context and authority are separate

### Codex

`codex-rs/core/src/tools/handlers/multi_agents_spec.rs:620` defines a plain-text
`message`, optional role selector and `fork_turns`. The v2 handler validates a non-empty
message, selects the role/configuration and submits an agent communication. No automatic
LLM briefing rewrite or mandatory objective/constraints/deliverables schema appears in
this dispatch path. V1 additionally accepts structured transport input items, which are
not a semantic task-contract schema.

`multi_agents_v2/spawn.rs:291` defaults `fork_turns` to `all`; `none` and positive
turn counts are supported. Fork scope and role selection are independent in v2, including
an explicitly selected role on a full fork. V1 has different restrictions, so the two
versions must not be conflated.

`multi_agents_common.rs:177` builds a parent-derived config and copies base instructions.
The shared config copies developer instructions, with an optional subagent-specific
replacement. `agent/role.rs:48` applies a role configuration; role developer instructions
replace that configurable layer rather than necessarily being appended. Role metadata
provides selection guidance; configuration controls model, instructions and bounded
capability reductions. The role does not replace the parent's authority.

`agent/control/spawn.rs:827` loads parent model context for forks. It filters inherited
items and parent collaboration guidance, handles compaction, and substitutes child role
instructions when appropriate. Thus even `all` means an inherited model-context path,
not a promise of byte-for-byte duplication of every raw event/tool trace. Each child is
a separate thread, not a shared mutable conversation.

### Claude local snapshot

`src/tools/AgentTool/AgentTool.tsx:83` takes free-text description and prompt. In the
normal path (`:483`), the selected agent builds its own system prompt and the task is
added as a user message. The fork path instead reuses the parent's rendered system prompt
and supplies parent conversation context. This path is feature-gated in the snapshot.

`runAgent.ts:510` uses a supplied system prompt override or builds one from the agent
role plus environment details. `loadAgentsDir.ts:712` maps role-file body text to the role
system prompt and parses tools, disallowed tools, model, skills and other settings.
`runAgent.ts:625` adds explicitly preloaded skills as initial context; `agentToolUtils.ts:122`
resolves tool allow/deny rules against the available tool pool. This does not mean every
main-agent prompt, loaded skill body or runtime state is implicitly copied to a normal child.

The prompt guidance at `AgentTool/prompt.ts:107` asks for context, prior findings and
judgment space, distinguishing concrete lookups from open investigations. It also contains
language about not delegating understanding. Siclaw's similar wording is therefore not
without precedent, but copying that prohibition without its investigative guidance can
make it overbroad. These are prompting choices, not a required reasoning algorithm.

## 2. Running direction and completed follow-up reuse child identity

### Codex v2

`multi_agents_v2/message_tool.rs:11` defines two delivery modes. Both route through the
same target resolution and communication path:

- `send_message`: queue-only; does not request a new idle turn.
- `followup_task`: requests a turn when idle and can deliver direction while running.
- `interrupt_agent`: a separate lifecycle action. Messaging is not synonymous with aborting
  a tool that is already executing.

`session/handlers.rs:80` enqueues mailbox input; the pending-work scheduler in
`tasks/mod.rs:418` only starts an idle turn for trigger-turn mail or an outstanding durable
sleep. The active-turn guard prevents two simultaneous turns from being started in the
same session. Loading an evicted child is separate from waking it: the messaging handler
first calls `ensure_v2_agent_loaded`, which can restore recorded context.

V1 instead offers `send_input` with an interrupt flag plus resume/close operations.
`multi_agents_tests.rs:1757` exercises follow-up completion notification on every turn.
Other source tests cover message-only queuing, interrupted children and cold reload.
These tests were inspected, not executed in this review.

### Claude local snapshot

`SendMessageTool.ts:800` resolves a name or agent ID. For a running local child it appends
to `pendingMessages`; `utils/attachments.ts:1085` drains that queue into subsequent child
input. For a non-running child, this snapshot calls `resumeAgentBackground`; an evicted
child can be restored from disk transcript.

`resumeAgent.ts:63` reads transcript and metadata, sanitizes unfinished message/tool
sequences, restores replacement state and appends the follow-up prompt. The logical
agent ID is retained. This is continuation of evidence/context, not a new blank assignment.
The inspected non-running branch does not distinguish every cancellation reason; our
explicit user-cancellation policy should be designed rather than copied blindly.

## 3. Completion is a lifecycle signal, not verified coverage

Codex `agent/status.rs:6` maps a successful TurnComplete event to Completed with the last
agent message. `session/mod.rs:2199` forwards terminal v2 results to the direct parent.
The completion communication has `trigger_turn: false`. A waiting/running parent can
consume it; a completely idle parent does not universally wake just because a result
arrived (durable sleep is an explicit exception). Therefore a channel integration still
needs its own task-lifecycle and delivery contract. UI completion, model notification,
parent continuation and user delivery must be considered separately.

Claude `LocalAgentTask.tsx:197` enqueues a completion/failure/stop notification, including
result and output-file information, and guards duplicate notification with task state.
`agentToolUtils.ts:276` extracts the final assistant text, with fallback to earlier text
if the last message has only tool calls. This finalization function does not establish
that the original assignment was semantically fulfilled. Hooks provide additional checks;
there is no universal correctness guarantee established by the inspected path.

Siclaw's bounded completion assessment is therefore a product-specific safeguard worth
retaining, not something to remove just because another runner marks a turn complete.
It still cannot recover a requirement that the parent omitted from the assignment.

## 4. Multi-target coverage is separate from agent count and plan display

Codex `tools/handlers/plan.rs:93` parses a checklist update and emits PlanUpdate. It does
not schedule each entry, enumerate an external inventory or verify evidence for each
entry. `list_agents` enumerates known agents, not all targets requested by the user.
Current v2 exposes the child lifecycle tools, not a typed inventory-coverage engine.

Claude's local `utils/tasks.ts:199` selects a session/team task-list namespace. Task
creation and claims use filesystem locks; `claimTask:541` checks ownership, completion
and dependencies under the lock. `TaskUpdateTool.ts:231` can invoke configured completion
hooks before accepting a completed status. These mechanisms coordinate registered work;
they cannot detect a resource never registered as a task.

Siclaw's template plus items is useful for repeated checks and should remain. One-item
free-text assignments and multi-item batches should share child lifecycle primitives.
For exhaustive requests, add a complete authorized target snapshot, stable per-target
records, bounded scheduling and final set reconciliation. Keep target identity distinct
from child/attempt identity so steering, retry and regrouping cannot lose coverage.
A common template ensures common instructions, not complete enumeration.

## 5. Additional concrete Siclaw findings

### P1: the configured Agent business addendum is omitted from child initialization

Parent creation at `src/agentbox/session.ts:3554` passes the persisted Agent addendum
through `systemPromptAppend`. Child creation at `:2730` passes only
`type.systemPromptAddendum`. `agent-factory.ts:439` forwards that single value as
`agentPrompt`, and `agent-context.ts:178` compiles it into the Agent addendum layer.

The child retains the platform kernel, Agent type contract, configured resources and
allowed tools, but not the parent's custom Agent addendum. A business rule such as
which evidence to collect can therefore disappear unless the parent restates it in the
task prompt. This is an instruction-inheritance gap, not evidence of expanded tool access.

A local pure compiler probe using a synthetic parent marker confirmed that it appears in
the parent prompt but not in the child prompt built with the actual child option shape.
No production prompt or secret was used.

### P2: child prompt guidance mentions tools removed from the actual child tool surface

`agent-factory.ts:432` compiles context using the inherited capability list and disables
interactive progress. The compiler does not receive `isSubagent`. In
`agent-context.ts:160`, planning and delegation guidance are inferred from that inherited
list. Later registration hides task tools for `isSubagent` (`task-tools.ts:373`), and child
creation omits the spawn executor. As a result an ordinary SRE child can still be told
to use `task_create` and `spawn_subagent` while neither is available to it.

A pure compiler probe confirmed both guidance flags and both tool-name instructions are
present for the child option shape. Prompt construction should use the child's effective
capabilities, not the parent's unfiltered capability list.

## 6. Recommended Siclaw composition

Keep these concerns explicit:

1. Platform safety and runtime enforcement: mandatory, never replaced by role text.
2. Agent business policy: preserve the relevant configured behavior for the same Agent.
3. Child role: a concise worker/reviewer/investigator specialization, with capability
   restrictions and optional skill references. Do not build a separate tenant Agent or
   cross-runtime handoff just to select a subagent role.
4. Task prompt: free text or per-target rendered template, with optional output guidance.
5. Conversation context: independently controlled, initially scoped briefs/evidence;
   consider selected-history/fork support only with permission, artifact-scope and
   compaction behavior defined. No blind full-history copying across different Agents.

Do not use an LLM or string heuristics to extract security policy from arbitrary prose.
The existing editable addendum may mix business policy and parent orchestration: make
inheritance explicit and keep parent-only planning/routing guidance separate from child
rules. Enforce the effective permission intersection in code, not solely through prompt
ordering. Role selection should not dictate diagnostic steps or expand authorization.

Priorities: fix instruction inheritance and effective-tool guidance; add stable child
handles, queued direction, retained-context follow-up and result revisions; preserve batch
mode and implement exhaustive target accounting for inventory-wide work. Recompute or
invalidate synthesis when a child is reopened. Keep lifecycle state separate from verified
coverage and from healthy/unhealthy diagnostic results.

## Verification

- Cloned and inspected pinned Codex source, relevant handlers, lifecycle, role/context
  assembly, and existing test bodies.
- Inspected local Claude snapshot source; did not build/run it or assume official provenance.
- Traced Siclaw parent/child initialization and prompt compilation; ran two local pure
  compiler probes. No live-model, production session or channel queries were performed.
- No application code, deployment, git commit or push was changed by this review.
