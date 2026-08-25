# Delegation contract v1 — request side and result side

**Status: values fixed, ready to implement. Nothing in this contract is implemented yet.** This is the contract both sides
implement together; the analysis behind it is `2026-08-24-coordinator-defects.md` (items C1 and the
request-side handoff). It supersedes that document's C1 section as the normative source — that
section stays for the evidence and the reasoning, this one is what gets built from.

**Third round: the blanks are gone.** §10b listed seven "TBD" values — budgets, their unit, the
head/tail split, the expansion cap, the router's field spelling, the UI rendering of the plan-only
case, and what a v1 producer emits when the peer called no protocol tool. None of them needed a
decision meeting; they needed someone to write a number down, and leaving them blank is how two
sides fill them differently. They are now fixed with the reasoning for each. §8 also gained the type
of `schema_version` (**integer ≥ 1**) — it previously said only "compares numerically", and a reader
built to that accepted `1.5` and `Infinity` into the new protocol.

**Revised twice before that.** Second round, three corrections — all of them
about *when* and *where*, which is where a contract between two repositories actually fails:
`access_mode` now names a merge ORDER rather than "one change" (§9.7 — receiver first, and the two
directions are not symmetric); the stale-revision measurement is qualified to the environment it
came from, with production explicitly unverified (§10.3, §11 #4); and #4 is split so only the
publish/execute half waits on an owner (§11).

First round, four things, each marked where it lands:
§7 gained the write site that decides whether `access_mode` works at all (it is in the other
repository, and this draft had missed it); §9.2 is already shipped, which also lowers the price of
the §4 coupling; §9.4 has the same prompt-delivery problem §9.3 does; and two of §10's three owed
items have since landed. §11 now carries the other side's position on every decision.

**Why one document for two repositories.** Request and result are the two ends of one pipe. Built
separately they grow two `schema_version` schemes, two "never inferred" rules and two answers to
"what happens when a field is absent", and the cross-specialist case — where a peer's structured
result becomes the next peer's sourced observation — only works if both ends agree. A one-sided
implementation of either half is worse than neither.

---

## 0. What this does and does not fix

Stated first because the framing decides whether the result is judged a success.

**This is a correctness change, not an execution-efficiency change.** From 112 production coordinator
traces / 274 delegations:

| Fixes | Mitigates | Does not touch |
|---|---|---|
| user constraints lost in relay — ⚠️ **magnitude contested, see below** | repeated canonical-identity resolution (69/112 first returns re-confirm; an independent 10-session check saw 5/10) | live-state re-verification — and it **must not**, that re-check is correct |
| multi-target ambiguity (63/112 first turns span several clusters) | | plan-only first turns (7 clear cases) — that is the **result** contract, item C1 |
| cross-specialist provenance (a candidate laundered into a fact) | | result truncation — needs the unified budget |
| mis-routing, caught before the peer starts | | `list_delegates` volume — **907 calls for 274 delegations**; a request schema cannot reduce it |

The `list_delegates` ratio is the largest measured efficiency item on the table and it is a
**separate** piece of work (batch coverage resolution, or dispatch-side routing from `targets[]`).
If only one efficiency item ships this cycle, it should be that one, not this.

### ⚠️ The constraint-loss figures are contested and must not be quoted as a baseline

The 112-trace sample put negative constraints at **~38% preserved** and time windows at **~15%
lost**. An independent 10-session check reproduced **neither**: read-only constraints 10/10 kept,
time windows 7/7 kept. Both samples used **text matching** to decide whether a constraint "survived",
and the two disagree by more than sampling noise plausibly explains.

**Neither number is a baseline. Quote them with their sample or not at all.** What both samples DO
agree on is reproduced independently and is what the contract should rest on: repeated
canonical-identity re-confirmation (69/112 and 5/10) and plan-only turns marked done (7 cases and
2/10).

**This strengthens the case for a structured `time_window` rather than weakening it.** Two
text-sampling estimates cannot settle a disagreement produced by text sampling. A structured field
is the only thing that makes the retention question answerable by counting instead of by reading —
so the field's justification is **measurability**, not a loss rate that is currently in dispute.
Written that way in §1.

The knock-on: §12's constraint-retention criterion has **no trustworthy before-value**. Either
measure one properly before shipping, or judge that criterion only on the after-value plus the
absence of the failure mode.

---

## 1. Shared protocol

```ts
interface DelegationRequestContextV1 {
  schema_version: 1;

  /**
   * Whether this is the whole context or a change to what the peer already holds. EXPLICIT, never
   * inferred from `session_id` — see rule 5. A first delegation must be "snapshot".
   * "delta" makes every field below optional; see rule 5's table for replace-vs-append.
   */
  mode: "snapshot" | "delta";

  /** How the targets were arrived at. Exactly ONE shape of `targets` is legal per scope — see §2. */
  scope: "exact" | "all_peer_bindings" | "discovery";

  targets: DelegationTarget[];

  constraints: {
    /**
     * Structured because it is the one constraint with a machine-checkable shape, which makes
     * retention answerable by COUNTING rather than by reading. That is the whole justification —
     * the loss rate itself is contested (~15% in one sample, 0/7 in another, both by text
     * matching), and two text-sampling estimates cannot settle a disagreement produced by text
     * sampling. Left as prose, this stays unvalidatable and unmeasurable.
     */
    time_window?: { from?: string; to?: string; timezone?: string };
    /**
     * The user's own words, verbatim where possible. This field exists to carry NEGATIVE
     * constraints and boundary conditions — "if you can't find it, say so, don't guess", "don't
     * restart anything" — which is where the measured loss is (~38% preserved vs 24/24 for a
     * positive "read only" request). Prose compresses toward the affirmative; that is why the
     * affirmative ones already survive and these do not.
     */
    user_requirements: string[];
  };

  observations: Array<{
    text: string;
    /**
     * Provenance is the point of this field, not decoration. A coordinator does no hands-on work,
     * so it is STRUCTURALLY incapable of establishing a live fact — everything it holds is
     * first-hand-but-not-live, second-hand, or reference material. Collapsing those into one
     * "known facts" list is what launders a candidate into a premise.
     */
    source: "user" | "peer_report" | "knowledge_base" | "coordinator_tool";
    observed_at?: string;
    /** For source="peer_report": the peer session the finding came from. */
    session_id?: string;
  }>;

  execution_policy?: {
    /**
     * ABSENT MEANS "normal". Stated explicitly because the safe-looking inference — unspecified
     * therefore read-only — would strip write tools from every existing remediation delegation.
     * Only an explicit user request flips this; a coordinator must not infer it from tone.
     */
    access_mode: "read_only" | "normal";
  };
}

type DelegationTarget =
  | { type: "cluster";      cluster_binding: string }
  | { type: "host";         host: string }
  | { type: "k8s_resource"; cluster_binding: string; kind: string; name: string; namespace?: string };
```

Carried alongside the existing fields, all of which keep their current meaning:

```ts
task: string;                                  // the high-level objective, unchanged
session_id?: string;                           // continuation, unchanged
request_context?: DelegationRequestContextV1;  // new, optional
```

### No free-text escape hatch

No `known_facts`, no `steps`, no `notes`, no `extra`. This is load-bearing rather than tidiness: the
rule "do not send the specialist your execution steps" cannot be enforced by prompt wording, but it
is enforced by there being nowhere to put them. An `observations` entry demands a `source` and is
awkward to stuff a procedure into; a `notes: string` would undo every other rule in this document.

---

## 2. `scope` × `targets` — exactly one legal shape each

The earlier draft left this open, and six states with three defined is how two implementations
diverge. **One legal combination per scope**; the other three are schema errors, not interpretations.

| scope | `targets` | |
|---|---|---|
| `exact` | **non-empty** | ✅ every target validated against the peer's bindings (§4) |
| `exact` | empty | ❌ reject — `exact` asserts the targets are known |
| `all_peer_bindings` | **empty** | ✅ expanded mechanically from the roster, subject to the cap below |
| `all_peer_bindings` | non-empty | ❌ reject — intersection or override is unknowable; pick one scope |
| `discovery` | **empty** | ✅ no coverage validation; the target genuinely is not known yet |
| `discovery` | non-empty | ❌ reject — a guess is a **candidate**, and candidates go in `observations` |

Rejections are machine-readable (`rejected_by`, plus the offending target and a hint), following the
precedent in `command-validator.ts`: a bare refusal that names neither the argument nor the
alternative gets retried in a different wrong shape.

**`all_peer_bindings` needs an expansion cap.** One word can expand to every host an agent is bound
to — a real agent covers thousands. Over the cap: reject and require explicit enumeration. Without
it, the work a delegation commissions is set by roster size and is invisible at the call site.

---

## 3. Rules

1. **`targets` is confirmed routing identity. `observations` is leads.** A candidate cluster, an
   alias that has not resolved, a name the coordinator half-recognises — all `observations`. This
   is why `ip` is **not** a target field: an IP cannot be checked against a binding, so it could
   never satisfy what `targets` claims about itself.
2. **Canonical binding names only.** No aliases in `cluster_binding`.
3. **An observation is never a premise.** Live state is re-verified by the specialist before it is
   relied on, `observed_at` or not. Passing an observation does not license skipping a check.
4. **`constraints` carries the user's constraints, never the coordinator's plan.**
5. **Continuation is a DELTA — carried by an EXPLICIT `mode`, not inferred from `session_id`.**
   The peer already holds the context on a continuation, so re-sending everything pollutes a context
   that is already correct. (60 continuations observed; 32 did not even restate the cluster and
   worked.)

   ⚠️ **The earlier "`session_id` present ⇒ delta" rule contradicted the schema and had no legal
   encoding for the commonest case.** Adding one constraint to an ongoing investigation: omitting
   `targets` violates a required field; `scope=exact, targets=[]` is rejected by §2; re-sending the
   old targets violates this rule. All three paths refused, so an implementer would have had to
   invent a fourth. This is the same defect I flagged in the draft that preceded this document — an
   underspecified state space that each side resolves differently — reintroduced one rule further
   down.

   The union, explicit:

   | `mode` | shape |
   |---|---|
   | `"snapshot"` | `scope`, `targets`, `constraints`, `observations` all **required**. §2's table applies |
   | `"delta"` | `constraints` and `observations` optional; **`scope` and `targets` are ATOMIC — both present or both absent**. Present `targets` / `constraints` **REPLACE**; present `observations` **APPEND**; absent means unchanged |

   Replace-not-merge for `targets` and `constraints` is deliberate: a merge needs per-element
   identity that neither has, and "remove a constraint" would be inexpressible. Append for
   `observations` because they are an accumulating record and removal is meaningless.

   ⚠️ **`scope` + `targets` are atomic because nothing can validate them apart.** An earlier
   revision let each be omitted independently and still demanded §2's legality check on "the new
   combination" — a check no one can perform. Sending `{scope: "discovery"}` alone against a prior
   `exact + [cluster-a]` has no defined answer: keep the old targets (a `discovery` request carrying
   targets, which §2 rejects) or clear them (a silent deletion the caller never asked for). And the
   gateway holds **no persisted effective context** to merge against — it validates one request and
   forgets it, by design, since the peer's session is the only thing with continuity.

   So the pair travels together or not at all. A delta changing only a constraint omits both and
   the peer's existing targets stand; a delta touching either one restates both, and §2's table
   applies to what was sent, with no prior state involved. The alternative — persisting effective
   context at the gateway and defining recovery, merge and revalidation — buys nothing here and adds
   a second source of truth about what the peer believes.

   A first delegation must be `snapshot`. A continuation may be either — `snapshot` is always legal
   and is the safe choice when the coordinator is unsure what the peer still holds.
6. **Absent `request_context` ⇒ today's behaviour**, unchanged, forever. That is what makes the whole
   change additive and what makes §4's new rejection incapable of breaking an existing caller.

---

## 4. Gateway validation (`scope=exact`)

Runs **before the peer starts**, in the gateway, on both the local and cross-Runtime paths.

- every `cluster_binding` / `host` must be covered by the target peer;
- **all-or-nothing**: one uncovered target rejects the whole delegation, naming which;
- exact match only — no alias, no substring. (Coverage is an authorization-shaped question and a
  short alias once substring-matched the wrong delegate.)

**This is routing correctness, not an access boundary.** The peer's own capabilities remain the
final say on what it can reach; this only stops a delegation being handed to an agent that does not
cover the target. Do not describe it as a security control.

⚠️ **Coupling worth naming**: all-or-nothing rejection makes batch coverage resolution a
**prerequisite**, not an optimization — otherwise a coordinator with 9 targets discovers coverage
gaps by collecting rejections one at a time.

**What that prerequisite costs is now known, and it is small.** The roster already in `ToolRefs`
carries each member's clusters and hosts (§9.2) — so validating nine targets is a loop over data the
box is already holding, not nine round trips, and not a new query interface on the other side. The
coupling stands; the price attached to it does not.

⚠️ **The batch tool is siclaw's, the data is the management plane's.** `list_delegates` matches
in-box against a roster already in `ToolRefs`; what the other side owns is the canonical binding and
coverage data — and it already sends it. And batching has an **unsolved problem already**: the tool
holds ONE single-use retry token per routing attempt, so several aliases cannot each spend their one
retry — whether the misses arrive as a batch or as separate calls. Give every input its own token,
or defer batching. **That token is the only real blocker left on this item**; the data side is not
one.

---

## 5. Budget — and why it is asymmetric with the result side

Both sides are bounded. They fail differently, on purpose:

| | over budget | why |
|---|---|---|
| **result** (C1) | truncate + report `original_bytes` / `omitted_bytes` (§8a) | the work already happened; re-running it is expensive and may not reproduce |
| **request** | **reject** + name what exceeded | nothing has run yet, so the caller can simply send less — a silent truncation would instead drop a user constraint on the way in |

The cap belongs in this contract, not in the renderer. A render-time cap is invisible to the sender,
unversioned, and lets the two sides disagree about what was actually delivered.

---

## 6. Rendering into the peer's turn

Deterministic, by siclaw — never by having the coordinator assemble prose. Structure that arrives as
a paragraph has bought nothing but validation.

```
[DELEGATED OBJECTIVE]
…the task text…

[AUTHORITATIVE TARGETS]
…

[USER CONSTRAINTS]
…

[UNVERIFIED OBSERVATIONS]
- <text>
  source: peer_report (session <id>)
  observed_at: <timestamp | "unknown">
```

- observations are never labelled as facts, and a dynamic observation with no `observed_at` says
  **unknown** rather than omitting the line;
- the original structure is persisted in message metadata as well — rendered text alone cannot
  answer "was a target dropped in transit".

⚠️ **One contract, two repositories.** These block names are rendered by siclaw and explained by the
specialist prompt, which lives on the other side. Change one without the other and the block becomes
noise — **with no failing test anywhere**. Pin the vocabulary in both suites, or version it here.

---

## 7. `access_mode` — a real permission, not a hint

The enforcement already exists and has simply never been switched on:

- `tool-registry.ts:563-573` filters the toolset to `readOnlyDelegable` when `delegation.readOnly`
  is true, dropping every exec/script/mutation tool;
- `agent-factory.ts:532-533` gates MCPs separately, since the registry filter does not reach them;
- `delegate-api.ts` hardcodes `readOnly: false` — **on the local path only** (see below).

So `access_mode: "read_only"` maps to `delegation.readOnly = true`. Requirements:

- `report_findings` and `request_input` are protocol tools and remain available in read-only mode —
  otherwise a read-only turn cannot report and lands as `unknown` under C1;
- read-only MCP / cluster tools stay available;
- **default `normal`** (§1).

⚠️ **Two of those are not free today, and both were stated as requirements without checking they
were reachable.** Verified in this checkout after review:

**(a) Read-only REPLACES the specialist's prompt, it does not add to it.** `session.ts` sets
`systemPromptAppend` to `DELEGATED_READONLY_PERSONA` *instead of* the agent's effective prompt when
`delegation.readOnly` is true, with a comment giving the reason: composing them would instruct the
model to use tools the read-only gate just removed.

The consequence runs backwards through this contract. §9.4 asks the other side to teach the
specialist prompt what `targets` / `constraints` / `observations` mean — and **implementing
`access_mode` would switch that prompt off on exactly the turns that opt in.** A user asking for a
read-only investigation would get a peer that no longer understands the blocks §6 renders for it.

So the protocol knowledge cannot live in the agent's own prompt. **It belongs in a protocol persona
that siclaw injects on every delegated turn**, with read-only remaining a *permission* layered on
top rather than a replacement identity. The existing persona's reason for replacing stays valid —
it is about the agent's *identity* prompt, not about protocol vocabulary, and the two should not
have been the same string.

**(b) The whitelist has no exemption, by design.** `tool-registry.ts` filters the resolved toolset
by `allowedTools` under a verbatim comment: *"allowedTools whitelist (sole availability axis; no
exemptions)"*. So an agent whose capability selection omits the session-output group loses
`report_findings` and `request_input` — and under C1 every one of its delegated turns then reports
`task_status: unknown`, structurally, forever.

That makes "protocol tools are always present" a **change to a deliberate invariant**, not a
detail of this contract. It needs to be argued and approved as such. (There is precedent for a
carve-out at a different layer — MCPs bypass this filter — so the invariant is already narrower
than its comment claims, but that is an argument for stating the new exemption explicitly, not for
slipping it in.)

**Neither (a) nor (b) is optional.** Without (a) the receiving end stops understanding the contract
on read-only turns; without (b) the result contract degrades to `unknown` for a whole class of
agents. Both are siclaw work and both must land with `access_mode`.

### The fourth write site is in the other repository, and it decides whether any of this holds

⚠️ **A cross-Runtime delegation never passes through `delegate-api.ts`.** It goes through the
management plane's router, which **reconstructs** `prompt.delegation` from trusted state (§9.1) and
writes `readOnly: false` unconditionally, independent of anything the caller sent.

That is not a forwarding omission to be patched — it is the reconstruction working as designed.
The rule on that side is that nothing inside the opaque prompt may determine routing identity, and
`readOnly` lives in the object that rule exists to protect. Consequence: siclaw implementing the
mapping correctly, **alone**, does not produce a read-only peer. The same
`access_mode: "read_only"` request yields a read-only local peer and a fully-armed remote one.

**That failure shape is worse than an unimplemented field.** A permission that holds or not
depending on where the peer happened to be scheduled cannot be reasoned about by anyone, and it
reads as enforced from the call site. An unimplemented field at least fails uniformly.

So the fix is **not** "pass `readOnly` through" — that would invert the rule that makes the
reconstruction trustworthy in the first place. It is to let the router **derive** it: `access_mode`
travels as a request parameter beside `delegationId`, outside the opaque prompt, and the router
validates it and writes the result into the delegation it rebuilds.

**Sequencing.** Two repositories, and the merge order is **not symmetric — the router side goes
first**. See §9.7 for the two directions and why one of them is harmless and the other is the exact
failure this section exists to prevent.
**If the mapping is not implemented in the same change — on *both* paths — the field must be named
`requested_access_mode`.** A field that reads as an enforcement and is a hint is worse than no field,
and worst precisely where it matters. Shipping only the siclaw half does not earn the real name.

⚠️ It also changes the shape of the reconstructed `delegation` object, which the other side's
contract test currently pins at exactly four fields. That test is updated in the same change.

---

## 8. Result side (C1) — normative mapping table

Unchanged from `2026-08-24-coordinator-defects.md`; restated here so one document is the copy source.

`schema_version`: integer, **top level, beside `status`** — not nested under `delegation`, which the
router reconstructs. Current contract = absent. This contract = `1`.

**A reader accepts it only when it is an INTEGER ≥ 1**, and treats anything else — a non-number, a
fraction, `NaN`, `Infinity`, `0`, a negative — exactly as absent, i.e. falls back to `status`. Then,
among accepted values, `> 1` means "newer than me, read the fields I know" and is **never** an
error.

⚠️ An earlier revision said only "compares numerically" and never named the type. That is not a
detail: a reader implemented against it accepts `1.5` and `Infinity` into the new protocol, which is
how a malformed or hostile value gets read as a valid contract. The under-specification produced
exactly that in one implementation, so the type is now part of the rule rather than left to the
obvious reading.

| the peer's turn | `turn_status` | `task_status` | `payload_kind` | legacy `status` |
|---|---|---|---|---|
| `report_findings`, finished | `completed` | `complete` | `artifact` | `done` |
| `report_findings`, unfinished (peer says so) | `completed` | `partial` | `artifact` | `done` |
| `request_input` | `completed` | `blocked` | `none` | `input_required` |
| ended on narration, no protocol tool | `completed` | `unknown` | `narrative` | `done` |
| peer errored | `failed` | `unknown` | `none` \| `narrative` | `failed` |
| aborted / interrupted | `interrupted` | `unknown` \| `partial` | `narrative` \| `none` | `failed` |

- `task_status` is **submitted by `report_findings`**, never inferred from artifact presence — an
  artifact proves the peer *reported*, not that it *finished*.
- `request_input` carries `next_action: ask_user` (new in v1) beside the existing `inputQuestion`;
  `blocked` must not flatten away
  *what* is needed.
- **Legacy `status` stays populated** for the whole transition. "The three fields replace `status`"
  is wrong and breaks the rollout: during it, `status` is the only field an old reader has. Two rows
  above deliberately map to `done` while meaning different things — that loss is what the new fields
  remove, and why the old field must keep its own meaning rather than being repurposed.

| reader | `schema_version` absent | `≥ 1` |
|---|---|---|
| old | reads `status` | reads `status` |
| new | reads `status`; treats the three fields as **unavailable — not `unknown`** | reads the three fields |

That bottom-left cell is the whole reason `schema_version` exists rather than field-presence:
otherwise an old producer's silence is indistinguishable from a new producer honestly reporting
`unknown`, and a dashboard counting unknowns would be showing the rollout instead of the defect.

---

## 8a. `DelegationResultV1` — the wire shape, and the truncation algorithm

§8 fixed the status fields and §10b fixed the budget number. Neither said **where the fields sit** or
**which one gets cut first**, and two implementations of "32 KiB across all result-bearing fields"
produce two different wires. This section is the missing half.

```ts
interface DelegationResultV1 {
  schema_version: 1;              // top level, beside `status` (§8)
  status: "done" | "failed" | "input_required";   // legacy, still populated
  ok: boolean;                    // legacy
  turn_status: "completed" | "failed" | "interrupted";
  task_status: "complete" | "partial" | "blocked" | "unknown";
  payload_kind: "artifact" | "narrative" | "none";
  next_action?: "ask_user";       // NEW in v1; derived from task_status === "blocked"
  peerAgentId: string;
  peerName?: string;
  peerSessionId?: string;
  artifact?: { findings: string; actions_taken: string; residual_state: string } | null;
  finalText?: string;
  inputQuestion?: string;
  steps: string[];
  /** Present ONLY when something was cut. Top level, never inside a payload field. */
  truncation?: {
    original_bytes: number;
    omitted_bytes: number;
    /** Which fields were cut, in the order the algorithm reached them. */
    fields: string[];
  };
}
```

**`truncation` is top level, not per field.** A per-field marker would have to live inside the field
it describes, which means editing the very text whose integrity is in question — and a reader
counting bytes could not tell a real `omitted_bytes` from one the peer wrote. One object, outside the
payload, is checkable.

### The algorithm — deterministic, and it does not cut mid-character

Budget: **32 KiB, UTF-8 bytes of the serialized result-bearing fields** (`artifact` members,
`finalText`, `inputQuestion`, `steps`). Identity and status fields are never counted and never cut;
they are bounded by construction and a truncated `task_status` would be worse than no result at all.

Applied in this order, stopping as soon as the total fits:

| # | field | how |
|---|---|---|
| 1 | `steps` | **drop entries from the START**, keeping the most recent. They are progress labels; the last ones describe where the peer ended up |
| 2 | `finalText` | head+tail clip, **25% head / 75% tail** (§10b) |
| 3 | `artifact.residual_state` | tail-clip |
| 4 | `artifact.actions_taken` | tail-clip |
| 5 | `artifact.findings` | tail-clip — **LAST, and it is never emptied**: a floor of 4 KiB survives whatever else has to go |

The order is the reverse of how much the coordinator needs the field. `steps` are the cheapest to
lose (they are a progress card, and the peer's own session keeps them); `findings` is the answer, so
it is cut last and never to nothing. **`inputQuestion` is never truncated** — a half-question cannot
be relayed to a user, and it is bounded by being a question.

Two mechanical rules, so "32 KiB" cannot be implemented two ways:

- **Never split a UTF-8 sequence.** A byte-count cut lands mid-character roughly a third of the time
  in CJK text. Walk back to the nearest character boundary; the result is then ≤ the budget, never
  over it.
- **Truncate the STRING VALUES, never the serialized JSON.** Cutting the JSON produces a document
  that does not parse, which is exactly the failure mode this contract exists to remove. The budget
  is computed over the serialized form; the cut is applied to the values and the document is
  re-serialized.

Clip marker: an omission is marked in-band with `…` at the cut point (both ends for a head+tail
clip), so a reader that never looks at `truncation` still sees that text is missing.

### Worked example, so both sides can check themselves against it

A result with `steps` 40 KiB, `finalText` 10 KiB, `artifact.findings` 3 KiB, other artifact members
1 KiB each: total 55 KiB, over by 23 KiB. Step 1 drops the oldest `steps` entries until the total is
32 KiB — reached before `finalText` is touched, so `truncation` is
`{original_bytes: 56320, omitted_bytes: 23552, fields: ["steps"]}` and every other field is verbatim.


## 9. Work split

### siclaw

1. `delegate_to_agent`: optional `request_context` param; `task` and `session_id` unchanged.
2. `DelegateRequest`: `requestContext` — **identical shape on the local and cross-Runtime paths**.
3. Gateway validation per §2 and §4, machine-readable rejections.
4. Deterministic rendering per §6 + persist the raw structure in message metadata.
5. `access_mode` → `delegation.readOnly` per §7 — **only meaningful paired with the router-side
   derivation below; alone it buys a permission that fails by topology.** Ships together, or the
   field is named `requested_access_mode`.
6. Result side per §8: `DelegateResponse` gains the three fields + `schema_version`, legacy `status`
   retained; unified budget per §8a.
7. Batch coverage in `list_delegates` — **including the retry-token fix** (§4), or explicitly defer.

**Tests**: old caller (`task` only) unchanged; single and multi target; wrong peer rejected *before*
a child session exists; each of the three legal scope shapes and each of the three illegal ones;
observations rendered as non-authoritative; **read-only genuinely removes write tools on the local
*and* cross-Runtime paths — one test per path, since a single-path test is exactly what would have
passed while §7's topology hole stayed open**; continuation does not require restating targets; local
and cross-Runtime render identically; the raw structure is readable back from the persisted message.

### The management plane

1. **Router passthrough** of `request_context` at the prompt's **top level** — not inside
   `prompt.delegation`, which is reconstructed. Unknown to an old Runtime ⇒ it works off `task`.
2. **Canonical resource + coverage data** — ✅ **already shipped, no v1 work.** The roster pushed to
   the runtime already carries per-member `clusters[]` / `hosts[]`, which is exactly what §4
   validates against; no new synchronous query interface is needed. Outstanding but **not blocking
   v1**: a stable resource id, if cluster/host have one worth exposing. Matching is by canonical
   name until then.
3. **Coordinator prompt** (the one that actually reaches production — see §10): keep `task`
   high-level; extract `targets` and `constraints` from the user's request without inventing
   constraints the user never expressed; only user / tool result / knowledge base / prior peer report
   may become an observation; the coordinator's own reasoning may never become a target; use
   `scope=discovery` rather than guessing a canonical name; continue the same `session_id` and send
   deltas; carry a prior specialist's conclusion forward as a **sourced** observation.
4. **Specialist prompt** — the rules: `targets` are confirmed identity — do not re-ask which cluster
   (API reachability and identity mapping are still fair to check); `observations` are not live
   facts; a coordinator observation is not a user confirmation.

   ⚠️ **"`constraints` are binding" means the USER's constraints, and nothing else.** An earlier
   revision said it unqualified, which lands the same defect from the opposite end: the coordinator
   is told not to direct the investigation, and the specialist is simultaneously told that
   everything in the payload is inviolable — so a relayed observation becomes a premise the
   specialist may not question, and the coordinator has directed it after all, without saying so.

   Binding: `constraints.user_requirements` and `constraints.time_window`, because they come from
   the person asking and the specialist cannot obtain them any other way. NOT binding:
   `observations`, whatever their source. Whether one still needs verifying is the specialist's call
   — which is exactly what §9.3's coordinator wording now says from its side, and the two have to
   agree or the pair of prompts cancels out.
   ⚠️ **The delivery problem is identical to the coordinator's, and this draft first missed it.**
   The specialist constant is a second copy seeded through the same path, and the specialist type
   **already carries a released seed revision in a live environment** — so editing the constant
   reaches no production specialist either. §10.3 covers **both** prompts; a release that migrates
   only coordinators leaves half of this contract unenforced at the receiving end, which is the half
   that reads the blocks §6 renders.
5. **Storage and analysis**: keep the raw object in trace/message metadata, so the acceptance
   questions in §11 are answerable at all.
6. **C1 result side** per §8. The terminated-class work in §10 is done; the prompt release is not.
7. **`access_mode` derivation in the router** (§7) — accept it as a request parameter beside
   `delegationId`, validate it, and write the result into the reconstructed `delegation`. **Not**
   passthrough from the prompt.

   ⚠️ **RECEIVER FIRST, and the order is not symmetric.** "One change" states the intent, but two
   repositories have no atomicity — one side always merges first, and the two directions differ:

   | merges first | consequence |
   |---|---|
   | **receiver (router)** | an absent parameter means `normal`; behaviour unchanged — **harmless** |
   | sender (siclaw) | `access_mode` is sent, the router does not know it, and a cross-Runtime delegation silently runs fully-armed — **precisely the shape §7 exists to eliminate** |

   So: **the router merges and deploys before siclaw's item 5.** Same rule and same reason as
   §10.2's classifier → writer, stated in the same words on purpose — left as "one batch", it
   degrades in practice into "whoever finishes first merges first".

**Tests**: router does not drop `request_context`; mixed old/new Runtime still works off `task`; a
**newly created** coordinator's stored `system_prompt` contains the new rules (this one siclaw cannot
write — it does not own the creation entry point, and it catches "the constant was edited but the
seeding path never reads it"), **and the same test for a newly created specialist**; all three
scopes; a peer-report observation keeps its source and session; a trace reaches from the
coordinator's delegation to the child turn; a `read_only` delegation arriving over the router
produces a read-only peer, and the reconstruction still refuses a `readOnly` planted in the prompt.

---

## 10. Already landed in siclaw, and what it still needs

| | state |
|---|---|
| **C2** — tool rows finalized on every exit (`abandoned` / `stopped`, `outcome` stays null) + portal-web | landed. ⚠️ **must not deploy** until the analysis layer reclassifies |
| **C3** — trace propagation | ✅ spans **and** rows; see §10a for what was missing and why it was claimed complete |
| **P1** — coordinator continuation rule (incl. the input-required carve-out), tool description | landed, **but reaches no production coordinator** — see below |
| **C5/C4b** — `match_basis` gains `no_match`; a query no longer prints the other kind's total | landed |

### 10a. C3 is half done, and the half that is missing is the half this contract needs

Claimed as a full chain in an earlier revision. Verified against the code after review, and the
claim does not hold. **Two independent mechanisms share the name "trace propagation" and only one
of them works:**

| | state |
|---|---|
| **OTel spans** — the peer's root nests under the coordinator's `delegate_to_agent` tool span | ✅ |
| **DB `trace_id` grouping** — the peer's persisted rows joining the coordinator's turn | ✅ **fixed** |
| **Tool-row correlation** via the dispatching tool-call id | ✅ **fixed** |

Three concrete gaps, all confirmed in this checkout and now closed:

1. The delegated **opening user row** was persisted with no `trace_id`. It cannot be stamped at
   write time — it is written before dispatch — so it is now **bound afterwards** from the ack, the
   same backfill every other prompt entry point (web, channels) already performed. Delegation was
   the only entry point that skipped it.
2. The local path called `consumeAgentSse` **without `traceId`**, and that consumer is what stamps
   every row it persists — so every peer row landed unstamped. Now passed, preferring the **box's
   own id from the ack** over the one we sent: a box that did not adopt ours carries a different id
   on its spans, and stamping rows with ours would split rows from spans in exactly that case.
3. The dispatching tool-call id was **write-only** — declared in three places, read in none. (The
   commit that added it disclosed this in its own message while the summary table called the chain
   complete; both statements shipped together.) Now consumed on both sides, because spans and rows
   are queried by different tools: the gateway writes it into the delegated user row's metadata,
   which is where the DB join is actually made, and the box records it as a root-span attribute.
   Concurrent delegations are why session lineage alone is insufficient — several peer sessions can
   share one parent turn, and only this says which `delegate_to_agent` row each answers.

**Why this mattered more than a status correction.** §12's acceptance criteria include
coordinator↔child trace linkage and whether a specialist re-resolves identity. Those are answered
from **DB grouping**, not from spans — so with only the OTel half, this contract would have shipped
without the instrument that judges it, and that would have surfaced after the fact.

⚠️ **A naming mismatch on the other side compounds it**: their router test asserts a field named
`toolCallId`, while the wire field is `delegationToolCallId`. A test that pins the wrong name passes
regardless of whether the real field survives — the false-pass shape this project has hit twice
before (a fixture that never matched its own regex; a `-t` filter that selected zero tests and
exited 0). Fix the assertion before trusting it as evidence of passthrough.

---

Three things were owed from the other side. **One has landed; the other two have not**, and the
terminated-class work turns out to be broader than a single pass:

1. ⚠️ **The terminated class must be excluded from EVERY consumer, not only the filter and the two
   aggregates.** Reported as delivered in an earlier revision; a fuller sweep on the other side found
   five more read paths still treating a terminated call as incomplete, failed, or missing: the
   nightly analyzer's input provider, the digest `ErrorCount`, the `missing_result` flag, the
   aggregate `error_count`, and timing's `FailedCalls` / `FailedThenRetried`. **Status rolled back to
   in progress, and C2's writer stays undeployable until it closes.** The lesson is the shape, not
   the count: "excluded from the classification" and "excluded from every consumer of the
   classification" are different claims, and only the second one makes the writer safe. Earlier text
   about the delivered half is kept below for the defect it describes —
   the first having changed the filter alone and left the summary counters reading the other way.
   (The defect: an outcome-less row counted as `empty` with no text and as **`success` with partial
   text** — which the finalizer writes — so one record read "not empty" through the filter and
   "empty" in the summary.)
2. ✅ **Deploy order is fixed and cannot be inverted**: classifier first, siclaw's writer second.
   Recorded on the other side as a hard requirement. Rows written in the gap are misclassified
   **permanently** — they are the audit record, nothing recomputes them.
3. ❌ **The prompt needs a released revision and a migration of existing agents** (matched on the
   exact old text). Editing the constant only affects new agents with no released seed revision;
   existing agents hold a materialized `system_prompt`. Still open, and it is a **platform action**
   rather than a code change: someone has to decide who publishes and in which environment.
   ⚠️ **Measured in a LIVE environment, not production**: there, the released coordinator revision is
   still the older routing-only text and does not contain the new rules. **Production must be
   re-checked before the migration is scoped** — which revision its release points at, and whether
   that revision's text matches, are independent facts and may differ. Reading this measurement as a
   production finding is exactly how the production check gets skipped. **This covers the specialist
   prompt as well as the coordinator's** (§9.4). Without it, the P1 work and everything §9.3/§9.4
   specify are invisible in production.

**C3 should ship with this contract, not after it.** Child sessions exist today with dozens of
messages and no trace, so whether a specialist re-resolves identity — the metric this contract is
partly judged on — is currently unmeasurable.

---

## 10b. The values, now fixed

An earlier revision left these blank and called them "TBD". A contract with a blank where a number
goes is a contract two sides fill differently, and none of them needed a meeting — they needed
someone to write a value down. Here they are. Change them by amending this table, not by picking a
different number at a call site.

| | value | why this one |
|---|---|---|
| **request budget** | **64 KiB**, measured as **UTF-8 bytes** of the serialized `request_context` | Bytes, not characters: CJK is 3× wider in UTF-8, and a character budget silently gives a Chinese request a third of the room. 64 KiB is far above any honest request (the largest observed task text is ~2 KB) and far below a runaway paste, so it bounds abuse without ever binding normal use |
| **request rejection** | reject the CALL, naming the field that exceeded and its size | §5: nothing has run yet, so the caller can send less. Silent truncation on the way IN would drop a user constraint — the exact loss this contract exists to stop |
| `observations` count | **32 entries**, each **4 KiB** | A cap on total bytes alone lets one 64 KiB observation crowd out thirty real ones. Both bounds are needed |
| **result budget** | **32 KiB** UTF-8 bytes across all result-bearing fields | Sized so a full `report_findings` artifact fits without truncation; only a runaway narrative hits it |
| **result head/tail split** | **25% head / 75% tail**, reporting `original_bytes` / `omitted_bytes` | Tail-heavy because a conclusion comes last — that is why the old behaviour kept the tail. The head is kept because dropping it entirely is what made a truncated narrative unreadable: the reader loses what the peer was even asked to do |
| **`all_peer_bindings` cap** | **64 targets** after expansion; over that, reject and require enumeration | An agent covering thousands of hosts must not have one word commission thousands of checks. 64 is above any real multi-cluster task (the largest observed is 9) |
| **the router's field name** | **`access_mode`** — snake_case, matching every other field on this wire | §7 argued the semantics of the name for a page and never fixed the spelling, which is itself the silent no-op §7 exists to prevent. Two spellings = the field is dropped and nobody sees an error |
| **`completed` + `unknown` in the UI** | ✅ **settled and implemented**: "No result reported" / "未上报结果", from the message catalogue rather than hardcoded | It is the plan-only case: the turn ended normally and nothing was reported. Rendering it as either extreme is the ambiguity C1 removes — and it is the single most common thing C1 makes newly visible. (An earlier revision reported this as drifting from the UI; that reading was stale — the other side had aligned it before the question was asked, and I had searched the wrong place.) |
| **legacy `ok`** | keep emitting it: `true` unless `turn_status` is `failed` | Unchanged meaning for old readers. It is transport health, and it deliberately stays `true` for a plan-only turn — which is exactly why it was never sufficient |
| **`next_action`** | ⚠️ **it is NEW, not legacy.** The wire carries only `inputQuestion` today — verified in `agent-delegate.ts`. It is ADDED by v1, derived from `task_status` (`blocked` → `ask_user`), and emitted only under v1 | An earlier revision called it "a field that exists on the wire today" and told both sides to keep emitting it unchanged. There was nothing to keep. Two sides implementing that sentence would have produced one field and one absence |
| **a v1 producer whose peer called no protocol tool** | **emit v1** with `task_status: unknown` | Falling back to the old shape would make `schema_version` unreliable as the branch key — the one property §8 depends on. A producer that speaks v1 speaks it always |

**Unit rule, stated once so it is not re-derived per field: every byte count in this contract is
UTF-8 bytes of the serialized JSON value**, never characters, never UTF-16 units. `.length` on a JS
string is UTF-16 units and undercounts CJK by ~3× — that mistake is already documented elsewhere in
this codebase for stream size caps, and it would repeat here.

---

## 11. Decisions needed at review

| # | decision | blocks | the other side's position |
|---|---|---|---|
| 1 | Adopt §8's mapping table verbatim (both sides) | **all of C1** — half a contract is worse than none | ✅ agreed, implementable as written; the five open items are settled, work can start |
| 2 | Terminated class excludes failed / empty / running / **success**, across filters *and* aggregates | whether C2 can deploy | ✅ **implemented** (§10.1) |
| 3 | Deploy order: classifier → writer | same | ✅ agreed, recorded as a hard requirement (§10.2) |
| 4 | Prompt: release a revision + migrate existing agents — **coordinator and specialist both** | whether P1 and §9.3/§9.4 are visible in production | ⚠️ agreed; the **publish/execute** half is unowned, the migration code and its dry-run are not (see below). The stale-revision finding is from a live environment — **production is unverified** (§10.3). Extending it to the specialist is their proposal (§9.4) |
| 5 | Request side as specified here: `targets[]` plural, one legal shape per scope, `time_window` structured, `access_mode` → real permission, continuation = delta | this document | ✅ agreed — with the two-repository constraint on `access_mode` they raised (§7) |
| 6 | Batch coverage: own the retry-token fix, or defer batching | the §4 coupling | data side is **not** a blocker (§9.2); the retry token is siclaw's own problem |

**The one decision with no owner is #4 — but only half of it.** Everything else is either agreed
or already built. #4 splits, and reading it as one indivisible blocker makes it look like nothing
can move:

| | needs an owner? |
|---|---|
| the migration service itself — CAS update, audit, warm-reload invalidation, the dry-run inventory | **no.** Buildable now |
| running that dry-run in a live environment to validate the exact-old-text matching | **no.** And it is the cheapest way to find out whether the matching rule is right before it touches production |
| **publishing the revision**, and executing on production | **yes** — a platform action, and the production re-check in §10.3 belongs to whoever takes it |

So the code can be ready and verified while the owner question is settled; what waits is the
execution, not the work. Two prompts' worth of rules in this contract reach production only through
that last row.

---

## 12. Acceptance criteria

Compare before/after:

- times the specialist asks which cluster **after** a target was supplied;
- delegations where target and peer coverage disagree (should become zero — rejected pre-dispatch);
- **user-constraint retention** — cheaply measurable only if `time_window` is structured (§1);
  otherwise this stays a text-sampling estimate, like the ~38% figure that motivated the field;
- average `list_delegates` per delegation (expected: **unchanged** by this contract — it moves only
  with batch coverage or dispatch-side routing);
- repeat alias discovery by the specialist;
- coordinator↔child trace linkage rate (needs C3 on both sides);
- share of cross-specialist observations missing source or timestamp.

Expected outcome is fewer clarifications and no mis-routing. It will not remove live-state
re-verification, and it does not by itself address plan-only turns, result truncation, or routing-query
volume — those are C1's result side, the unified budget, and batch coverage respectively.
