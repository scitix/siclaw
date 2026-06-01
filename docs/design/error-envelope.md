# Error Envelope (siclaw + management server)

> **Goal**: Whenever something fails along the chat flow (browser ↔ management web ↔ management API server ↔ siclaw-runtime ↔ agentbox ↔ model/tool), the user sees a clear in-line error bubble — not a silent stop. We do **not** exhaustively classify every failure; we ensure errors are never swallowed, and we tag the few we know how to handle specifically.

---

## 1. Wire schema

One canonical shape, shared by REST bodies and SSE error frames.

### `ErrorDetail` (the inner object)

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | ✅ | Identifier. Reuse the management server's `ErrCode*` values where possible (`INTERNAL_ERROR`, `CONNECTION_FAILED`, `CONNECTION_TIMEOUT`, `TOO_MANY_REQUESTS`, etc.). Default to `INTERNAL_ERROR` when nothing better is known. |
| `message` | string | ✅ | One-line, user-facing. English fine for v1; i18n later. |
| `retriable` | bool | ✅ | Whether the UI should show a retry button. Default to `true` when wrapping unknown errors (be optimistic). |
| `retryAfterMs` | number | ❌ | Hint for rate-limit/overload backoff. UI uses for retry button countdown. |
| `requestId` | string | ❌ | Trace ID for support handoff. Echoed in UI as small text. |
| `details` | unknown | ❌ | Opaque extra info, folded behind a "Details" disclosure in UI. Truncate to ~2 KB to protect the renderer. |

### Transports

| Channel | Body shape |
|---|---|
| **REST 4xx/5xx** | `{ "error": ErrorDetail }` (matches the management server's existing `ErrorResponse`) |
| **SSE error event** | `event: error\ndata: <ErrorDetail>\n\n` (data is `ErrorDetail` directly — the event name discriminates, no extra wrapping) |
| **WS RPC error** (management server↔runtime) | `{ ok: false, error: ErrorDetail }` — replaces today's `{OK, Error: string}` shape gradually (see §5 migration) |

---

## 2. Code values (initial set, extensible)

Hard rule: **start small, add only when we actually emit one in code**. No speculative codes.

### Generic / fallback
- `INTERNAL_ERROR` — anything we couldn't classify. Always default.
- `BAD_REQUEST` — caller sent garbage (matches the management server's `ErrCodeBadRequest`).

### Connectivity & infra
- `CONNECTION_FAILED` — the management server can't reach the siclaw runtime ("no Runtime connected for agent X"). Maps to existing `ErrCodeConnectionFailed`.
- `CONNECTION_TIMEOUT` — WS RPC timed out. Maps to existing `ErrCodeConnectionTimeout`.
- `STREAM_INTERRUPTED` — SSE / WS connection broke mid-stream.

### Chat-specific
- `AGENT_NOT_FOUND` — agentId doesn't exist or user can't access it.
- `AGENTBOX_FAILED` — runtime couldn't spawn or lost the agentbox process.

### Model / tool (best-effort tagging when we recognize)
- `MODEL_RATE_LIMIT` (with `retryAfterMs`) — upstream 429.
- `MODEL_OVERLOADED` — upstream 529 / 503.
- `MODEL_ERROR` — generic model API failure.
- `TOOL_ERROR` — tool execution failed (kept generic; per-tool details go in `details`).

That's 11 codes total. Anything else is `INTERNAL_ERROR`. We add codes as we hit specific UX needs — not before.

---

## 3. Propagation rules

Two rules. No origin tracking, no hops, no trace stack at this stage.

### R1 — Passthrough envelopes
If a layer's catch sees an object that already looks like `ErrorDetail` (has `code` + `message` + `retriable`), forward it verbatim. **Never re-wrap.** Re-wrapping loses the inner code.

### R2 — Wrap raw errors
If a layer's catch sees a raw `Error` / Go `error`, wrap into `ErrorDetail`:
- `code`: `INTERNAL_ERROR` (or a more specific one if the call site knows).
- `message`: `err.message` (for Go: `err.Error()`).
- `retriable`: `true` by default. Only set `false` for known-permanent failures (`AGENT_NOT_FOUND`, validation errors, `MODEL_CONTEXT_TOO_LONG`, etc.).

That's it.

---

## 4. Front-end rendering

Two frontends — `siclaw/portal-web` and the management server's web UI — both implement the same rules.

### `<ErrorBubble>` component
- Inline red-toned bubble in the chat message stream (same column as agent messages, not a toast)
- Shows `message` prominently
- "Retry" button if `retriable === true` (with countdown if `retryAfterMs` provided)
- Footer: small `requestId` (copyable)
- "Details" disclosure for `details` (collapsed by default)

### `usePilotChat` integration
On SSE `event: error` or fetch failure:
1. Parse data → `ErrorDetail` (with backward-compat fallback for old `{error: "string"}` shape)
2. Push a synthetic message into chat history with type `error` and the ErrorDetail
3. Stop the stream, clear "streaming" state
4. The chat list renderer checks message type and uses `<ErrorBubble>` for `error` messages

### Backward-compat parser
```ts
function parseErrorDetail(raw: unknown): ErrorDetail {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // New envelope shape: {code, message, retriable, ...}
    if (typeof obj.code === "string" && typeof obj.message === "string") {
      return obj as ErrorDetail;
    }
    // REST body shape: {error: ErrorDetail | string}
    if ("error" in obj) {
      const e = obj.error;
      if (typeof e === "object" && e !== null) return parseErrorDetail(e);
      if (typeof e === "string") {
        return { code: "INTERNAL_ERROR", message: e, retriable: true };
      }
    }
  }
  return { code: "INTERNAL_ERROR", message: String(raw), retriable: true };
}
```

The frontend handles both old and new shapes during migration. After all backends emit the new shape, the legacy branches stay as defensive code (cheap insurance).

---

## 5. Migration & scope

We are **not** rewriting all 402 catch blocks in siclaw or all 15+ `gin.H{"error": ...}` in the management server. Scope for v1:

### Required (chat-flow user-visible)

**siclaw** (TS):
- `src/lib/error-envelope.ts` (new) — types + `wrapError()` + `sseErrorFrame()`
- `src/gateway/server.ts` — chat SSE catch, RPC error returns
- `src/gateway/sse-consumer.ts` — model `stopReason="error"` path: emit envelope as SSE error frame
- `src/agentbox/http-server.ts` — chat steer/prompt/abort error paths
- `portal-web/src/components/chat/ErrorBubble.tsx` (new)
- `portal-web/src/hooks/usePilotChat.ts` — SSE error + fetch error handling
- `portal-web/src/components/chat/PilotArea.tsx` (or message renderer) — render error type

**Management server** (Go + React):
- `pkg/model/response.go` — extend `ErrorDetail` with `Retriable`, `RetryAfterMs`, `RequestId`; new `RespondErrorEnvelope()` and `WriteSSEError()` helpers
- `internal/siclaw/proxy/handler.go` — replace `gin.H{"error": ...}` with envelope helpers; map `"no Runtime connected"` → `CONNECTION_FAILED`, RPC timeout → `CONNECTION_TIMEOUT`
- `web/components/siclaw/chat/error-bubble.tsx` (new)
- `web/hooks/siclaw/use-pilot-chat.ts` — SSE error + fetch error handling
- `web/components/siclaw/chat/pilot/pilot-area.tsx` — render error type

### Not in scope (v1)
- 400 other siclaw catches that are not on the user-visible chat path
- Other management-server handlers (host, cluster, credential, etc.) — they use proper `RespondError` already; the gap was siclaw proxy bypassing it
- Auto-classification of every model/tool error subtype — handled per-call as we encounter need

### Future (v2+, when actual UX gaps surface)
- More specific codes (per-LLM-provider, per-tool)
- i18n message lookup keyed by `code`
- requestId propagation end-to-end (currently best-effort)
- ESLint rule enforcing `catch` blocks emit envelope on user-visible paths

---

## 6. Cleanliness self-check

| Property | Pass? | Why |
|---|---|---|
| Single source of truth for shape | ✅ | One `ErrorDetail`, two transports |
| Wire-compatible with the management server's existing `ErrorResponse` | ✅ | `{error: ErrorDetail}` matches; only adds optional fields |
| Frontend renders without per-code branching | ✅ | One bubble + `retriable` flag drives all UX; code only used for optional friendlier copy via i18n later |
| New code added without UI change | ✅ | Default render uses `message` directly |
| Backward-compatible during migration | ✅ | `parseErrorDetail()` handles both `{error: string}` and `{error: ErrorDetail}` |
| Doesn't require touching every catch block | ✅ | Scope is the user-visible chat flow; rest stays as-is, can migrate later |
| Two simple propagation rules | ✅ | Passthrough or wrap. No hop tracking. |

If a new requirement (e.g. cross-layer trace) breaks one of these, we revisit. Until then, keep it boring.
