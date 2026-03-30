import { describe, it, expect } from "vitest";
import {
  preExecSecurity,
  sanitizeExecOutput,
  postExecSecurity,
} from "./security-pipeline.js";

// ── preExecSecurity ─────────────────────────────────────────────────

describe("preExecSecurity", () => {
  it("blocks disallowed commands", () => {
    const result = preExecSecurity("rm -rf /", { context: "pod" });
    expect(result.error).toBeTruthy();
    expect(result.action).toBeNull();
    expect(result.hasSensitiveKubectl).toBe(false);
  });

  it("allows valid commands and returns action", () => {
    // kubectl needs extraAllowed for local context; use env which has a sanitizer
    const result = preExecSecurity("env", { context: "pod" });
    expect(result.error).toBeNull();
    // env → has sanitization action (sanitize-env)
    expect(result.action).not.toBeNull();
  });

  it("allows valid commands without sanitization action", () => {
    const result = preExecSecurity("ls /tmp", { context: "pod" });
    expect(result.error).toBeNull();
    expect(result.action).toBeNull();
    expect(result.hasSensitiveKubectl).toBe(false);
  });

  // ── analyzeTarget strategies ────────────────────────────────────

  describe("analyzeTarget: single (default)", () => {
    it("uses the command directly for output analysis", () => {
      // env has a sanitizer rule in output-sanitizer
      const result = preExecSecurity("env", {
        context: "pod",
        blockPipeline: true,
      });
      expect(result.error).toBeNull();
      expect(result.action).not.toBeNull();
      // single strategy → hasSensitiveKubectl is always false
      expect(result.hasSensitiveKubectl).toBe(false);
    });
  });

  describe("analyzeTarget: last-in-pipeline", () => {
    it("uses last command in pipeline for output analysis", () => {
      // Pipeline: env (has sanitizer) | wc (no sanitizer)
      // last-in-pipeline → uses wc → action is null
      const result = preExecSecurity("env | wc -l", {
        context: "node",
        analyzeTarget: "last-in-pipeline",
      });
      expect(result.error).toBeNull();
      expect(result.action).toBeNull();
    });

    it("picks up sanitizer from last command", () => {
      // Pipeline: ls | env → last command env has sanitizer
      const result = preExecSecurity("ls /tmp | env", {
        context: "node",
        analyzeTarget: "last-in-pipeline",
      });
      expect(result.error).toBeNull();
      expect(result.action).not.toBeNull();
    });
  });

  describe("analyzeTarget: auto", () => {
    it("detects kubectl exec inner command", () => {
      const result = preExecSecurity(
        "kubectl exec my-pod -- env",
        {
          context: "local",
          extraAllowed: new Set(["kubectl"]),
          analyzeTarget: "auto",
        },
      );
      expect(result.error).toBeNull();
      // inner command is "env" → should have sanitization action
      expect(result.action).not.toBeNull();
    });

    it("falls back to last-in-pipeline when no kubectl exec", () => {
      // uptime (general category) and wc (text category) are both in local whitelist
      const result = preExecSecurity("uptime | wc -l", {
        context: "local",
        analyzeTarget: "auto",
      });
      expect(result.error).toBeNull();
      // last command is wc → no sanitizer
      expect(result.action).toBeNull();
    });
  });

  // ── hasSensitiveKubectl detection ─────────────────────────────

  describe("hasSensitiveKubectl", () => {
    it("detects sensitive kubectl in pipeline (auto)", () => {
      const result = preExecSecurity(
        "kubectl get secret my-secret -o json | jq '.data'",
        {
          context: "local",
          extraAllowed: new Set(["kubectl"]),
          analyzeTarget: "auto",
        },
      );
      expect(result.error).toBeNull();
      expect(result.hasSensitiveKubectl).toBe(true);
    });

    it("is false for single-command kubectl get secret (auto)", () => {
      const result = preExecSecurity("kubectl get secret my-secret -o json", {
        context: "local",
        extraAllowed: new Set(["kubectl"]),
        analyzeTarget: "auto",
      });
      expect(result.error).toBeNull();
      // single command, not a pipeline → false
      expect(result.hasSensitiveKubectl).toBe(false);
    });

    it("is always false for single strategy", () => {
      const result = preExecSecurity("env", {
        context: "pod",
        analyzeTarget: "single",
      });
      expect(result.error).toBeNull();
      expect(result.hasSensitiveKubectl).toBe(false);
    });
  });
});

// ── sanitizeExecOutput ──────────────────────────────────────────────

describe("sanitizeExecOutput", () => {
  it("returns output unchanged when action is null", () => {
    expect(sanitizeExecOutput("hello world", null)).toBe("hello world");
  });

  it("applies sanitizer when action is provided", () => {
    const action = {
      type: "sanitize" as const,
      sanitize: (s: string) => s.replace(/secret/gi, "[REDACTED]"),
    };
    expect(sanitizeExecOutput("my secret value", action)).toBe(
      "my [REDACTED] value",
    );
  });

  it("applies redactSensitiveContent when hasSensitiveKubectl", () => {
    // A JWT-like token should be redacted
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
    const result = sanitizeExecOutput(jwt, null, {
      hasSensitiveKubectl: true,
    });
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });
});

// ── postExecSecurity ────────────────────────────────────────────────

describe("postExecSecurity", () => {
  it("sanitizes and truncates output", () => {
    const output = "x".repeat(200_000);
    const result = postExecSecurity(output, null);
    expect(result.length).toBeLessThan(output.length);
  });

  it("applies sanitizer then truncates", () => {
    const action = {
      type: "sanitize" as const,
      sanitize: (s: string) => s.replace(/TOKEN/g, "[REDACTED]"),
    };
    const result = postExecSecurity("my TOKEN here", action);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("TOKEN");
  });
});
