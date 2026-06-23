import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CAPABILITY_GROUPS,
  resolveCapabilities,
  encodeToolCapabilitiesForDb,
} from "./tool-capabilities.js";
// Frontend catalog (the hand-maintained UI copy). Imported directly so the
// drift guard below compares the live constants — refactor-safe and
// type-checked, unlike text-parsing the source. This import only resolves under
// vitest (esbuild); the tsc build/typecheck exclude **/*.test.ts, so the
// cross-tree `.ts` import never reaches the Node16 build resolver.
import { CAPABILITY_GROUPS as FRONTEND_CAPABILITY_GROUPS } from "../../portal-web/src/lib/toolCapabilities.ts";

describe("resolveCapabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("null / [] / undefined all resolve to null (whitelist off)", () => {
    expect(resolveCapabilities(null)).toBeNull();
    expect(resolveCapabilities([])).toBeNull();
    expect(resolveCapabilities(undefined)).toBeNull();
  });

  it("a single group resolves to exactly that group's tools", () => {
    expect(resolveCapabilities(["read_files"])).toEqual(["read", "grep", "find", "ls"]);
  });

  it("multiple groups resolve to the union of their tools", () => {
    const result = resolveCapabilities(["read_files", "search_memory"]);
    expect(new Set(result)).toEqual(
      new Set(["read", "grep", "find", "ls", "memory_search", "memory_get"]),
    );
  });

  it("overlapping groups produce a deduped union", () => {
    // Construct overlap synthetically would require shared tools; instead assert
    // no duplicates appear when the same group is listed twice.
    const result = resolveCapabilities(["read_files", "read_files"]);
    expect(result).toEqual(["read", "grep", "find", "ls"]);
    expect(result!.length).toBe(new Set(result).size);
  });

  it("unknown group keys are warned + ignored, valid subset is used", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveCapabilities(["read_files", "does_not_exist"]);
    expect(result).toEqual(["read", "grep", "find", "ls"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("does_not_exist");
  });

  it("a selection of only unknown keys resolves to an empty list (not null)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // All keys invalid → valid subset is empty → [] (a real, restrictive
    // whitelist), distinct from the null=all-tools case.
    expect(resolveCapabilities(["nope"])).toEqual([]);
  });

  it("no baseline tools are injected (only selected groups appear)", () => {
    const result = resolveCapabilities(["scheduling"]);
    expect(result).toEqual(["manage_schedule"]);
  });

  it("CAPABILITY_GROUPS contains the 10 designed groups", () => {
    expect(Object.keys(CAPABILITY_GROUPS).sort()).toEqual([
      "inspect_infra",
      "plan_tasks",
      "read_files",
      "run_commands",
      "run_scripts",
      "scheduling",
      "search_memory",
      "session_output",
      "spawn_subagents",
      "write_sandbox",
    ]);
  });
});

describe("encodeToolCapabilitiesForDb", () => {
  it("encodes an empty selection as null (the unrestricted / backward-compat hinge)", () => {
    // Both submit flows send `Array.from(selectedCapabilities)`; an empty
    // selection MUST collapse to null so an un-configured agent stays
    // unrestricted (resolveCapabilities(null) === null).
    expect(encodeToolCapabilitiesForDb([])).toBeNull();
    expect(encodeToolCapabilitiesForDb(null)).toBeNull();
  });

  it("omits the field (undefined) when the value is undefined — leave stored value untouched", () => {
    expect(encodeToolCapabilitiesForDb(undefined)).toBeUndefined();
  });

  it("encodes a non-empty selection as a deduped JSON array of keys", () => {
    expect(encodeToolCapabilitiesForDb(["read_files", "read_files", "run_commands"]))
      .toBe(JSON.stringify(["read_files", "run_commands"]));
  });

  it("round-trips through resolveCapabilities for a real selection", () => {
    const encoded = encodeToolCapabilitiesForDb(["read_files"]);
    expect(encoded).not.toBeNull();
    const decoded = JSON.parse(encoded as string) as string[];
    expect(resolveCapabilities(decoded)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("rejects non-array, non-null/undefined values (HTTP 400 at the boundary)", () => {
    expect(() => encodeToolCapabilitiesForDb("read_files")).toThrow();
    expect(() => encodeToolCapabilitiesForDb({})).toThrow();
    expect(() => encodeToolCapabilitiesForDb(["read_files", 42])).toThrow();
  });
});

/**
 * Anti-drift guard: the frontend catalog
 * (`portal-web/src/lib/toolCapabilities.ts`) is a hand-maintained copy of this
 * module's CAPABILITY_GROUPS — the backend stays the source of truth for
 * resolution; the frontend only adds labels/descriptions for the UI. There is
 * no shared module across the two builds, so without this guard the backend
 * could add/rename a group or tool and the UI would silently desync (offering a
 * group that grants nothing, or hiding a real one). We compare `{key → sorted
 * tools}` on both sides; any mismatch fails with a precise diff.
 */
describe("frontend ↔ backend CAPABILITY_GROUPS parity", () => {
  /** Normalize a catalog to `{ key: sortedToolNames }`, ignoring tool order. */
  const normalizeBackend = (groups: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(Object.entries(groups).map(([key, tools]) => [key, [...tools].sort()]));

  const normalizeFrontend = (
    groups: ReadonlyArray<{ key: string; tools: string[] }>,
  ): Record<string, string[]> =>
    Object.fromEntries(groups.map((g) => [g.key, [...g.tools].sort()]));

  it("expose the same group keys", () => {
    const backendKeys = Object.keys(CAPABILITY_GROUPS).sort();
    const frontendKeys = FRONTEND_CAPABILITY_GROUPS.map((g) => g.key).sort();
    // Equal-as-sets AND no duplicate keys on the frontend side.
    expect(frontendKeys).toEqual(backendKeys);
    expect(new Set(frontendKeys).size).toBe(frontendKeys.length);
  });

  it("map each group key to the identical set of tools", () => {
    // toEqual on the full normalized maps yields a per-group, per-tool diff on
    // failure, naming exactly which group/tool drifted.
    expect(normalizeFrontend(FRONTEND_CAPABILITY_GROUPS)).toEqual(
      normalizeBackend(CAPABILITY_GROUPS),
    );
  });
});
