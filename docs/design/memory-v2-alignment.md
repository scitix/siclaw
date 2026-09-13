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

Operational bounds: the host allows at most 64 batches per user per UTC day.
Each batch has at most 24 primary fragments plus eight adjacent read-only context
fragments, sharing 32 KiB of text. Repeated failures reduce primary batch size;
eight failures cause a one-day cooldown. Learning leases last 120 seconds; model
requests have a 25-second deadline. Startup resumes the certificate-bound session
without a foreground execution binding. A completed unchanged source revision
and note watermark requires no object read. Sources expire after 90 days; explicit
forget tombstones persist within the memory generation. Auxiliary batch/note/job,
review, receipt and feedback metadata is collected without deleting OSS versions.
