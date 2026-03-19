import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverBuiltinRules,
  resolveUserRulePaths,
  buildRulePaths,
} from "./rule-registry.js";

describe("discoverBuiltinRules", () => {
  it('discovers all Go rule YAML files from rules/go/', async () => {
    const paths = await discoverBuiltinRules("go");

    // klog-printf, klog-structured, logr, zap-native, zap-sugar
    expect(paths.length).toBeGreaterThanOrEqual(5);

    // Every path ends with .yaml
    for (const p of paths) {
      expect(p).toMatch(/\.yaml$/);
    }

    // Every path contains /rules/go/
    for (const p of paths) {
      expect(p).toContain("/rules/go/");
    }

    // Includes klog-printf.yaml
    expect(paths.some((p) => p.endsWith("klog-printf.yaml"))).toBe(true);

    // Sorted alphabetically
    const basenames = paths.map((p) => path.basename(p));
    const sorted = [...basenames].sort();
    expect(basenames).toEqual(sorted);
  });

  it('discovers Python rule YAML files from rules/python/', async () => {
    const paths = await discoverBuiltinRules("python");
    expect(paths.length).toBeGreaterThanOrEqual(1);
    for (const p of paths) {
      expect(p).toMatch(/\.yaml$/);
      expect(p).toContain("/rules/python/");
    }
  });

  it('throws for unsupported language "nonexistent"', async () => {
    await expect(discoverBuiltinRules("nonexistent")).rejects.toThrow(
      "Unsupported language",
    );
  });
});

describe("resolveUserRulePaths", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "siclaw-test-"));
  const tempFile = path.join(tempDir, "custom-rule.yaml");

  writeFileSync(tempFile, "rules: []\n");

  afterAll(() => {
    try {
      unlinkSync(tempFile);
    } catch {
      // ignore
    }
  });

  it("resolves existing file to absolute path", () => {
    const result = resolveUserRulePaths([tempFile]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(tempFile);
  });

  it("throws for missing file", () => {
    expect(() => resolveUserRulePaths(["/nonexistent/rule.yaml"])).toThrow(
      "User rule file not found",
    );
  });
});

describe("buildRulePaths", () => {
  it('returns all built-in rules for "go"', async () => {
    const paths = await buildRulePaths("go");
    expect(paths.length).toBeGreaterThanOrEqual(5);

    // All paths are absolute
    for (const p of paths) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it("appends user rule to built-in rules", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "siclaw-test-"));
    const tempFile = path.join(tempDir, "user-rule.yaml");
    writeFileSync(tempFile, "rules: []\n");

    try {
      const paths = await buildRulePaths("go", [tempFile]);
      // 5 built-in + 1 user
      expect(paths.length).toBeGreaterThanOrEqual(6);
      // Last element is the user rule
      expect(paths[paths.length - 1]).toBe(tempFile);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        // ignore
      }
    }
  });
});
