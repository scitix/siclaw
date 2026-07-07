# kbc — knowledge base compilation framework (mechanism layer, domain-agnostic) · working name

> Compile any local document tree into a standard OKF bundle, testable, with a human in the loop who only adjudicates the irreducible contradictions.
> **This repo holds only the "mechanism", not the "content".** Any given KB's concrete knowledge (taxonomy / invariants / sensitivity rules / coverage logic)
> lives elsewhere — it is injected by a Profile, loaded from a constitution, or produced on demand by Claude Code and registered.

## Iron rule (first design principle)

**Do not assume what the user's KB looks like** — do not assume the format (it can be a mix of ppt / spreadsheet / image / doc / md),
do not assume the structure, **and do not assume which methodology it should use**. Our own methodology (kb-method) is one specific instance
in the infra/SRE flavor — not a universal law — so it stays in `~/project/kb-method` as a reference constitution and does not enter this repo.

The only universal assumption: `bundle_root` points to an OKF markdown tree.

## Spine / leaves

- **Spine (shipped by this repo, domain-agnostic, always)**: parse any file · governed compile / adjudicate / gate loop · generic lint · Profile/constitution loader.
- **Leaves (per-KB, conditional/dynamic)**: coverage ledger, sensitivity scan, domain calculators, etc. — lit up only once a Profile registers them;
  for tools that don't exist, Claude Code builds them on demand, and **the moment one is built it is captured + versioned + registered into `tools_registry`** (guaranteeing reproducibility).

## Phase model: composable, not a rigid pipeline

Phases are not welded to each other — **compose freely, trigger on demand; everything except the compile core is optional**. See [`design/phases.md`](design/phases.md).
LLM calls go through **headless Claude Code** (`tools/llm.py`, reuses Claude Code's auth, **no API key needed**; the backend can be swapped for the Messages API SDK).

## Environment

```bash
/usr/bin/python3 -m venv .venv
.venv/bin/pip install pdfplumber python-pptx openpyxl pyyaml   # parsing + Profile/question sets
```

## Phase tools

| phase | tool | what it does |
|---|---|---|
| **ingest** | `ingest.py` | heterogeneous files (pdf/pptx/xlsx/image/text) → normalized md + `@prov` precise provenance (trace-back = re-read the local file). Engine is pluggable; the high-fidelity upgrade is a Docling backend |
| **compile** (core) | `compile_loop.py` + `triage.py` | normalized md → extract OKF assertions + detect cross-source contradictions → adjudicate (self-resolve / escalate to a domain MCQ) → ledger. State machine: see [`design/compile-loop.md`](design/compile-loop.md) |
| **emit** | `emit.py` | ledger → standard OKF bundle (pages grouped by topic, frontmatter+type, each item carries its source, contradictions landed per adjudication, writes index.md) |
| **audit** | `kb_audit.py` / `lint_links.py` | generic link-lint spine + optional Profile-driven leaves |
| **eval (publish gate)** | `kb_eval.py` | question-set stress test of the bundle (blue team answers from the bundle read-only + a judge scores + a threshold gates it). **Optional**, can be run standalone against any bundle |

```bash
.venv/bin/python tools/ingest.py --src <file or directory> --out out/ingested/
.venv/bin/python tools/compile_loop.py --ledger out/ledger.json --ingested out/ingested/ --constitution <constitution file>
.venv/bin/python tools/emit.py       --ledger out/ledger.json --out out/bundle/        # ledger → OKF bundle
.venv/bin/python tools/kb_audit.py   --profile examples/profile.siflow.yaml
.venv/bin/python tools/kb_eval.py    --bundle out/bundle/ --questions <question-set.yaml>      # optional publish gate
```

Closed-loop verified: `raw conflicting sources → ingest → compile (detect contradictions) → triage (escalate to domain MCQ) → human adjudicates → emit (OKF bundle with contradictions landed per adjudication) → lint (valid) → publish gate (consumable)`.

`profile.schema.yaml` = Profile field reference. `examples/` = Profiles for two real KBs. Constitution / question set / Profile are all **loaded per-KB content**, not part of the `tools/` code (a grep gate keeps the code jargon-free).
