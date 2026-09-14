# Unified, evidence-backed memory

This change retires the previous embedding/FTS memory implementation in every
runtime shape. Local and remote memory implement the same bounded search, read,
catalog, feedback and explicit note contracts. Runtime knowledge routing remains
independent. Legacy source files and investigation exports are migration inputs,
not a second recall authority; no historical object versions are deleted.

AgentBox owns background model inference. The host selects immutable, committed
source material and authorized topic hints, leases a durable learning batch and
validates publication. A batch is scoped to owner, session, source revision,
memory generation and placement. Candidate text must quote supplied sources.
Publication, reviews, supersession and completion receipts commit together.
Expired leases and changed generations cannot publish; ambiguous replies retry
the same token and digest. Backoff and progress survive process restarts. The
AgentBox scheduler continues retrying while resident and drains bounded work on
shutdown; no external queue service is required.

Learning keeps preferences, conventions and task experience distinct. Task
experience retains observed/failed/proposed/uncertain status, applicability and
exact evidence; tool success alone cannot prove a remediation works. Multiple
claims in a user input are supported. Consolidation merges matching scoped
claims and produces a compact source directory; generated labels are retrieval
aids, never authoritative facts. Explicit remember/correct/forget requests are
append-only operations tied to a real user event. Topic tombstones prevent old
or concurrent learning from restoring forgotten claims.

Independent user claims from one input require disjoint literal quote spans;
overlapping candidates are rejected as a batch. This prevents a sibling claim's
quote from retaining another claim's old value after correction or forgetting.
Complete search excerpts can be used directly. Usage is recorded from final
citations; the model feedback tool is reserved for incorrect or irrelevant
evidence and adds no routine reporting round trip.

All recall paths recheck owner, source visibility, generation, expiry and
supersession. Small catalogs and bounded source windows share context budgets.
Usage and correction feedback affect ranking without turning repeated
retrieval into proof or extending a hard expiry. Compaction resets context-local
deduplication, not authorization or durable learning progress. Memory cannot
create skills, tools or execution permissions.

Validation includes both runtime shapes, long Unicode inputs, multi-claim and
cross-language corrections, explicit deletion races, failed/background retries,
restart recovery, multi-runtime ownership, stale and polluted evidence, and
same-model task/cost comparisons. Official Codex source mechanisms are a design
reference; equivalence of product effectiveness requires measured evidence.

Operational bounds: the host allows 64 background model batches per user per UTC
day, plus independent reserves of 16 explicit and 16 second-stage batches.
Trivial batches are admitted before reserving model quota.
Each batch has at most 24 primary fragments plus eight adjacent read-only context
fragments, sharing 32 KiB of text. Repeated failures reduce primary batch size;
eight failures cause a one-day cooldown. Learning leases last 120 seconds; model
requests have a 25-second deadline. Startup resumes eligible pending sessions of the authenticated owner through
a rotating metadata scan, without a foreground execution binding. The host
rechecks each historical session; publish/fail resolve its source from the
authority-issued token rather than a client-selected session. A completed unchanged source revision
and note watermark requires no object read. Sources expire after 90 days; explicit
forget tombstones persist within the memory generation. Auxiliary batch/note/job,
review, receipt and feedback metadata is collected without deleting OSS versions.


The second stage has its own durable lease, revision fencing and receipt. It
consumes chronological groups of phase-one evidence records and a filtered
previous outline; it does not open original transcripts or call executable tools.
The output is a bounded navigation plan. Stable statements are rendered from
authorized original quotes at read time. Complete short tasks include their
goal and evidence directly; long task pointers require source reading. This deliberately uses validated records instead of freeform summary
files as the factual authority. Independent task attempts remain readable.

Automatic briefs require the selected Agent's Memory Search capability. Clear,
expiry, source revocation and supersession are rechecked on every read; cached
context bookkeeping never grants access. Optional automatic recall has a 1.5-second
foreground deadline; late results neither enter context nor count as delivered.
The host batches source authorization and reads at most five source bodies. A final structured citation counts only
evidence supplied within the current context. Search exposure, explicit read and
cited usage are observed separately; usage affects ranking, never truth.

Local and remote use the same lexical metadata fields, ranking formula, query
anchors and shared fixtures. Each query inspects at most 1,001 metadata candidates;
1,001 means an explicit refine_query response with no partial matches. Source
ownership is checked in batches and repeated at the return boundary. There is no
vector database, BM25, embedding service or automatic Skill writer.
