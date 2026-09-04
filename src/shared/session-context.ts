/**
 * The session-context contract, in the one place BOTH the AgentBox and the
 * gateway can import from.
 *
 * ⚠️ **`src/agentbox` MUST NOT import `src/lib`.** That boundary is not enforced
 * by tsconfig — `tsconfig.agentbox.json` typechecks against a full working tree,
 * where `../lib/…` resolves perfectly well. It is enforced by
 * `Dockerfile.agentbox`, which copies only `src/{agentbox,core,cron,knowledge,
 * memory,shared,tools}`. So a cross-boundary import typechecks locally, passes
 * every test, and then fails the image build with `Cannot find module`.
 *
 * That is exactly what happened: the resume work put
 * `SESSION_CONTEXT_UNAVAILABLE` into `lib/error-envelope.ts` and had
 * `agentbox/http-server.ts` import `ErrorCodes` from there. Green locally, and
 * the agentbox image would not build. `src/shared` exists for this — anything
 * both halves need lives here, and `lib` references THIS rather than the
 * reverse, so the two cannot drift apart.
 */

/** The error code for a continuation whose session context cannot be restored. */
export const SESSION_CONTEXT_UNAVAILABLE_CODE = "SESSION_CONTEXT_UNAVAILABLE";

/**
 * The HTTP status `/api/prompt` answers with. Non-retriable: the context is
 * gone, so retrying the same call cannot succeed — the caller has to decide
 * whether to start a fresh session instead.
 */
export const SESSION_CONTEXT_UNAVAILABLE_STATUS = 412;
