# Phase model: composable capabilities, not a rigid pipeline

> **Principle**: the framework is composed of several **phases (capability units)**, each with a clear `input → output` contract.
> Phases are **not welded to each other**—they pass work through shared artifacts (raw / normalized form / ledger / bundle / provenance), and can be **freely composed and triggered on demand**.
> **Except for the "compile core," every phase is optional.** The flow is "assemble phases on demand," not "run one fixed loop."

## Phase inventory (each with its contract)

| phase | Tool | Input → Output | Trigger | Optional? |
|---|---|---|---|---|
| **ingest** | `ingest.py` | raw file tree → normalized md + provenance | when there are heterogeneous sources | Optional (skip if already markdown) |
| **compile** | `compile_loop.py` | normalized md → OKF assertions/bundle + ledger (detect contradictions → adjudicate) | to build/update knowledge | **Core** (the minimal, non-omittable one) |
| **audit** | `kb_audit.py` | bundle → lint for links/orphans/etc. | whenever you want a health check | Optional, can run standalone on any bundle |
| **eval (publish gate)** | `kb_eval.py` | bundle + question set → gate pass/fail decision | to stress-test before publishing | **Optional**, can run standalone on any bundle, independent of compilation |
| **update (incremental)** | `compile_loop.py` (re-entry) | changed raw → recompile only the affected subgraph | when raw changed | Optional (just a re-trigger of compile) |
| **serve (consume)** | (consumer side / siclaw mount) | bundle → answers with sources | to go live with Q&A | Optional |

## How to compose (all are valid paths)

- Just want a health check on an **existing bundle**: run `audit` standalone, don't touch compilation.
- Just want to **stress-test** whether someone else's bundle is up to par: run `eval` standalone, don't touch compilation (the publish gate is purely consumer-side).
- Standard KB build: `ingest → compile`; add `→ eval` if you want a quality gate, or stop at compile if you don't.
- raw changed: `ingest (changed files) → compile (re-entry, incremental)`, then `eval` as needed.
- Sources are already clean markdown: skip ingest, go straight to `compile`.

## Why cut it this way (design stance)

- **Each phase carries its own contract and can run independently** → nothing binds anything else; adding a new phase only requires declaring `input → output`.
- **Shared artifacts are the interface, not a call chain**: the ledger (compile state), the bundle (OKF output), and provenance (trace back to source) are the only coupling points between phases;
  phase A does not directly call phase B.
- **Optional-first**: the publish gate, audit, incremental, and ingest can all be omitted. The minimal usable set = a single compile.
- **Triggered on demand**: the same phase can be triggered by multiple events (compile is the first-time build, the incremental update, and the feedback-driven recompile alike).

> Anti-pattern: writing ingest→compile→audit→eval→serve as one big loop with a fixed order, where every step is mandatory and they import each other.
> That would make "I just want to lint" or "I just want to stress-test someone else's bundle" impossible. **Don't weld it shut.**
