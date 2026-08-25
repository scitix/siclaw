# Coordinator defects — seventh revision

Base `30e2b4f9`. Branch `analysis/coordinator-issues`.

> ➡️ **The contract to review and build from is `2026-08-25-delegation-contract-v1.md`** — request
> side and result side as one versioned protocol, with the work split for both repositories. This
> document remains the **evidence and the reasoning**: the trace analysis, why each decision went the
> way it did, and the ten recorded errors. Where the two disagree about a field or a rule, the
> contract document wins; where they disagree about *why*, this one does.

Ten content errors across seven drafts are listed at the end with the reasoning that produced
them. Read that section before trusting any single claim here. **Five of the ten are two errors
repeated**: one misreading corrected in the third draft, restated in the fifth, and restated a third
time while implementing (4, 9, 10); and one scope error corrected twice, still too narrow the second
time (6, 8). "It was fixed once" is not evidence that it is fixed.

**Provenance.** Code claims are verifiable from this checkout — check them, three of my errors
were code misreadings. Trace claims: ⟨t1⟩ my sampling (single verifier), ⟨t2⟩ second-round
production analysis with lineage matching, ⟨t3⟩ third-round read-only verification. Neither ⟨t2⟩
nor ⟨t3⟩ is reproducible from this checkout; where they contradict ⟨t1⟩ they win. ⟨other-repo⟩
marks a claim about the management plane's code or data that **cannot be checked from here at
all** — one such claim already turned out to invert a decision in this document (see M1).

---

## Order

| # | Item | Priority | Gate |
|---|---|---|---|
| 1 | **C2** — tool rows never finalized except on abort | P0 | ✅ **siclaw DONE** (all exits + nested finally + peek-then-shift + portal-web). ⚠️ **Must NOT deploy** until the analysis layer reclassifies — classifier first, writer second |
| 2 | **C1** — delegation result contract + one budget, **plus the request side** | P0 | **Not started.** Spec is now `2026-08-25-delegation-contract-v1.md`. Blocked on ONE decision: does the other side adopt that mapping table? Half a contract is worse than none |
| 3 | **P1** — tool description + coordinator continuation rule | P0 | ✅ **DONE** in siclaw (`delegate-to-agent.ts` description; `COORDINATOR_DEFAULT_PROMPT` + digest tripwire). The other side must copy the prompt text and add the creation-wiring test |
| — | ~~platform prompt: an announcement is not a turn's output~~ | — | **declined — cannot be scoped to coordinators**, see P1. File as a platform issue |
| 4 | **C3** — trace propagation | P1 | ✅ **siclaw DONE — spans AND rows.** An earlier revision claimed a full chain when only the span half worked; the DB half (row stamping + tool-call correlation) is now closed too. Contract doc §10a records what was missing |
| 5 | **K1** — identity resolver + coordinator MCP cleanup | P1 | ready to design |
| 6 | **C5 / C4b** — `list_delegates` | P2 | ✅ **DONE**: `match_basis` no longer claims an exact match on zero results, and a query no longer prints the other kind's total. Batch still deferred — the single retry token is unsolved |
| 7 | **M1** — analysis-tooling filter semantics | P2 | different repo; **no dependencies, can start now** |

⚠️ **Cross-repo heads-up from the C5 fix: `match_basis` now has THREE values**, not two —
`browse | exact_resource_binding | no_match`. A consumer branching on the old pair will meet an
unrecognised value. That is the intended correction (a miss used to report
`exact_resource_binding`), so any count of "successful coverage lookups" computed from the old pair
was over-counting and changes when this deploys. `details` is stripped before the model, so nothing
about routing behaviour changes.

**Decided since the fourth revision** (details in each section): C2 writes `outcome: null` +
`metadata.status="abandoned"` and never `error`; C3's field goes at the prompt's top level; M1
splits its filter semantics by capability, with `mcp_server` in the same-call group; K1 must not
unbind MCPs before the resolver exists.

**Decided in the sixth** — all six from review, three of them correcting me: C2's write must ship
**with** an analysis-layer reclassification, because `outcome: null` escapes the failure set only by
landing in the empty and running sets; C1's `task_status` is **submitted by `report_findings`, never
inferred from artifact presence**, `request_input` maps to `blocked` while keeping
`next_action: ask_user`, no protocol tool means `unknown` only, and a `schema_version` carries the
rollout; P1's tool-description wording had two inaccuracies of its own; Proposal 3's prompt text was
missing the `input_required` carve-out that the prose around it already had; C3's router
reconstruction is **confirmed**, not an unevidenced rumour.

**Decided in the seventh** — two implementation-level blockers cleared, both from review. **C2's
release order is fixed and cannot be inverted**: the analysis-layer classifier ships and deploys
first, siclaw's writer second, because rows written in the gap are misclassified permanently. And the
pollution is worse than the sixth revision recorded — an abandoned row *with* partial text counts as
**`success`**, so the terminated class must be exclusive of `success` too, not only of `failed` /
`empty` / `running`. **C1 now carries a normative cross-version mapping table** (`schema_version`'s
value and position, all six turn shapes against the three fields, what legacy `status` carries in
each, and how old vs new readers branch) — implement from the table; "the three fields replace
`status`" is explicitly wrong and would break the rollout. Also: portal-web is **required** for C2,
not optional.

**The prompt-constant question is resolved and was never blocking.** ⟨other-repo⟩ Agent creation
happens in the management plane, which seeds a coordinator's `system_prompt` non-empty, and
siclaw's `effectiveAgentPrompt` falls back to its own constant *only* when the stored value is
empty. So **siclaw's `COORDINATOR_DEFAULT_PROMPT` is dead code for deployed coordinators** and the
creation-path constant is the management plane's. siclaw's Portal is not deployed in production, so
there is no Standalone path to preserve either. Earlier revisions guessed the opposite; see P1.

**Nothing in this document is blocked on data**, and the prompt dependency is now discharged: the
wording is approved and landed in this branch's code commits, so the management plane's constant can be
aligned to the text in the companion document as it stands. What remains outstanding is all
cross-repo: C2's classifier (which must deploy *before* siclaw's writer), C1's adoption of the
mapping table, M1 entirely, and P1's creation-wiring test.

---

## C2 — A tool row is finalized only when the turn was aborted  ⟨P0⟩

### What is wrong

`sse-consumer.ts` writes a `tool_execution_start` row and completes it on `tool_execution_end`
(`:624`). If the end never arrives, the row stays `outcome=null` / `metadata.status="running"`
forever. The consumer already has a finalizer for exactly this — its comment says so — but three
things limit it:

1. **It runs only on the abort path.** The loop breaks on `signal.aborted` (L205) and the
   finalization block is the "Abort finalization" stage. EOF, disconnect, exception, and a
   normally-ending parent turn all skip it.
2. **It sits *after* `} finally { await flushTerminalError(); }`** (`:1038`), i.e. outside the
   try/finally, so a thrown error propagates past it.
3. **`shiftPending` (`:314-320`) removes the pending entry before any DB write.** It is called at
   the top of the `tool_execution_end` branch, so if the update then fails, the entry is gone and
   no finalizer can recover it.

**An existing test pins the current behaviour deliberately** — `sse-consumer.test.ts:1000`,
named `"does NOT finalize tool rows on a normal (non-abort) stream end"`, asserting
`expect(updateCalls.find(u => u.metadata?.status === "stopped")).toBeUndefined()`. So this is
**inverting a deliberate decision, not filling a gap**; read that test's intent before flipping
it. Earlier drafts said "no test covers this path", which was wrong.

### Evidence

⟨t1⟩ 51 of 838 delegation traces contain such a row; ⟨t2⟩ those hold **58** rows, and lineage +
time-window matching shows **58/58 had a peer executing** (49 new child sessions, 9 reused), **46
sit last in the coordinator trace**, and the peer continued a **median ≈255 s** afterwards. So
the work happened and the record was abandoned — "the peer never started" is ruled out.

⟨t1⟩ Cleanest case `0481f7c76af49d2fdd249566c4b8bce6` — 3 messages, 14 s: user asks, coordinator
answers *"我会沿用刚才同一专家会话…"*, delegation row empty, trace ends.

### This is primarily a record-integrity defect

The UI already degrades these rows on a timer: `isStaleRunningTool`
(`portal-web/src/hooks/usePilotChat.ts:321-333`) renders an outcome-less running tool as `error`
after a per-class window — **15 minutes for async delegated tools**, shorter otherwise. So
"spinner forever" is largely mitigated; what is not mitigated is the window before it trips and,
more importantly, the DB row, which stays `running` permanently and corrupts audit, metrics and
any trace analysis — including the analysis in this document.

### Terminal states — DECIDED

| exit | write |
|---|---|
| user Stop | `outcome: null` + `metadata.status="stopped"` (unchanged) |
| EOF / disconnect / exception / parent turn ended | **`outcome: null` + `metadata.status="abandoned"`** |

Plus, on the abandoned path: keep the original metadata, write duration and reason, and persist
any partial assistant text not yet stored.

**`outcome` must stay `null`. Do not write `error`.** Two reasons, and the second is the
decisive one:

1. ⟨t2⟩ 58/58 of these had a peer executing, continuing a median ≈255 s afterwards — so the call
   most likely *succeeded* and only the record was lost. `error` is a false statement about the
   peer's work.
2. The analysis layer's failure set includes `error`, which drives `ErrorCount`, `tool_outcome=failed` and the
   **nightly analyzer**. That analyzer's output is the review backlog this document prioritizes
   from. Writing `error` would inject ~58 false failures a month into the instrument we use to
   decide what to fix next.

**`null` is outside the failure set**, so nothing has to be excluded from failure or nightly-analyzer
counts. It also avoids widening `outcome`'s typed union
(`"success" | "error" | "blocked" | null`), which crosses the wire and the DB.

⚠️ **But `null` is not free — it lands in a different set, and this must be fixed with the same
change.** ⟨other-repo⟩ The analysis layer currently classifies an outcome-less row as **all four**
of: `tool_outcome=empty`, `missing_outcome`, `missing_result`, and `RunningToolCalls`. So writing
`outcome: null` keeps the failure statistics clean and **pollutes the empty-result and completeness
statistics instead** — including the very `tool_outcome=empty` filter that surfaced these 51 traces
in the first place, which would then be unable to distinguish "the tool returned nothing" from "the
record was abandoned".

An earlier revision of this section claimed "no exclusion logic is needed anywhere". That was too
broad: it is true of the failure set only.

**Required alongside**: treat `stopped | abandoned | aborted | killed` as a single class —
*terminated without a result* — excluded from both the empty and the running sets, and carrying its
own flag so it stays countable.

⚠️⚠️ **And it is worse than false-empty, because this write carries partial text.** The terminal-state
table above says the abandoned path persists "any partial assistant text not yet stored" — and
⟨other-repo⟩ the outcome classifier keys on **whether the row has content**:

| the abandoned row | how the analysis layer counts it today |
|---|---|
| no text captured | `empty` — plus `missing_outcome`, `missing_result`, `RunningToolCalls` |
| **partial text captured** | **`success`** — plus, still, `missing_outcome` / `missing_result` / `RunningToolCalls` |

So the same defect lands in **two different buckets depending on how far the peer got before the
record was lost**, and the second is the damaging one: a lost record counted as a *success* inflates
the success rate and erases the abandonment entirely, where `empty` at least looks anomalous. It also
means partial-text capture — which is unambiguously the right thing for the audit record — actively
makes the statistics worse until the classifier is fixed.

Two revisions of this section understated this: the fifth said nothing needed excluding anywhere, the
sixth corrected that to false-empty and still had only half the story. **The class must therefore be
exclusive of `success` as well as of `failed`, `empty` and `running`** — a terminated-without-result
row is none of the four, whatever text it happens to carry.

### Release order — the classifier ships FIRST

**⟨other-repo⟩ classification change → deploy → then siclaw's writer.** Not the reverse, and not
simultaneously. The writer creates rows in the new shape; if it lands first, every abandoned row is
misclassified (as `success` or `empty`) for the whole gap, and those rows are permanent — they are
the audit record, so nothing recounts them later. The classifier landing first is harmless by
construction: it changes how a status is read, and until the writer ships, only `stopped` occurs,
which it already handles.

This is the one ordering constraint in this document that cannot be inverted, so it belongs in the
rollout plan and not only here.

It mirrors the abort path exactly, which is verified in code (not only in its comment) to write
`outcome: null` + `metadata.status: "stopped"`.

**Both frontends should take the label. Neither heuristic gets this right today.**

One line each: add `abandoned` to the terminal-status list (siclaw:
`usePilotChat.ts:354`, currently `stopped | aborted | killed`). Without it the row falls through
to the stale-timer heuristic, and the two frontends are wrong in opposite directions:

| | window for `delegate_to_agent` | behaviour without the label |
|---|---|---|
| siclaw portal-web | **4 min** (`DELEGATED_TOOL_STALE_MS`, `usePilotChat.ts:135,144`) | flips to `error` at 4 min — but ⟨t2⟩ the peer's median completion is **≈255 s ≈ 4.25 min**, so it mislabels a *working* delegation as failed more often than not |
| ⟨other-repo⟩ management plane | **30 min** — it has a `spawn_subagent` bucket at 60 min but **no `delegate_to_agent` bucket**, so peer delegation lands in the branch literally named `NON_DELEGATION` | 30 minutes of false `running`, then `error` for something that did not fail — twice as long as siclaw, and mis-classified by construction |

So this is **not** "only if you want a distinct display": both frontends currently produce a wrong
answer, one too early and one too late. That the two existing heuristics disagree by 7.5× is
itself the argument that a timer is not the fix — the row has to be finalized.

⟨other-repo⟩ The missing `delegate_to_agent` window is a separate pre-existing defect on that
side, tracked separately.

**Do not finalize as `stopped`.** ⟨t2⟩ The peer usually runs on for minutes — a row reading
"stopped" while work continues is a second wrong answer.

⚠️ **Implementation constraint** (`sse-consumer.ts`, in the abort finalizer's own comment):
`updateMessage` **REPLACES columns — it is not a partial patch**, so every column must be
re-sent. A finalizer that sends only `outcome` and `metadata` will blank the rest of the row.

**Files** `src/gateway/sse-consumer.ts` (primary), `src/gateway/delegate-api.ts`,
`src/agentbox/session.ts`, `src/gateway/internal-api.ts`, **`portal-web/src/hooks/usePilotChat.ts`
(required, not optional — see "Both frontends should take the label" above; leaving it out is what
makes the row fall through to the stale timer, which is the visible half of the defect)**.
**Tests** `sse-consumer.test.ts` (invert `:1000`, add EOF / disconnect / exception / failed-update
cases) + the portal-web suite.

---

## C1 — The delegation result contract, and one budget  ⟨P0⟩

### Established

**(a) The fallback path caps at 12,000, keeps the tail, reports nothing.**
`delegate-api.ts:816-819`. ⟨t1⟩ `d40c1b617a9278bd8cdc564413f67412` — 52 min, 3 tool calls: a
34-minute delegation returned 12,127 chars beginning `…` then a partial table row; the
coordinator reported *"逐节点表头、汇总值和前半段被截断"* and spent **16 further minutes (31%)**
re-delegating for five gaps.

**(b) The artifact path has no cap.** `src/tools/workflow/report-findings.ts` — zero
`MAX_`/`slice`/`truncate`. So pushing peers toward artifacts relocates the overflow instead of
bounding it, which is why (b) and (d) cannot be fixed separately.

**(c) `status: "done"` means the peer's turn ended, not that the task finished.** ⟨t1⟩
`bac9eb6a…`: three `delegate_to_agent` calls for one question (12.6 s returning a *plan* with
`outcome=success`, then 3.5 min, then 7.7 min), the coordinator writing *"我继续等待其完成"*.
⟨t3⟩ Independently reproduced: a task marked `completed` whose entire output was *"我会读取
skill，然后执行三次查询"*, with the real queries running only after a follow-up in the same
context.

*The earlier claim that `finalText` means different things on the live and durable paths was
wrong — see Corrections. Both accumulate the turn's assistant messages.*

### Blocking decisions

**"No artifact" cannot mean "not complete".** Delegations always run `readOnly: false`
(`delegate-api.ts:637, 710`); the persona mandating `report_findings` is injected **only** for
read-only delegations (`session.ts:2761`); and the whitelist has no platform exemption
(`tool-registry.ts:576`, verbatim `// 3. allowedTools whitelist (sole availability axis; no
exemptions)`).

1. **Three independent fields**, e.g. `turn_status: completed | failed | interrupted`,
   `task_status: complete | partial | blocked | unknown`, `payload_kind: artifact | narrative |
   none`. Transport state, task state and payload format are orthogonal; collapsing any two
   reproduces the current ambiguity.
2. **`report_findings` and `request_input` are protocol tools** and must be present in every
   delegated turn, independent of whether the specialist's capability selection includes
   `session_output`. Otherwise `task_status` describes the peer's configuration, not its work.

   **And `task_status` is *submitted*, never inferred.** `report_findings` takes it as an explicit
   argument; deriving it from "is there an artifact" would rebuild the presence-inference this whole
   item exists to remove — one level up, and harder to see. An artifact proves the peer *reported*,
   not that it *finished*: a peer that reports what it found before being cut off is `partial`, and
   only the peer knows that.

   The three mappings, so no reader has to guess:

   | the peer called | `task_status` | also |
   |---|---|---|
   | `report_findings` | whatever it submitted (`complete`/`partial`/`blocked`) — never inferred | `payload_kind: artifact` |
   | `request_input` | **`blocked`** | keep the actionable part: `input_required` + `next_action: ask_user` + the question. `blocked` must not flatten *what* is needed away |
   | neither | **`unknown`** — and only `unknown` | never `complete`. A turn that ended without the protocol tool is exactly the case with no evidence either way |
3. **A base completion persona for every delegated turn**, not only read-only ones.
4. **One budget covering every result-bearing field** — artifact, `finalText`, `steps`,
   `full_summary`, `inputQuestion`, and the artifact event itself. Enforce at the producing end
   *and* defensively at the gateway. When an artifact is present, do not also carry the full
   narrative. Deterministic (no model call in transport), **head + tail**, reporting
   `original_chars` / `omitted_chars` / `truncation_mode` / the session id holding the full text.
5. **Status fields alone do not reduce round-trips.** If that is a goal it needs bounded
   auto-continue or an end-of-turn constraint — decide, or declare it out of scope.
6. **Rolling upgrade: keep the old `status` and add `schema_version`.** "Additive on the wire" is
   not sufficient on its own — during a rollout every one of the four combinations is live (new
   Runtime → old UI, old Runtime → new UI, and both matched pairs), and a reader cannot tell "this
   producer does not emit `task_status`" from "this producer emits it and the task state is
   genuinely unknown" unless something says which contract the message was written to. So: the
   existing `status` field stays populated and meaningful for the whole transition, the new fields
   are added beside it, and `schema_version` is what a reader branches on rather than
   field-presence. **⚠️ "The three fields replace `status`" is the wrong reading and would break the
   rollout** — during the transition `status` is the only field an old reader has. Absent
   `schema_version` ⇒ old producer ⇒ trust `status` and treat `task_status`
   as unavailable, **not** as `unknown`.

### The cross-version mapping table — normative, this is the copy source

Everything below is one contract. It is stated here in full because the two sides implementing it
cannot both be right by coincidence, and because "three fields replace `status`" was a live reading
of the earlier text.

**`schema_version`: an integer, at the delegation result's top level, beside `status` — not nested
under `delegation` and not inside `metadata`.** Top level for the same reason C3's field is (⟨other-repo⟩
the router reconstructs `prompt.delegation`, so a nested field is dropped); beside `status` because a
reader has to see both to branch. Current contract = **absent**. This contract = **`1`**. A reader
compares numerically and treats anything `> 1` as "newer than me, read the fields I know" — never as
an error, or a future field addition takes the current readers down.

**The three fields, and what `status` carries alongside each:**

| the peer's turn | `turn_status` | `task_status` | `payload_kind` | legacy `status` | notes |
|---|---|---|---|---|---|
| called `report_findings`, work finished | `completed` | `complete` | `artifact` | `done` | the only combination that means "done" |
| called `report_findings`, work unfinished (peer says so) | `completed` | **`partial`** | `artifact` | `done` | ⚠️ legacy `status` cannot express this — an old reader sees `done`. Accepted, and it is the reason `partial` exists |
| called `request_input` | `completed` | **`blocked`** | `none` | `input_required` | plus `next_action: ask_user` + the question. The turn *ended normally*, so `turn_status` is `completed` — blocking is a task state, not a transport state |
| ended with narration, no protocol tool | `completed` | **`unknown`** | `narrative` | `done` | the plan-only case. Old readers cannot tell it from success — which is C1's whole point |
| peer errored | `failed` | `unknown` | `none` \| `narrative` | `failed` | `task_status` is *not* `partial`: nobody reported on the work, so its state is unknown |
| parent aborted / peer interrupted | **`interrupted`** | `unknown` \| `partial` | `narrative` \| `none` | `failed` | `partial` only if the peer had already reported. Pairs with C2's `abandoned` on the tool row |

Three rules the table encodes, stated so they are not re-derived differently:

1. **`turn_status` describes the transport, `task_status` the work.** `completed` + `unknown` is a
   normal, common combination (the plan-only case) and must not be collapsed to either "success" or
   "failure".
2. **`task_status` is never inferred** — `report_findings` submits it. Everything else in the table
   is `unknown`, `blocked`, or (for an interruption after a report) `partial`.
3. **Legacy `status` is lossy on purpose.** Two rows above map to `done` while meaning different
   things. That is the loss the new fields exist to remove, and it is *why* the old field must keep
   its old meaning rather than being repurposed: an old reader must keep reading it correctly-by-its-
   own-definition, not correctly-by-the-new-one.

**How each reader behaves:**

| reader | `schema_version` absent | `schema_version` ≥ 1 |
|---|---|---|
| old UI / old analysis layer | reads `status`, as today | still reads `status`, as today — it does not know the new fields exist. This row is why `status` stays populated |
| new UI / new analysis layer | reads `status`, treats the three fields as **unavailable** — *not* as `unknown`. "The producer is old" and "the task state is unknown" are different facts and must not share a value | reads the three fields; `status` ignored |

The asymmetry in the bottom-left cell is the whole reason `schema_version` exists rather than
field-presence: without it, an old producer's silence is indistinguishable from a new producer
honestly reporting `unknown`, and a dashboard counting "unknown task states" would show the rollout
rather than the defect.

**Retirement.** `status` and `schema_version` are both transitional. `status` may be dropped only
once no old reader remains, and dropping it is itself a version bump; until then a writer that omits
it is a bug, not an optimization.

**Files** `delegate-api.ts`, `agent-delegate.ts`, `delegate-to-agent.ts`, `report-findings.ts`,
`session.ts`.

---

## P1 — The platform prompt licenses "plan as done"  ⟨P0, ⚠️ approval required⟩

Editing `COORDINATOR_DEFAULT_PROMPT` is not sufficient, and the reason is in the platform prompt
itself. `src/core/prompt.ts:171-172`, verbatim:

> **Before your first tool call, say what you're about to check** …
> **A turn can be just a short update; it doesn't have to end in a tool call or a conclusion.**

That is a platform rule, so it applies to a coordinator whose agent prompt has been customized,
and it **licenses exactly the behaviour C1(c) documents**. The "plan as done" pattern is
therefore partly a platform-prompt consequence, not solely coordinator behaviour — and C1 and P1
cannot be fixed independently.

### Scope: coordinator-only, so the platform prompt is out

The platform prompt is shared by every agent type — `prompt.ts` has no per-type branch — so an
edit there **cannot be scoped to coordinators** and would change SRE and knowledge-QA behaviour
too. That is out of scope for a coordinator fix, and it is declined here.

By contrast the coordinator's own prompt is cleanly separable: `agent-types.ts` holds one constant
per type (`SRE_DEFAULT_PROMPT` `:39` → `sre` `:139`; `COORDINATOR_DEFAULT_PROMPT` `:44` →
`coordinator` `:146`; `KNOWLEDGE_QA_DEFAULT_PROMPT` `:110`; `custom` → `null`). Editing the
coordinator constant touches coordinators and nothing else.

**What this costs, stated honestly.** The platform prompt licenses a plan-only turn for every agent
type, and that licence stays. What the two remaining items do is make the *coordinator* immune to
it rather than removing it: C1's `task_status` lets the coordinator tell a plan from a result, and
the rule below tells it what to do. The residual — a worker agent burning a turn on an
announcement, which is where ⟨t3⟩'s reproduction actually came from — is untouched. That is a
platform-level question with its own evidence and its own blast radius, and it does not belong
inside a coordinator fix.

Two items, in this order of reliability:

1. **The tool description** (`delegate-to-agent.ts:58`) must state that the call is
   **synchronous**: when it returns, the peer's turn for this call has ended. A description reaches
   the model regardless of prompt customization, which no prompt edit can guarantee. `delegate_to_agent`
   is exposed only to agents holding `delegate_agents`, so this too is coordinator-only.
2. **`COORDINATOR_DEFAULT_PROMPT`**: at most one follow-up on the same `session_id` when the result
   is plainly only a plan — **scoped to the same user request, and excluding the normal
   `input_required` flow** — then deliver a partial answer rather than re-delegating indefinitely.

### Rollout — resolved: siclaw's constant is not the lever

Earlier revisions treated "which constant a new coordinator receives" as an open question and
built a decision table around it. It is answered, and the answer inverts what those revisions
guessed.

⟨other-repo⟩ Agent creation happens in the management plane: its `CreateAgent` seeds
`system_prompt` from its own `defaultCoordinatorPrompt`, so a coordinator's stored prompt is
**always non-empty**. The runtime then reads that value back over `config.getAgent`. And siclaw's
`effectiveAgentPrompt` (`agent-types.ts:189-193`) returns its built-in default **only** when the
stored value is empty or whitespace. Therefore:

- **siclaw's `COORDINATOR_DEFAULT_PROMPT` never fires for a deployed coordinator.** Editing it
  changes nothing.
- **The creation-path constant is the management plane's**, and that is where the wording work
  lands.
- siclaw's Portal creation path (`agent-api.ts:143-147`, which does materialize siclaw's constant
  into the row) is **not deployed in production**, so there is no Standalone case to preserve.

⟨t3⟩ Consistent with observation: in a test namespace the coordinator row is non-empty while
`custom` agents are NULL, matching a seeding function that returns empty for `custom` only.

*(Narrow residual: a row that is non-null but whitespace-only would still hit siclaw's fallback.
Not produced by the creation path; possible only for historically edited rows.)*

**P1's remaining step is unaffected by any of this** — the tool description
(`delegate-to-agent.ts:58`) ships in the siclaw image and reaches production regardless of which
prompt constant a coordinator holds. (The platform-prompt edit that used to be listed here is
declined; see "Scope" below.) That was the
stated reason for ordering the tool description first, and it holds: it is the only channel that
survives prompt customization. Only step 3, editing siclaw's default constant, turns out to be a
no-op.

### Migrating existing rows — the pre-query is planning value, not a prerequisite

A migration has to classify **row by row** regardless, because production is almost certainly
mixed: some rows equal to an old default, some hand-edited or historical. Since per-row
classification is required anyway, knowing the distribution beforehand is not a precondition — it
only tells you the workload and whether to staff a human-review step.

So the shape is an **adaptive migration with a dry-run that classifies as it goes**, and the
dry-run *is* the query. Run it against the test namespace first — ⟨t3⟩ it happens to contain a row
of the awkward third kind, which exercises the "skip and list" branch — then re-point the
connection string.

The dry-run must classify into **three** buckets, not two, because the disposition differs:

| bucket | test | disposition |
|---|---|---|
| matches a current default | hash of `TRIM(system_prompt)` | migrate automatically |
| **missing a function** | no `(A) ANSWER` / `(B) ROUTE` triage structure | **almost certainly migrate** — the agent has been running a persona that cannot answer knowledge questions at all |
| ordinary wording customization | triage structure present, text differs | **may deserve keeping** — a human decides |

⟨t3⟩ This distinction is not hypothetical: the observed row is 4,129 chars, opens *"whose ONLY job
is ROUTING"*, and has no triage structure, while **both** current constants are 6,215 chars and
carry the ANSWER half. That is not a wording difference — it is **half the function missing**. A
coordinator on that text has never been able to answer a knowledge question itself; every such
request was routed. Collapsing it into a generic "differs from default" bucket would hand a
reviewer the same label for two rows that need opposite decisions.

Aligning the two constants is still worth doing as hygiene — otherwise an independently deployed
siclaw would give its coordinators a different persona — but with Portal undeployed it is not a
correctness requirement.

### The question that row raises: has the deployed contract drifted from the repo's?

siclaw's `COORDINATOR_DEFAULT_PROMPT`, measured from this checkout:

| | |
|---|---|
| length | **6,215** chars |
| sha256 | `7c3e62c0c6b5a4e51c7ee467b8b131be5b4162bb231eac3695bb604e2335f38d` |
| md5 | `eb35f27244cd173dd938f0c6ece71b01` |
| contains `(A) ANSWER` | **yes** |
| contains "ONLY job is ROUTING" | **no** |

The observed row is **4,129** chars and opens *"whose ONLY job is ROUTING"* — roughly 2,100
characters shorter, and the missing part looks like the **ANSWER half**. The repo default
explicitly tells the coordinator to answer knowledge questions itself and *"do NOT delegate a
question just to have a specialist restate the answer"*; a routing-only prompt removes that.

If a routing-only prompt is what production runs, then **the A/B triage contract described in
`coordinator-routing.md` is not the deployed contract**, and some share of the delegation volume
(⟨t1⟩ 838 traces in 30 days) is a configuration artifact rather than inherent. This document has
been treating that volume as given.

**Not asserted** — one row, a test namespace, possibly hand-made. And note what it is *not*:
⟨other-repo⟩ the management plane's `defaultCoordinatorPrompt` is byte-identical to siclaw's, so
this routing-only text is **not** either current default. It came from a hand edit or an older
version — which makes it an instance of drift, not evidence that the default is routing-only.

The consequence for the migration stands either way: the per-row classification must record
**whether the row still carries the triage contract**, not only whether its text matches a
constant. A migration that rewrites text alone would leave a diverged behaviour contract in place,
and if routing-only rows are common in production then some share of the delegation volume
(⟨t1⟩ 838 traces in 30 days) is a configuration artifact — which this document has been treating
as inherent.

```sql
SELECT id, name,
       system_prompt IS NULL                                          AS is_null,
       CHAR_LENGTH(system_prompt)                                     AS chars,
       MD5(TRIM(system_prompt))                                       AS md5_trimmed,
       MD5(TRIM(system_prompt)) = 'eb35f27244cd173dd938f0c6ece71b01'  AS is_siclaw_default,
       system_prompt LIKE '%(A) ANSWER%'                              AS has_answer_mode,
       system_prompt LIKE '%ONLY job is ROUTING%'                     AS is_routing_only,
       LEFT(system_prompt, 80)                                        AS opening
FROM agents
WHERE agent_type = 'coordinator'
ORDER BY chars;
```

Compare against `MD5(TRIM(...))` because `effectiveAgentPrompt` trims before use — a row differing
only in surrounding whitespace behaves identically but would fail a raw hash comparison. Confirm
the stored spelling of `agent_type` first. The management plane's own constant needs the same two
hashes computed for comparison; ⟨other-repo⟩ reports the two constants are byte-identical, in
which case this one hash covers both.

Until then the rollout step cannot be written down: it is possible to change siclaw's constant,
migrate the rows that match the old default, and still leave both hand-customized rows and every
newly created coordinator on stale text.

⚠️ Both `src/core/prompt.ts` and `src/core/agent-types.ts` **require human approval** before
editing (CLAUDE.md). Describe the intended wording and wait.

---

## C3 — Trace propagation  ⟨P1⟩

**Reframe: this is trace *splitting*, not unobservability.** The peer is reachable —
The session-detail tool returns delegation children, then the session→turns tool finds their
traces. The defects are that the parent trace does not contain the peer (⟨t1⟩ every coordinator
trace sampled shows `sessionCount: 1`, including the 52-minute and 2h13m ones) and that some peer
messages carry no `trace_id`. **C1 and C2 do not depend on this** — both were diagnosed without
it; an earlier draft claimed otherwise.

**Propagating `traceId` alone will not achieve DB grouping.**
`agent-trace-recorder.ts:531-546` discards the passed id on two paths — when
`!isTracingEnabled()` and when there is no attachment — replacing it with
`randomBytes(16).toString("hex")` in both. So in a deployment with tracing off, the peer still
gets a random id. Fix that first or the rest is wasted.

For a real call tree, additionally:
- thread the `delegate_to_agent` **`toolCallId`** into the executor and capture the corresponding
  tool span — `DelegateToAgentExecutor` (`tool-registry.ts:371`) has no such field today;
- cross-process, pass an explicit **serializable span-context DTO**, not an OTel object.

**Chain** `session.ts` (read the coordinator's current-turn id — sub-agents already do),
`agent-delegate.ts`, `delegate-api.ts`, `gateway/agentbox/client.ts`, `agentbox/http-server.ts`,
`gateway/server.ts` (cross-Runtime forwarding + persistence), plus
`shared/tracing/agent-trace-recorder.ts`.

**Field placement — DECIDED: top level, not nested under `delegation`.** Reasoning, not evidence:
a passthrough router is more likely to preserve a known top-level scalar than to deep-merge an
object it does not recognise, and if it *does* reconstruct the prompt, a missing top-level scalar
fails the contract test cleanly, whereas a nested object can survive partially and be harder to
diagnose. Add the cross-repo contract test; it settles the question without needing to read the
other side's code.

✅ **Now confirmed, and it validates the placement.** ⟨other-repo⟩ The management plane's delegation
router **does** reconstruct `prompt.delegation`. An earlier revision of this section recorded the
claim as circulating-but-unevidenced, because a first search found no reconstruction point; that
search was wrong and the claim was right.

So a field nested under `delegation` would be dropped, and the top-level placement decided above is
not merely the safer guess — it is the only one that survives. The contract test is still required,
now to pin the behaviour rather than to discover it.

**Tests** tracing on and off × local and remote × traceId-only (no parent span).

---

## K1 — Identity resolver, and the coordinator's MCP bindings  ⟨P1⟩

### The static map has drifted — measured

⟨t3⟩ 14–16K characters, 13 primary entries, **no per-entry `source` or `verified_at`**. It prescribes an
opaque `cluster_id` for the catalog service; live read-only checks: **one cluster alias resolves,
a second does not, and the prescribed `cluster_id` fails.** A hand-maintained contract that
contradicts production is worse than none.

*Correction to the earlier draft: "every routing decision reads the full map" was inaccurate.
The skill reads the reference file only for aliases, spelling variants and similar cases; a
canonical binding skips it. Any cost claim needs a sample size.*

### Shape

- The **skill holds process only**; the mapping comes from a narrow interface — e.g. a
  `resolve_cluster_identity` tool/MCP returning one structured result per input:
  `match_field`, `canonical_key`, `binding_name`, `surface_identifier`, `confidence`,
  `last_verified_at`.
- **The resolver proves identity mapping only. Coverage must still be proven by
  `list_delegates`.** Keeping these separate is the point of P1's third constraint.
- State data-source precedence, update time, and conflict/staleness policy.
- Represent **catalog-only clusters**, so "present in the management catalog, no Kubernetes
  binding" is not read as "does not exist".
- Drift-check against the live roster, the management catalog and the MCP source catalog.

### The coordinator's MCP bindings are existing config to clean

`agent-factory.ts:506-510`, verbatim: *"MCP tools are **EXEMPT** from the per-agent `allowedTools`
capability whitelist. MCP availability is governed by an orthogonal axis — the
`agent_mcp_servers` binding"*. So capability groups do not gate MCPs, and ⟨t3⟩ the live
coordinator is bound to a resource-catalog MCP, a ticketing MCP and a chat MCP. This needs a
**configuration cleanup
plus an acceptance check**, not only a design principle. The coordinator should hold at most a
narrow identity/coverage resolver.

⚠️ **Ordering constraint: do not unbind before the resolver exists.** Unbinding the catalog MCP
while the resolver is still being built leaves the coordinator with neither — strictly worse than today,
since it currently reaches identity information through those MCPs. Either land the resolver
first, or ship the unbind and the resolver in the same batch.

Also reconcile: the current prompt says to ask the user when the cluster is missing, while the
resource-locator skill requires a global locate first.

**The console-resolver skill needs no change** — ⟨t1⟩ it correctly flagged an internal console
host as unregistered and preserved the `region` / `cluster` pair it had parsed.

**Knowledge base**: ⟨t3⟩ no copies of these identity mappings were found, so no KB change is
needed. Add a constraint that dynamic identity mappings must not be copied into the KB.

---

## C5 / C4b — `list_delegates`  ⟨P2⟩

**Do `resource_type` and C4b first; defer batch.**

⟨t2⟩ **Correction:** the 16 `list_delegates` calls were one parallel batch within ≈137 ms, not 16
sequential waits. The latency argument is withdrawn; the real benefits are fewer tool calls,
smaller context and less noise. ⟨t1⟩ Irrelevant host totals appear verbatim —
`hosts: no match (2991 total)` on a cluster-name query.

**Batch has an unsolved retry problem, and delegating misses to the scalar path does not avoid
it.** `list-delegates.ts:81` holds **one** `pendingRetryToken` per routing attempt, so several
aliases cannot each spend their one retry — whether the misses come from a batch or from
individual follow-up calls. So either give every input its own retry token, or defer batch
entirely. Before any schema: maximum batch size, de-duplication, ordering, and the shape when one
target is covered by several agents.

**C4b** — `list-delegates.ts:208-212` emits `match_basis: q ? "exact_resource_binding" : "browse"`
whenever a query was passed, **including when `total === 0`**, beside `binding_name_confirmed`,
which is the caller's own input echoed back. A zero-match call reporting `exact_resource_binding`
is wrong on its own terms. **It cannot affect the model**: CLAUDE.md states verbatim that *"the
class must be in the TEXT (`details` is stripped before the model sees a result)"*. Telemetry/UI
only. A general wording improvement to the model-visible `content` — state the narrow fact "this
string exactly matched a roster binding" — is worth making as clarity, with no known defect
behind it.

---

## M1 — Analysis-tooling filter semantics  ⟨P2, different repo⟩

The trace-listing tool's `tool=X` + `tool_outcome=Y` pair is documented as constraining to the
same call. It
selects traces that used `X` **and** contain some call with outcome `Y`. ⟨t2⟩ The 46 traces
returned for `tool=list_delegates, tool_outcome=empty` contain **182** `list_delegates` calls,
all successful, **zero** empty — the empty ones were `delegate_to_agent`. This produced the first
draft's wrong statistic.

### Fix shape — DECIDED, and the criterion corrected

An earlier version of this decision grouped by *"can the predicate land on the same message"* and
put `mcp_server` at trace level on that basis. **Both the criterion and that placement were
wrong.** ⟨other-repo⟩ Reading the filter predicates shows all five test columns of a single
message (`tool_name` / `tool_input`), so same-message alignment is achievable for every dimension.
And `mcp_server`'s predicate is `tool_name LIKE 'mcp__<server>__%'` — that *is* the tool call,
differing from `mcp_tool` only in prefix versus exact match. Leaving it at trace level would
reproduce the exact bug M1 exists to fix, one dimension over: "did calls to this MCP server fail"
would still be answered across messages.

The right criterion is **whether the predicate identifies the call itself**:

| dimension | predicate | grouping |
|---|---|---|
| `tool`, `mcp_tool` | `tool_name = ?` | **same-call** |
| `mcp_server` | `tool_name LIKE 'mcp__<server>__%'` | **same-call** |
| `skill` | `tool_name='read' AND tool_input LIKE '%SKILL.md%'`, or a script run | trace-level |
| `knowledge` | `tool_name='read' AND tool_input LIKE '%knowledge/…%'` | trace-level |

`skill` and `knowledge` stay trace-level for a different reason than previously stated: not
because same-call is impossible, but because it would be **meaningless** — the merged question
becomes "did the read of that SKILL.md fail", which is not what anyone asks, and page reads
almost never fail, so the answer would be near-permanently empty.

**How this error surfaced, and what it implies for the other decisions.** It was found by writing
the implementation, not by reading the design — the predicate's *shape* is not visible from a
design document. Every decision in this document marked DECIDED rests on code I could read; where
the relevant implementation lives in the other repository I could not, and this item is the proof
that such a decision can be confidently wrong. Treat the same-call/trace-level split for any
dimension whose predicate you have not personally read as provisional.

This item is independent of every other item here and can start immediately.

---

## Concurrency

| Stream | Items | Notes |
|---|---|---|
| **1** | C2 → C1 | Shares `delegate-api.ts` / `session.ts`; sequential. C2 first: smaller, root cause known, and it stops losing records while C1 is designed. |
| **2** | C5 → C4b | `list-delegates.ts` only — the one fully independent stream. |
| **3** | K1 | Skill/registry/config; no overlap. |
| **4** | C3 | Touches `delegate-api.ts`, `session.ts` — queues behind stream 1. |
| — | P1 | Needs approval; rollout is operational. Couple with C1. |

Three streams can run concurrently (1, 2, 3).

## Rules

- **Reverse-verify every new test**: revert the fix, confirm it goes red.
- `npm test` + `npx tsc --noEmit`; **plus `cd portal-web && npm ci && npx vitest run` — C2 changes
  portal-web, so this is required, not conditional.** The root suite does not include portal-web and
  a fresh worktree has no `node_modules` there, which is exactly how a portal-web break shipped
  before.
- C1, P1 and the C4b wording change are **model-visible** — say so in the PR.
- `src/tools/**` → agentbox image; `src/gateway/**`, `src/shared/**`, `src/core/**` → runtime.
  C1, C2, C3 span both.
- **Three items are cross-repo and cannot be closed from this side alone**, so none of them is done
  when siclaw's PR merges: **C2** (the analysis layer must reclassify `stopped | abandoned | aborted
  | killed` out of the empty and running sets, or the write makes those statistics wrong), **P1**
  (the management plane copies Proposal 3's text *and* owns the creation-wiring test siclaw cannot
  write), and **M1**, which lives there entirely. C1 additionally needs `schema_version` honoured on
  both sides during the rollout. Track each as paired work, not as a siclaw PR with a note attached.
- ⟨t3⟩ 6 test files / 164 cases currently pass and none covers a parent stream ending while a
  peer keeps running.

---

## Corrections

**1. `details` is not model-visible.** The first draft blamed the coordinator's canonical claim on
contradictory `details` fields. CLAUDE.md says `details` is stripped, in a row I have edited.

**2. "No artifact = not complete" would have regressed.** Peers run non-read-only, never receive
the persona mandating `report_findings`, and may lack the tool.

**3. The false-canonical case is withdrawn.** The second draft moved the blame to
`list_delegates`' text on the premise that *"everything it could have based that on is this
content"*. False: the coordinator had read the alias map two messages earlier, and searching the
trace confirms that map contains both the queried alias and a `binding_names` list. ⟨t2⟩ It
carries a `canonical_key` of the form `<region>/<cluster>` alongside `binding_names=[<alias>]`.

**4. `finalText` does not mean two different things.** The third draft claimed the durable-readback
path returns a single assistant message. It does not: `delegate-api.ts:235-243` filters the turn's
assistant messages and `join("\n\n")`s them — the same accumulated shape as the live path. I read
the variable name at the `return` and not the eight lines building it. What survives is far
smaller: the type comment says "the peer's **final** assistant narrative" while both paths produce
the whole turn's narrative, and the live path additionally ingests `e.text` / `e.content` events
(`:555`, `:557`) that the durable path cannot see — a source-consistency question, not a semantic
split.

**5. Scope and statistics.** C3's chain went three files → six → seven (the recorder).
C2's file list omitted `sse-consumer.ts`, where the defect lives, and claimed no test covered the
path when an existing test pins it deliberately. "portal-web is not involved" was wrong. "16
sequential calls" were parallel within ≈137 ms. "Every routing decision reads the full map" was
inaccurate. "46 empty `list_delegates` results" came from M1's filter semantics.

**6. `outcome: null` is outside the failure set — and inside two others.** The fifth draft argued
that because `null` is not in the failure union, "no exclude-abandoned logic is needed anywhere —
there is nothing to exclude". True of failures, and I stopped there. ⟨other-repo⟩ An outcome-less row
is simultaneously `tool_outcome=empty`, `missing_outcome`, `missing_result` and `RunningToolCalls`,
so the write trades a false-failure problem for a false-empty one — in the very filter that surfaced
these traces. The decision does not change; its cost and its cross-repo requirement do.

**7. The router reconstruction was real and I recorded it as a rumour.** The fourth draft framed the
`prompt.delegation` reconstruction claim as circulating-but-unevidenced, on the strength of a search
that found no reconstruction point. The search was wrong; ⟨other-repo⟩ confirms it. This one is the
inverse of errors 1–3 — not an unverified assertion but an unverified *negative*, "I looked and it
is not there", which carries the same weight and needs the same discipline. It happened to validate
the top-level placement, so the conclusion held by luck rather than by reasoning.

**8. The abandoned-row pollution was worse than error 6's own correction.** Error 6 fixed "nothing to
exclude" to "it lands in the empty set" — and stopped again, one bucket short. ⟨other-repo⟩ the
classifier keys on **content**, so an abandoned row *with* partial text counts as **`success`**. The
same section mandates persisting partial text, so the defect's two halves land in opposite buckets,
and the damaging one is invisible: an abandoned turn counted as a success inflates the success rate,
where `empty` at least looks anomalous. Two consecutive revisions of one paragraph, each correcting
the previous scope error and introducing a narrower one. The failure is answering "is it excluded
from *the* set" when the actual question is **which sets exist** — I never enumerated the
classifier's outputs, I checked the one I had just been told about.

**10. And a third, caught while implementing: "a summary of that turn's narration".** No
summarization step exists on the path — `delegate-to-agent.ts` passes `resp.finalText` verbatim when
there is no artifact. Worse than imprecise: the clipping is tail-kept, so what is missing is the
BEGINNING, and a summary is never missing its beginning. The word would have removed exactly the
suspicion the sentence exists to create. Same family as errors 4 and 9 — three occurrences now, of
one habit: describing a value by what it is called at the point of use rather than by what built it.

**9. Two inaccuracies in P1's own proposed wording**, both making the description more absolute than
the system: "everything you get from that turn" contradicts C1's budget (introduced by this very
document, four items up), and "closing narration" contradicts the join-the-whole-turn code — which
is **error 4, restated after I had corrected it**. Recorded separately because a re-introduced error
is worse than a new one: the first time is a gap in reading, the second is a gap in propagating a
correction into everything downstream of it.

**The pattern.** Errors 1–3 were unverified **exhaustiveness** claims — "the model reads this",
"everything it could have based that on is this", "the files are these three" — each a premise
about what *else* exists, asserted without looking. Error 7 is the same shape with the sign flipped:
an unverified **negative**. Errors 4, 9 and 10 are one error three times: reading a variable name instead of
the code that builds it, then restating it after fixing it. Errors 6 and 8 are also one error twice,
and they are the sharpest entry here: a claim scoped correctly ("not in the failure set"),
generalized past its scope ("nothing to exclude anywhere"), corrected to a *second* too-narrow scope
("it lands in the empty set"), and corrected again. Both times I answered the question I had been
handed instead of enumerating the space it came from.

Five rules, then. Before writing "X is the only source of Y", grep for other sources. Before quoting
what a value *is*, read its construction, not its name at the point of use. A negative finding needs
the same evidence as a positive one — "I searched and it is absent" is a claim about the search.
When a correction lands, grep the document for every other place the old reading was written down:
errors 4, 9 and 10 are the same sentence, and it survived because I fixed the section it was diagnosed in
and not the file that quotes it. And when a classification is at stake, **enumerate the classes
first** — errors 6 and 8 were both me checking membership of the one class I had just been told
about, when what the decision needed was the full set of outputs.
