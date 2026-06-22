# Unified model-routing prompt entry

**Status:** implemented (branch `arch/unify-prompt-entry`)
**Date:** 2026-06-22

## Context

A user prompt was driven by one of two code paths, chosen by a gate:

```
routeEnabled = shouldUseModelRouteRunner(policy, state)   // ≥2 candidates && not user-pinned
promptPromise = routeEnabled
  ? runPromptWithModelRouting(...)   // buffered/optimistic routing runner
  : brain.prompt(...)                // bare live path
```

The same `routeEnabled ? runner : brain.prompt` ternary existed in **both** the interactive path (`src/agentbox/http-server.ts`) and the synthetic/background path (`src/agentbox/session.ts`). The gate (`_routeBrainEventsThroughExtra`) leaked into every downstream consumer — SSE, persistence (`sse-consumer.ts`), and (on the tracing branch) the OpenTelemetry recorder — each had to branch on "which path produced these events."

This split had a concrete cost for downstream collection: a non-routed turn emitted no `model_route_*` events, so anything reconstructing per-model usage/cost (e.g. a Langfuse/OTel exporter) had no model identity for the common case and could not attribute a turn to its model uniformly.

The bare path existed for one reason: when the routing runner was pure-buffering it would have killed live streaming for turns with nothing to fall back to. That reason **disappeared** once `optimisticPrimaryStream` (already on `main`) made the primary candidate stream live — a single-candidate run through the runner is now behaviourally identical to a bare prompt.

## Decision

Make `runPromptWithModelRouting` the **single entry**. A new helper resolves the policy every caller passes:

```
resolveEffectivePolicy(configured, state, currentModel):
  - real multi-candidate routing applies  → the configured policy, unchanged
  - otherwise (routing off / single candidate / user-pinned) → a single-candidate
    policy built from the current model
  - no current model → undefined (runner's own guard does a bare brain.prompt)
```

Both call sites now invoke the runner unconditionally. The single candidate carries **no** `modelConfig`, so `runAttempt`'s `modelNeedsUpdate` guard skips a redundant `setModel` and runtime params (`reasoning_effort`) applied during setup survive.

## Contracts (what must hold)

- **One entry, one channel.** Every prompt with a resolvable model streams through the runner's `emitBrainEvent`; the live `_eventBuffer` subscription is suppressed (`_routeBrainEventsThroughExtra = effectivePolicy !== undefined`).
- **Uniform telemetry.** Every such turn emits `model_route_start` + `model_route_success`. A single-candidate success carries `isFallback:false` and never a `model_route_switch`. Consumers MUST treat `model_route_*` as present-on-every-turn and gate any "switched model" UI on `is_fallback || recovered` (the gateway `sse-consumer.ts` and `portal-web` already do).
- **User pin = no fallback.** A user-pinned model resolves to a single candidate (the pinned model), ignoring configured fallback candidates.
- **No-current-model edge.** `effectivePolicy === undefined` → bare `brain.prompt`; events flow through the live `_eventBuffer`/SSE subscription and persist inline (no `model_route_start`, so `isRoutingTurn` stays false in `sse-consumer.ts`).
- **Synthetic turns** still pass `optimisticPrimaryStream:false` (they persist from collected events and have no live viewer).
- All prior routing contracts are preserved: optimistic primary + `model_route_rollback`, commit-gated persistence, setup-failure `message_end(stopReason:"error")` synthesis, exhausted runs RESOLVE (only `prompt_error` rejects).

## Consequences

- **Behaviour change — preflight on every turn.** A turn that was previously a bare prompt now runs the runner's preflight (`ensureContextForModelPrompt`). For an over-budget turn this means proactive compaction (compaction on) or a clean preflight failure (compaction off) instead of a mid-stream failure. This is a deliberate, arguably cleaner outcome; it is invisible to the mocked unit suite (no real brain) — verify against a live brain when changing context budgeting.
- **Deploy ordering.** agentbox now emits `model_route_*` on every turn; the paired gateway `sse-consumer.ts` MUST be a version that commit-gates routed turns. Do not run a new agentbox against a pre-routing-commit-gating gateway.
- **Partial win, honestly.** The dual *entry* is gone (one call site in each file). The event-routing gate (`_routeBrainEventsThroughExtra` / `_eventBuffer`) is **retained** for the no-current-model edge — it is narrower in meaning now ("did a policy resolve") but not removed. Removing it entirely would require eliminating the bare-prompt fallback, which is out of scope.

## Why this is the right base for Langfuse/OTel integration

With one entry, the tracing recorder has a single event source and every turn carries its model identity via `model_route_success.modelId` — per-model usage/cost attribution becomes uniform instead of missing on non-routed turns. This removes the root cause of the earlier per-model collection gap rather than patching the ROOT span's model label.

## Verification

`npx tsc --noEmit` clean; full suite `vitest run` = 3628 passed / 2 skipped. New tests: `resolveEffectivePolicy` unit cases (real routing passthrough / single-candidate / user-pin / no-model) and an http integration test asserting a plain disabled-routing turn still emits `model_route_success(isFallback:false)` with no switch. Adversarially reviewed (all targeted risks hold; see branch review).
