# Subagent acceptance and recoverable tool output

## Verified failure

A map child in a test conversation returned an intent sentence with `stopReason=stop`
and `phase=final_answer`, without collecting evidence. The runtime equated response
completion with task completion. A sibling produced a full report, but reduction used
its 1,800-character display capsule, dropping decisive tail evidence. Cross-runtime
handoff restored chat history but not the plan ledger. A separate Web live-fold bug
left completed batch work active until refresh, suppressing the thinking indicator.

## Completion contract

After the normal delegated run, the same child context performs a tools-disabled semantic
assessment of the original assignment against the actual evidence. A legitimate zero-tool
analysis may pass. No keyword heuristic or required tool count determines success.
Incomplete work continues in the same session at most twice, under the original deadline.
Blocked, invalid/unavailable assessment, cancellation and exhausted continuations do not
become `done`. Provider output-limit responses continue and preserve their preceding
fragments. Review JSON is internal; it does not replace the public findings. Public phase,
stop reason and error metadata are retained for diagnosis.

This adds one model assessment to successful delegated execution and more only when a
bounded continuation is necessary. Semantic assessment improves acceptance, but is not
proof of correctness and does not guarantee model reasoning. Read-only tool restrictions,
model selection, cancellation, timeouts and session isolation continue to apply.

## Evidence and context budget

Capsules remain UI previews. Every report section is retained. Map-to-reduce passes full
reports when they fit. Otherwise it creates report artifacts in the reducer's own scope
and supplies references; the reducer uses existing `tool_result_read` / `tool_result_search`.
A storage/budget failure explicitly fails synthesis; no unmarked slice replaces evidence.
The parent receives source reports plus complete synthesis, with recoverable context
compaction. Background reports are saved before terminal job notification; the notification
includes an artifact reference so later history does not depend solely on the in-memory job
registry. `task_output` also resolves reports and provides byte pagination for command files.

## Security and lifecycle

The former `siclaw-output-*.log` shared temporary-file path is no longer created. The tool
wrapper establishes an AsyncLocalStorage invocation context, including detached children.
Command stdout is sanitized/projected and stderr redacted by the existing pipeline *before*
full-output retention. The wrapper captures that sanitized text before the 8,000-character
preview cut. MCP and other tool results use the same scoped artifact mechanism.

Files live under the session's `.tool-results/<hash(agentId,sessionId)>` directory. Direct
read/write/grep/bash access remains blocked; recovery tools accept opaque IDs, never paths.
Directory permissions are 0700, files 0600, writes atomic, and reads reject symlinks and
verify digest/size. The same provider call ID in different sessions yields different files.
Background command files also use the invocation scope; `task_output` verifies job ownership.
This preserves the existing boundary: trusted runtime/approved skill code can access
runtime storage; model-authored tools cannot read another session by choosing a path.

Artifacts retain the existing 64 MiB per-file and 256 MiB / 256 files per-scope limits.
Quota checks serialize across store instances. Valid existing evidence is not evicted to
make room; new writes fail explicitly. Artifacts expire after 24 hours. Startup and a
10-minute sweep remove expired artifacts and crash leftovers; old background output is
removed only when no live writer holds it. The sweeper discovers previous-process files
and never follows directory symlinks. Active output protection uses full paths, not a
shared basename. Handoff cache eviction preserves artifact files for their own TTL; a
receiving Agent or another runtime cannot use the old scope as a path-based bypass.
Cross-runtime artifact replication is not introduced; unavailable remote evidence must be
queried again through the receiving Agent’s authorized resources. Model and upstream command-capture limits still exist: content discarded
by an upstream provider/process cannot be recovered from an artifact, and truncation/error
notices must remain visible. No unsanitized stream is saved to bypass structural redaction.

## Handoff and UI

Replay ordered `task_event` history into only the requested session ledger, including
upserts, deletes and resets. Preserve task IDs and the observed high-water mark, then
persist a local snapshot. No Agent-global mutable handoff or plan state is introduced.

Web keeps batch live terminal status distinct from the durable detailed fold. This clears
the running latch without preventing the later report merge. The transcript gains a compact
jump-to-latest control while scrolled away (animated dots during execution, arrow when idle).
Clicking restores auto-follow; plan-only events do not pull readers away from old content.
Elapsed time has no duplicate spinner or empty process padding.

## Validation

Regression coverage includes intent-only continuation, valid zero-tool analysis, bounded
repairs, cancellation/error/length endings, complete report tail/middle recovery, reducer
storage failure, UTF-8 pagination, concurrent session isolation, sanitized secrets, symlink
rejection, shared quotas, startup cleanup, active output preservation and plan replay.
No new HTTP API or database schema is introduced; tool schemas include pagination fields.
