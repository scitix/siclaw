# AgentBox stream recovery

When Runtime loses an AgentBox SSE stream, it does not immediately replay the
request. The original user prompt may already have executed tools, so replaying
it can duplicate cluster reads or mutations.

Runtime recovers a chat turn only when all of these conditions hold:

1. The stream failure is a recognized connection-level failure.
2. Kubernetes confirms that the AgentBox is gone or terminal. A healthy Pod
   with a broken client connection is not rebuilt because AgentBox SSE has no
   event cursor for duplicate-free reattachment.
3. The replacement Pod reaches Ready and rehydrates the same Pi session JSONL
   from the agent PVC.
4. The rehydrated transcript is eligible for continuation: last message is a
   successful `toolResult`, or a `user` message (crash during the first LLM
   call — no tool side effects yet). No unmatched tool calls.

The replacement continues through Pi's transcript continuation API
(`agent.continue()` on a cold-rehydrated session). Runtime never sends the
original text or media again. Recovery is capped at three AgentBox rebuilds
and remains cancellable by the existing chat Stop signal. After exhaustion,
the user receives `AGENTBOX_FAILED`; an unconfirmed transport break remains
`STREAM_INTERRUPTED`.

Before a terminal Pod is deleted for recreation, the spawner logs bounded,
redacted Kubernetes evidence: Pod phase/reason, node/IP, and container waiting
or termination state including exit code, signal, timestamps, and restart
count. New AgentBoxes use `FallbackToLogsOnError` so Kubernetes can retain a
short termination message when the process did not write one explicitly.

Recovery fails closed when persistence is disabled, history is absent, the last
tool failed, a tool call is still pending, or the transcript ends with an
assistant message that still has unmatched tool calls. In those cases Runtime
surfaces the error rather than risk duplicating work.

## Accepted gaps vs a warm `_runAgentPrompt` turn

Resume uses `agent.continue()` rather than pi's full `_runAgentPrompt` wrapper
(no upstream `continueRun()` API yet). Compared with a normal prompt:

1. **No LLM auto-retry** for transient 429/overload on the resumed turn.
2. **No post-run auto-compaction loop** (`_checkCompaction` → continue). We
   **do** run `ensureContextForModelPrompt` before `continue()` so near-ceiling
   sessions compact once or fail closed before paying for a useless rebuild.
3. **`agent_settled` / post-run queue drain** may not fire the same way as a
   full prompt path for the duration of the continued turn.

These are non-safety gaps (failures surface). Upstreaming a session-level
continuation that reuses `_runAgentPrompt`'s post-run loop is the clean fix.

## Multi-AgentBox note

Recovery acquisition is **session-aware** (`getOrCreate(agentId, undefined,
sessionId)`). When multi-box pooling is active, confirmation still uses
`inspect(agentId)` (instance-level); a future pass should pin confirmation to
the session's pod UID so concurrent sessions on one agent do not mis-confirm.
