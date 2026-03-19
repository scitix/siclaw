import { describe, it, expect } from "vitest";
import { parseGoFormat } from "./go-format.js";
import { extractKeywords } from "./keywords.js";

describe("parseGoFormat — verb patterns", () => {
  it("converts %s and %d to regex that matches sample input", () => {
    const result = parseGoFormat("failed to connect to %s:%d");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(2);
    expect(result.verbs[0].verb).toBe("s");
    expect(result.verbs[1].verb).toBe("d");
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("failed to connect to 10.0.0.1:8080")).toBe(true);
  });

  it("converts %f to regex that matches float", () => {
    const result = parseGoFormat("latency: %f ms");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("latency: 12.5 ms")).toBe(true);
  });

  it("converts %x to regex that matches hex", () => {
    const result = parseGoFormat("address: 0x%x");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("address: 0x1a2b3c")).toBe(true);
  });

  it("converts %q to regex that matches quoted string", () => {
    const result = parseGoFormat('received %q from peer');
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test('received "hello" from peer')).toBe(true);
  });

  it("returns null regex and medium confidence for pure %v", () => {
    const result = parseGoFormat("error: %v");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("v");
    expect(result.verbs[0].precise).toBe(false);
  });

  it("returns high confidence for mixed %s + %v", () => {
    const result = parseGoFormat("pod %s error: %v");
    expect(result.confidence).toBe("high");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(result.verbs).toHaveLength(2);
  });

  it("returns null regex and medium confidence for pure %w", () => {
    const result = parseGoFormat("wrapped: %w");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("w");
  });

  it("returns medium confidence when all verbs are imprecise (%v %w)", () => {
    const result = parseGoFormat("%v %w");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("treats %% as literal percent sign, not a verb", () => {
    const result = parseGoFormat("100%% complete");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("100% complete")).toBe(true);
  });

  it("returns medium for standalone %v", () => {
    const result = parseGoFormat("%v");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});

describe("parseGoFormat — width/precision modifiers", () => {
  it("handles %10.2f same as plain %f", () => {
    const result = parseGoFormat("value: %10.2f");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs[0].verb).toBe("f");
    expect(result.verbs[0].raw).toBe("%10.2f");
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("value: 3.14")).toBe(true);
  });

  it("handles %-20s same as plain %s", () => {
    const result = parseGoFormat("name: %-20s");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs[0].verb).toBe("s");
    expect(() => new RegExp(result.regex!)).not.toThrow();
  });

  it("handles %04d same as plain %d", () => {
    const result = parseGoFormat("code: %04d");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs[0].verb).toBe("d");
    expect(() => new RegExp(result.regex!)).not.toThrow();
  });

  it("handles %+v same as %v (medium, null regex)", () => {
    const result = parseGoFormat("%+v");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs[0].verb).toBe("v");
  });
});

describe("parseGoFormat — unknown verbs", () => {
  it("degrades unknown verb %Z to greedy match", () => {
    const result = parseGoFormat("value: %Z");
    expect(result.verbs[0].verb).toBe("Z");
    expect(result.verbs[0].pattern).toBe("(.*)");
    expect(result.verbs[0].precise).toBe(false);
    // Only imprecise verb → medium, null regex
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("mixed unknown + precise verb returns high confidence", () => {
    const result = parseGoFormat("id=%d val=%Z");
    expect(result.confidence).toBe("high");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
  });
});

describe("parseGoFormat — regex special chars in static text", () => {
  it("escapes brackets and parens in static text", () => {
    const result = parseGoFormat("error in [pod] (ns)");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.regex).toContain("\\[pod\\]");
    expect(result.regex).toContain("\\(ns\\)");
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("error in [pod] (ns)")).toBe(true);
  });

  it("escapes dots and slashes in static text", () => {
    const result = parseGoFormat("path: /var/log/app.log %s");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.regex).toContain("\\.log");
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("path: /var/log/app.log something")).toBe(true);
  });
});

describe("parseGoFormat — edge cases", () => {
  it("handles empty string", () => {
    const result = parseGoFormat("");
    expect(result.regex).toBe("^$");
    expect(result.confidence).toBe("exact");
    expect(result.verbs).toHaveLength(0);
  });

  it("handles pure static string with no placeholders", () => {
    const result = parseGoFormat("no placeholders here");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("no placeholders here")).toBe(true);
  });

  it("handles multiple consecutive verbs — downgraded by ReDoS guard", () => {
    const result = parseGoFormat("%s%s%s");
    expect(result.verbs).toHaveLength(3);
    expect(result.verbs.every((v) => v.precise)).toBe(true);
    // ReDoS guard downgrades consecutive (.*)(.*)(.*)
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("handles negative integer with %d", () => {
    const result = parseGoFormat("offset: %d");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("offset: -42")).toBe(true);
  });

  it("handles negative float with %f", () => {
    const result = parseGoFormat("temp: %f");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(new RegExp(result.regex!).test("temp: -3.14")).toBe(true);
  });
});

describe("parseGoFormat — real K8s format strings", () => {
  it("matches pod sandbox creation failure (%q + %v)", () => {
    const result = parseGoFormat(
      "Failed to create pod sandbox for pod %q: %v",
    );
    expect(result.confidence).toBe("high");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
    expect(
      new RegExp(result.regex!).test(
        'Failed to create pod sandbox for pod "test-pod": connection refused',
      ),
    ).toBe(true);
  });

  it("downgrades pure %v event write to medium", () => {
    const result = parseGoFormat(
      "Unable to write event '%v' (may retry after sleeping)",
    );
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("downgrades container start — consecutive %s with short separators", () => {
    // %s_%s(%s) has only 1-char separators between groups → ReDoS guard flags
    const result = parseGoFormat("Started container %s in pod %s_%s(%s)");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("matches klog timestamp format with width modifiers", () => {
    const result = parseGoFormat("E%02d%02d %02d:%02d:%02d.%06d");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(() => new RegExp(result.regex!)).not.toThrow();
  });

  it("downgrades pod eviction — %s/%s has 1-char separator", () => {
    // %s/%s has only "/" between groups → ReDoS guard flags
    const result = parseGoFormat("Evicting pod %s/%s due to %s");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});

describe("parseGoFormat — ReDoS guard integration", () => {
  it("downgrades pathological %v%v%v to keyword-only", () => {
    const result = parseGoFormat("%v%v%v");
    expect(result.regex).toBeNull();
    expect(result.confidence).toBe("medium");
  });

  it("downgrades %s%s%s — consecutive (.*) without separators", () => {
    const result = parseGoFormat("%s%s%s");
    expect(result.regex).toBeNull();
    expect(result.confidence).toBe("medium");
  });

  it("does not flag format string with sufficient separators", () => {
    const result = parseGoFormat("error %s in %s");
    expect(result.regex).not.toBeNull();
    expect(result.confidence).toBe("exact");
    expect(() => new RegExp(result.regex!)).not.toThrow();
  });

  it("does not flag format string with non-greedy groups", () => {
    const result = parseGoFormat("id=%d val=%d");
    expect(result.regex).not.toBeNull();
    expect(result.confidence).toBe("exact");
  });
});

describe("parseGoFormat + extractKeywords — full pipeline", () => {
  it("pod sandbox failure: high confidence + meaningful keywords", () => {
    const template = "Failed to create pod sandbox for pod %q: %v";
    const parse = parseGoFormat(template);
    const keywords = extractKeywords(template);

    expect(parse.confidence).toBe("high");
    expect(parse.regex).not.toBeNull();
    expect(keywords).toContain("failed");
    expect(keywords).toContain("create");
    expect(keywords).toContain("pod");
    expect(keywords).toContain("sandbox");
    // 2-char words filtered (MIN_KEYWORD_LENGTH=3)
    expect(keywords).not.toContain("to");
    // "for" is 3 chars so it passes the length filter
    expect(keywords).toContain("for");
  });

  it("event write failure: medium confidence + keywords fallback", () => {
    const template = "Unable to write event '%v' (may retry after sleeping)";
    const parse = parseGoFormat(template);
    const keywords = extractKeywords(template);

    expect(parse.confidence).toBe("medium");
    expect(parse.regex).toBeNull();
    expect(keywords).toContain("unable");
    expect(keywords).toContain("write");
    expect(keywords).toContain("event");
    expect(keywords).toContain("retry");
    expect(keywords).toContain("sleeping");
  });

  it("client-go error: namespace token preserved as keyword", () => {
    const template = "error in k8s.io/client-go: %v";
    const parse = parseGoFormat(template);
    const keywords = extractKeywords(template);

    expect(parse.confidence).toBe("medium");
    expect(parse.regex).toBeNull();
    expect(keywords).toContain("error");
    expect(keywords).toContain("k8s.io/client-go");
  });
});
