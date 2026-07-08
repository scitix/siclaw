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
  read_files:      ["read", "grep", "find", "ls"],
  write_sandbox:   ["write", "edit", "skill_preview"],   // includes skill authoring
  inspect_infra:   ["cluster_list", "cluster_probe", "host_list", "resolve_pod_netns"],
  run_commands:    ["bash", "node_exec", "pod_exec", "host_exec"],
  run_scripts:     ["node_script", "pod_script", "local_script", "host_script"],
  search_memory:   ["memory_search", "memory_get"],
  plan_tasks:      ["task_create", "task_update", "task_list", "task_get"],     // split ①
  spawn_subagents: ["spawn_subagent", "task_output", "job_stop"], // split ① (permission amplification)
  scheduling:      ["manage_schedule"],
  session_output:  ["task_report", "save_feedback", "channel_update"],   // includes IM-channel-visible updates
};

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
