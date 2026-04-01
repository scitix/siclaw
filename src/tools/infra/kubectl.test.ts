import { describe, it, expect } from "vitest";
import {
  parseArgs,
  hasAllNamespacesWithoutSelector,
  SAFE_SUBCOMMANDS,
} from "./command-sets.js";

describe("parseArgs", () => {
  it("splits simple arguments", () => {
    expect(parseArgs("get pods -n default")).toEqual([
      "get",
      "pods",
      "-n",
      "default",
    ]);
  });

  it("handles double-quoted strings", () => {
    expect(parseArgs('get pods -l "app=my service"')).toEqual([
      "get",
      "pods",
      "-l",
      "app=my service",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(parseArgs("get pods -l 'app=my service'")).toEqual([
      "get",
      "pods",
      "-l",
      "app=my service",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseArgs("")).toEqual([]);
  });
});

describe("SAFE_SUBCOMMANDS", () => {
  it("includes core read-only subcommands", () => {
    expect(SAFE_SUBCOMMANDS.has("get")).toBe(true);
    expect(SAFE_SUBCOMMANDS.has("describe")).toBe(true);
    expect(SAFE_SUBCOMMANDS.has("logs")).toBe(true);
  });

  it("excludes write subcommands", () => {
    expect(SAFE_SUBCOMMANDS.has("delete")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("apply")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("create")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("patch")).toBe(false);
  });
});

describe("SAFE_SUBCOMMANDS excludes exec", () => {
  it("exec is no longer a safe kubectl subcommand (use pod_exec/node_exec tools instead)", () => {
    expect(SAFE_SUBCOMMANDS.has("exec")).toBe(false);
  });
});

describe("hasAllNamespacesWithoutSelector (backward-compat wrapper)", () => {
  // get -A without -o yaml/json is now ALLOWED (returns false)
  it("returns false for get -A (table output allowed)", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A"], "get")).toBe(false);
  });

  // get -A -o yaml → blocked
  it("returns true for get -A -o yaml (bulk serialization)", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A", "-o", "yaml"], "get")).toBe(true);
  });

  it("returns true for get -A -o json", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A", "-o", "json"], "get")).toBe(true);
  });

  // describe -A without selector → still blocked
  it("returns true for describe -A without selector", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A"], "describe")).toBe(true);
  });

  it("returns false when -l is present", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A", "-l", "app=web"], "describe")).toBe(false);
  });

  it("returns false for non-restricted subcommands", () => {
    expect(hasAllNamespacesWithoutSelector(["auth", "can-i", "--list", "-A"], "auth")).toBe(false);
  });

  it("returns false when no -A", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-n", "default"], "get")).toBe(false);
  });

  it("applies to describe", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A"], "describe")).toBe(true);
  });

  it("applies to events", () => {
    expect(hasAllNamespacesWithoutSelector(["events", "-A"], "events")).toBe(true);
  });

  it("applies to top", () => {
    expect(hasAllNamespacesWithoutSelector(["top", "pods", "-A"], "top")).toBe(true);
  });
});
