---
title: "Knowledge Retrieval and Citation Architecture"
sidebarTitle: "Knowledge Retrieval"
description: "Platform-owned discovery, leaf-page evidence, and version-scoped citations for mounted OKF wikis."
---

# Knowledge Retrieval and Citation Architecture

## Product contract

A bound OKF wiki is the Agent's factual knowledge snapshot and its navigable
reasoning space. The Karpathy-style LLM Wiki value is not "find the most similar
page and rewrite it". Its value is that the Agent can understand a question,
follow a catalog and links, discover facts distributed across pages, compare
scope and versions, and synthesize an answer.

`knowledge_search` is therefore a retrieval accelerator, not the knowledge
authority or a mandatory router. It may shorten a frequent, concrete,
single-page lookup. It must not replace Agent-led exploration for novel,
ambiguous, broad, comparative, weak-match, or cross-page questions.

This contract has six consequences:

1. The mounted pages and their graph are authoritative; the derived index is
   disposable optimization state.
2. A search candidate is a hypothesis, not evidence and not proof that the page
   applies to the user's subject, task, version, environment, or scope.
3. Only one unique, high-confidence leaf page may take the direct-hit fast path.
   The complete page must fit the evidence budget. Weak, competing, or
   oversized matches return exploration hints without reading or registering
   them as evidence.
4. `explore` and `unavailable` never mean the Wiki lacks an answer. They hand
   discovery back to the Agent through `index.md`, links, Find, Grep, and Read.
5. `index.md`, `_index.md`, and pages with `type: index` are navigation, never
   answer evidence or citable sources.
6. Citation authority is the mounted `.citation-manifest.json`, not the current
   state of Sicore Manage Raw and not a URL copied by the model.

## Runtime flow

```text
user question
     |
     v
Agent understands subject / task / version / environment / scope
     |
     +-- concrete and likely single-page --> knowledge_search (optional)
     |                                      |
     |                                      +-- direct_hit --> read one page
     |                                      |                 validate applicability
     |                                      |
     |                                      +-- explore/unavailable --+
     |                                                                  |
     +-- broad / novel / ambiguous / cross-page ------------------------+
                                                                        v
                                                        Wiki network exploration
                                                        index + links + Find/Grep/Read
                                                                        |
                                                                        v
                                                        Agent synthesis and conflict checks
                                                                        |
                                                                        v
                                                        knowledge_cite for pages actually used
```

The optional fast path and the exploration path read the same atomic knowledge
mount: pages plus `.sync-manifest.json` and `.citation-manifest.json`. A reload
replaces those files as one generation and refreshes the derived index.

## Retrieval design

### Current baseline

`KnowledgeResolver` is the platform-owned module behind the optional
model-visible `knowledge_search` tool. It is scoped to one Agent's mounted
knowledge directory. Candidate generation uses dense and FTS retrieval with
MMR; FTS remains functional when no embedding model is configured or an
embedding request fails. Embeddings improve recall but have no authority to
decide that a page answers the question.

Interactive search starts local FTS immediately. Query embedding is a
single-attempt optional network call with a short timeout. Knowledge-index
materialization uses the same fail-fast network profile, while investigation
memory keeps its separate durable retry policy. Scores are normalized per
candidate across only the channels that found that candidate. Therefore a
strong FTS-only exact match is
not capped by the configured FTS hybrid weight merely because vectors found a
different page, and an unavailable or slow embedding endpoint degrades to the
same FTS candidate path used when embeddings are not configured.

Malformed release embedding descriptors are logged at the AgentBox boundary
but do not reject the user's prompt. The current FTS/Wiki path remains usable;
model-registration correctness is therefore observable without making an
optional accelerator a question-answering availability dependency.

The resolver makes one search with the user's original question. It does not
rewrite weak queries or retry with entity fragments, because query expansion
can silently change intent. It removes navigation pages, aggregates chunks by
leaf page, and inspects only a bounded candidate set. Local routing confidence
then combines:

- retrieval score as a weak signal;
- query-term coverage in page identity metadata such as path, title,
  description, and tags;
- query-term coverage in the matched passages.

The direct-hit gate additionally preserves intent qualifiers that recall-
oriented FTS tokenization may discard, including explicit negation and numeric
version/date tokens. A page for an opposite action or a different requested
version can remain an exploration lead but cannot become a direct hit merely
because the remaining words overlap.

A direct hit requires a conservative threshold in all three dimensions and no
similarly strong competing page. This intentionally prefers false negatives:
an overly strict gate costs extra Agent exploration, while an overly permissive
gate can turn a tangential similarity into a confident wrong answer.

Maintainers can improve the fast path without changing Raw source ownership by
adding accurate Wiki metadata such as aliases, tags, and `example_questions`.
Those fields make a known user phrasing part of the page's identity signal; they
do not force selection, bypass competing-page detection, or become answer text.

Only the winning direct-hit page is read through the current-turn citation
registrar. A direct hit is returned only when the complete page fits the
context-derived evidence budget; large pages remain unverified exploration
leads because isolated matched sections can omit applicability, deprecation,
version, or conflict context. The exact page snapshot has a stable `resultId`.
Even then, the Agent must validate subject, task, version, environment, and
scope and may reject the hit and explore the Wiki instead.

For weak or ambiguous matches the resolver returns `explore` with bounded,
unverified page hints and no page body. Those hints are leads for Agent
reasoning, not sources. Search failure returns `unavailable` with the same
exploration instruction. Repeated calls in one turn return an
`already_resolved` reminder so the model exits the accelerator instead of
looping through query rewrites.

The prompt does not inline a large `index.md`, because that inflates every first
turn and a truncated catalog creates false absence. The runtime injects the
actual scoped Wiki root and top-level `indexPath`; results also return
model-usable `readPath` values. In Kubernetes this may be the configured
`.siclaw/knowledge` mount, while LocalSpawner and Portal CLI layouts may use an
Agent-scoped or custom directory. Omitting the catalog from the prompt is a
context-budget choice, not a transfer of discovery authority to search.

### Next retrieval stage

Further optimization is evaluation-driven and must preserve the exploration
baseline:

1. Build a fixed set containing direct lookups, weak tangential matches,
   cross-library ambiguity, multi-page synthesis, version conflicts, and no-hit
   questions. The catcher-versus-sichek case is mandatory.
2. Measure both fast-path precision and end-answer quality. A new accelerator
   configuration ships only when its worst-case answer quality is no worse than
   Wiki exploration without embeddings.
3. Add mount generation metadata and traces for candidate channels, scores,
   direct-hit decisions, Agent rejection, page reads, and citations.
4. Calibrate thresholds or metadata only from observed errors. Do not add a
   completion gate that forces every factual question through
   `knowledge_search`; the valid completion condition is that the Agent used
   sufficient mounted evidence, whether reached by acceleration or exploration.

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

The GSP regression case is mandatory: `关掉 GSP 怎么操作` must reach and Read
`运维/GSP禁用方法.md` through either a maintained direct hit or Wiki
exploration; it must not answer from or cite an index page.

## Primary references

- [OpenAI Vector Store Search API](https://developers.openai.com/api/reference/typescript/resources/vector_stores/methods/search)
- [Anthropic: Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- [Microsoft GraphRAG query overview](https://microsoft.github.io/graphrag/query/overview/)
- [LangChain ParentDocumentRetriever](https://reference.langchain.com/python/langchain-classic/retrievers/parent_document_retriever/ParentDocumentRetriever)
- [RAG-Fusion](https://arxiv.org/abs/2402.03367)
