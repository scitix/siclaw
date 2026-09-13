import type { SubagentTargetCoverage } from "../core/tool-registry.js";

/** Pure selection from a complete, immutable tool-result snapshot; never execute model-supplied code. */
export interface SubagentTargetSource {
  artifact_id: string;
  array_pointer: string;
  fields: Record<string, string>;
  identity_field: string;
  /** Pointer to source-declared total (e.g. total). Mandatory to detect incomplete pages. */
  total_pointer: string;
  offset?: number;
  limit?: number;
}
function at(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("Use JSON pointers starting with / (or empty for the root)");
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`Missing JSON pointer: ${pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function selectSubagentTargets(text: string, source: SubagentTargetSource, maxItems: number) {
  const document: unknown = JSON.parse(text);
  const rows = at(document, source.array_pointer);
  const total = at(document, source.total_pointer);
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total !== rows.length) {
    throw new Error("Target snapshot is incomplete: array length must equal the source's total. Fetch all pages before delegation.");
  }
  if (!rows.length) throw new Error("Target snapshot is empty; there is nothing to delegate");
  if (!Object.hasOwn(source.fields, source.identity_field)) throw new Error("identity_field must name one of the selected fields");
  const ids = new Set<string>();
  const items = rows.map(row => {
    const item = Object.fromEntries(Object.entries(source.fields).map(([key, pointer]) => {
      const value = at(row, pointer);
      if (typeof value !== "string" || !value.trim()) throw new Error(`Target field ${key} must be a non-empty string`);
      return [key, value];
    }));
    const id = item[source.identity_field];
    if (ids.has(id)) throw new Error(`Duplicate target identity: ${id}`);
    ids.add(id);
    return item;
  });
  const offset = source.offset ?? 0;
  const limit = source.limit ?? maxItems;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= items.length || !Number.isSafeInteger(limit) || limit < 1 || limit > maxItems) {
    throw new Error(`Invalid snapshot range; limit must be 1..${maxItems}`);
  }
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    coverage: { artifact_id: source.artifact_id, total: items.length, offset, selected: selected.length,
      next_offset: offset + selected.length < items.length ? offset + selected.length : null,
      target_ids: selected.map(item => item[source.identity_field]) },
  };
}

/** Join each terminal result back to its stable snapshot identity, including failures/skips. */
export function finishTargetCoverage(coverage: SubagentTargetCoverage | undefined, statuses: string[]): SubagentTargetCoverage | undefined {
  if (!coverage) return undefined;
  return {
    ...coverage,
    outcomes: Object.fromEntries(coverage.target_ids.map((id, i) => [id, statuses[i] ?? "missing"])),
    snapshot_complete: coverage.offset === 0 && coverage.selected === coverage.total &&
      statuses.length === coverage.selected && statuses.every(status => status === "done"),
  };
}
