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

  describe("file-reading commands", () => {
    it("returns sanitize for cat", () => {
      const action = analyzeOutput("cat", ["/etc/config"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for head", () => {
      const action = analyzeOutput("head", ["-20", "/var/log/app.log"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for grep", () => {
      const action = analyzeOutput("grep", ["pattern", "/etc/config"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("env/printenv commands", () => {
    it("returns sanitize for env", () => {
      const action = analyzeOutput("env", []);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for printenv", () => {
      const action = analyzeOutput("printenv", []);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("crictl commands", () => {
    it("returns sanitize for crictl inspect", () => {
      const action = analyzeOutput("crictl", ["inspect", "abc123"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for crictl inspecti", () => {
      const action = analyzeOutput("crictl", ["inspecti", "img123"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns null for crictl ps", () => {
      expect(analyzeOutput("crictl", ["ps"])).toBeNull();
    });

    it("returns null for crictl logs", () => {
      expect(analyzeOutput("crictl", ["logs", "abc123"])).toBeNull();
    });
  });

  describe("unregistered commands", () => {
    it("returns null for unknown binary", () => {
      expect(analyzeOutput("some-tool", ["arg1"])).toBeNull();
    });

    it("returns null for ls", () => {
      expect(analyzeOutput("ls", ["/tmp"])).toBeNull();
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

// ── Integration: file-reading sanitize ──────────────────────────────

describe("file-reading content sanitization", () => {
  it("redacts JWT tokens in file output", () => {
    const action = analyzeOutput("cat", ["/app/config"]);
    const output = "normal line\ntoken: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig\nmore data";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("normal line");
    expect(result).toContain("more data");
  });

  it("redacts PEM private keys", () => {
    const action = analyzeOutput("cat", ["/app/cert"]);
    const output = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
  });

  it("redacts KEY=VALUE with sensitive key name", () => {
    const action = analyzeOutput("grep", ["password", "/etc/config"]);
    const output = "DB_PASSWORD=secret123\nDB_HOST=localhost";
    const result = applySanitizer(output, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("DB_HOST=localhost");
  });

  it("redacts YAML-style key: value with sensitive key name", () => {
    const action = analyzeOutput("cat", ["/app/config.yaml"]);
    const output = "database:\n  password: mysecret\n  host: localhost";
    const result = applySanitizer(output, action);
    expect(result).toContain("password: **REDACTED**");
    expect(result).toContain("host: localhost");
  });

  it("leaves non-sensitive output unchanged", () => {
    const action = analyzeOutput("cat", ["/etc/os-release"]);
    const output = "NAME=Ubuntu\nVERSION=22.04";
    const result = applySanitizer(output, action);
    expect(result).toBe(output); // no redaction warning appended
  });
});

// ── Integration: env/printenv sanitize ──────────────────────────────

describe("env/printenv output sanitization", () => {
  it("redacts sensitive env vars by key name", () => {
    const action = analyzeOutput("env", []);
    const output = "PATH=/usr/bin\nDB_PASSWORD=secret123\nHOME=/root\nAPI_KEY=sk-abc123";
    const result = applySanitizer(output, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("API_KEY=**REDACTED**");
    expect(result).toContain("PATH=/usr/bin");
    expect(result).toContain("HOME=/root");
  });

  it("redacts env vars with JWT values", () => {
    const action = analyzeOutput("printenv", []);
    const output = "AUTH_HEADER=eyJhbGciOiJSUzI1NiJ9.payload.sig";
    const result = applySanitizer(output, action);
    expect(result).toContain("AUTH_HEADER=**REDACTED**");
  });

  it("leaves non-sensitive env vars unchanged", () => {
    const action = analyzeOutput("env", []);
    const output = "PATH=/usr/bin\nHOME=/root\nSHELL=/bin/bash";
    const result = applySanitizer(output, action);
    expect(result).toBe(output);
  });
});

// ── Integration: crictl inspect sanitize ────────────────────────────

describe("crictl inspect output sanitization", () => {
  it("redacts containerd-style envs (KEY=VALUE strings)", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const json = JSON.stringify({
      info: {
        config: {
          envs: ["PATH=/usr/bin", "DB_PASSWORD=secret123", "HOME=/root"],
        },
      },
    });
    const result = applySanitizer(json, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("PATH=/usr/bin");
    expect(result).toContain("HOME=/root");
  });

  it("suppresses output on JSON parse failure", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const result = applySanitizer("not json {{{", action);
    expect(result).toContain("Failed to parse");
    expect(result).not.toContain("not json");
  });

  it("handles missing envs gracefully", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const json = JSON.stringify({ info: { config: {} } });
    const result = applySanitizer(json, action);
    expect(result).not.toContain("REDACTED");
  });
});
