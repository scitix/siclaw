---
title: "Knowledge Retrieval and Citation Architecture"
sidebarTitle: "Knowledge Retrieval"
description: "Platform-owned discovery, leaf-page evidence, and version-scoped citations for mounted OKF wikis."
---

# Knowledge Retrieval and Citation Architecture

## Product contract

A bound OKF wiki is the Agent's factual knowledge snapshot. A user must be able
to ask with task language, aliases, or exact terms without knowing a document
title. If the answer is supported by that snapshot, the Agent should find the
leaf page, read it, answer from it, and cite only the trusted original mapped by
that same mounted version.

This contract has four consequences:

1. `index.md` is navigation context, not the existence boundary for knowledge.
2. Search chunks are candidates, not evidence; the platform reads selected
   leaf pages and returns only their bounded content to the Agent.
3. `index.md`, `_index.md`, and pages with `type: index` are never citable.
4. Citation authority is the mounted `.citation-manifest.json`, not the current
   state of Sicore Manage Raw and not a URL copied by the model.

## Runtime flow

```text
published OKF version
        |
        v
atomic knowledge mount
  pages + .sync-manifest.json + .citation-manifest.json
        |
        v
knowledge_search -- one model-visible call per user turn
        |
        v
KnowledgeResolver -- query derived hybrid index (rebuildable, Agent-scoped),
                     aggregate candidates, read exact leaf snapshots
        |
        v
bounded evidence + navigation hints
        |
        v
knowledge_cite -- validate read snapshot against pinned citation manifest
        |
        v
answer + trusted original links
```

The index is derived state. The mounted pages and manifests are authoritative.
A knowledge reload replaces those files as one mount, refreshes the derived
index, and reloads the session prompt.

## Retrieval design

### Current baseline

`KnowledgeResolver` is the platform-owned deep module behind the model-visible
`knowledge_search` tool. It is scoped to one Agent's mounted knowledge
directory. It uses dense and FTS keyword retrieval with MMR, and FTS remains
available when embeddings are unavailable. This matches the common
hybrid pattern: lexical retrieval preserves exact identifiers while embeddings
recover semantic matches. Anthropic's Contextual Retrieval evaluation likewise
combines BM25 and embeddings, then improves precision with reranking.

The prompt may inline a small catalog as cheap routing context. An oversized
catalog is not prefix-truncated: a prefix looks complete and creates false
absence. Search is the normal discovery path; Grep/Read of the full index is the
deterministic fallback.

The resolver retrieves a wider chunk pool, removes navigation pages from answer
candidates, aggregates hits by owning page, and reads up to three selected leaf
pages concurrently. Small pages are returned whole; large pages return matched
sections within a context-window-derived evidence budget. Reads pass through the
same current-turn citation registrar as the Read tool. The model therefore gets
answer evidence in one retrieval call and can register only what it used with
`knowledge_cite`. This follows the parent-document pattern: use smaller chunks
for recall, but use the owning document as the answer and provenance boundary.

Repeated `knowledge_search` calls in the same turn reuse the first result. This
is a latency guard, not a forced case-specific index: every question goes
through the same Agent-scoped hybrid index, page aggregation, read, and budget
policy. `index.md` may still be omitted from the system prompt when it exceeds
the catalog budget; retrieval does not depend on that prompt copy and filters
navigation pages from answer evidence.

### Next retrieval stage

Add these in order, measured against a fixed query set rather than by prompt
intuition:

1. Rerank the hybrid candidate pool before returning the top leaf pages.
2. On low recall only, expand aliases or generate a small set of alternate
   queries and fuse results with reciprocal-rank fusion. Query expansion must
   not replace the original query because it can drift.
3. Return stable `result_id` and mount generation metadata for every candidate,
   and trace query variants, candidate scores, selected reads, and citations.
4. Add a completion gate for the Knowledge QA harness: when mounted
   knowledge is required but no search or explicit-page Read occurred, continue
   the turn once with a required retrieval action instead of finalizing a factual
   answer. Never loop indefinitely.

Graph retrieval is a later, separate path for corpus-wide synthesis such as
"what are the recurring failure families across all GPU runbooks?". Entity-local
SOP questions such as "how do I disable GSP?" should stay on the lower-cost local
hybrid path. GraphRAG itself distinguishes local entity search from global
map-reduce search over community reports.

## Citation design

`knowledge_cite` is an evidence registration API, not a model-authored reference
formatter. It accepts only pages successfully Read in the current turn. Exact
evidence markers bind a section to source ids; legacy unmarked pages bind their
declared resources. The runtime resolves those ids/resources against the pinned
manifest and emits the link event.

Navigation-page rejection is enforced in code even if the model ignores prompt
guidance. A mixed cite call containing any navigation page fails closed and
emits no source event. This prevents a broad index page from leaking unrelated
original links into an otherwise correct answer.

The long-term result contract should expose citation annotations tied to stable
retrieval/read result ids. This is consistent with retrieval APIs that return
file identity, content chunks, and relevance scores, and with response APIs that
carry source annotations as structured output rather than prose guessed by the
model.

## Version and ownership boundary

- OKF publishing owns the immutable Wiki content and its citation mapping.
- AgentBox owns scoped materialization, derived indexing, retrieval, exact Read
  snapshots, and citation validation.
- Sicore Manage Raw may be an upstream authoring/sync source, but its live state
  is not consulted when answering from a previously published, adopted OKF
  version.
- Reload must select one complete mount generation. Old page bytes must never be
  combined with a new citation manifest, or vice versa.

The next protocol revision should add `mount_id` (derived from repository
versions and checksums) to the sync manifest, search results, Read receipts, and
citation events. That makes stale-index and cross-version leakage observable and
rejectable at every boundary.

## Acceptance metrics

Use cold sessions and questions that do not include document titles.

- leaf page Recall@10 and Top-1/Top-3 accuracy
- navigation page rate among answer candidates: `0`
- navigation citation rate: `0`
- citation precision and supported-claim coverage
- old-version page/manifest leakage: `0`
- correct abstention when the mounted Wiki has no support
- p50/p95 search and end-to-answer latency

The GSP regression case is mandatory: `关掉 GSP 怎么操作` must retrieve and
Read `运维/GSP禁用方法.md`; it must not answer from or cite an index page.

## Primary references

- [OpenAI Vector Store Search API](https://developers.openai.com/api/reference/typescript/resources/vector_stores/methods/search)
- [Anthropic: Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- [Microsoft GraphRAG query overview](https://microsoft.github.io/graphrag/query/overview/)
- [LangChain ParentDocumentRetriever](https://reference.langchain.com/python/langchain-classic/retrievers/parent_document_retriever/ParentDocumentRetriever)
- [RAG-Fusion](https://arxiv.org/abs/2402.03367)
