# Compile-loop state machine (Phase ③ · the heart · draft v0)

> Self-driven compile: read the ledger → compile the next batch → record three states → self-adjudicate what can be self-adjudicated, batch the irreducible ones into domain multiple-choice questions →
> **route around blocks and keep compiling; stop only when nothing but blocks remains**. All state lives in the ledger + git; interruptible/resumable at any moment.
>
> **The machine is mechanism (shipped by the framework, domain-agnostic); "what counts as self-adjudicable / how to adjudicate" is decided by the loaded constitution (per-KB).**
> This file defines only the orchestration skeleton; it hard-codes no specific taxonomy for any KB.

## 1. Persistent state = the ledger (both resume and incremental rely on it)

```
ledger (json or sqlite, travels with the bundle in git):
  sources : [{anchor_id, src_file, loc, hash, status}]    # provenance from ingest
            # status: pending | compiled | parked
  nodes   : [{node_id, type, from_anchors[], hash}]        # produced OKF nodes + back-references to source
  findings: [{finding_id, kind, refs[], status, resolution, mcq}]
            # kind: dup | contradiction | gap
            # status: auto_resolved | parked | ruled
            # resolution: rule name or human ruling (includes "ruled by human @date")
            # mcq: if parked, holds the framed domain multiple-choice question (evidence inlined + pre-classified options)
  rounds  : {dry_count, last_progress_at}                  # convergence guard
```

- `sources.hash` = the key to incremental compilation: a raw file changes → its hash changes → that anchor and its downstream nodes are flagged for re-check.
- `findings` are de-duplicated by a `kind+refs` fingerprint: **the same contradiction is parked only once** (otherwise it is re-thrown every round and never converges).

## 2. States and transitions

```
        ┌──────┐  load profile/constitution + ingest corpus + ledger (create empty if none)
        │ INIT │
        └──┬───┘
           ▼
   ┌─────────────────────┐  any advanceable batch? ── yes ──────────▶ COMPILE_BATCH
   │        SELECT       │  none, but parked exist ─────────────────▶ PARK ─▶ WAIT_HUMAN
   │ (read ledger, pick) │  none, and no parked ─▶ DRY? ─ <K ─▶ (back to SELECT)
   └──────────▲──────────┘                        └─ ≥K ─▶ CONVERGED
              │
   ┌──────────┴──────────┐  extract → structure into OKF → dedup/weave links → detect contradictions
   │    COMPILE_BATCH     │  successfully structured → nodes ✅ compiled
   └──────────┬──────────┘
              ▼  iterate over every finding
     ┌──────────────┐   constitution.classify(finding) ──┐
     │    TRIAGE     │   self-adjudicable ─▶ AUTO_RESOLVE ─▶ ✅ ─▶ back to SELECT
     │  (the moat)   │   irreducible ─▶ PARK_ITEM (frame as MCQ, batch) ─▶ back to SELECT
     │              │   not understood ─▶ PARK_ITEM (flag questionable, batch) ─▶ back to SELECT
     └──────────────┘

  WAIT_HUMAN ── human ruling arrives ──▶ BACKFILL (backfill & harden) ──▶ back to SELECT
  [raw update event] ─▶ flag affected nodes for re-check by hash ─▶ re-enter SELECT
```

**State by state:**

| State | What it does | Exit |
|---|---|---|
| **INIT** | Load profile/constitution/corpus/ledger | → SELECT |
| **SELECT** | Pick the next advanceable batch of work from the ledger: uncompiled source anchors / parked items unlocked by a human ruling / nodes flagged for re-check by the incremental path | See section 3 |
| **COMPILE_BATCH** | For that batch: extract assertions (with provenance) → structure them into OKF nodes per the constitution → dedup/weave links against existing nodes → detect contradictions. Write successful ones to nodes ✅ | → TRIAGE (per finding) |
| **TRIAGE** | Call `constitution.classify(finding)` to decide the direction (**this is the moat's decision point; the machine only dispatches, the rules live in the constitution**) | One of three ↓ |
| **AUTO_RESOLVE** | Apply the constitution's default resolution (e.g., annotate side-by-side / keep the newer / mark), record resolution+provenance, item ✅ | → SELECT |
| **PARK_ITEM** | Write the framed domain MCQ (evidence inlined + pre-classified options + an "I'm not sure either" escape hatch) into the pending-alignment batch; that unit is parked | → SELECT (**keep routing around**) |
| **PARK** | Only human-adjudicable items remain: throw the whole pending-alignment batch to the human, persist, suspend | → WAIT_HUMAN |
| **WAIT_HUMAN** | Suspended (via the forked loop runtime's interrupt/WAITING_FOR_CONFIRMATION), waiting with zero compute | Human ruling arrives → BACKFILL |
| **BACKFILL** | Apply the human ruling: contradiction → compiled (record the human ruling + date), unlock dependents | → SELECT (resume) |
| **CONVERGED** | Nothing advanceable, nothing parked, dry for ≥K rounds = compilation complete, hand off to the Phase ⑥ publish gate | Terminal state (re-enters on a raw update or a new problem) |

## 3. Two stop conditions (must be told apart)

- **PARK (block)**: everything compilable has been compiled, **all that remains is human-only adjudication**. → throw the MCQ batch, wait for the human.
  This is what you called "stop only at the bottom of the blocks." **Note: it does not stop at the first block it hits; it accumulates blocks, routes around them and keeps compiling, and stops only when nothing but blocks remains.**
- **CONVERGED (dried up)**: nothing advanceable, nothing parked, and K consecutive rounds with no new progress. → truly stop, hand off to the publish gate.
  `dry_count` guards against spinning (the agent perpetually "feeling there's more to understand" and looping forever).

## 4. Discipline of the moat (the key to TRIAGE not collapsing)

1. **Park by default, don't guess by default**: AUTO_RESOLVE only when the constitution gives a deterministic rule; otherwise PARK_ITEM (leave it questionable, don't hard-code).
2. **But don't drown the human**: the constitution's self-adjudication rules absorb the bulk (e.g., "convention difference → side-by-side"); only genuine domain forks get parked.
3. **A contradiction is parked only once** (de-duplicated by the `kind+refs` fingerprint), otherwise it never converges.
4. **Batch, then throw**: PARK_ITEM only enqueues; PARK is what throws the whole batch to the human—no per-item interruptions.

## 5. resume / incremental (the integration point for Phase ④)

- **resume**: every transition persists the ledger + writes OKF nodes to disk. Re-entry after any interruption = re-read the ledger, continue from SELECT, idempotent. State does not live in the conversation.
- **incremental (Phase ④)**: an external "raw update" event = diff `sources.hash`; changed anchors → their downstream nodes flagged for re-check → injected into SELECT. **Recompile only the affected subgraph + neighbors + re-run contradiction detection on the delta, not everything from scratch.** Anyone without provenance can only do a full recompile — this is an extension of the moat.

## 6. Boundaries (not covered by this draft)

- The actual intelligence of "extract/structure" inside COMPILE_BATCH = work the agent does under the constitution's constraints; this file defines only when it is scheduled and how its outputs are recorded in the ledger.
- The quality of MCQ framing = validated separately (domain language + evidence inlined + pre-classified options).
- The publish gate (Phase ⑥) = downstream, connected after CONVERGED.
