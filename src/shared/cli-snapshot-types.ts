/**
 * CLI snapshot public type contracts.
 *
 * These live in `src/shared/` (not `src/portal/`) so that `src/core/` — the
 * agent-runtime code compiled into the AgentBox image — can type-check
 * against them without pulling in the Portal REST handler module. The
 * handler (`src/portal/cli-snapshot-api.ts`) transitively depends on
 * `gateway/rest-router` and `gateway/db`, neither of which are part of the
 * AgentBox Docker build context (by design — AgentBox ↛ Portal layering).
 *
 * `src/portal/cli-snapshot-api.ts` re-exports these for back-compat; keep
 * this file as the canonical location.
 */

export interface CliSnapshotAgentMeta {
  /** Display name; used as `--agent <name>` value. */
  name: string;
  description: string | null;
  /** Model this agent prefers, if configured in Portal. */
  modelProvider: string | null;
  modelId: string | null;
  icon: string | null;
  color: string | null;
}

export interface CliSnapshotActiveAgent {
  name: string;
  description: string | null;
  systemPrompt: string | null;
  modelProvider: string | null;
  modelId: string | null;
}
