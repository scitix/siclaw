import { describe, it, expect } from "vitest";
import { parseBashFormat } from "./bash-format.js";

describe("parseBashFormat — echo mode (variable interpolation)", () => {
  it("converts $VAR to imprecise match (medium confidence)", () => {
    const result = parseBashFormat("Error: service $SERVICE_NAME failed", "echo");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].precise).toBe(false);
  });

  it("converts ${VAR} to imprecise match", () => {
    const result = parseBashFormat("Error: ${SERVICE} down", "echo");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("handles multiple variables", () => {
    const result = parseBashFormat("Error: service $SERVICE_NAME failed on $HOST", "echo");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("returns exact for pure static string", () => {
    const result = parseBashFormat("Starting service", "echo");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("Starting service")).toBe(true);
  });

  it("handles empty string", () => {
    const result = parseBashFormat("", "echo");
    expect(result.regex).toBe("^$");
    expect(result.confidence).toBe("exact");
  });

  it("handles ${VAR:-default} with default value", () => {
    const result = parseBashFormat("using ${PORT:-8080}", "echo");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("real Bash: Error: $SERVICE_NAME failed", () => {
    const result = parseBashFormat("Error: $SERVICE_NAME failed", "echo");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});

describe("parseBashFormat — printf mode (format verbs)", () => {
  it("converts %s to precise match", () => {
    const result = parseBashFormat("host: %s", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("s");
    expect(result.verbs[0].precise).toBe(true);
  });

  it("converts %d to precise integer match", () => {
    const result = parseBashFormat("Error: port %d is already in use", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("Error: port 8080 is already in use")).toBe(true);
  });

  it("converts %f to precise float match", () => {
    const result = parseBashFormat("load: %f", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("load: 3.14")).toBe(true);
  });

  it("treats %% as literal percent sign", () => {
    const result = parseBashFormat("100%% done", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("100% done")).toBe(true);
  });

  it("handles mixed %s and %d", () => {
    const result = parseBashFormat("host %s port %d", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(2);
    expect(new RegExp(result.regex!).test("host localhost port 3000")).toBe(true);
  });

  it("real Bash: Listening on port %d", () => {
    const result = parseBashFormat("Listening on port %d", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("Listening on port 8080")).toBe(true);
  });

  it("returns exact for pure static string in printf mode", () => {
    const result = parseBashFormat("Starting service", "printf");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
  });

  it("downgrades consecutive %s via ReDoS guard", () => {
    const result = parseBashFormat("%s%s%s", "printf");
    expect(result.verbs).toHaveLength(3);
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});
