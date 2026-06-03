/**
 * Declarative sub-agent type registry (design §6). A sub-agent type selects the
 * child's system-prompt flavour and model. The parent model picks a type via
 * `spawn_subagent({ subagent_type })`; `whenToUse` is surfaced to it.
 *
 * Recursion is always forbidden, enforced structurally: a child session is created
 * WITHOUT the spawn_subagent executor (see AgentBoxSessionManager.runSpawnedSubagent),
 * so the spawn_subagent tool's `available` guard hides it from every child — no
 * sub-agent can spawn another. This holds regardless of subagent type.
 */

export type SubagentModel = "sonnet" | "opus" | "haiku" | "inherit";

export interface SubagentType {
  /** Unique selector, e.g. "general-purpose". */
  agentType: string;
  /** One-to-two sentences shown to the parent so it picks the right type. */
  whenToUse: string;
  /** Appended to the base SRE system prompt when building the child. */
  systemPromptAddendum: string;
  /** Model override; "inherit" uses the parent's model. */
  model?: SubagentModel;
}

/**
 * Master switch for `spawn_subagent`'s background mode (and the `job_stop` tool).
 *
 * OFF by default: the Job runtime (startBackgroundSubagent / subagentJobs) and the
 * Portal Jobs bar are fully built and kept intact, but `run_in_background` is NOT
 * exposed to the model and `job_stop` is NOT registered — because background jobs
 * currently have no completion notification back to the parent model (the result is
 * dropped, the prompt would over-promise, and the session is held; see design §7).
 * Flip to `true` only after implementing that notification — then the param, the
 * job_stop tool, and the prompt guidance all return automatically.
 */
export const RUN_IN_BACKGROUND_ENABLED = false;

/** Default cap on sub-agent child sessions running concurrently in one AgentBox. */
export const DEFAULT_SUBAGENT_CONCURRENCY = 2;

/**
 * Max sub-agent child sessions allowed to run at once within a single AgentBox,
 * from `SICLAW_SUBAGENT_CONCURRENCY` (default {@link DEFAULT_SUBAGENT_CONCURRENCY}).
 * pi runs a tool-call batch unbounded, so a wide fan-out would otherwise spin up
 * one child agent + one LLM stream per target from a single pod; this bounds it.
 * Invalid / non-positive values fall back to the default.
 */
export function getSubagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SICLAW_SUBAGENT_CONCURRENCY;
  if (raw == null || raw.trim() === "") return DEFAULT_SUBAGENT_CONCURRENCY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SUBAGENT_CONCURRENCY;
}

/** Default wall-clock backstop for a sub-agent's whole run, in ms (10 minutes). */
export const DEFAULT_SUBAGENT_MAX_RUNTIME_MS = 10 * 60_000;

/**
 * Wall-clock backstop for one foreground sub-agent's entire run, from
 * `SICLAW_SUBAGENT_MAX_RUNTIME` (in SECONDS; default 600 = 10 min). The parent tool
 * call blocks on the child, so this bounds the worst-case wait; on expiry the child
 * brain is aborted and the result is reported as `timed_out`. It is a backstop, not
 * the expected runtime — most bounded tasks finish far sooner. Invalid / non-positive
 * values fall back to the default.
 */
export function getSubagentMaxRuntimeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SICLAW_SUBAGENT_MAX_RUNTIME;
  if (raw == null || raw.trim() === "") return DEFAULT_SUBAGENT_MAX_RUNTIME_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) * 1000 : DEFAULT_SUBAGENT_MAX_RUNTIME_MS;
}

export const DEFAULT_SUBAGENT_TYPE = "general-purpose";

const GENERAL_PURPOSE: SubagentType = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose SRE sub-agent for a bounded diagnostic or research task: investigate one " +
    "hypothesis, check one target, or gather specific evidence, then report concise findings.",
  systemPromptAddendum:
    "You are a sub-agent handling ONE bounded task delegated by the main agent. " +
    "Do exactly the task described, gather the requested evidence, and end with a concise findings " +
    "report — the caller only sees your final report, not your steps. Do not ask for confirmation; " +
    "if blocked, report what you found and what's missing.",
  model: "inherit",
};

const BUILTINS: Record<string, SubagentType> = {
  [GENERAL_PURPOSE.agentType]: GENERAL_PURPOSE,
};

/** All registered sub-agent types (built-in; user/Portal-defined types may be added later). */
export function listSubagentTypes(): SubagentType[] {
  return Object.values(BUILTINS);
}

/**
 * Resolve a sub-agent type by name. Undefined/empty resolves to the default.
 * Returns undefined for an unknown explicit name so callers can report a clear error.
 */
export function getSubagentType(name?: string): SubagentType | undefined {
  const key = name?.trim() || DEFAULT_SUBAGENT_TYPE;
  return BUILTINS[key];
}
