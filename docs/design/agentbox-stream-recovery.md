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
4. The rehydrated transcript ends in a successful tool result and has no
   unmatched tool calls.

The replacement continues through Pi's transcript continuation API. Runtime
never sends the original text or media again. Recovery is capped at three
AgentBox rebuilds and remains cancellable by the existing chat Stop signal.
After exhaustion, the user receives `AGENTBOX_FAILED`; an unconfirmed transport
break remains `STREAM_INTERRUPTED`.

Before a terminal Pod is deleted for recreation, the spawner logs bounded,
redacted Kubernetes evidence: Pod phase/reason, node/IP, and container waiting
or termination state including exit code, signal, timestamps, and restart
count. New AgentBoxes use `FallbackToLogsOnError` so Kubernetes can retain a
short termination message when the process did not write one explicitly.

Recovery fails closed when persistence is disabled, history is absent, the last
tool failed, a tool call is still pending, or the transcript already ends with
an assistant response. In those cases Runtime surfaces the error rather than
risk duplicating work.
