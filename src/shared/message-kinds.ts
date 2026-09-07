/**
 * What `chat_messages.metadata.kind` can say, and which of those values mean
 * "the runtime talking to itself" rather than "a person asking something".
 *
 * The runtime writes several kinds of row under the user role because that is
 * the channel the model reads from: a to-do ledger it maintains itself, status
 * reports from delegated children, the notification that wakes it when a
 * background job ends. None of these are shown in a transcript and none of them
 * are questions — but every one of them used to be counted as a prompt.
 *
 * This file exists for the reason {@link ../portal/session-origin.ts} exists,
 * one axis over. That one was written after `'subagent'` shipped and eight
 * hardcoded origin predicates failed to learn about it. The same shape had
 * already formed here: four call sites each spelled the kind filter out by
 * hand, all four naming a single kind, so the largest category by far —
 * `task_event` — was counted as a prompt everywhere.
 *
 * **Adding a kind means adding it HERE**, and the metadata type below is what
 * makes that more than a request: it narrows `kind` to
 * {@link CHAT_MESSAGE_KINDS}, so an unregistered value fails to compile, and
 * registering it means arriving at this file — where the next question, whether
 * a human asked it, is the one being asked. The rule was a comment first, and a
 * comment is exactly what the origin predicates had; it did not survive
 * `subagent` there. Three of the seven values below were found by the compiler
 * rather than by an author.
 *
 * The check has one hole, and it is worth knowing precisely because it is not
 * where you would guess. TypeScript rejects an unregistered kind in an inline
 * object literal, but a value that arrives as `Record<string, unknown>` is
 * assignable to this type with no error — the source's index signature does not
 * have to satisfy the target's declared optional property. So a helper that
 * builds metadata and returns an open record slips past, which is exactly how
 * `model_route_notice` was written for a release without ever being registered.
 * No shape of this type fixes that (a version without the index signature
 * rejects every literal carrying a payload key, i.e. all of them), so the
 * builders are typed at their own declarations instead, and
 * `portal/message-kind-invariants.test.ts` pins that they stay typed.
 */

/**
 * Every kind THIS repository persists to `chat_messages.metadata.kind`.
 *
 * Scoped to what it can prove, deliberately. It is not "every kind that exists
 * in the column": the Portal frontend synthesizes display-only rows that are
 * never persisted (`delegation_status_notice`), and sicore's own readers know
 * kinds this runtime does not write (`investigation_plan_snapshot`,
 * `task_prompt`). A registry that claimed those would be asserting something
 * nothing in this tree can check.
 *
 * Not every kind is about prompts — `error_response` and `model_route_notice`
 * ride assistant rows — so this list is broader than
 * {@link SYNTHETIC_USER_KINDS} by design. Its job is to be the place a new kind
 * has to pass through.
 */
export const CHAT_MESSAGE_KINDS = [
  // The parent's ledger of a delegated child's progress. role='user'.
  "delegation_event",
  // A turn that ended in failure, persisted so a reload shows what the live
  // stream showed. role='assistant' — never a prompt, and listed here only
  // because it shares the column.
  "error_response",
  // A background job's completion marker. Carries role='user' only so the model
  // is woken by it.
  "exec_job_event",
  // A model-routing switch or recovery, persisted so a reload shows the fallback
  // that happened. role='assistant', like error_response.
  "model_route_notice",
  // A person typing WHILE a turn is running. role='user', and a real question:
  // it is tagged only so the frontend can draw it as a steer bubble instead of
  // a plain user message. Deliberately absent from SYNTHETIC_USER_KINDS — the
  // tag describes when it was sent, not who wrote it.
  "steer",
  // The agent's own to-do ledger, persisted so a plan survives a page refresh.
  // By volume this is the largest by an order of magnitude.
  "task_event",
  // The <task_notification> text injected when a background job finishes.
  "task_notification",
  // A model call's reasoning text, persisted as its own row right before the
  // model-call row it belongs to (`metadata.llm_round` links them). role='assistant';
  // hidden in transcripts, excluded from search and reply counts.
  "thinking",
] as const;

export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

/**
 * The `role='user'` rows that are workflow plumbing rather than a person's
 * question — i.e. the rows a prompt count must exclude.
 *
 * **This list has no counterpart in sicore, and earlier revisions of this
 * comment claimed one that does not exist.** For the record, because the wrong
 * pointer is worse than none: sicore counts prompts as every `role='user'` row
 * with no kind filter at all (`internal/siclaw/metrics/handler.go`,
 * `internal/siclaw/adapter/rpc.go`), so its figure is inflated by MORE than
 * this one was. What sicore does have is
 * `internal/siclaw/metrics/trace_kinds.go`, whose `TraceNonPromptUserKinds`
 * answers an ADJACENT question — which user row may be a trace's title or an
 * analysis input — and `internal/siclaw/chat/service.go`'s
 * feedback-attribution LIKE list, which answers a third. Neither is this.
 *
 * That the questions differ is why the sets differ, and `steer` is the case to
 * understand before syncing anything: it belongs in sicore's set (a mid-turn
 * steer is a poor session title) and must stay OUT of this one (it is a real
 * question a person asked). Copying one list into the other would be wrong in
 * both directions.
 *
 * The SQL that consumes this list lives in `portal/human-prompt.ts`: it needs
 * the database driver to pick a dialect, and `src/shared` is bundled into the
 * AgentBox image and must not reach into the gateway.
 */
export const SYNTHETIC_USER_KINDS = [
  "delegation_event",
  "exec_job_event",
  "task_event",
  "task_notification",
] as const satisfies readonly ChatMessageKind[];

export type SyntheticUserKind = (typeof SYNTHETIC_USER_KINDS)[number];

/**
 * Metadata persisted alongside a `chat_messages` row.
 *
 * Open on every other key — metadata carries per-kind payloads, model-routing
 * detail and channel bookkeeping, and typing all of that here would only move
 * the guesswork. `kind` is the one key with a cross-cutting meaning: it decides
 * whether the row counts as a human prompt, so it is narrowed to the registry
 * above and a literal outside it is a compile error at the write site.
 */
export type ChatMessageMetadata = {
  kind?: ChatMessageKind;
  [key: string]: unknown;
};
