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
export const RUN_IN_BACKGROUND_ENABLED = true;

/**
 * Master switch for background bash (`run_in_background` on the `bash` tool) and its
 * share of the `job_stop` tool. Independent of {@link RUN_IN_BACKGROUND_ENABLED} so the
 * two modes can be rolled back separately even though they ship together. When OFF, the
 * `run_in_background` param is not exposed on the bash tool.
 */
export const BACKGROUND_BASH_ENABLED = true;

/** Default cap on background bash commands running concurrently in one AgentBox. */
export const DEFAULT_BACKGROUND_BASH_CONCURRENCY = 4;

/**
 * Max background bash commands allowed to run at once within a single AgentBox, from
 * `SICLAW_BACKGROUND_BASH_CONCURRENCY` (default {@link DEFAULT_BACKGROUND_BASH_CONCURRENCY}).
 * Bounds detached processes per pod; past the cap, restricted-bash falls back to a
 * foreground run with a note. Invalid / non-positive values fall back to the default.
 */
/**
 * Parse a positive-integer env value: blank/NaN/non-positive → `fallback`. With
 * `{ unitMs: true }` the raw value is read as SECONDS and returned as milliseconds
 * (×1000) — this makes the seconds-vs-count distinction explicit at the call site.
 * Single source of truth for every `SICLAW_*` count/duration knob below.
 */
export function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  opts?: { unitMs?: boolean },
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!(Number.isFinite(n) && n >= 1)) return fallback;
  return opts?.unitMs ? Math.floor(n) * 1000 : Math.floor(n);
}

export function getBackgroundBashConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.SICLAW_BACKGROUND_BASH_CONCURRENCY, DEFAULT_BACKGROUND_BASH_CONCURRENCY);
}

/**
 * Default cap on sub-agent child sessions running concurrently in one AgentBox.
 *
 * Raised 2 → 4 with `spawn_subagent`'s batch (map→reduce) path (design §"Consequences"):
 * a multi-item batch defaults to background and is the primary fan-out path, and the group
 * worker share is `max(1, concurrency - 1)` (see {@link getGroupWorkerShare}) — at concurrency
 * 2 a batch would get a single worker, making a 50-item batch effectively serial and
 * unusable. 4 keeps ≥1 slot free for an interactive single spawn while giving a batch a
 * usable worker pool. This is a GLOBAL change to plain fan-out concurrency too; tune it
 * back with `SICLAW_SUBAGENT_CONCURRENCY`.
 */
export const DEFAULT_SUBAGENT_CONCURRENCY = 4;

/**
 * Max sub-agent child sessions allowed to run at once within a single AgentBox,
 * from `SICLAW_SUBAGENT_CONCURRENCY` (default {@link DEFAULT_SUBAGENT_CONCURRENCY}).
 * pi runs a tool-call batch unbounded, so a wide fan-out would otherwise spin up
 * one child agent + one LLM stream per target from a single pod; this bounds it.
 * Invalid / non-positive values fall back to the default.
 */
export function getSubagentConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.SICLAW_SUBAGENT_CONCURRENCY, DEFAULT_SUBAGENT_CONCURRENCY);
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
  return parsePositiveIntEnv(env.SICLAW_SUBAGENT_MAX_RUNTIME, DEFAULT_SUBAGENT_MAX_RUNTIME_MS, { unitMs: true });
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

// ── spawn_subagent batch fan-out (design §"Env knobs", v3 single-tool merge) ─────

/**
 * Operational rollback lever for spawn_subagent's batch (map→reduce) capability (design v3
 * decision #20). Read from `SICLAW_SUBAGENT_GROUP_ENABLED` (default ON; only "false"/"0"
 * disables) so ops can flip it WITHOUT a rebuild — mirroring the sibling `SICLAW_*` knobs.
 * Since v3 merged the batch path into the single `spawn_subagent` tool, this no longer gates a
 * separate tool's registration — instead, when OFF the tool's item cap is forced to 1 (see the
 * tool layer), so a multi-item plan or a reduce_prompt is rejected and the tool degrades to a
 * pure single-task spawn (pre-batch behaviour).
 */
export function isSubagentGroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SICLAW_SUBAGENT_GROUP_ENABLED;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0");
}

/** Default upper bound on the number of items in one `spawn_subagent` batch call. */
export const DEFAULT_MAX_GROUP_ITEMS = 50;

/**
 * Max items allowed in a single `spawn_subagent` batch, from
 * `SICLAW_SUBAGENT_GROUP_MAX_ITEMS` (default {@link DEFAULT_MAX_GROUP_ITEMS}). Bounds a
 * fan-out the model can request in one turn; past the cap the tool fails fast with a
 * "split into batches" hint before any child is started. Invalid / non-positive values
 * fall back to the default. (When {@link isSubagentGroupEnabled} is off the tool clamps the
 * effective cap to 1 regardless of this value.)
 */
export function getMaxGroupItems(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.SICLAW_SUBAGENT_GROUP_MAX_ITEMS, DEFAULT_MAX_GROUP_ITEMS);
}

/** Model-visible cap (chars) on a group's reduce summary — larger than a normal capsule
 *  (1800) because the reduce output synthesises N items into one report. */
export const GROUP_REDUCE_SUMMARY_MAX_CHARS = 6000;

/** Cap (chars) on the assembled reduce INPUT (all item results concatenated). Past this
 *  the builder truncates each item proportionally and marks `[truncated]`. Budget math: a
 *  full 50-item batch of 1800-char capsules is ~90K chars; the 150K ceiling is ~40K tokens,
 *  comfortable headroom inside a 128K-token model context alongside the reduce child's
 *  system prompt. */
export const GROUP_REDUCE_INPUT_MAX_CHARS = 150_000;

/** Default per-item wall-clock BUDGET (expected-value, not a hard limit) used by the
 *  group runtime-scaling formula. Seconds. */
export const DEFAULT_GROUP_ITEM_BUDGET_MS = 300_000;

/** Fixed slack added on top of the scaled per-wave budget in the group runtime formula. */
export const GROUP_RUNTIME_MARGIN_MS = 600_000;

/** Lower bound (floor) for a group's overall wall-clock backstop. */
export const GROUP_RUNTIME_FLOOR_MS = 1_800_000;

/** Default hard ceiling for a group's overall wall-clock backstop. Seconds. */
export const DEFAULT_GROUP_RUNTIME_HARD_CAP_MS = 7_200_000;

/**
 * Per-item budget (ms) for the group runtime-scaling formula, from
 * `SICLAW_SUBAGENT_GROUP_ITEM_BUDGET` (in SECONDS; default 300). Invalid / non-positive
 * values fall back to the default. This is the EXPECTED runtime of one child, not a hard
 * limit — each child keeps its own 600s backstop ({@link getSubagentMaxRuntimeMs}).
 */
export function getGroupItemBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.SICLAW_SUBAGENT_GROUP_ITEM_BUDGET, DEFAULT_GROUP_ITEM_BUDGET_MS, { unitMs: true });
}

/**
 * Hard ceiling (ms) for a group's overall backstop, from `SICLAW_SUBAGENT_GROUP_MAX_RUNTIME`
 * (in SECONDS; default 7200 = 2h). Invalid / non-positive values fall back to the default.
 */
export function getGroupHardCapMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.SICLAW_SUBAGENT_GROUP_MAX_RUNTIME, DEFAULT_GROUP_RUNTIME_HARD_CAP_MS, { unitMs: true });
}

/**
 * Overall wall-clock backstop for a whole `spawn_subagent` batch, scaled to its size.
 *
 * SEMANTICS: this is an OUTER SAFETY NET, not a precise budget. Each child still has its
 * own independent 600s backstop ({@link getSubagentMaxRuntimeMs}); the per-item budget
 * here is an EXPECTED value (most diagnostic children finish in 2–4 min). If children
 * systematically approach their 600s ceiling, the group may hit this net first and produce
 * a PARTIAL result — that is accepted behaviour, not a bug.
 *
 * Formula: `clamp(ceil(N / concurrency) × itemBudget + margin, floor 1800s, hardCap 7200s)`.
 * The `ceil(N / concurrency)` term is the number of sequential worker waves.
 */
export function getSubagentGroupMaxRuntimeMs(
  itemCount: number,
  concurrency: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const items = Math.max(1, Math.floor(itemCount));
  const workers = Math.max(1, Math.floor(concurrency));
  const waves = Math.ceil(items / workers);
  const raw = waves * getGroupItemBudgetMs(env) + GROUP_RUNTIME_MARGIN_MS;
  const hardCap = getGroupHardCapMs(env);
  return Math.min(Math.max(raw, GROUP_RUNTIME_FLOOR_MS), hardCap);
}

/**
 * How many group children may be in flight at once: `max(1, concurrency - 1)`. A group
 * runs children through the SAME global `subagentLimiter` as plain fan-out (single
 * resource cap), but its orchestrator keeps at most this many submitted concurrently so
 * an interactive `spawn_subagent` always retains ≥1 slot (no head-of-line starvation).
 */
export function getGroupWorkerShare(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, getSubagentConcurrency(env) - 1);
}
