import { describe, it, expect } from "vitest";
import { parseJavaFormat } from "./java-format.js";

describe("parseJavaFormat — SLF4J/Log4j2 placeholders", () => {
  it("converts single {} to imprecise match (medium confidence)", () => {
    const result = parseJavaFormat("Connection failed for host {}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("v");
    expect(result.verbs[0].precise).toBe(false);
  });

  it("converts multiple {} placeholders", () => {
    const result = parseJavaFormat("Request {} completed in {}ms");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("returns exact for pure static string", () => {
    const result = parseJavaFormat("Server started on port 8080");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("Server started on port 8080")).toBe(true);
  });

  it("handles empty string", () => {
    const result = parseJavaFormat("");
    expect(result.regex).toBe("^$");
    expect(result.confidence).toBe("exact");
    expect(result.verbs).toHaveLength(0);
  });

  it("real Java: Connection refused for host {}", () => {
    const result = parseJavaFormat("Connection refused for host {}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("real Java: User {} authenticated from {}", () => {
    const result = parseJavaFormat("User {} authenticated from {}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("handles mixed static text and {}", () => {
    const result = parseJavaFormat("Starting service {} on node {} at port 8080");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("escapes regex special chars in static text", () => {
    const result = parseJavaFormat("error in [module]");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.regex).toContain("\\[module\\]");
    expect(new RegExp(result.regex!).test("error in [module]")).toBe(true);
  });

  it("does not match non-placeholder braces with content", () => {
    // {content} should not match — only {} matches in Java SLF4J
    const result = parseJavaFormat("JSON: {key: value}");
    expect(result.verbs).toHaveLength(0);
    expect(result.confidence).toBe("exact");
  });

  it("handles three consecutive {} placeholders", () => {
    const result = parseJavaFormat("{} {} {}");
    expect(result.verbs).toHaveLength(3);
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});
