/**
 * Fold a Portal's `config.getAgent` response into the environment variables the
 * Gateway injects into an AgentBox at cold spawn (setSpawnEnvResolver →
 * AgentBoxManager.resolveEnv → spawner).
 *
 * Two sources, applied in this order:
 *   1. `spawn_env` — a generic, Portal-owned map of extra per-agent env vars.
 *      Merged verbatim; only string values are kept (env vars are strings, and
 *      the payload arrives as untyped JSON over the wire). Portals own the
 *      keys/values; the Gateway forwards them without interpreting.
 *   2. `idle_timeout_sec` → SICLAW_AGENTBOX_IDLE_TIMEOUT — the runtime's own
 *      per-agent field. Applied AFTER the merge so a stray same-named key in
 *      `spawn_env` can never clobber this dedicated idle-window control.
 *
 * Pure (no IO) so the merge/precedence is unit-testable — its caller in the
 * server closure (resolveAgentSpawnEnv) is not.
 */
export function buildSpawnEnv(
  agent:
    | { idle_timeout_sec?: number | null; spawn_env?: Record<string, unknown> | null }
    | null,
): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Generic Portal-supplied env. Only strings survive.
  for (const [key, value] of Object.entries(agent?.spawn_env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }

  // 2. Idle-window mapping, last so it always wins on a key collision.
  const sec = agent?.idle_timeout_sec;
  if (sec !== undefined && sec !== null) {
    env.SICLAW_AGENTBOX_IDLE_TIMEOUT = String(sec);
  }

  return env;
}
