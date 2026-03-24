import { describe, it, expect } from "vitest";
import { analyzeOutput, applySanitizer, type OutputAction } from "./output-sanitizer.js";

// ── analyzeOutput ────────────────────────────────────────────────────

describe("analyzeOutput", () => {
  describe("kubectl rules", () => {
    // Secret
    it("returns sanitize for get secret -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns rewrite for get secret -o yaml", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("rewrite");
      if (action!.type === "rewrite") {
        expect(action!.newArgs).toContain("json");
        expect(action!.newArgs).not.toContain("yaml");
      }
    });

    it("returns rewrite for get secret -o=yaml", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o=yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("rewrite");
      if (action!.type === "rewrite") {
        expect(action!.newArgs).toContain("-o=json");
      }
    });

    it("returns rewrite for get secret -oyaml", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-oyaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("rewrite");
      if (action!.type === "rewrite") {
        expect(action!.newArgs).toContain("-ojson");
      }
    });

    it("returns null for get secret (default table)", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-A"])).toBeNull();
    });

    it("returns null for get secret -o wide", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-o", "wide"])).toBeNull();
    });

    it("returns null for get secret -o name", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-o", "name"])).toBeNull();
    });

    // jsonpath/go-template → null (handled by pre-execution block in kubectl.ts)
    it("returns null for get secret -o jsonpath (block handled elsewhere)", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-o", "jsonpath={.data}"])).toBeNull();
    });

    // ConfigMap
    it("returns sanitize for get configmap -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "configmap", "my-cm", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get cm -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "cm", "my-cm", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    // Pod
    it("returns sanitize for get pod -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "pod", "my-pod", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns rewrite for get pods -o yaml", () => {
      const action = analyzeOutput("kubectl", ["get", "pods", "-A", "-o", "yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("rewrite");
    });

    // Non-sensitive resources
    it("returns null for get deployment -o json", () => {
      expect(analyzeOutput("kubectl", ["get", "deployment", "-o", "json"])).toBeNull();
    });

    it("returns null for get svc -o yaml", () => {
      expect(analyzeOutput("kubectl", ["get", "svc", "-o", "yaml"])).toBeNull();
    });

    // describe → null (block handled by kubectl.ts, describe secret is safe)
    it("returns null for describe secret", () => {
      expect(analyzeOutput("kubectl", ["describe", "secret", "my-secret"])).toBeNull();
    });

    it("returns null for describe configmap", () => {
      expect(analyzeOutput("kubectl", ["describe", "configmap", "my-cm"])).toBeNull();
    });

    // Other subcommands
    it("returns null for logs", () => {
      expect(analyzeOutput("kubectl", ["logs", "my-pod"])).toBeNull();
    });

    it("returns null for version", () => {
      expect(analyzeOutput("kubectl", ["version"])).toBeNull();
    });

    // Flags interspersed
    it("handles flags before resource type", () => {
      const action = analyzeOutput("kubectl", ["get", "-n", "kube-system", "secret", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("unregistered commands", () => {
    it("returns null for env", () => {
      expect(analyzeOutput("env", [])).toBeNull();
    });

    it("returns null for cat", () => {
      expect(analyzeOutput("cat", ["/etc/config"])).toBeNull();
    });

    it("returns null for unknown binary", () => {
      expect(analyzeOutput("some-tool", ["arg1"])).toBeNull();
    });
  });
});

// ── applySanitizer ───────────────────────────────────────────────────

describe("applySanitizer", () => {
  it("returns original output when action is null", () => {
    expect(applySanitizer("raw output", null)).toBe("raw output");
  });

  it("applies sanitize function for sanitize action", () => {
    const action: OutputAction = {
      type: "sanitize",
      sanitize: (o) => o.replace(/secret/g, "***"),
    };
    expect(applySanitizer("my secret data", action)).toBe("my *** data");
  });

  it("applies sanitize function for rewrite action", () => {
    const action: OutputAction = {
      type: "rewrite",
      newArgs: ["arg1"],
      sanitize: (o) => `sanitized: ${o}`,
    };
    expect(applySanitizer("output", action)).toBe("sanitized: output");
  });
});

// ── Integration: kubectl sanitize via framework ──────────────────────

describe("kubectl sanitize via framework", () => {
  it("sanitizes Secret JSON output end-to-end", () => {
    const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "json"]);
    expect(action).not.toBeNull();

    const secretJson = JSON.stringify({
      kind: "Secret",
      metadata: { name: "my-secret" },
      data: { password: "cGFzc3dvcmQ=" },
    });

    const result = applySanitizer(secretJson, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("cGFzc3dvcmQ=");
    expect(result).toContain("my-secret"); // metadata preserved
  });

  it("sanitizes ConfigMap JSON output end-to-end", () => {
    const action = analyzeOutput("kubectl", ["get", "configmap", "my-cm", "-o", "json"]);
    expect(action).not.toBeNull();

    const cmJson = JSON.stringify({
      kind: "ConfigMap",
      data: {
        "db.password": "secret123",
        "log.level": "debug",
      },
    });

    const result = applySanitizer(cmJson, action);
    expect(result).toContain("**REDACTED**"); // db.password redacted
    expect(result).toContain("debug");        // log.level preserved
  });

  it("rewrite yaml→json adds conversion note", () => {
    const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "yaml"]);
    expect(action).not.toBeNull();
    expect(action!.type).toBe("rewrite");

    const secretJson = JSON.stringify({
      kind: "Secret",
      data: { key: "dmFsdWU=" },
    });

    const result = applySanitizer(secretJson, action);
    expect(result).toContain("**REDACTED**");
    expect(result).toContain("Note: Output converted from YAML to JSON");
  });
});
