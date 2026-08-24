# Sub-agent Model Tiering

> Status: design (no implementation yet)
> Baseline: `main` @ `30e2b4f9`
> Complements `coordinator-routing.md` (delegation vs sub-agent boundary) and
> `2026-06-22-unified-model-routing-entry.md` (the candidate machinery reused here).
>
> Implementation order: settle §4 (state scoping), §5 (revision), §6 (wire contract
> and normalizer), and §7 (failure semantics) **before** writing Runtime code. Those
> four decide the shape of everything else.

---

## 1. Problem

A sub-agent **hard-inherits** its parent's model. `session.ts:2199-2206` takes the
parent turn's `{provider, modelId}` — carried in via `setDelegationModel` — and
sets it on the child session. There is no override layer of any kind.

`SubagentType.model` (`subagent-registry.ts:12`) declares
`"sonnet" | "opus" | "haiku" | "inherit"`, but the whole repository contains only
the two lines that declare it. It is a dead field that was never wired, and those
aliases never made sense here anyway: models are administered by a control plane,
and several providers coexist.

The goal is to let a lead agent send cheap work to a cheap model when it fans out.
**The speedup comes from the parallel map children** — they already run
concurrently, so making each one faster makes the whole fan-out faster, while the
lead keeps a large model for orchestration. Execution-side measurement puts ~75%
of wall-clock in model round-trips, so the headroom is real. The actual gain must
still be measured, not assumed.

## 2. The two deployment shapes are not a hierarchy

This section decides most of what follows, so it comes first.

| | Standalone Portal | Upstream mode |
|---|---|---|
| **Where config lives** | `agents.subagent_models` (new column, §11.1) | The management plane's **own storage** — typically a join table, not a column added to an agents row. The Standalone column is irrelevant there and stays NULL |
| **Provider granularity** | One provider holds many models; `modelConfig.models` is an array | Provider names are generated **per model row** — one name per row, so `models` holds a single descriptor |
| **Who builds the binding** | **Three** local paths, see §11.6 | The management plane's `config.getModelBinding` handler. The Portal paths **do not run at all** |
| **Does today's `model_routing` have a UI** | No — `AgentDetail.tsx:12` is a lone type declaration | **Yes, a complete one** |

Two consequences run through the whole design:

- **"Restrict tiers to one provider" would disable the feature outright under
  Upstream mode** (§3.3).
- **"No UI in v1" can only hold for Standalone** and must not be generalized (§12.4).

The Runtime-side `resolveAgentModelBinding` (`agent-model-binding.ts:44`) passes
`data.binding` through verbatim (line 50); the type assertion performs no runtime
validation. **This is why §6.3 requires a Runtime normalizer**: neither side's write
validation can be trusted as the only gate, because the Runtime consumes data it
did not validate. CLAUDE.md records the same lesson on `model-compat.ts` — a rule
fixed on the Portal side is *not* fixed on the management-plane side;
`maxTokensField` had to be fixed separately in both.

## 3. Design decisions

### 3.1 Available models are a configured **list**; the tier name is its `tier`

The number of tiers is not hardcoded; adding one is a config change. This mirrors
how `subagent_type` already works — its available values are injected into the
tool description at build time.

For contrast: Claude Code hardcodes the tier parameter to an
`["sonnet","opus","haiku"]` enum, which is why users behind a proxy gateway cannot
expose non-Anthropic models as sub-agent options. That is the shape to avoid.

### 3.2 A tier entry **extends** `ModelRouteCandidate` — but does not reuse `label`

`ModelRouteCandidate` (`model-routing.ts:24`) is already
`{provider, modelId, label?, modelConfig?}`, and `model-routing.ts:1005-1032`
performs the exact sequence a tier switch needs — per-candidate
`registerProvider` → `findModel` → `modelNeedsRebind` → `setModel`. Reuse that
machinery rather than writing a parallel path.

**But the tier selector must be its own field, not `label`.** The two have
incompatible contracts:

| | `ModelRouteCandidate.label` | The tier selector |
|---|---|---|
| Purpose | Display / telemetry | A selector the **model** writes |
| Uniqueness | None | Required |
| Character set | Unconstrained | `^[a-z][a-z0-9_-]{0,31}$` |
| Enforcement | None — `model-routing.ts:437` is its only non-test reference, a passthrough with no trim and no validation. `candidateKey` does not include it | Normalized at every boundary (§6.3) |

Overloading one field with both contracts will eventually break: a routing label is
free-form prose today, and nothing stops it from becoming so again after a tier
starts depending on its shape.

So a tier **candidate** is a `ModelRouteCandidate` plus a `tier` selector, and the
switching machinery is shared while the selector is not.

Note that "a tier entry" is a *configuration-level* concept only. On the wire it
splits into two structures with different contents and different confidentiality —
`whenToUse` belongs to the menu and never travels with credentials. §6.1 freezes
both shapes; treat that as the interface, not this paragraph.

### 3.3 Cross-provider tiers are mandatory

Under Upstream mode a provider name is generated per model row, so
**"same provider" means "the same single model"**. A same-provider restriction
would reduce the feature to nothing there.

The cost of cross-provider was also paid long ago: routing failover already calls
`registerProvider` per candidate and has run across providers in production for
some time. This is reuse of an exercised path, not new risk.

### 3.4 The list is an authorization boundary

The lead can only use models on the list. Anything else — unknown tier, missing
candidate, stale revision — resolves to the **effective parent model** (§7.1),
silently and without error. No list configured means behaviour byte-for-byte
identical to today. Prompt injection cannot reach a model that is not listed,
because "which models may be used" is an operator decision, not the model's.

### 3.5 The lead sees only `tier` and `whenToUse`

Three necessary consequences: it cannot invent a model id; the same prompt keeps
working across deployments; and provider credentials and the model inventory never
enter the prompt.

### 3.6 What "the lead picks from the list" actually means

No complexity detector exists anywhere in this design. Three steps:

1. The menu is rendered as a passage in the tool description — the lead's only
   source of this information (same assembly point as
   `Available subagent_type values:`, `spawn-subagent.ts:169`).
2. The lead puts a string in its tool call, e.g.
   `{"items": [...], "model_tier": "fast"}`.
   This is the same mechanism by which it fills `subagent_type` or
   `run_in_background`. Nothing new.
3. Code looks the tier up in the snapshot (§4), resolves a candidate, and sets the
   model. Any miss falls back per §7.

So **routing accuracy rests entirely on the `whenToUse` prose**, not on code. The
lead will sometimes choose wrong. Three mitigations: write concrete descriptions
(name the kind of work; never "simple tasks"), a weak child report exposes a bad
choice, and the env override serves as the ops lever.

The second mitigation has a prerequisite: **which tier ran, and why, must be
visible per item**, or "the report is weak", "the lead chose badly" and "the
candidate never arrived" are indistinguishable from the outside. §11.5 specifies
the fields. This is part of the design, not a follow-up.

### 3.7 Resolution order

1. `SICLAW_SUBAGENT_MODEL_TIER` — ops lever (see below)
2. `spawn_subagent`'s `model_tier` parameter — the lead's per-call choice
3. The `subagent_type` default (`defaultModelTier`, §11.5)
4. The effective parent model (§7.1) — today's behaviour, and where every fallback
   lands

`SICLAW_SUBAGENT_MODEL_TIER` accepts exactly three kinds of value:

| Value | Meaning |
|---|---|
| unset / empty | No intervention — resolution proceeds from level 2 |
| `off` | Tiering disabled: every child inherits the effective parent model. Levels 2 and 3 are ignored |
| any other string | Treated as a tier name and pins every child to it, overriding levels 2 and 3. An unknown name falls back per §7 — it is not an error and does not disable the deployment |

Two deliberate choices:

- **There is no `inherit` value.** "Inherit everything" is what `off` means, and
  giving the same behaviour two spellings is how Claude Code shipped a bug where
  `CLAUDE_CODE_SUBAGENT_MODEL=inherit` silently suppressed the per-call parameter;
  they later had to redefine `inherit` as equivalent to unset. One spelling, one
  meaning.
- **The reduce child is unaffected.** Reduce is always on the effective parent
  model (§3.8), so pinning a tier cannot move it. `off` is a no-op for reduce.

### 3.8 Reduce does not downgrade

Map children use the resolved tier; the reduce child is **forced onto the effective
parent model**. Synthesis is the step a downgrade hurts most, and reduce runs once
so there is nothing to save. Not exposed as a parameter. The reduce child goes
through the same `SpawnSubagentRequest` (`session.ts:954`), so this is a decision
inside the executor.

## 4. State scoping and lifetime

The menu and the candidates have **different scopes, different lifetimes, and
different confidentiality**. Conflating them is the single easiest way to get this
feature wrong — either the lead never sees the menu, or credentials leak across
sessions, or a batch silently spans two configurations.

| State | Scope | Contains credentials | Set by |
|---|---|---|---|
| **Latest menu** | **Box-level**, mutable | No | tools sync channel (§6.1) |
| **Session menu snapshot** + its revision | **Session-level**, immutable after creation | No | Captured from the latest menu when the session is built |
| **Candidates** | **Session/turn-level** | **Yes (apiKey)** | Prompt binding, per turn |
| **Spawn snapshot** | Per `spawn_subagent` call, immutable | Yes | Captured once at dispatch |

Four rules follow, and each one closes a specific failure:

**1. Candidates must never be stored at box level.** A box holds many sessions for
many turns; box-level candidates would both share credentials across sessions and
let one session's turn resolve against another's binding. `setDelegationModel`
(`session.ts:384-386`) *is* box-level today, which is exactly the pattern **not**
to copy for candidates.

Because they carry credentials, their lifetime is specified rather than left to
whatever the storage location implies:

- **Installed** onto the current turn before the prompt begins.
- **Cleared on every terminal path** — normal finish, setup failure, and abort
  alike. "Cleared when the turn ends" must hold for every way a turn can end, not
  just the successful one.
- **Overwritten unconditionally by a new turn**, *including* being overwritten with
  nothing. A turn whose binding carries no candidates must leave none behind (§5).
- **A background spawn's snapshot lives until that job reaches a terminal state**,
  then is dropped. This is the one lifetime that legitimately outlives its parent
  turn, and it is bounded by the job rather than by the session.
- **Never persisted and never echoed**: candidates and their `modelConfig` do not
  go into session JSON, logs, or `item_results`. `effective_provider` /
  `effective_model_id` (§11.5) are identifiers, not credentials — that is the whole
  of what may be reported.

**2. The menu that built the tool schema is the menu that must be honoured.** The
tool schema is fixed when the session is created — `http-server.ts:829` creates the
session, `:936` only then calls `setDelegationModel`, and `sync-handlers.ts:704-710`
states it outright: *"the tool-set is baked into each session at creation time, so a
live session must be rebuilt to pick up a new whitelist"*. So the session records
the menu snapshot it advertised, plus its revision, and resolution is validated
against that snapshot — not against whatever the box's latest menu has become.

**3. `spawn_subagent` captures one immutable snapshot at dispatch** — the session
menu snapshot, the current turn's candidates, and the **effective parent candidate**
(§7.1). Everything derived from that call uses it: the single-task collapse path,
every map child, every later wave of the worker pool, the background continuation
after the parent session is released, and the reduce child.

This matters because a batch does not start all its children at once — the worker
pool submits them in waves, *"Child sessions are created LAZILY inside each worker
— never all N at once"* (`session.ts:755`) — while `runSpawnedSubagent` currently
reads mutable state as each child starts (`session.ts:2200-2205`). Without the
snapshot a 50-item batch straddles a configuration change: the first wave runs one
model, the rest another, and the reduce child merges the results into one report
where the difference is invisible. That hole exists today but is nearly
unobservable; tiering widens the trigger surface, so the snapshot closes it.

**4. A menu reload mid-batch does not touch the running batch.** The batch keeps
its snapshot; the next dispatch picks up the change. This has to be *stated* because
`invalidateSessions` defers its release until *"any in-flight prompt completes"* and
a background group is **not** an in-flight prompt — it is detached, so that
guarantee does not cover it. The failure drills in §13 verify the behaviour rather
than assuming it.

## 5. The revision protocol

The menu and the candidates arrive over two independent channels, so they can
disagree. Without a way to detect that, the disagreement presents as "tiering
silently does nothing" — which is indistinguishable from correct behaviour on an
unconfigured deployment.

**Both payloads carry a `revision`.** It is the SHA-256 of the tier configuration
in a canonical, order-normalized form, computed by whoever owns the configuration,
so the same configuration always yields the same value on both channels regardless
of serialization order.

At dispatch, compare the **session menu snapshot's revision** against the
**current turn's candidate revision**:

| Condition | Outcome | Recorded reason |
|---|---|---|
| Revisions match, candidate present | Use the tier | — |
| Revisions match, candidate absent for that tier | Fall back | `candidate_missing` |
| Revisions differ | Fall back | `revision_mismatch` |
| One side has a revision, the other has none | Fall back | `revision_mismatch` |
| Neither side has tier state | No tiering (not an error) | — |

Both mismatch cases fall back to the effective parent (§7.1) rather than guessing.
A revision skew means the menu the lead chose from is not the menu the candidates
describe, and honouring the choice anyway would run a model the operator did not
intend for that tier name.

**Empty must clear, never persist.** This is stated explicitly because the failure
is silent in both directions:

- A prompt that carries **no** candidates means *this turn has no tiers*. It must
  not reuse the previous turn's candidates — that would keep a withdrawn model
  reachable, and would outlive a credential rotation.
- A tools payload clears the box-level menu by sending **`subagentTierMenu: null`**,
  not by sending a menu with an empty `items` array. An empty-but-present menu still
  carries a `revision`, which would leave a revision on the menu side with nothing
  to match on the candidate side — a permanent `revision_mismatch` that reads as
  "tiering mysteriously stopped working". `null` means *no tier state*, which is a
  different thing from *a configuration that happens to be empty*.

## 6. Wire contract

Two independent implementations consume these fields, so the names are part of the
contract, not an implementation detail.

### 6.1 Frozen payload shapes

| Carrier | Field | Shape | Contains credentials |
|---|---|---|---|
| Agent config read (`config.getAgent`) | `subagent_model_tiers` | Config form (tier + provider + modelId + whenToUse) | No |
| tools sync payload (`ToolsPayload`, `sync-handlers.ts:647`) | `subagentTierMenu` | `SubagentTierMenu` | No |
| Model binding (`config.getModelBinding` → `binding`) | `subagentTiers` | `SubagentTierCandidates` | **Yes** |
| AgentBox prompt body | `subagentTiers` | `SubagentTierCandidates` | **Yes** |

```ts
interface SubagentTierMenu {
  revision: string
  items: Array<{
    tier: string
    whenToUse: string
  }>
}

interface SubagentTierCandidates {
  revision: string
  candidates: Array<{
    tier: string
    provider: string
    modelId: string
    modelConfig: ModelConfig
  }>
}
```

Two asymmetries are deliberate and neither side may "helpfully" add the missing
field:

- **`whenToUse` exists only on the menu.** It is prose written for the model, and
  the menu is the channel that reaches a tool description. Putting it beside a
  `modelConfig` would make the credential-bearing payload carry model-visible text
  for no reason.
- **`provider` / `modelId` / `modelConfig` exist only on the candidates.** The menu
  is what the lead reads; per §3.5 it must not disclose the model inventory.

`tier` is the only field common to both, and it is the join key. **Credentials
appear only in `SubagentTierCandidates`** — anything that puts a `modelConfig` on
the menu channel is a bug, not a convenience.

### 6.2 Version skew

A deployment may run a new Runtime against an old management plane or the reverse.
Every combination must degrade to **safe fallback**, never to an error and never to
a partially-applied tier:

- Menu present, candidates absent → no tiering (`candidate_missing`)
- Candidates present, menu absent → no tiering; the lead was never offered a choice
- Either side missing `revision` → `revision_mismatch` per §5

### 6.3 Runtime normalizer

`config.getModelBinding` is consumed through a type assertion with no runtime
validation (`agent-model-binding.ts:50`), so **write-side validation on either side
is necessary but not sufficient**. The Runtime must defend against the data it
receives.

Two shared functions, applied at the Runtime boundary to whatever arrives. They do
**not** share one rule set — each validates only the fields its own payload carries
(§6.1):

| Rule | `normalizeSubagentTierMenu()` | `normalizeSubagentTierCandidates()` |
|---|---|---|
| `revision` | 64 lowercase hex characters | Same |
| `tier` pattern | `^[a-z][a-z0-9_-]{0,31}$` | Same |
| `tier` uniqueness | Required | Required |
| Max entries | 5 | 5 |
| `whenToUse` | Required; 8–256 Unicode code points after trim; control characters rejected | **Not present — must not be required** |
| `provider` / `modelId` | **Not present — must not be validated** | Both required, non-empty |
| Duplicate `(provider, modelId)` | N/A | Rejected — two names for one model make the report ambiguous |

Length is counted in **Unicode code points, not UTF-16 units**, so a `whenToUse`
written in CJK is not penalised for it. Control characters are rejected outright
rather than stripped: the value lands in a tool description, and silently editing
prose that an operator wrote is worse than telling them it was refused.

**Rejection is scoped to the channel that was malformed**, because the two have
different lifetimes:

- **Invalid menu** → clear the box-level latest menu **and trigger session
  invalidation**. A session must not keep advertising a menu that has been
  withdrawn as invalid.
- **Invalid candidates** → disable tiering for **that turn only**. The menu is
  untouched; the next turn's binding may well be fine.

**Neither case throws.** A malformed tier list is a configuration problem; letting
it propagate as an exception would take down the parent turn, which is strictly
worse than running without tiers. Same reasoning as §3.4, applied to malformed
input rather than to an unknown name.

The cap of 5 is a context-budget decision as much as a sanity one: every tier
contributes a `whenToUse` line to the tool description of every turn.

## 7. Failure semantics

"Every failure is a fallback" and "a child session has no failover" are both true
but describe different phases, and stating only one of them is what made earlier
drafts read as self-contradictory. The dividing line is **whether the child's
prompt has started**.

### 7.1 "Effective parent" is the parent's actual model, not its configured primary

Every fallback in this document lands on the **effective parent candidate**: the
model the parent turn actually ran on, successfully.

This is not the same as the configured primary. The parent session has failover
(`model-routing.ts`), so by the time it dispatches a `spawn_subagent` it may well be
running a fallback candidate — precisely because the primary was unavailable.
Falling back to the *configured* primary would send every child at a model the
parent already found broken.

**Neither existing source can supply this value at spawn time**, so the runner needs
a new hook:

- `state.activeCandidateKey` is written only **after** an attempt finishes
  successfully (`model-routing.ts:812-826`, inside the `if (!failure)` branch). A
  `spawn_subagent` call happens *during* `brain.prompt()` (`:1134`), so at that
  moment the field still holds the **previous** turn's value — or nothing at all on
  the first turn.
- `brain.getModel()` identifies the model but carries neither the credentials
  (`modelConfig`) nor the applied parameters, so it cannot be used to run a child.

Add an `onAttemptReady(candidate)` callback to the routing runner, invoked once the
attempt is fully set up and immediately before the prompt is issued:

```
1. registerProvider
2. setModel
3. apply params            (applyCandidateModelParams)
4. context preflight       (succeeds)
5. onAttemptReady(candidate)   ← writes the full candidate to current-turn state
6. brain.prompt()
```

The callback receives the **complete** candidate, `modelConfig` included, and stores
it as current-turn state. `spawn_subagent` then reads the effective parent from
there, and the spawn snapshot (§4, rule 3) captures it alongside the tier state. The
reduce child (§3.8) uses the same captured value.

Position 5 is load-bearing: after preflight, so a candidate that never got to run is
never recorded as effective; before `brain.prompt()`, so it is available to any tool
call the prompt makes.

### 7.2 Before the prompt starts: fall back

All of these resolve to the effective parent and let the child run:

- Unknown tier name (including one pinned by the env override)
- `revision_mismatch` / `candidate_missing` (§5)
- `registerProvider` / `findModel` failure — includes a model deleted after the
  tier list was written
- Parameter application failure (§11.3)
- Context-fit preflight failure (§7.4)

Each records its `fallback_reason` (§11.5). None is an error to the caller.

### 7.3 After the prompt starts: the child fails

429, timeout, 5xx and anything else the endpoint returns mid-stream **fail that
child** in v1. There is no mid-flight retry onto another tier and no child-level
failover.

This is a deliberate v1 scope line, not an oversight: child failover needs a
capture/replay path equivalent to the parent's runner, and building it here would
double the size of this work. What v1 owes instead is that the failure is *legible*
— which is what §11.5's fields and §8's endpoint limiter are for.

Consequence to state plainly: **a tier endpoint that starts returning 429 fails
every fan-out while the lead reports itself healthy.** §8 is about making that
unlikely; §13's failure drills record what it looks like.

### 7.4 v1 includes a context-fit check — and it must be a *new*, pure one

`ensureContextForModelPrompt` has exactly one call site (`model-routing.ts:1118`),
and a child session calls `child.brain.prompt()` **directly** at `session.ts:2379` —
so today a child has no preflight at all. That is harmless only because the child's
window always equals the parent's. Once a tier can move the child to a smaller
window, an over-budget prompt fails **mid-stream** instead of failing cleanly.

**The existing function cannot be reused for this.** Its name says `ensure`, not
`check`, and the implementation earns it: when the estimate exceeds budget and
compaction is enabled, `pi-agent-brain.ts:325` calls
`await this.session.compact(...)` — which mutates the session's history and issues
its own model call to produce the summary. Running that against a freshly created
child would compact the one thing the child's context consists of: the rendered task
briefing. It would also spend a model round-trip to decide whether to spend a model
round-trip.

So v1 adds a **pure** entry point — either `checkContextFitForModelPrompt(model, text)`
or an `allowCompaction: false` mode on the existing one. Requirements: estimate only,
no compaction, no model call, no session mutation.

**Falling back is an action, not a decision.** By the time the fit check fails, the
child has already been switched onto the tier model — `registerProvider`, `setModel`
and the parameter application have all run. Restoring the parent therefore means
re-running them for the parent candidate: `setModel(effectiveParent)` **and**
re-applying that model's parameters (§11.3), for exactly the reason
`model-routing.ts:1034-1038` gives — the parameters are session state that the tier
switch already moved.

**Fallback terminates.** If restoring the effective parent also fails, that child
**fails** with `parent_fallback_failed`. There is no second fallback and no attempt
at a third model: the parent candidate is the last resort by definition, and a loop
here would burn the whole fan-out retrying a broken session.

Full child-side compaction and child failover remain follow-ups (§7.3).

## 8. Concurrency: the endpoint is what needs protecting

Every limiter in the fan-out path counts *children*, not requests against a model:
`_subagentLimiter` (10 per session), `podSubagentLimiter` (50 per pod),
`podGroupLimiter`, `detachedSubagentLimiter` — all plain `ConcurrencyLimiter`
instances (`session.ts:487,500,509`). **None is scoped to a model endpoint.**

Today those ~10 concurrent children all hit the *parent's* provider — the endpoint
the main path has been exercising all along, at a concurrency it has already
survived. After tiering, the same 10 hit the cheap endpoint instead, and a cheap
endpoint usually carries a *tighter* quota. Combined with §7.3 that yields the
concrete failure named there.

**The limiter key must be `(provider, modelId)`, not the tier.** A tier is an
alias local to one agent: two agents' `fast` may point at the same endpoint, and the
same name may point at different endpoints in different agents. Only the resolved
model identifies the quota being consumed.

Staging:

- **Pilot** — no new limiter. State the constraint: a tier endpoint must tolerate
  the full session child concurrency (default 10), not an average request rate. Run
  §13's quota drill.
- **Before general rollout** — add a concurrency cap keyed by `(provider, modelId)`,
  independent of the existing per-session / per-pod counters.

Two limits of that cap must be documented rather than discovered:

- **It is per AgentBox process.** An agent running multiple boxes (`replicas`)
  multiplies the concurrency reaching one endpoint by the box count. A local limiter
  cannot see that.
- **Shared quota across boxes needs more than a local limiter** — either
  distributed limiting or quota allocation by the control plane. That is out of
  scope here, but general rollout against a shared low-quota endpoint should not
  proceed on the assumption that a local cap is sufficient.

The reason a drill is not a substitute for the cap: the only lever available today
is `SICLAW_SUBAGENT_CONCURRENCY`, and it is **global to the agent**. Lowering it to
protect a cheap endpoint also throttles children that inherited the parent model, so
the mitigation costs exactly the parallelism this feature exists to exploit.

### 8.1 General rollout is NOT designed yet

The direction above is settled; the mechanism is not. **This document supports a
bounded pilot only.** Three questions must be answered — and frozen — before general
rollout, and none of them is answered here:

1. **Where the endpoint limiter sits in the acquisition order.** The existing
   limiters are taken in a fixed **group → session → pod** order specifically to keep
   the wait-for graph acyclic (`session.ts:495-500`). A fourth limiter has to be
   placed inside that order deliberately; wrapping it is how a cycle gets introduced.
2. **Whether a child waiting on the endpoint limiter holds its session/pod slot.**
   Holding them is simpler and risks head-of-line blocking a whole session behind one
   saturated endpoint; releasing them re-opens the ordering question above and admits
   a thundering herd on release. This is a real trade-off, not an implementation
   detail.
3. **How a multi-replica agent bounds a shared endpoint.** A local limiter cannot see
   sibling boxes, so either the limiting is distributed, or the control plane
   allocates a per-instance share of the quota. Both are viable; they imply very
   different work.

Treat these as blocking items for rollout, not as future nice-to-haves. A pilot that
succeeds against a generously-provisioned endpoint proves nothing about them.

## 9. Explicitly out of scope: the delegation path

Delegation and sub-agents inherit in opposite directions:

| | Who configures the child | Tool whitelist |
|---|---|---|
| Delegation | The **peer's own** binding | The peer's own |
| Sub-agent | The **parent's** current configuration | Inherited from the parent, never wider |

"A delegated agent runs under its own configuration" is the contract in
`coordinator-routing.md`. Adding coordinator-side model selection to that path
would break it.

Note that delegation's prompt forwarding still carries **the peer's own** tier
state — that is the contract in action, not an exception to it.

## 10. Contracts

1. No tier state ⇒ behaviour byte-for-byte identical to today.
2. The lead cannot use a model outside the menu it was shown, whatever the prompt
   contains.
3. Every pre-prompt resolution failure is a fallback to the effective parent; every
   post-prompt endpoint failure fails that child (§7).
4. Credentials appear only in the `subagentTiers` carriers — never on the menu
   channel, never in a tool description, never in a prompt.
5. One `spawn_subagent` call resolves against one immutable snapshot, for every
   child and every wave (§4).
6. Malformed tier data disables tiering for that turn; it never throws into the
   parent turn (§6.3).
7. Validation rules are identical across both deployment shapes, and the Runtime
   normalizes regardless (§6.3, §12.3).

## 11. siclaw-side implementation surface

### 11.1 Configuration and validation

Add a column (**serves Standalone only**, see §2):

```
await safeAlterTable(db, "agents", "subagent_models", "TEXT DEFAULT NULL");
```

Around `migrate.ts:645`; additive migrations must run before `createIndexes()`.

New `src/core/subagent-models.ts`, modelled on `src/core/tool-capabilities.ts`:
`encodeSubagentModelsForDb` (validate + encode, throw on invalid — `agent-api.ts`
already has the try/catch → 400 pattern), plus the two normalizers from §6.3, which
are shared with the Runtime boundary rather than duplicated.

**Shape validation is not enough — verify the referenced model exists.** On write,
resolve each entry against `model_providers` / `model_entries` and reject an entry
naming a model this deployment does not have. Without it the first symptom of a typo
is every fan-out silently running on the inherited model.

Referential decay is answered without cascading:

- **Do not cascade** on delete — the deletion paths are many, and coupling them
  spreads the blast radius.
- **Runtime already degrades safely**: `findModel` misses and the child falls back
  (§7.2).
- **The fallback must be legible**: a dangling reference surfaces as a
  `fallback_reason`, so a deleted model is distinguishable from a lead that chose
  not to tier.

**Two pre-existing traps to handle in the same change:**

- `decodeAgentRow` must include the new column in its JSON-in-TEXT list, or the
  REST response echoes a raw string — the `tool_capabilities` echo bug its comment
  already records.
- **`agent-api.ts:643`, the clone path, omits `tool_capabilities`** (it carries only
  `model_routing`). That is an existing bug; fix it while adding the new column, or a
  cloned agent silently loses configuration.

### 11.2 Menu channel

- Extend `ToolsPayload` (`sync-handlers.ts:647`) with `subagentTierMenu` + revision
- Emit it from `internal-api.ts:287-297`
- Box-level state holds the **latest** menu; an empty payload **clears** it (§5)
- Session creation captures the menu snapshot + revision that built its tool schema
  (§4, rule 2)
- `postReload` uses the existing `invalidateSessions`

### 11.3 Candidate channel

- Extend `ResolvedModelBinding` (`agent-model-binding.ts:33`) with `subagentTiers`
- Store candidates at **session/turn level, never box level** (§4, rule 1)
- **Extract two helpers out of `http-server.ts` and reuse them in the child path.**
  Both are currently local functions with no export, each with a single call site:

  | Helper | Today | Why the child needs it |
  |---|---|---|
  | `withResolvedCandidateCompat` (`http-server.ts:337`) | Local; wraps the exported `withResolvedModelCompat` (`model-compat.ts:352`) per candidate | Skip it and the descriptor lacks `api`; pi's `parseModels` drops the model from the registry and it surfaces as "model not found" rather than a protocol error |
  | `applyModelParamsForCandidate` (`http-server.ts:375`) | Local; invoked only from the routing runner's callback (`:1179`) | Without it a tiered child runs with the **previous** model's parameters |

  The second is the load-bearing case, and `model-routing.ts:1034-1038` states the
  contract: it runs *after* `setModel`, **unconditionally**, and explicitly also when
  the rebind was skipped — *"the level is session state a previous candidate or turn
  may have moved, so 'no model change' does not mean 'no params change'"*.

  A child session today does a bare `setModel` (`session.ts:2204`) and applies no
  parameters at all, which is harmless only because the model never changes. Once a
  tier switches the model, reasoning level and friends are left carrying whatever the
  parent's model set — a silent wrong-parameter request, not a visible failure.

- **Redaction must be the union of parent and child.** The extras at
  `session.ts:2248` carry only the parent model's apiKey/baseUrl; once tiers cross
  providers, the child model's own credentials are absent from the redaction set and
  leak through echoed tool output.
- The resolution chain lands at `session.ts:2199`

### 11.4 Propagation: 8 forwarding sites (+ the TUI snapshot) plus an invariant

binding → prompt body is a **field-by-field copy everywhere, never a spread**.

⚠️ **Correction to earlier drafts, which said 13.** That count came from grepping
`modelRouting:` and treating every hit as a forwarding site. Three hits are not:
`chat-gateway.ts` and `channels/lark.ts` each pass those fields to
`modelOptionsSupportImageInput` (a vision-capability check that has no business
carrying tier state), and `agent-api.ts:120` is a local variable declaration.
Verified by implementation — adding the field to the check sites is a type error.

The **8** real binding → prompt sites:

| File | Sites |
|---|---|
| `chat-gateway.ts` | 3 |
| `delegate-api.ts` | 2 (remote `delegation.start` + local `client.prompt`) |
| `a2a-gateway.ts` | 1 |
| `task-coordinator.ts` | 1 (cron) |
| `channels/lark.ts` | 1 |
| `channels/dingtalk.ts` | 1 |

Plus the TUI, which is not a binding forward at all but a snapshot — see §11.6.

Missing one means tiering silently does nothing on that entry path. **An invariant
test pins both the field's presence and the site count**, following
`model-api-invariants.test.ts`, which pins its own call-site count for the same
reason. Note that the type system already catches part of this: `PromptOptions`
declares the field, so a site that forwards it is checked, while a site that
forgets it simply compiles — which is exactly why the count needs pinning.

Collapsing the 13 into a `bindingToPromptFields()` helper is the more thorough fix,
but the sites differ in detail (`delegate-api.ts:697` uses `systemPromptTemplate`
where `:630` uses `systemPrompt`; the channel sites use optional chaining). Unifying
them is a separate refactor and should not share a PR with a feature.

### 11.5 Tool surface, dead-field cleanup, and observability

- **Rename the field: `SubagentType.model` → `SubagentType.defaultModelTier`**, and
  change its type to `string`. The old name says "model id" while the value is a tier
  selector — the same conflation §3.2 rejects for `label`, and renaming is free here
  because the field has no readers. Delete `GENERAL_PURPOSE`'s `model: "inherit"`
  outright rather than porting it: absent *is* inherit (§3.7).

- **Name the parameter `model_tier`, not `model`.** Its value is a tier selector,
  and calling it `model` reintroduces exactly the model-id/tier conflation §3.2
  rejects for `label` and §11.5 rejects for `SubagentType.model`. There is no
  compatibility burden — the parameter does not exist yet.

- **Generate the parameter schema from the menu**, rather than accepting free text.
  With a non-empty menu the parameter is a union of literals built from the snapshot's
  tier names; with an empty menu **neither the parameter nor the description passage
  exists** — in a deployment without tiers the lead never sees the concept. A closed
  set means a typo is a schema violation the harness can repair, instead of a silent
  fallback discovered later in the report.

- Add an optional tier field to `SpawnSubagentRequest` and
  `SpawnSubagentGroupRequest` (`tool-registry.ts:39,141`).

- **Record the full resolution outcome in `details.item_results`**
  (`spawn-subagent.ts:353-358`, alongside `child_session_id`):

  | Field | Answers |
  |---|---|
  | `requested_tier` | What the lead asked for (absent = it did not tier) |
  | `resolved_tier` | What was actually used (absent = inherited) |
  | `selection_source` | Which resolution level won: `env` / `request` / `type_default` / `inherit` |
  | `effective_provider` / `effective_model_id` | Which model really ran |
  | `fallback_reason` | Why they differ: `revision_mismatch`, `candidate_missing`, unknown tier, model deleted, preflight, … |

  `requested` vs `resolved` plus `selection_source` separates failure modes that
  otherwise look identical from outside: the lead chose badly (§3.6), an env override
  pinned something, the tier name is wrong or its model was deleted (§11.1), or the
  candidate never arrived while the menu advertised it (§5).

  Putting `effective_provider` / `effective_model_id` here does **not** conflict with
  §3.5. That contract keeps the model inventory out of the *prompt*, and `details` is
  explicitly not model-visible — its own comment says the per-item detail exists for
  the group card and UI drill-in, not for model-visible content.

### 11.6 Standalone has three binding-production paths, not one

Naming only `chat-gateway.ts:282` understates the surface. All of these produce
tier state in Standalone and must go through **one shared resolver** rather than
three hand-rolled queries — three copies is how one of them ends up without
`revision`, or without the new column, and the failure is silent:

| Path | Carries |
|---|---|
| `chat-gateway.ts:282` — local binding resolution | Candidates |
| `adapter.ts` `config.getAgent` handler | Config form (`subagent_model_tiers`) |
| `adapter.ts` `config.getModelBinding` handler | Candidates |
| `cli-snapshot-api.ts` + `cli-snapshot-types.ts` + `cli-main.ts` | **Both** menu and candidates — see below |

**The TUI is a special case: it does not go through the AgentBox tools sync
channel.** The two-channel split in §4 assumes a tools payload exists to carry the
menu; in TUI mode there is none. So the CLI snapshot must carry **both** the menu and
the candidates, and the TUI's session construction takes its menu snapshot from there
instead of from box-level state.

This is not a second design — the snapshot plays the role the tools channel plays
elsewhere, and §5's revision rules apply unchanged. But it does mean the snapshot
payload is the one place where menu and candidates travel together, so the
confidentiality rule in §6.1 has to be enforced at the point of *use* there: the
menu half feeds the tool description, the candidate half must not.

### 11.7 Portal UI

Standalone v1 ships without one, consistent with `model_routing` being API/DB-only
configuration today. Get the runtime path working and measure the speedup first.
**This conclusion does not generalize to the management plane** — see §12.4.

## 12. Management-plane implementation surface

This is not an appendix to the siclaw work. It has its own storage, its own binding
construction, and its own UI; the feature does not exist if any one of them is
missing.

### 12.1 Storage and API

Configuration lives in the management plane's **own storage** — typically a join
table relating agents to tier entries, not a column bolted onto an agents row.
`agents.subagent_models` is a Standalone artifact and is always NULL in this shape.

- Add the storage **and migrate existing data**; changing a model definition does
  not migrate rows already stored
- The agent administration API reads and writes it as
  `subagent_model_tiers` (§6.1)

### 12.2 Both channels must be populated, with revisions

- **Candidates** — include `subagentTiers` in the `config.getModelBinding` response,
  hydrated with `modelConfig`, carrying a `revision`. Omit this and the feature does
  not exist under Upstream mode, **without any error** — it presents as "configured
  but has no effect". The existing route-candidate hydration can be reused directly;
  it already does this for failover.
- **Menu** — deliver `subagentTierMenu` plus the same `revision` through the existing
  resource-reload notification in its `["tools"]` form. Omit this and the tool
  description carries no list, so the lead never sees the feature.
- **The two revisions must be computed from the same canonical form** (§5), or every
  spawn reports `revision_mismatch` and tiering never engages.

### 12.3 Validation must match, and empty must clear

`tier` pattern and cap, uniqueness, `whenToUse` bounds — identical to §6.3.
Divergence fails **silently**: the management plane stores a configuration siclaw
considers invalid, siclaw falls back, and the operator sees "configured but does
nothing". CLAUDE.md records the same failure mode for `isOpenAccessTier` — two copies
drifting apart left one side treating a tier as usable while the other refused, and
the sender got silence.

Clearing a configuration must emit an **empty** menu and **absent** candidates, not
simply stop sending. Per §5, omission on the candidate channel means "no tiers this
turn"; on the menu channel an empty payload is what clears box-level state.

### 12.4 A UI is required here

**Do not cite the siclaw side's "no UI in v1".** That conclusion rests on Standalone
Portal's `model_routing` having no UI either, whereas the management plane's
`model_routing` **has a complete one**. The same feature having a configuration
surface on one side and not the other is a normal difference between the shapes, not
an inconsistency.

Tier configuration should be treated here the same way `model_routing` is.

## 13. Verification

1. `npx tsc --noEmit`
2. `npm test`. Historical worktree copies carry pre-existing failures (`portal-web`
   without `node_modules`, `restricted-bash` skill-whitelist cases); judge results
   with `--dir` scoped to the main checkout.
3. State scoping and snapshot (§4):
   - Two concurrent sessions in one box do not see each other's candidates
   - A batch's later waves use the dispatch snapshot after box state changes
   - The **single-task collapse path** uses the snapshot too, not live state
   - Clearing configuration does not leave a stale menu or stale candidates in use
4. Revision protocol (§5): match, `candidate_missing`, `revision_mismatch`, one-sided
   revision, and both-absent (no tiering, no error).
5. Failure semantics (§7):
   - Pre-prompt: unknown tier, deleted model, preflight miss → fall back, each with
     its `fallback_reason`
   - Post-prompt: endpoint 429/5xx → that child fails
   - **After the parent failed over, both the fallback and the reduce child use the
     parent's effective model**, not its configured primary
6. Normalizer (§6.3): bad `tier` pattern, malformed `revision`, 6th tier, duplicate
   tier, duplicate `(provider, modelId)`, `whenToUse` outside 8–256 code points,
   `whenToUse` containing control characters — none throws. An invalid **menu**
   clears box state and invalidates sessions; invalid **candidates** disable only
   that turn. The menu normalizer must **not** reject a payload for lacking
   `provider`/`modelId`, and the candidate normalizer must **not** require
   `whenToUse` (§6.1). A `null` menu clears; an empty-`items` menu with a revision is
   rejected as malformed rather than treated as a clear (§5).
7. Effective-parent capture (§7.1): `onAttemptReady` fires after preflight and before
   the prompt; a `spawn_subagent` issued during the first turn of a session sees the
   current attempt's candidate, not an empty or stale `activeCandidateKey`.
8. Fit-check purity (§7.4): the child fit check performs **no** compaction, issues
   **no** model call, and leaves the child's history unmodified. A fit-check failure
   restores the parent via `setModel` + parameter re-application; if that restore
   fails the child fails with `parent_fallback_failed` and no further fallback is
   attempted.
9. Credential lifetime (§4, rule 1): candidates are cleared on normal finish, on
   setup failure, and on abort; a new turn with no candidates leaves none behind; a
   background job's snapshot survives its parent turn but not its own terminal state;
   no `modelConfig` appears in session JSON, logs, or `item_results`.
10. Unit tests, by file:
   - `subagent-models.test.ts` — validation and normalization; a cross-provider list
     is accepted; a nonexistent provider/model is rejected on write
   - `subagent-registry.test.ts` — `defaultModelTier` resolution; dead field is gone
   - `spawn-subagent.test.ts` — with an empty menu neither the parameter nor the
     description passage appears; the parameter is a closed union built from the
     menu; `item_results` carries all resolution fields
   - `sync-handlers.test.ts` — a menu change triggers `invalidateSessions`; an empty
     payload clears box state
   - `http-server.test.ts` — tier candidates pass `withResolvedCandidateCompat`
   - `session.test.ts` — all four resolution levels; reduce stays on the effective
     parent; redaction union covers the child's credentials
   - env override — `off` inherits everywhere, an unknown name falls back without
     disabling, neither moves the reduce child
   - `migrate-sqlite.test.ts` — the column is created under both drivers
   - invariant — 13 forwarding sites plus the count pin
   - `agent-api` clone — both the new column and `tool_capabilities` are carried
11. End-to-end (real environment): a **cross-provider** two-entry list → fan out →
   verify the child's actual model, `llm.model_name` on the trace, that the child's
   credentials are redacted in logs, and **that the menu really appears in the tool
   description**. That last one is the easiest false green: if candidates work but the
   menu does not, the lead never fills the parameter, the feature is silently absent,
   and every unit test still passes.
12. **Measure the speedup** — this decides whether to widen scope. Compare wall-clock
    for an N-item batch on a fast tier versus inherited.
13. **Failure drills**:
    - **Deleted model** — remove the model a tier names. Children fall back
      pre-prompt and report `fallback_reason`; nothing fails.
    - **Live endpoint returning errors** — model exists, endpoint returns 429/5xx.
      Those children fail (§7.3) while the lead reports healthy. Record what this
      looks like from the lead's side.
    - **Quota exhaustion** — a low-quota endpoint under full session child
      concurrency (§8).
    - **Menu reload mid-batch** — the running batch keeps its snapshot, the next one
      picks up the change (§4, rule 4).

## 14. Deployment order

**The management plane goes first** (storage, candidates + revision in the binding,
menu + revision on the tools channel). To an older Runtime those are harmless extra
fields. siclaw follows. Reversed, siclaw never receives the fields and the feature is
silently missing.

The siclaw side spans two images: `session.ts`, `src/tools/`, and `sync-handlers.ts`
are in the **agentbox** image (build it, repoint `SICLAW_AGENTBOX_IMAGE`, recycle
pods); `agent-api`, `chat-gateway`, `internal-api`, and `migrate` are in the
portal/runtime image. Run the migration first.
