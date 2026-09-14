# Preserve consumption acknowledgements for concurrent sends

When a concurrent `chat.send` joins an active turn as a steer, its background
handler returns before the owning stream receives the user-message consumption
acknowledgement. Its unconditional cleanup previously removed the session's
pending user rows. An input the AgentBox had consumed could consequently remain
unsequenced and be excluded when conversation history was reconstructed.

Only a handler that acquired the turn lock and did not steer into an existing turn
now clears the pending queue. Both Runtime-busy and AgentBox-409 fallback paths
retain their entries. The owning turn still discards inputs it did not consume
when it ends. RPC shapes and persistence schemas are unchanged.

## Automated validation

Validated on official `main` at `d9505a52` on 2026-09-14:

- The real `chat.send` handlers, with the AgentBox and persistence calls mocked,
  exercise a long-running reply, concurrent input, the original stream's delayed
  consumption callback, and the real `loadFullHistory` filter. A separate case
  covers the AgentBox-409 fallback; owner cleanup is also checked.
- Both new regression cases fail on the original implementation and pass with
  the fix.
- Five targeted Runtime test files passed, covering 159 cases.
- Full suite: 377 files and 7,607 tests passed.
- `npx tsc --noEmit`, `npm run build`, and `git diff --check` passed.

The review follow-up clarified that 409 retention depends on pi replaying an
unconsumed steer on a later prompt and removed fixed sleeps from the two cases.
Both cases still failed with an unconditional sweep; all 42 cases in the two
affected Runtime test files passed with the guard. TypeScript and diff checks
passed, and transpilation without comments confirmed unchanged Runtime code.
Full-suite, build, and deployed Runtime validation were completed before this
comment and test-only follow-up.

## Deployed Runtime validation

The Runtime behavior was also checked on a test deployment through an integration
client. This validates the concurrent-send contract rather than claiming every
client permits concurrent sends to an active conversation.

Before the fix, Runtime logs confirmed an input was steered into the active turn
and the model acknowledged it, but its persisted user row remained
`seq_sequenced = 0`.

After the fix, the same path retained the input until consumption. Its user row
was sequenced between the original answer and the acknowledgement. After the
AgentBox was automatically recycled, a new instance with empty transient session
storage fetched history from the control plane. Its log confirmed reconstruction,
and inspection of the new transcript found the original user message exactly
once. A subsequent model response reproduced the complete message without tools.

The check did not modify stored consumption flags or seed a session cache. It
confirms preservation of consumed inputs through actual database-backed history
reconstruction. Previously incorrect historical flags are not backfilled.
