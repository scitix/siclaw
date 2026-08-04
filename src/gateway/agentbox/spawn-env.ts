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
 *   2. `idle_timeout_sec` → SICLAW_AGENTBOX_IDLE_TIMEOUT and `timezone` → TZ —
 *      the runtime's own per-agent fields. Applied AFTER the merge so a stray
 *      same-named key in `spawn_env` can never clobber a dedicated control.
 *
 * Pure (no IO) so the merge/precedence is unit-testable — its caller in the
 * server closure (resolveAgentSpawnEnv) is not.
 */
export function buildSpawnEnv(
  agent:
    | {
        idle_timeout_sec?: number | null;
        timezone?: string | null;
        spawn_env?: Record<string, unknown> | null;
      }
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

  // 3. Timezone. The per-turn reminder does not depend on this — it renders the
  //    configured zone directly, so a change is live on the next message. This
  //    is for the box's OWN clock: `date` in an agent's shell, and any log line
  //    it writes, otherwise stay UTC and disagree with what the model was just
  //    told. Cold-spawn only, so this half lands on the next restart.
  const tz = agent?.timezone?.trim();
  if (tz) env.TZ = tz;

  return env;
}
