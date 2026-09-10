# Cross-library knowledge lookup

Ordinary knowledge questions can require a label search followed by several
page reads even when the compiled Wiki already contains the answer. Labels
also cannot retrieve a fact that appears only in a page body.

`knowledge_lookup` searches the current agent's mounted Wiki and returns the
first complete pages in the same call. It retains the Wiki's prose, conditions,
exceptions, links and original paths. Existing catalog navigation,
`knowledge_search` and `Read` remain available. This is a retrieval experiment;
it does not establish an improvement in real answers or end-to-end latency.

## Runtime contract

1. Search every mounted library by default. Optional `repoIds` constrain an
   explicit follow-up. Library identity/root come from `.citation-manifest.json`;
   name/version come from `.sync-manifest.json`. Names do not select libraries.
   An unmanifested local Wiki uses the ID `local`.
2. Index catalog-reachable, non-navigation Markdown leaves in disposable
   SQLite FTS5. Title, typed labels/aliases, headings and body have descending
   field weights. Document and query tokenization use CJK bigrams and Latin
   words; numbers, negations and compound identifiers remain searchable.
   Compound query terms stay intact to avoid matching unrelated error codes.
   This is lexical partial matching and alias support, not semantic paraphrase
   or general spelling correction. No embeddings or production dependency is added.
3. Return up to six candidates with original file paths, library identity,
   version when provided, and content hash. Read the first two complete pages
   when they fit inside the 12,000-byte serialized UTF-8 output budget.
   `readCount=0` returns metadata only. A page that does not fit is explicitly
   `budget_exceeded` and still has a path for `Read`; pages are never truncated
   and described as complete. These are relevance ranks, not confidence scores.
4. Feed only full contents included in the returned output into the existing
   session citation read registrar. Candidate paths and over-budget pages are
   not eligible. The model still chooses which evidence actually supports its
   answer and calls `knowledge_cite`. Existing frozen-source, turn and remount
   checks apply. Consumers must treat page contents as reference data.
5. A shared resolver belongs to one agent mount, independently of investigation
   memory. Build the FTS index lazily; warm lookups inspect manifests and read
   selected pages without scanning the corpus. Managed sync invalidates it;
   both manifests participate in the generation fingerprint. Verify selected
   page hashes, retry once after an edit/deletion, and reject a changing mount
   rather than returning inconsistent evidence. Local additions/catalog edits
   require `sync()` or a fresh CLI invocation. There is no background watcher.

The initial index admits up to 10,000 reachable pages / 64 MiB of source text,
with a 2 MiB per-page bound. Oversized inputs raise an explicit error; catalog
navigation and `Read` remain usable. The existing catalog scanner still reads
Markdown while building routes. Large-corpus cold start and memory use need
separate measurement before raising these limits or persisting the index.

The tool is in the existing `read_files` capability group. Explicit tool-name
allowlists must include `knowledge_lookup` to expose it. Ordinary-question
guidance is in the mounted-Wiki prompt and tool description; instance-owned
system prompts and the core prompt are unchanged. No control-plane API, mount
format, deployment variable or database migration is required.

## CLI and repeatable comparison

After `npm run build`, use the same retrieval implementation offline:

```sh
node siclaw.mjs knowledge search "E_CONN_42 v2.3" --root ./wiki --json
node siclaw.mjs knowledge search "certificate expiry" --root ./wiki --read-count 0 --json
node siclaw.mjs knowledge search "certificate expiry" --root ./wiki --labels --json
node siclaw.mjs knowledge search "certificate expiry" --root ./wiki --repo library-id --json
node scripts/eval/knowledge-lookup.mjs
```

The CLI starts a fresh in-memory index per process and needs no model or Portal
connection. Agent sessions amortize this cold start. CLI JSON includes elapsed
time; the synthetic evaluation separates label sync, content cold start, warm
metadata search and warm search plus reading.

A local smoke run on Node 24.11 / macOS arm64 used 100 pages per library:

| Libraries | Pages | Content cold start | Warm lookup + read p95 |
| --- | --- | --- | --- |
| 1 | 100 | 118 ms | 2.0 ms |
| 5 | 500 | 587 ms | 3.7 ms |
| 10 | 1,000 | 734 ms | 10.9 ms |

The ten-library fixture has 40 queries: ten label aliases and thirty facts
deliberately present only in bodies (identifiers, CJK text and versions). Label
search found 10/40 expected pages at six results; body lookup found 40/40, all
ranked first. This measures the coverage gap intentionally constructed by the
fixture, not an estimate of production recall. Each result contained its first
full page, so the tool can combine search and reading; actual model tool counts
were not measured. A no-answer identifier query returned no candidates.

## Acceptance before broad rollout

Use the same mounted versions, model and representative questions for four
conditions: existing label search + Read, body lookup with `readCount=0` + Read,
body lookup with full-page output, and ordinary catalog/Read exploration.
Measure retrieval Recall@6, wrong-library results, unsupported claims, missing
conditions, citation correctness, first-evidence time, tool calls, output tokens
and end-to-end p50/p95. Include ambiguous library names, multi-library answers,
long pages, exceptions, obsolete versions, no-answer questions and updates.
The microbenchmark does not replace these agent-level trials.

Trace consumers that identify knowledge usage solely from `read` tool inputs
must also recognize `knowledge_lookup` results with `readStatus=full`, matching
`library.id` and `file`. They should not count metadata candidates as reads.
That downstream analytics integration and real-corpus answer evaluation are
still required before treating this experiment as production acceptance.
