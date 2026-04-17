import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveUnderDir } from "../path-utils.js";

describe("resolveUnderDir", () => {
  const base = path.resolve("/tmp/siclaw-path-utils-base");

  it("resolves a simple child path under base", () => {
    const resolved = resolveUnderDir(base, "child.txt");
    expect(resolved).toBe(path.join(base, "child.txt"));
  });

  it("resolves nested path segments under base", () => {
    const resolved = resolveUnderDir(base, "a", "b", "c.md");
    expect(resolved).toBe(path.join(base, "a", "b", "c.md"));
  });

  it("returns the base directory itself when no extra segments", () => {
    expect(resolveUnderDir(base)).toBe(base);
  });

  it("throws when path escapes via ..", () => {
    expect(() => resolveUnderDir(base, "..", "etc", "passwd")).toThrow(/escapes base directory/);
  });

  it("throws when an absolute path segment breaks out of base", () => {
    expect(() => resolveUnderDir(base, "/etc/passwd")).toThrow(/escapes base directory/);
  });

  it("throws when segment joins to a sibling directory", () => {
    // base = /tmp/siclaw-path-utils-base, .../../other resolves to /tmp/other (sibling, not under)
    const sibling = path.resolve(base, "..", "siclaw-path-utils-base-sibling");
    expect(() => resolveUnderDir(base, "..", "siclaw-path-utils-base-sibling")).toThrow(/escapes base directory/);
    expect(sibling.startsWith(path.dirname(base))).toBe(true); // sanity
  });

  it("allows a path that starts with the base name but is a sibling — should throw", () => {
    // A path that shares a prefix with base but isn't actually a child must be rejected.
    // resolveUnderDir(base, "../siclaw-path-utils-basex") would resolve to .../siclaw-path-utils-basex,
    // which starts with base's name prefix but is NOT under base.
    expect(() => resolveUnderDir(base, "..", "siclaw-path-utils-basex")).toThrow(/escapes base directory/);
  });

  it("handles trailing separators correctly — path equal to base is allowed", () => {
    const resolved = resolveUnderDir(base, ".");
    expect(resolved).toBe(base);
  });
});
