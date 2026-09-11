# Planning alignment with Codex and Claude Code

Status: implemented in an isolated worktree and deployed to an isolated test
namespace. The changes cover planning instructions and deferred model binding.
The existing task schema, ledger, and UI remain compatible.

## Evidence and scope

- Siclaw: `d78fd7bfdd9741e82d35aa967d867e9c20dc5349`, fetched from `main`
  on 2026-09-11. The reported screenshot shows an execution checklist, not an
  explicit proposal-only interaction. It does not expose task descriptions,
  the complete conversation, model configuration, or private reasoning.
- Codex: official upstream `main` at
  [`da20788df913189878ebca7f4963d8a363ee6bf2`](https://github.com/openai/codex/tree/da20788df913189878ebca7f4963d8a363ee6bf2),
  fetched on 2026-09-11. Reviewed the checklist schema/handler, registration,
  config, instruction assembly, built-in prompts, and plan rendering.
- Claude Code: the installed `@anthropic-ai/claude-code` **2.1.258** native
  distribution contains a readable minified JavaScript bundle. Reviewed its
  task-tool prompts and schemas, update path, plan-mode instruction assembly,
  and exit-plan schema/validation. Binary SHA-256:
  `b63136194160791c27cfa7b0403060d85eb0752991625fde8c09f9acacb17c78`.
  This is a versioned distribution inspection, not a claim that the core is
  open source or that every conditional feature is active in a running session.
  The [official repository](https://github.com/anthropics/claude-code/tree/536a2e23d9e28586f81f17b3535281b5f2995a70)
  exposes plugins, examples, and distribution/support material, not these core
  source modules. An older unofficial source snapshot was used only to locate
  concepts; claims below were checked against the installed bundle.

The source comparison establishes design choices, not measured product parity.
Behavioral replay methodology and its limits are documented below.

## The essential distinction

| Concern | Codex | Claude Code | Siclaw today |
| --- | --- | --- | --- |
| Execution progress | `update_plan`: short steps, statuses, optional explanation | `TaskCreate/Update/Get/List`: task ids, descriptions, owners, dependencies | `task_*` ledger, batched writes, persisted events |
| Designing an approach | Separate Plan collaboration mode and a proposed-plan document | Separate plan permission mode, plan file, and `ExitPlanMode` | The displayed ledger is the execution-progress surface |
| Plan quality | Instructions and model work; checklist handler does not assess quality | Exploration/design/review instructions; task fields do not imply a researched solution | Strong timing instructions, weak examples of useful decomposition |
| Revising work | Replace the checklist and explain the pivot | Change subject/description as requirements become clearer; delete obsolete tasks | API permits edits, but tool prose discourages relabeling and favors growth |

The two products do not have identical policies: Codex rejects `update_plan`
in Plan Mode, while Claude's task prompt explicitly permits a task list inside
plan mode. Both distinguish a progress record from the substantive proposal.

### Codex: a deliberately small checklist tool

The [schema](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/core/src/tools/handlers/plan_spec.rs)
contains only `explanation?` and `plan: [{ step, status }]`. It has no hypothesis,
evidence, confidence, or acceptance-criteria object. Its description asks for
at most one `in_progress` step. The
[handler](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/core/src/tools/handlers/plan.rs#L87)
parses arguments, emits `PlanUpdate`, and returns `Plan updated`; it does not
run another model or verify the semantic quality of a plan. The one-active-step
rule is prose in this path, not a validator.

The [bundled checklist guidance](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/models-manager/prompt.md#L52)
asks for meaningful, logically ordered steps that can be verified, explicitly
rejects padding and obvious phases, and provides positive and negative examples.
It allows mid-task plan changes with an explanation and says not to repeat the
whole checklist in the chat after updating it. Its good examples name concrete
implementation choices; the bad examples merely rename the requested outcome.

These bundled prompts are not proof of the exact instructions for every deployed
model. Catalog and caller instructions can differ. In fact, at this revision,
[`update_plan` is opt-in](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/core/src/config/mod.rs#L2641):
absence of an enabled config resolves to false, also covered by a
[config test](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/core/src/config/config_tests.rs#L606).
Registration follows that setting. When disabled,
[assembly removes checklist guidance](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/core/src/session/world_state.rs#L47)
from Codex-owned instructions, with exceptions for custom instructions/catalogs.
This does not establish which setting a particular desktop or hosted deployment
uses. It does establish that a visible checklist is not a prerequisite for
the upstream planning workflow.

### Codex: a separate proposal workflow

The [Plan Mode template](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/collaboration-mode-templates/templates/plan.md)
requires three phases:

1. Ground in the environment through non-mutating inspection. Discoverable facts
   should be investigated before asking the user.
2. Settle the goal, success criteria, scope, constraints, and meaningful tradeoffs.
3. Resolve the approach and implementation decisions before issuing the proposal.

The final artifact is a `<proposed_plan>` document, intended to be actionable
without leaving important decisions to its implementer. The template also asks
for concision: relevant changes, tests, and assumptions, not an exhaustive
inventory of files or speculative edge cases. The TUI has
[separate rendering types](https://github.com/openai/codex/blob/da20788df913189878ebca7f4963d8a363ee6bf2/codex-rs/tui/src/history_cell/plans.rs)
for checklist updates and proposed-plan Markdown. Reading a source template
does not prove compliance by the model or enforcement of every non-mutation
rule; the checklist-in-plan-mode rejection is directly visible in its handler.

### Claude Code: mutable tasks plus researched proposals

The installed bundle's `TaskCreate` prompt explicitly recommends task lists for
complex work with three or more steps. It also rejects trivial tracking and
asks for clear, specific subjects describing the outcome. Therefore, the
three-step heuristic alone cannot explain a quality gap with Claude Code.

`TaskUpdate` explicitly allows changing details when requirements become clearer,
including subject and description. It warns against marking tasks complete with
failing tests, partial implementation, missing files, or unresolved errors.
The adjacent schema/update code accepts those text changes. This differs from
Siclaw's instruction to always create a new task rather than refine an existing
one when a lead changes.

The separate plan-mode instruction assembly in this distribution has full,
sparse-reminder, and subagent paths. The full default workflow describes:

1. Understand the request and explore existing code, functions, and patterns.
2. Design using the exploration results, requirements, and constraints.
3. Review important files again and check alignment with the original request.
4. Write a plan file with context, a recommended approach, relevant files/reuse,
   and verification; keep it concise enough to scan and detailed enough to act on.
5. Present it for approval through `ExitPlanMode`.

Exploration/design can be delegated on one conditional branch; another branch
explicitly performs the work directly. The bundle's presence does not establish
the active branch or justify mandatory planning subagents in Siclaw.
`ExitPlanMode` uses the plan file, not task-list rows, as its proposal. Its prompt
distinguishes implementation planning from pure research, and its input validation
checks the current mode. The [official best-practices guide](https://code.claude.com/docs/en/best-practices#explore-first-then-plan-then-code)
independently describes exploration before planning and the overhead of using
plan mode for small, clear tasks.

For reproducibility, the readable bundle anchors and byte offsets in the hashed
native binary are: `TaskCreate` prompt at 164392755, `TaskUpdate` prompt at
164398590, `ExitPlanMode` prompt at 163819441, and plan-mode assembly around
165982498–165994365. These offsets apply only to that binary.

## What is wrong with Siclaw's current instructions

1. **Premature commitment.** `buildWorkflowSection()` makes `task_create` the
   first move before investigation, even when the relevant Skill or data source
   has not been read. This conflicts with developing a grounded approach. An
   initial outline can be useful; requiring a detailed plan before context is
   not the same thing.
2. **Weak exemplars.** The tool example prescribes status/events, GPU, network,
   storage, and correlation without evidence that each investigation needs all
   these branches. The model can imitate a reusable list instead of selecting
   checks that discriminate between explanations.
3. **Discouraged revision.** The tool's prose rejects relabeling an existing step
   when a lead changes, even though `TaskLedger.update()` supports it. This
   encourages stale tasks and unnecessary additions.
4. **Bookkeeping competes with investigation.** Repeated creation/listing/status
   narration can consume turns without new information. Existing batched writes
   are useful and should remain. Completion updates must not run speculatively
   beside the verification that is supposed to justify them.
5. **A checklist is being evaluated as a complete plan.** `PlanPanel` displays
   short subjects. A short title is normal for this surface. Making every row
   verbose or adding evidence fields would not itself improve the approach.
   The screenshot's generic titles and repeated introductions are visible;
   the depth of the model's private reasoning is not.

## A runtime cause found during replay

Prompt inspection confirmed that the candidate instructions were present, but
early Sonnet replays still completed failed verification milestones. A temporary
metadata-only proxy then showed `thinking: { type: "disabled" }` on actual model
requests, including after enabling the model descriptor's reasoning capability.
The factory's `thinkingLevel: "high"` argument was not sufficient.

The installed `@earendil-works/pi-coding-agent` **0.85.1** explains the transition:

1. `dist/core/sdk.js` clamps the initial thinking level to `off` when the initial
   model is absent or lacks reasoning support.
2. Siclaw can bind its selected model later, through `PiAgentBrain.setModel()`.
3. `dist/core/agent-session.js::_getThinkingLevelForModelSwitch()` resolves the
   per-model setting, then the default setting, then the current level. Without
   either setting, the earlier `off` survives the switch to a reasoning model.

`resolveSessionThinkingLevel()` now supplies Siclaw's existing `high` default as
an instance-only settings override before session creation. It honors explicit
default and per-model preferences and does not write a global user setting.
Model capability clamping and explicit route parameters still apply. This fixes
the integration's default propagation; it does not enable reasoning on models
whose descriptors disable it or make an incompatible provider support it.

An installed-SDK regression test failed with `expected high, received off`
before the fix and passes afterward. It covers bootstrap with a non-reasoning
model, late binding, actual serialized `reasoning_effort: "high"`, an explicit
route override, and the absence of a global preference write. Additional cases
cover configured defaults and per-model preferences. The deployed candidate
also sends Sonnet `thinking.type: "adaptive"` with `output_config.effort: "high"`.
This is evidence of the requested model configuration, not direct access to or
proof of the model's private reasoning quality.

## Implemented change

First align ordinary execution, retaining the existing ledger, event format,
dependencies, batching, and parent ownership:

- Use the checklist when it organizes substantial work, with no minimum count
  to satisfy. If context is missing, allow focused discovery before fixing the
  steps. Do not delay a useful plan until all investigation is finished.
- Give concise, concrete, verifiable milestones and positive/negative examples.
  Put relevant approach and constraints in the existing description field.
- Refine unfinished work in place, add genuinely distinct work, remove obsolete
  pending steps, and preserve completed results. Explain material pivots in chat.
- Update completion from observed results. Avoid duplicated checklist narration,
  unconditional list/get calls, and intermediate bookkeeping-only turns.
- When the user asks for a proposal before execution, provide a real proposal;
  ledger creation alone does not fulfill that request.

For the reported kind of request, after reading the procedure and finding the
available sources, useful milestones could be:

1. Select a slow request with a usable trace within the requested window.
2. Attribute elapsed time along the request's critical path.
3. Build and verify the timeline against the source events.

The description preserves the allowed time-window fallback and what makes a
sample usable. After seeing actual spans, milestone 2 can become a targeted
check of queueing, retries, or downstream latency, depending on the evidence.
These are candidate directions, not assumed findings. Request/trace identifiers,
timing evidence, limitations, and next steps belong in the delivered result.

An explicit proposal-only mode could be a separate follow-up: mode-owned
instructions, allowed actions, a persisted proposal, and a review/continue
transition. It should not be automatically inserted into every read-only SRE
investigation, nor conflated with the existing Deep Investigation workflow.
There is no source evidence here for adding a mandatory extra planner model,
quality-scoring tool, or fixed hypothesis schema to ordinary execution.

## Verification and evaluation

Existing task-tool/ledger tests, prompt assembly/capability tests, typechecking,
and build verify compatibility. They do not measure planning quality. The core
prompt wording and its model-envelope detection marker change together; the
detector now recognizes the planning section instead of the obsolete first-move
sentence.

Integrated candidate checks on 2026-09-11: 7,109 tests passed and 2 were skipped
across 331 files. `npx tsc --noEmit`, `npx tsc -p tsconfig.agentbox.json --noEmit`,
`npm run build`, and `git diff --check` passed. These checks cover the core
prompt, tool guidance, model-envelope marker, and model-binding fix together.

Before judging model behavior, replay synthetic cases against the same model,
reasoning settings, tool fixtures, and Skill content on baseline and candidate:

| Case | Expected behavior |
| --- | --- |
| Direct known lookup | Perform the lookup without inventing a multi-step plan |
| Unknown procedure/source | Read the relevant procedure or make focused discovery; use what it establishes |
| Context already provided | Start useful work/plan immediately; no mandatory exploratory round trip |
| Empty initial request window | Expand only on the specified trigger and only to the allowed bound |
| New trace evidence | Refine the pending analysis step; do not add unrelated subsystem checks |
| Incomplete trace or query failure | Preserve the gap; do not claim verified attribution or pre-complete a check |
| Proposal-only request | Deliver approach, important decisions/constraints, and verification without execution |

Record scope compliance, concrete versus generic steps, evidence-driven revisions,
final answer correctness, unsupported claims, bookkeeping-only turns, tool count,
latency, and token use. Review multiple runs; neither a keyword test nor a single
attractive plan proves alignment with either product. Keep the screenshot's
production data and service-specific procedures out of upstream fixtures.

### Deployed candidate observations

The final candidate AgentBox digest is
`sha256:34f23e496033d383725132fe0e4de0759190e85b73659bedc3588ab61b4db13e`;
the main AgentBox digest is
`sha256:062ce549b1f0060c1f288cd083b734953f9b2b4e897d13c7edc23e27f54f22e1`.
Both use the same fixed Runtime/Portal, synthetic Skill/MCP, and scoped test
agents with `read_files` and `plan_tasks`. This is a planning-kernel replay,
not an evaluation of the complete SRE tool inventory or production incidents.

Two configured models were exercised: `gpt-5.6-sol` over Chat Completions with
its reasoning capability disabled, and `claude-sonnet-4-6` over the Anthropic
protocol with its reasoning capability enabled. On the wire, GPT requests omit
an explicit reasoning effort. In the dedicated late-binding probes, Sonnet kept
disabled thinking on the prompt-only candidate and sent adaptive/high after the
runtime fix. A fresh main deployment with reasoning metadata already available
also sent adaptive/high: the original bug depends on initialization and binding
order, not solely on the image version. Keep these probes separate from the
stable main/candidate behavior batches. Default propagation is established by
the installed-SDK regression and controlled request probes; the replays do not
independently verify the provider's model implementation.

Both final candidates completed the eight-case batch without terminal model or
transport errors. Reviewing the actual tool arguments, results, task updates,
and assistant messages produced these observations:

| Case | GPT candidate | Sonnet candidate |
| --- | --- | --- |
| Direct lookup | One status call, no ledger | One status call, no ledger |
| Unknown procedure/source | Reads Skill and discovers sources before three concrete milestones | Reads Skill first; still uses four steps close to individual tool calls and leaves a finished analysis step active |
| Known procedure/source | Skips catalog lookup; calculates and verifies the supplied workflow | Skips catalog lookup; two tasks, including a report step |
| Permitted fallback | Searches 30 then 120 minutes; revises the title before completing; verifies 1200 ms / 400 ms | Same bounded searches and correct verification; title still says 30 minutes after using a 45-minute-old sample |
| Strict 15-minute bound | Explicit sample-existence question finishes on empty results; removes the conditional trace step | Stops after the empty 15-minute search; removes the trace step |
| Incomplete trace | Records the 600 ms gap; full verification remains incomplete | Explains the gap in the answer but marks failed verification completed |
| Query failure | Keeps sample acquisition incomplete and downstream work blocked | Keeps sample acquisition incomplete; the answer still suggests a larger window despite an index failure |
| Proposal only | Reads the Skill without live queries; supplies approach, scope, branches, and acceptance criteria | Same execution boundary; proposal still contains assumed result-field names and an unnecessary service-health gate |

For complete traces, both derive the critical path as 1200 ms and retry backoff
as 400 ms without summing overlapping parent/child or parallel spans. For an
incomplete trace, submitting a placeholder retry value of zero does not establish
that no retry occurred; the answers must retain that uncertainty.

The Sonnet incomplete-trace and query-failure cases were each repeated twice
without changing the candidate or retrying for a better answer. Across the three
runs, failed trace verification was marked completed **3/3**, whereas acquisition
after a query failure stayed incomplete **3/3**. These are small, deterministic
fixture samples, not estimated production success rates. GPT's stronger behavior
on these examples also does not establish universal compliance.

**Acceptance is partial.** Compatibility checks and the model-default regression
pass, and the implementation follows the reviewed checklist design principles.
The strict behavioral goal of consistently truthful, current task states has not
passed for Sonnet. Keeping an honest final answer does not excuse a misleading
green checklist. No result here supports claiming equal performance to the actual
Codex or Claude Code products. A longer checklist, more prompt repetition, or a
semantic keyword validator would not be a justified fix based on this experiment.

Earlier GPT trials encountered provider HTTP 400 errors around tools and reasoning
on Chat Completions. A minimal Responses request worked while full-agent Responses
requests failed. Those transport/protocol failures are recorded separately from
planning behavior; the final eight-case GPT candidate needed no retries. Repeated
queries in some earlier runs came from empty-final-response recovery re-injecting
the user request, so tool-count reductions cannot all be attributed to planning.

A further experiment-integrity issue was caught during review: some runs labeled
`baseline-final` actually used the prompt-only candidate after image reconciliation.
Their resident prompt/tool inspection identifies them as candidate runs; they are
excluded from main comparisons. Rolling-update sessions without successful
resident inspection are also excluded. The corrected runner can stop on variant
mismatch, and the main comparison uses a separate stable deployment epoch.

In that corrected main epoch, GPT's discovery case creates four steps before
reading the Skill, while the candidate reads the Skill and discovers the source
before three milestones. Main marks the failed incomplete-trace verification
completed; the candidate leaves it incomplete. Sonnet still reads the Skill on
main, so that behavior is not a candidate-only improvement. Its failed
verification status remains a problem after the change. A main GPT query-error
case encountered a terminal provider HTTP 400 and was rerun separately; no bad
plan was rerun to replace it with a better result.

The 32-case main/candidate matrix has 31 completed terminal text responses. Main
Sonnet's incomplete-trace run exhausted empty-final-response recovery and ended
without a final text response; it remains recorded as a baseline failure and is
excluded from final-answer comparisons. Its repeated tool calls do not establish
a planning-efficiency regression. All 16 final candidate cases completed normally.
Two fresh candidate status calls also passed after restoring the original provider
route; the temporary metadata proxy was then removed from the test environment.

### Reproducing the deployment replay

`scripts/smoke/planning-fixture.mjs` serves a synthetic observability MCP at
`/mcp` and exports the accompanying Skill and Chinese-language request cases
(matching the reported interaction language). Its evidence includes concurrent
spans, retry backoff, a bounded empty window, an incomplete trace, and a failed
query. It does not mock the model. Expose it only inside an isolated test
environment, register the MCP, and bind the exported `skillFixture` to the
test agents with no real cluster/host credentials.

Use the same model descriptors, Skill, capabilities, and fixture on both sides.
Run baseline and candidate AgentBox images built from the same base revision;
only the candidate patch differs. Use separate Runtimes or sequential deployment
epochs when sharing a Runtime: `AgentBoxManager` reconciles stale images on
acquisition, so manually pinning one pod's image does not preserve a mixed-image
comparison. Verify the desired spawn image, actual pod image digests, and the
resident-session prompt/tool inspection for each run. An agent's baseline label
is not proof of its code version.

```bash
SICLAW_PORTAL_URL=http://127.0.0.1:3003 \
SICLAW_AGENT_ID=<test-agent-id> \
SICLAW_TOKEN_FILE=/private/path/token.txt \
SICLAW_REPLAY_LABEL=baseline \
SICLAW_REPLAY_EXPECT_VARIANT=baseline \
SICLAW_REPLAY_DIR=/private/path/replays \
node scripts/smoke/planning-replay.mjs
```

Repeat with the candidate agent, label, and expected variant. The variant check
stops the batch if the resident core/tool instructions do not match the intended
baseline or candidate; it complements image verification and does not evaluate
semantic plan quality. Optional `SICLAW_REPLAY_REPEAT`
repeats each case; `SICLAW_REPLAY_CASES` selects comma-separated case ids.
Each run saves SSE events, persisted messages, task arguments, and exact prompt
inspection. Review the final answers and completion timing alongside the tool
results. The runner detects transport/model failures; it intentionally does not
turn keyword matches into a plan-quality pass score. Local artifact files are
private and may contain full conversation data.
