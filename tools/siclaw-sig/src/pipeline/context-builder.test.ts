import { describe, test, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextBuilder } from "./context-builder.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.resolve(path.dirname(__filename), "../extraction/__fixtures__");

describe("ContextBuilder", () => {
  test("extracts package name from Go file", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("klog-printf.go", 6);
    expect(result.package).toBe("controller");
  });

  test("finds enclosing function for klog.Infof at line 6", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("klog-printf.go", 6);
    expect(result.function).toBe("reconcilePod");
  });

  test("finds enclosing method with receiver for logr", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("logr.go", 6);
    expect(result.function).toBe("Reconcile");
  });

  test("captures surrounding source lines with correct range", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("klog-printf.go", 6);
    expect(result.source_lines.length).toBeGreaterThanOrEqual(3);
    expect(result.line_range[0]).toBeGreaterThanOrEqual(4);
    expect(result.line_range[1]).toBeLessThanOrEqual(8);
    expect(result.source_lines.some((l) => l.includes("klog.Infof"))).toBe(true);
  });

  test("clamps line range at file start", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("klog-printf.go", 1);
    expect(result.line_range[0]).toBe(1);
  });

  test("clamps line range at file end", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const result = await builder.build("klog-printf.go", 16);
    expect(result.line_range[1]).toBeLessThanOrEqual(17);
  });

  test("caches file content — second call returns consistent results", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    const first = await builder.build("klog-printf.go", 6);
    const second = await builder.build("klog-printf.go", 6);
    expect(first.package).toBe(second.package);
    expect(first.function).toBe(second.function);
  });

  test("returns 'unknown' when no enclosing func found", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    // Line 1 is the package declaration — no func above it
    const result = await builder.build("klog-printf.go", 1);
    expect(result.function).toBe("unknown");
  });

  test("throws on non-existent file", async () => {
    const builder = new ContextBuilder(FIXTURES_DIR);
    await expect(builder.build("nonexistent.go", 1)).rejects.toThrow("Source file not found");
  });
});
