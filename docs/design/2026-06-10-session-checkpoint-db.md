# AgentBox Session Checkpoint — DB-backed, NFS Removal

> Status: accepted (supersedes `2026-06-10-agentbox-session-checkpoint-oss.md` — the
> OSS variant was rejected for v1; blob storage moved to the Portal DB. The `storage`
> dimension of the contract below keeps the OSS door open without changing callers.)
> Date: 2026-06-10
> Scope: Siclaw only.

## 1. Problem

AgentBox `user-data` (pi-agent session JSONL, plan ledger, model-route state) currently
requires a shared RWX PVC (NFS on the manager clusters). The NFS is being decommissioned.

Two facts make a checkpoint design sufficient:

1. **Restart is routine, not exceptional.** AgentBox self-destructs after 5 idle minutes
   (`http-server.ts` idle timer); session continuity across that boundary is what the
   PVC provides today. At idle-exit time every session has already been released, so a
   release-time checkpoint fully covers the self-destruct path.
2. **User-visible chat history is already DB-backed** (every message/tool row is written
   through `chat.appendMessage`). What the checkpoint protects is the *framework's
   resumable execution state* only. Worst-case loss (hard crash between checkpoints) is
   the in-flight burst of agent context — never rendered chat history.

## 2. Shape

```
AgentBox (emptyDir, unchanged POSIX writes)
  release(30s idle) / SIGTERM(preStop)        getOrCreate() with empty dir
        │ pack tar.gz (deterministic)               │ fetch + sha256 verify + extract
        ▼                                           ▼
Gateway internal mTLS API  (identity = client cert; same path in K8s and local mode)
        │ FrontendWsClient RPC: checkpoint.save / checkpoint.load
        ▼
RPC server (standalone: Portal adapter → MySQL/SQLite; production: Sicore → PostgreSQL)
```

The Gateway never branches on deployment mode: persistence is always delegated over the
phone-home WS RPC, exactly like `chat.appendMessage` and `config.getKnowledgeBundle`.

## 3. RPC contract (the only cross-repo coupling point)

Two methods. Sicore implements the same two against `siclaw_session_checkpoints`.

### `checkpoint.save`

Request:

```jsonc
{
  "agent_id":   "…",        // injected by Gateway from mTLS identity — never client-supplied
  "session_id": "…",
  "revision":   3,           // strictly monotonic per (agent_id, session_id)
  "sha256":     "<hex of compressed bytes>",
  "size_bytes": 123456,      // compressed size
  "data_base64": "…"
}
```

Response: `{ "ok": true, "revision": 3 }`
Conflict: `{ "ok": false, "error": "revision_conflict", "latest": 5 }` — returned (not
thrown) when `revision <= MAX(existing revision)`. The single-writer assumption makes
this an anomaly signal (stale counter after takeover, or split-brain); the client may
re-sync once from `latest` and retry, then must give up loudly.

Retention: after a successful insert the server deletes revisions `<= revision - 3`
(keep last 3). GC ships with v1, not as a follow-up.

### `checkpoint.load`

Request: `{ "agent_id", "session_id", "before_revision"?: number, "meta_only"?: bool }`

Response (found): `{ "found": true, "revision", "sha256", "size_bytes", "data_base64"? }`
— latest revision, or latest `< before_revision` (integrity-failure fallback walk).
`meta_only: true` omits `data_base64` (used to re-sync the revision counter cheaply).
Response (none): `{ "found": false }`.

## 4. Payload contract

- Archive: `tar.gz` of the session directory **contents** (`agent/sessions/<id>/`),
  relative paths only. Created with `portable + noMtime` so identical content yields
  identical bytes — the client dedups by sha256 and skips no-op uploads.
- Excluded by construction: `agent/tasks/*.output` live outside the session dir.
  Task outputs are 24h-GC'd runtime traces; they are deliberately not durable.
- Hard cap: 64 MiB compressed. An over-cap session logs an error and skips checkpointing
  (bounded failure: that session degrades to fresh-on-restart; nothing else is affected).
- Extraction validates: gzip integrity, no absolute paths, no `..` traversal, per-file
  and total size caps, then writes into the (empty) session dir.

## 5. Client semantics (AgentBox)

- **Checkpoint triggers**: session `release()` (fires 30s after each prompt completes —
  this is the workhorse), and process `SIGTERM` (preStop) for sessions still live.
  Per-turn checkpointing was considered and deferred: release-cadence bounds crash loss
  to the active burst, which matches what any architecture loses mid-generation.
- **Hydrate trigger**: `getOrCreate()` finding no `*.jsonl` in the session dir. Verify
  sha256; on mismatch walk back via `before_revision` (≤2 steps); if nothing verifies,
  log and start fresh — never block the user's prompt on hydration failure.
- **Eligibility**: only sessions created through `getOrCreate()` (top-level chat).
  Delegated child sessions are one-shot and are not checkpointed.
- **Feature flag**: `SICLAW_SESSION_CHECKPOINT_ENABLED` (default off), same pattern as
  `SICLAW_MEMORY_ENABLED`. Requires `SICLAW_GATEWAY_URL` (the GatewayClient transport).

## 6. Why DB blob, not OSS / RWX / rebuild-from-chat

- **DB (chosen)**: release-cadence writes are ~MBs per conversation burst — trivial at
  current scale (~200 users). `knowledge_versions.data LONGBLOB` is the in-repo
  precedent. Zero new infrastructure or credentials.
- **OSS**: right long-term home for blobs; rejected for v1 because Siclaw has no object
  storage client today and the scale doesn't demand one. The RPC contract carries
  `sha256/size/revision` metadata separately from bytes, so moving blobs later changes
  only the two RPC server implementations.
- **Another RWX filesystem**: keeps the architectural false requirement (RWX is only
  needed because agents share one PVC; every session dir is single-writer).
- **Rebuild from `chat_messages`**: lossy — plan ledger, DP mode, model-route state and
  compaction state cannot be reconstructed, and the rebuild couples to pi-agent's JSONL
  format. The checkpoint preserves the directory verbatim; correctness stays the
  framework's own concern.
