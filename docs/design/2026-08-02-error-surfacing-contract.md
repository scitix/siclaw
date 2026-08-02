# Surfacing a failed turn to a user

**Status:** implemented
**Date:** 2026-08-02

## Context

Two events describe the same failure, and they leave siclaw on the same channel:

```
message_end  { role:"assistant", stopReason:"error", errorMessage:"…" }   ← the fact
stream_error { code:"MODEL_ERROR", message:"…" }                          ← the instruction
```

Nothing in either payload says which one a UI is supposed to draw. A consumer
that renders both shows two identical bubbles for one failure — which is what
happened, and the reason this document exists.

The split is not accidental and cannot be collapsed:

- **`message_end` is the fact stream.** Metrics, the a2a task tracker, and
  anything reconstructing a turn consume it. siclaw cannot withhold it just
  because the turn failed.
- **`stream_error` is the render signal.** A consumer watching only the raw
  stream sees a turn that stops with an empty assistant message and no
  explanation. This event is synthesised so there is something to show.

## The contract

> **Render from `stream_error`. Never from `message_end`.**

Three properties make `stream_error` authoritative, and each one is a reason
`message_end` cannot substitute for it.

**Deduped.** pi retries internally, so a single failed turn emits several error
`message_end`s. `stream_error` is emitted once per turn. Rendering from
`message_end` gives one bubble per internal attempt.

**Revocable — the important one.** When an in-turn retry succeeds, siclaw
suppresses `stream_error`: the turn recovered, so nothing should be shown. The
`message_end` for the failed attempt was already sent and cannot be taken back.
A consumer rendering from it paints a red error over a successful answer. This
is worse than a duplicate: it is a failure that did not happen.

**Last error wins.** Within a turn, `stream_error` carries the LAST error, not
the first. The first is usually the transport giving up ("Request timed out.")
while the retry that follows carries the provider's actual verdict
("unsupported_protocol") — the one that names the fix.

### `stream_error` is not terminal

It is flushed at every **turn** boundary, not at the end of the request. One
request can carry several independent turns: a steer adds a question to a run
already in flight.

```
user "1" → fails
user "2" → starts     ← turn 1's stream_error is flushed HERE
         → fails
user "3" → starts     ← turn 2's stream_error is flushed here
         → succeeds
```

So an error is followed by more events. **Termination is `done` /
`prompt_done`.** A consumer that tears the stream down on an error loses every
turn after the first failure.

This was not always true — before 2026-08 the error was held to the end of the
request — and a consumer had read the old timing as "nothing further is
actionable". That reading was never guaranteed, but nothing recorded that it
wasn't, which is why it is stated here.

### Why per-turn

The suppression rule ("an in-turn retry recovered this, leave nothing behind")
is only ever true *within* a turn. Scoped to the whole request, the last turn
succeeding erased every earlier turn's failure — three steered questions, the
first two failing, produced no error rows at all. The live page showed bubbles
the consumer had drawn itself; a reload read the database and found questions
with no answers and no explanation.

Persisted error rows follow the same scoping, so a reload agrees with what was
on screen while it was happening.

### Ordering guarantee

Turn N's `stream_error` is emitted BEFORE turn N+1's events. The flush happens
inside the `message_start` handler for the new user message, which runs before
that event is passed through, so a consumer never has two turns' errors in
flight at once.

This matters because it is what makes a single-slot buffer safe on the consumer
side — a consumer holding "the error I have not drawn yet" needs to know it can
only ever hold one. Moving the flush after the passthrough would silently
overwrite turn N's error with turn N+1's.

## What a consumer should do

```
on message_end with stopReason "error":
    remember it for this turn.  Do NOT render.

on message_end that carried real output (text or a tool call):
    FORGET what you remembered.  A retry recovered the turn.

on stream_error:
    render.  Clear what you remembered.  Do NOT tear down the stream.

on done / prompt_done:
    if something is still remembered, render it now.
```

**The second rule is not optional, and it is the one that gets left out.** It is
the consumer's half of revocation. siclaw withdraws `stream_error` when a turn
recovers, but the failing `message_end` is already in the consumer's hands — so
a consumer that buffers without also forgetting resurrects the withdrawn error
at the fallback step, and paints it under the answer that succeeded. That is the
original bug, reintroduced through the safety net meant to prevent it. Worse, it
is invisible on reload: siclaw wrote no row for a turn that recovered, so the
live view and the reloaded view disagree.

The condition is "produced output", not "stopReason is not error". An empty 200
arrives as `stop` with zero content blocks — the case pi's own retry loop exists
for — and a Stop arrives as `aborted`. Neither is a recovery. siclaw applies the
same test (`messageProducedOutput`) before withdrawing, so a consumer using a
weaker one will disagree with it.

The last step is a fallback, not the main path. `stream_error` is emitted from
a `finally`, so it survives a mid-stream throw — but it only exists on streams
consumed through `consumeAgentSse`. A consumer with a path that reads the box's
raw stream directly has no `stream_error` there, and that is what the fallback
covers.

Compliance is worth checking rather than assuming: siclaw's own Portal
frontend renders only from `stream_error` and has never shown a duplicate,
which is the useful reference.

### This contract has a version floor

Before 2026-08 the error was emitted on the FIRST failing `message_end`, i.e.
in the middle of pi's retry loop, so `agent_start` events followed it. A
consumer that treats an error as "this turn is over" is only safe against a
runtime that emits it after the retries settle. Pin the pairing when changing
consumer behaviour on the strength of it.

## Consequences

- Adding a render path for a new error-shaped event means asking whether it is
  a fact or an instruction. If a consumer must decide *whether* to show
  something, the decision belongs in `sse-consumer.ts`, where suppression and
  dedup already live — not in each consumer.
- `stream_error`'s payload carries no turn index and no "more follows" flag on
  purpose. The stream already has an explicit end; a second way to ask the same
  question is a second thing to get wrong.
- Changing WHEN `stream_error` is emitted is a consumer-visible contract
  change even though no type changes. It needs saying out loud, in the PR that
  does it.
