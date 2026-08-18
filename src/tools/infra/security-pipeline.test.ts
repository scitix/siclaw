import { describe, it, expect } from "vitest";
import {
  preExecSecurity,
  postExecSecurity,
} from "./security-pipeline.js";
import { analyzeOutput } from "./output-sanitizer.js";

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

// ── postExecSecurity ────────────────────────────────────────────────

describe("postExecSecurity", () => {
  it("returns output unchanged when action is null and output is short", () => {
    expect(postExecSecurity("hello world", null)).toBe("hello world");
  });

  it("truncates long output", () => {
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

  it("applies redactSensitiveContent when hasSensitiveKubectl", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
    const result = postExecSecurity(jwt, null, {
      hasSensitiveKubectl: true,
    });
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });
});

describe("postExecSecurity — a failed run survives a structural sanitizer", () => {
  // What a `kubectl get pod ... -o json` resolves to: structural, not line-safe.
  // Splicing "[exit code: N]" into the body made JSON.parse fail here, and the
  // parse-failure branch suppresses everything — error, stdout and exit code.
  const jsonAction = analyzeOutput("kubectl", ["get", "pod", "web-0", "-o", "json"])!;

  it("resolves kubectl -o json on a pod to a structural sanitizer", () => {
    expect(jsonAction).not.toBeNull();
    expect(jsonAction.lineSafe).toBe(false);
  });

  it("keeps the exit code and stderr when a NotFound leaves the body empty", () => {
    const result = postExecSecurity("", jsonAction, {
      stderr: 'Error from server (NotFound): pods "web-0" not found',
      exitCode: 1,
    });
    expect(result).toContain("(no output)");
    expect(result).toContain("[exit code: 1]");
    expect(result).toContain("NotFound");
    expect(result).not.toContain("Failed to parse");
  });

  it("still redacts a JSON body that came back with a non-zero exit", () => {
    const body = JSON.stringify({
      kind: "Pod",
      spec: { containers: [{ env: [{ name: "API_TOKEN", value: "s3cret" }] }] },
    });
    const result = postExecSecurity(body, jsonAction, { exitCode: 1 });
    expect(result).not.toContain("s3cret");
    expect(result).toContain("[exit code: 1]");
    expect(result).not.toContain("Failed to parse");
  });

  it("never shows the sanitizer our own annotations", () => {
    let seen: string | null = null;
    const action = {
      type: "sanitize" as const,
      lineSafe: false,
      sanitize: (s: string) => {
        seen = s;
        return s;
      },
    };
    postExecSecurity("body", action, {
      exitCode: 1,
      signal: "SIGKILL",
      notes: "\n...[truncated]",
    });
    expect(seen).toBe("body");
  });

  it("skips the sanitizer entirely on an empty body", () => {
    let called = false;
    const action = {
      type: "sanitize" as const,
      lineSafe: false,
      sanitize: () => {
        called = true;
        return "should not run";
      },
    };
    const result = postExecSecurity("   ", action, { exitCode: 2 });
    expect(called).toBe(false);
    expect(result).toContain("[exit code: 2]");
  });

  it("renders signal and notes alongside the exit code", () => {
    const result = postExecSecurity("partial", null, {
      exitCode: 137,
      signal: "SIGKILL",
      notes: "\n...[output truncated at 10 MB]",
    });
    expect(result).toContain("partial");
    expect(result).toContain("...[output truncated at 10 MB]");
    expect(result).toContain("[exit code: 137 (signal: SIGKILL)]");
  });

  it("leaves a successful run's body untouched by any annotation", () => {
    const result = postExecSecurity('{"kind":"Pod"}', jsonAction);
    expect(result).not.toContain("exit code");
    expect(result).not.toContain("(no output)");
  });
});
