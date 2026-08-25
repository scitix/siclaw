# P1 — wording, approved and LANDED in siclaw

> **Status.** Both in-scope proposals are implemented on this branch: the `delegate_to_agent` tool
> description, and `COORDINATOR_DEFAULT_PROMPT` + its cross-reference comment + the digest tripwire.
> (Deliberately no commit SHAs — this branch will be rebased before it merges, so a hash cited here
> is guaranteed to rot. The commit messages carry the linkage in the direction that survives.)
> Proposal 2 is declined; Proposal 4 is withdrawn. **The other side still owes two things**: copying
> Proposal 3's text *including the input-required carve-out*, and the creation-wiring test siclaw
> cannot write. Until the first lands, deployed coordinators keep the old prompt — siclaw's constant
> is the fallback, not the seed.
>
> One wording change was made after review while implementing: "a summary of that turn's narration"
> became "its narration from that turn … a size budget that drops the START of a long narration".
> Reason in the section below — the shaping passes `finalText` verbatim, so "summary" would
> misdescribe the one case that matters.


Companion to `2026-08-24-coordinator-defects.md`. Nothing here is applied: `src/core/prompt.ts`
and `src/core/agent-types.ts` require human approval (CLAUDE.md), so this states the intent and
the exact text and waits. The management plane's `defaultCoordinatorPrompt` has to be aligned to
whatever is approved here, so this file is also the copy source for that side.

## Three sites, one needs no approval

| site | status | scope | other side |
|---|---|---|---|
| `src/tools/workflow/delegate-to-agent.ts` — tool description | **not gated, do it** | coordinator-only (`delegate_to_agent` needs `delegate_agents`) | no copy there — nothing to mirror |
| `src/core/prompt.ts` — platform prompt | **DECLINED** | **every agent type** — cannot be scoped | no copy there — searched and absent |
| `COORDINATOR_DEFAULT_PROMPT` + the management plane's copy | **approved in scope** | coordinator-only: `agent-types.ts` holds one constant per type, `SRE_DEFAULT_PROMPT` is untouched | **the only cross-repo change** |

The per-type separation is what makes Proposal 3 safe: `SRE_DEFAULT_PROMPT` (`:39`) → `sre`
(`:139`), `COORDINATOR_DEFAULT_PROMPT` (`:44`) → `coordinator` (`:146`),
`KNOWLEDGE_QA_DEFAULT_PROMPT` (`:110`), `custom` → `null`. Editing one constant reaches one type.
The platform prompt has no such branch, which is exactly why Proposal 2 is out.

## What each proposal rests on

| proposal | evidence |
|---|---|
| 1. tool description: synchronous, and narration ≠ findings | ⟨t1⟩ `bac9eb6a…`: `delegate_to_agent` returned a plan with `outcome=success` at 12.6 s; the coordinator then wrote *"我继续等待其完成"* — it believed the peer was still working |
| 2. platform prompt: a first turn that only announces has delivered nothing | ⟨t3⟩ a task marked `completed` whose entire output was *"我会读取 skill，然后执行三次查询"*, with the real work happening only after a follow-up. ⟨t1⟩ the same shape in the coordinator trace above |
| 3. coordinator prompt: bounded continuation | ⟨t1⟩ three `delegate_to_agent` calls for one question (12.6 s → 3.5 min → 7.7 min); the user steered in at 3 min |
| ~~4. keep resolver identity, roster coverage and user input separate~~ | **withdrawn — no surviving evidence.** See below. |

### Proposal 4 is withdrawn

Its only case was the coordinator asserting that a short cluster alias was the exact binding name
for a fully-qualified `<region>/<cluster>` key.
That case was refuted: the coordinator had read the alias map two messages earlier, and that map
contains both that alias and a `binding_names` list, so the claim was supported by resolver
evidence. The
three `list_delegates` review findings that appeared to support it concern `details`, which the
model never receives.

So there is no demonstrated failure behind it, and a prompt rule without one is exactly the
special-case accretion this project's rules forbid. If K1's resolver work surfaces real instances
of coverage being read as identity, add it then, with the trace.

---

## Proposal 1 — tool description (no approval needed, but review the wording)

`src/tools/workflow/delegate-to-agent.ts:58-59`. **Current opening:**

> "Delegate a bounded task to one of your specialist agents **and get back its findings**. The peer
> runs the task in its OWN environment under its own capabilities and persona (you don't constrain
> it) and reports back — you keep oversight."

Two factual problems: it promises findings, when what comes back may be narration; and it never says
the call is synchronous, which is what left the model believing it was waiting.

⚠️ **The draft in an earlier revision of this file had two errors of its own**, both caught in
review, and both were the description being *more* absolute than the system:

| draft said | why it is wrong |
|---|---|
| "what it returns is **everything** you get from that turn" | contradicts item 4 of C1 in the companion document — the same work introduces **one budget across every result-bearing field**, reporting `omitted_chars`. Once that ships, what returns is explicitly *not* everything. Even today `MAX_FINAL_TEXT = 12000` clips it |
| "otherwise its **closing** narration" | `delegate-api.ts:235-243` joins **every** assistant message of the turn (`.filter(role === "assistant" …).join("\n\n")`), not the last one. This is a regression in my own writing — I corrected exactly this reading three revisions ago and then restated the wrong version here |

**Landed wording** (the rest of the description unchanged):

> "Delegate a bounded task to one of your specialist agents. **This call is SYNCHRONOUS: it returns
> when the peer's turn ends — the peer is not still working in the background afterwards.** You get
> the peer's structured findings when it reported them, otherwise its narration from that turn, both
> subject to **a size budget that drops the START of a long narration**; the complete record stays in
> the peer's own session. **Narration that describes a plan is not a result.** The peer runs the task
> in its OWN environment under its own capabilities and persona (you don't constrain it) — you keep
> oversight."

⚠️ **"A summary of that turn's narration" was the draft, and it is also wrong** — a third instance of
the family above, caught while implementing rather than in review. `delegate-to-agent.ts` shapes the
result as `const summary = a ? a.findings : (resp.finalText ?? …)`: with no artifact the model gets
`finalText` **verbatim**. There is no summarization step anywhere on the path. And the clipping is
tail-kept, so what is missing is the **beginning** — a summary is never missing its beginning, so a
model told "summary" has no reason to suspect a gap, which is exactly the suspicion the sentence
exists to create. Hence the explicit "drops the START".

Every clause is now a statement the code supports: synchronous *is* unconditional; the narration is
described as what it is rather than as a condensation; and "the complete record stays in the peer's
own session" tells the model where the rest went — which is what stops it re-delegating to recover
text that was only clipped.

This is a correction of fact, not an instruction, and it reaches the model through the one channel
prompt customization cannot bypass.

## Proposal 2 — platform prompt — **DECLINED, out of scope**

**Not doing this.** `prompt.ts` is the platform prompt and has no per-type branch, so the edit
cannot be scoped to coordinators: it would change SRE and knowledge-QA behaviour as well. A
coordinator fix must not carry a platform-wide behaviour change, and the evidence for it (⟨t3⟩'s
reproduction) came from an ordinary task rather than a coordinator — so it is not even
coordinator evidence.

The residual is real and stays: the platform prompt licenses a plan-only turn for every agent type,
and any agent can still burn a turn on an announcement. What Proposals 1 and 3 do is make the
coordinator *immune* to it — C1's `task_status` lets it tell a plan from a result, and Proposal 3
tells it what to do — rather than removing the licence. Removing it is a platform question needing
its own evidence and its own approval, separately from this work.

**Follow-up to file separately, so it is not lost by being declined here.** The behaviour is a
platform defect with its own evidence (⟨t3⟩: a task marked `completed` whose entire output was an
announcement) and its own blast radius (every agent type). It should be an issue against the
platform prompt, not a line in a coordinator document — the two need different reviewers, and
bundling them is what produced the mis-scoping in the first place. Nothing in the coordinator work
depends on it.

The analysis is kept below because the diagnosis stands even though the fix is out of scope: this
is *why* a coordinator receives plan-only results in the first place.

`src/core/prompt.ts:172`. **Current sentence, verbatim:**

> "A turn can be just a short update; it doesn't have to end in a tool call or a conclusion."

That sentence exists for a good reason — an agent working through something long should be able to
post progress instead of going silent — and it must keep working. But as written it also licenses a
*first* turn that announces and stops, which is the behaviour in both traces above.

**Proposed replacement:**

> "A turn can be just a short update once work is under way. But say what you're about to check **in
> the same turn as the call**, not instead of it: a turn that only announces a plan has delivered
> nothing, however well it reads."

**Why platform-wide rather than a coordinator exception.** The review suggested scoping an
exception to coordinators. The evidence says otherwise: ⟨t3⟩'s reproduction was an ordinary task,
not a coordinator. The behaviour is licensed for every agent type, so a coordinator-scoped
exception would leave it in place everywhere else. This is also a sharpening of an existing
sentence rather than a new rule, so it adds no special case — and it does not contradict "narrate
as you work", it says *when*.

## Proposal 3 — coordinator default prompt ⚠️

To be added to the coordinator prompt — in siclaw's constant for consistency, and in the
management plane's copy, which is the one that reaches deployed coordinators.

> "When a delegation returns only a plan or progress rather than findings, continue that same
> `session_id` **once**, asking for the completed result. If the second return still is not
> findings, give the user what you have, say which part is missing, and stop — do not restart the
> task as a new delegation.
>
> This does not apply when the peer is asking for input. A returned question belongs to the user:
> relay it and wait. Do not continue the delegation, and do not answer on the user's behalf."

⚠️ **That second paragraph is not optional, and it was missing from this text for a revision.** The
main document discussed the exclusion; the prompt text — the part the management plane copies
verbatim — did not contain it. A returned question is, from the coordinator's point of view, exactly
the shape the rule fires on (a delegation that came back without findings), so a rule stated without
the carve-out actively instructs the coordinator to continue a session that is waiting on the user.
What follows is the coordinator guessing an answer and reporting a conclusion built on its own
invented input — a worse failure than the round-trips this rule exists to prevent, and one that is
hard to spot afterwards because the transcript reads as if the user had answered.

Once C1 ships, this carve-out is `task_status: blocked` + `next_action: ask_user` and stops being
prose. Until then it has to be in the sentence.

**Why this one is coordinator-scoped.** The coordinator is the only agent whose primary action is
delegation, and the failure requires a tool whose *successful* result may be narration. The
platform prompt already covers the adjacent general case ("don't blindly repeat a failing call");
this one is about a call that succeeded and returned nothing usable, which that rule does not
reach.

**Removal condition — state it in the commit so it does not become permanent.** This is a stopgap
for the missing contract, not a durable rule. Once C1 ships `task_status`
(`complete | partial | blocked | unknown`), replace it with "act on `task_status`": the model reads
the state instead of counting attempts, and the hardcoded "once" can be deleted. A rule with a
magic number in it should carry its own expiry.

### Bundled into the same approval: keeping the two constants from diverging silently

Alignment is hygiene rather than correctness while siclaw's Portal is undeployed — but the other
side of that is that **a one-sided edit is currently caught by nothing**. Byte-identity rests on
discipline spanning two repositories and two people, which is not a mechanism.

Two additions, both in `agent-types.ts`, so they ride this approval cycle instead of needing
another:

1. **A cross-reference comment** beside the constant naming the other side's file and symbol, and
   stating that a change here requires the same change there. This is a reminder, not a mechanism —
   worth having, insufficient alone.
2. **A hash tripwire** in `src/core/agent-types.test.ts`: assert the constant's digest equals a
   recorded value, with a failure message that says *"if this change is deliberate, update the
   digest AND the management plane's copy at `<file>`"*.

The tripwire is deliberately the thing I argued against for behaviour tests — it breaks on every
rewording. That is the point here: it does not claim the wording is *correct*, it makes a one-sided
edit impossible to make **silently**. Its honest limitation: it cannot detect the other side
changing, only that *this* side changed without acknowledgement. Symmetry requires the management
plane to add the mirror-image test on its own constant; then neither side can drift without one
editor being told.

⚠️ The recorded digest must be computed **after** the approved wording lands, not from today's
constant — Proposal 3 changes it. For reference, the current pre-change values are
md5 `eb35f27244cd173dd938f0c6ece71b01`, sha256 `7c3e62c0c6b5a4e51c7ee467b8b131be5b4162bb231eac3695bb604e2335f38d`, length 6,215.

---

## Sequencing

1. **Proposal 1 now** — not gated, and the highest-reliability channel.
2. **Proposal 3** — approved in scope. Its text, *including the input-required carve-out*, is what
   the management plane copies. (Proposal 2 is declined; there is no step 2 for it.)
3. Align the two coordinator constants (hygiene: an independently deployed siclaw would otherwise
   give its coordinators a different persona). Not a correctness requirement — siclaw's Portal is
   not deployed.
4. Migrate existing rows via the adaptive dry-run in the companion document, whose per-row report
   must include whether the row still carries the `(A) ANSWER` triage half.

## Verification, and who can test what

Three different things are worth pinning, and they belong to different sides. None of them pins
whether the wording is *good* — that is what behavioural checking is for.

| what | where | catches |
|---|---|---|
| the description states the synchronous semantics | siclaw, `delegate-to-agent.test.ts` | a future edit dropping the fact |
| the constant's digest | siclaw, `agent-types.test.ts` | a one-sided edit made without acknowledgement |
| **a newly created coordinator's `system_prompt` contains the bounded-continuation rule** | **management plane only** | the constant changed but the creation path never picked it up |

That third one siclaw cannot write — it does not own the creation entry point — and it is the most
valuable of the three. It is not a wording assertion: it pins **wiring**, catching "the constant was
edited but `seedPromptFor` doesn't read it" or "the type switch is missing a branch". Those are
exactly the failures where the change looks complete and does nothing, which is the shape this whole
item exists to prevent — the same shape as *"a PR that changes only the constant will look complete
and change nothing"* in the companion document.

Behavioural check, on a deployment carrying the change: ask a coordinator a routing question and
confirm the first turn contains the `list_delegates` / `delegate_to_agent` call rather than only an
announcement, and that a plan-only return produces at most one continuation.

Prompt text is deliberately *not* pinned as prose semantics: `agent-types.test.ts` asserts the
registry, and a phrase assertion only restates the diff while breaking on every rewording. The
digest tripwire above is not an exception to that — it asserts nothing about meaning, only that a
change was acknowledged.

These are **model-visible** changes — say so in the PR.
