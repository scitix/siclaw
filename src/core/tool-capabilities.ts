/**
 * Per-Agent Tool Capabilities — registry + resolution
 *
 * Capability groups are the user-visible, multi-selectable configuration unit.
 * They decouple the vocabulary an admin reasons about ("read files", "run
 * commands") from the internal tool names, so tools can be renamed or
 * regrouped without invalidating an agent's stored selection.
 *
 * This is a pure module (no heavy deps) by design — mirroring `tool-append.ts`
 * — so it stays unit-testable. `agent-factory.ts` pulls in ssh2 transitively
 * and cannot be imported under vitest; keep the resolution logic here.
 *
 * Semantics mirror `appendAllowedTools` / `ToolRegistry.resolve()`:
 *   null / empty selection → null (whitelist OFF; every tool passes).
 * "Selecting nothing defaults to selecting everything" — this is the
 * backward-compatibility hinge: an agent that never set `tool_capabilities`
 * resolves to null and keeps today's full tool set.
 */

/**
 * Capability group key → the internal tool names it grants.
 *
 * Copied verbatim from the design (per-agent-tool-capabilities-DESIGN.md
 * "Interface and data structures"). The group keys are the stable contract stored in
 * `agents.tool_capabilities`; the tool-name arrays may evolve as tools are
 * added/renamed without changing stored selections.
 */
export const CAPABILITY_GROUPS: Record<string, string[]> = {
  read_files:      ["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite"],
  write_sandbox:   ["write", "edit", "skill_preview"],   // includes skill authoring
  inspect_infra:   ["cluster_list", "host_list"],   // read-only fleet discovery (registry)
  // `k8s_inspect` sits here rather than in `inspect_infra` on purpose. That group is REGISTRY metadata
  // — it touches no API server — so putting a live cluster read in it would hand every
  // metadata-only agent a capability it does not have today. Under `run_commands` the expansion is
  // zero instead: everything the tool can read, `bash` can already read through the same read-only
  // kubectl policy, so it adds round-trip efficiency and no reach.
  run_commands:    ["bash", "node_exec", "pod_exec", "host_exec", "k8s_inspect"],
  run_scripts:     ["node_script", "pod_script", "local_script", "host_script"],
  search_memory:   ["memory_search", "memory_get"],
  plan_tasks:      ["task_create", "task_update", "task_list", "task_get"],     // split ①
  spawn_subagents: ["spawn_subagent", "task_output", "job_stop"], // split ① (permission amplification)
  delegate_agents: ["delegate_to_agent", "list_delegates"],   // delegate a bounded task to a peer agent (roster-gated) + inspect delegate coverage; distinct from spawn
  scheduling:      ["manage_schedule"],
  session_output:  ["task_report", "save_feedback", "channel_update", "report_findings", "request_input", "propose_execution"],   // IM-channel-visible updates + delegation result artifact + clarification / write-approval requests
};

/** Strictly decode the stored/wire selection where null means intentional unrestricted. */
export function parseToolCapabilitiesAtBoundary(value: unknown): string[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("Invalid tool_capabilities value");
    }
  }
  if (parsed === null) return null;
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  throw new Error("Invalid tool_capabilities value");
}

/**
 * Resolve a set of capability group keys to a concrete `allowedTools` list.
 *
 * - `null` / `undefined` / `[]` → `null` (whitelist off — all tools allowed).
 *   "Selecting nothing defaults to selecting everything." This is the
 *   backward-compatibility invariant: `resolveCapabilities(null) === null`,
 *   strictly aligned with `tool-append.ts`'s null = whitelist-off semantics.
 * - non-empty → the deduped union of the selected groups' tool names.
 *   Unknown group keys fail loud (warn) and are ignored — the valid subset
 *   is still used. No baseline injection (decision #2 / #3): a misconfigured
 *   selection yields exactly what was selected, nothing forced in.
 */
export function resolveCapabilities(
  groupKeys: string[] | null | undefined,
): string[] | null {
  if (!Array.isArray(groupKeys) || groupKeys.length === 0) return null;

  const tools = new Set<string>();
  for (const key of groupKeys) {
    const group = CAPABILITY_GROUPS[key];
    if (!group) {
      console.warn(
        `[tool-capabilities] Unknown capability group "${key}" ignored; ` +
        `using the valid subset of the selection.`,
      );
      continue;
    }
    for (const tool of group) tools.add(tool);
  }

  return [...tools];
}

/**
 * Encode a `tool_capabilities` value for storage in the `agents` TEXT column.
 *
 * Validate-at-boundary (the only write site is the admin agent-update API):
 *   - `undefined`           → `undefined` (field omitted from the SET clause —
 *                             leave the stored value untouched).
 *   - `null` / `[]`         → `null` (clear the selection = unrestricted).
 *   - an array of strings   → deduped JSON array of group keys.
 *   - anything else         → throw (rejected as HTTP 400 by the caller).
 *
 * Unknown group keys are NOT rejected here: `resolveCapabilities` already
 * tolerates them (warn + ignore), and a key absent today may become valid in a
 * later release — storing it forward-compatibly beats a hard 400.
 */
export function encodeToolCapabilitiesForDb(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error("tool_capabilities must be null or an array of capability group keys");
  }
  if (value.some((k) => typeof k !== "string")) {
    throw new Error("tool_capabilities must contain only string group keys");
  }
  const deduped = [...new Set(value as string[])];
  if (deduped.length === 0) return null; // empty selection = unrestricted
  return JSON.stringify(deduped);
}
