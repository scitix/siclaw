import { describe, it, expect } from "vitest";
import {
  detectSensitiveResource,
  getOutputFormat,
  sanitizeJSON,
  SENSITIVE_ENV_NAME_PATTERNS,
  SENSITIVE_KEY_PATTERNS,
  SENSITIVE_VALUE_PATTERNS,
} from "./kubectl-sanitize.js";

// ── detectSensitiveResource ──────────────────────────────────────────

describe("detectSensitiveResource", () => {
  // Secret aliases
  it("detects 'secret'", () => {
    expect(detectSensitiveResource(["get", "secret", "my-secret"])).toBe("secret");
  });
  it("detects 'secrets'", () => {
    expect(detectSensitiveResource(["get", "secrets", "-A"])).toBe("secret");
  });
  it("detects 'secret/name'", () => {
    expect(detectSensitiveResource(["get", "secret/my-secret", "-o", "json"])).toBe("secret");
  });

  // ConfigMap aliases
  it("detects 'configmap'", () => {
    expect(detectSensitiveResource(["get", "configmap", "app-config"])).toBe("configmap");
  });
  it("detects 'configmaps'", () => {
    expect(detectSensitiveResource(["get", "configmaps"])).toBe("configmap");
  });
  it("detects 'cm'", () => {
    expect(detectSensitiveResource(["get", "cm", "app-config"])).toBe("configmap");
  });
  it("detects 'cm/name'", () => {
    expect(detectSensitiveResource(["get", "cm/app-config", "-n", "default"])).toBe("configmap");
  });

  // Pod aliases
  it("detects 'pod'", () => {
    expect(detectSensitiveResource(["get", "pod", "my-pod"])).toBe("pod");
  });
  it("detects 'pods'", () => {
    expect(detectSensitiveResource(["get", "pods", "-A"])).toBe("pod");
  });
  it("detects 'po'", () => {
    expect(detectSensitiveResource(["get", "po", "-n", "default"])).toBe("pod");
  });
  it("detects 'po/name'", () => {
    expect(detectSensitiveResource(["get", "po/my-pod"])).toBe("pod");
  });

  // Comma-separated
  it("detects comma-separated 'pod,secret'", () => {
    const result = detectSensitiveResource(["get", "pod,secret", "-A"]);
    expect(result).not.toBeNull();
  });
  it("detects comma-separated 'deploy,cm'", () => {
    expect(detectSensitiveResource(["get", "deploy,cm", "-A"])).toBe("configmap");
  });

  // Flags are skipped
  it("skips -n value", () => {
    // -n secret-ns should not trigger — "secret-ns" is a namespace, not resource type
    // But "secret" after it IS the resource type
    expect(detectSensitiveResource(["get", "-n", "secret-ns", "pods"])).toBe("pod");
  });
  it("skips --namespace value", () => {
    expect(detectSensitiveResource(["get", "--namespace", "kube-system", "secret"])).toBe("secret");
  });
  it("skips -l value", () => {
    expect(detectSensitiveResource(["get", "-l", "app=secret", "pods"])).toBe("pod");
  });
  it("skips -o value", () => {
    expect(detectSensitiveResource(["get", "-o", "json", "secret"])).toBe("secret");
  });

  // Non-sensitive resources
  it("returns null for deployments", () => {
    expect(detectSensitiveResource(["get", "deployments", "-A"])).toBeNull();
  });
  it("returns null for services", () => {
    expect(detectSensitiveResource(["get", "svc", "my-svc"])).toBeNull();
  });
  it("returns null for nodes", () => {
    expect(detectSensitiveResource(["get", "nodes"])).toBeNull();
  });
  it("returns null for empty args", () => {
    expect(detectSensitiveResource([])).toBeNull();
  });

  // Flags with = syntax
  it("skips --namespace=kube-system", () => {
    expect(detectSensitiveResource(["get", "--namespace=kube-system", "secret"])).toBe("secret");
  });

  // Case insensitive resource type
  it("detects case variants", () => {
    expect(detectSensitiveResource(["get", "Secret", "my-secret"])).toBe("secret");
    expect(detectSensitiveResource(["get", "ConfigMap", "cfg"])).toBe("configmap");
  });
});

// ── getOutputFormat ──────────────────────────────────────────────────

describe("getOutputFormat", () => {
  it("returns 'json' for -o json", () => {
    expect(getOutputFormat(["-o", "json"])).toBe("json");
  });
  it("returns 'json' for -o=json", () => {
    expect(getOutputFormat(["-o=json"])).toBe("json");
  });
  it("returns 'yaml' for --output yaml", () => {
    expect(getOutputFormat(["--output", "yaml"])).toBe("yaml");
  });
  it("returns 'yaml' for --output=yaml", () => {
    expect(getOutputFormat(["--output=yaml"])).toBe("yaml");
  });
  it("returns 'wide' for -o wide", () => {
    expect(getOutputFormat(["-o", "wide"])).toBe("wide");
  });
  it("returns 'name' for -o name", () => {
    expect(getOutputFormat(["-o", "name"])).toBe("name");
  });
  it("returns null for no -o flag", () => {
    expect(getOutputFormat(["get", "pods", "-A"])).toBeNull();
  });

  // jsonpath/go-template/custom-columns prefix matching
  it("returns 'jsonpath' for -o jsonpath='{.items}'", () => {
    expect(getOutputFormat(["-o", "jsonpath={.items}"])).toBe("jsonpath");
  });
  it("returns 'jsonpath' for -o=jsonpath='{.data}'", () => {
    expect(getOutputFormat(["-o=jsonpath={.data}"])).toBe("jsonpath");
  });
  it("returns 'go-template' for -o go-template=...", () => {
    expect(getOutputFormat(["-o", "go-template={{.metadata.name}}"])).toBe("go-template");
  });
  it("returns 'custom-columns' for -o custom-columns=...", () => {
    expect(getOutputFormat(["-o", "custom-columns=NAME:.metadata.name"])).toBe("custom-columns");
  });

  // -o with flags interspersed
  it("works with flags before -o", () => {
    expect(getOutputFormat(["get", "pods", "-n", "default", "-o", "json"])).toBe("json");
  });
  it("works with flags after -o", () => {
    expect(getOutputFormat(["-o", "yaml", "--all-namespaces"])).toBe("yaml");
  });

  // kubectl shorthand: -ojson, -oyaml (no space, no equals)
  it("returns 'json' for -ojson", () => {
    expect(getOutputFormat(["-ojson"])).toBe("json");
  });
  it("returns 'yaml' for -oyaml", () => {
    expect(getOutputFormat(["-oyaml"])).toBe("yaml");
  });
  it("returns 'jsonpath' for -ojsonpath='{.data}'", () => {
    expect(getOutputFormat(["-ojsonpath={.data}"])).toBe("jsonpath");
  });
  it("returns 'wide' for -owide", () => {
    expect(getOutputFormat(["-owide"])).toBe("wide");
  });

  // Edge: -o followed by a flag (no value)
  it("returns null if -o is followed by a flag", () => {
    expect(getOutputFormat(["-o", "-A"])).toBeNull();
  });
});

// ── sanitizeJSON ─────────────────────────────────────────────────────

describe("sanitizeJSON", () => {
  describe("Secret — unconditional redaction", () => {
    it("redacts all .data values", () => {
      const input = JSON.stringify({
        kind: "Secret",
        metadata: { name: "my-secret", namespace: "default" },
        data: { password: "cGFzc3dvcmQ=", token: "dG9rZW4=" },
        type: "Opaque",
      });
      const result = sanitizeJSON(input, "secret");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data.password).toBe("**REDACTED**");
      expect(parsed.data.token).toBe("**REDACTED**");
      expect(parsed.metadata.name).toBe("my-secret");
      expect(parsed.type).toBe("Opaque");
    });

    it("redacts .stringData values", () => {
      const input = JSON.stringify({
        kind: "Secret",
        stringData: { api_key: "sk-12345" },
      });
      const result = sanitizeJSON(input, "secret");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.stringData.api_key).toBe("**REDACTED**");
    });

    it("handles SecretList", () => {
      const input = JSON.stringify({
        kind: "SecretList",
        items: [
          { kind: "Secret", data: { a: "YQ==" } },
          { kind: "Secret", data: { b: "Yg==" }, stringData: { c: "val" } },
        ],
      });
      const result = sanitizeJSON(input, "secret");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.items[0].data.a).toBe("**REDACTED**");
      expect(parsed.items[1].data.b).toBe("**REDACTED**");
      expect(parsed.items[1].stringData.c).toBe("**REDACTED**");
    });

    it("handles Secret with no data field", () => {
      const input = JSON.stringify({
        kind: "Secret",
        metadata: { name: "empty-secret" },
      });
      const result = sanitizeJSON(input, "secret");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.metadata.name).toBe("empty-secret");
    });
  });

  describe("ConfigMap — key/value pattern redaction", () => {
    it("redacts entries with sensitive key names", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "db.password": "super-secret",
          "log.level": "debug",
          "auth-token": "abc123",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["db.password"]).toBe("**REDACTED**");
      expect(parsed.data["log.level"]).toBe("debug");
      expect(parsed.data["auth-token"]).toBe("**REDACTED**");
    });

    it("redacts entries with sensitive value patterns (connection string)", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "db.url": "postgresql://user:pass@db:5432/mydb",
          "api.endpoint": "https://api.example.com",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["db.url"]).toBe("**REDACTED**");
      expect(parsed.data["api.endpoint"]).toBe("https://api.example.com");
    });

    it("redacts entries with JWT value pattern", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "some-config": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["some-config"]).toBe("**REDACTED**");
    });

    it("redacts entries with PEM private key", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "tls.key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["tls.key"]).toBe("**REDACTED**");
    });

    it("redacts entries with known token prefixes", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "github-token": "ghp_abc123def456",
          "gitlab-token": "glpat-xyz789",
          "openai-key": "sk-proj-123",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["github-token"]).toBe("**REDACTED**");
      expect(parsed.data["gitlab-token"]).toBe("**REDACTED**");
      expect(parsed.data["openai-key"]).toBe("**REDACTED**");
    });

    it("preserves non-sensitive entries", () => {
      const input = JSON.stringify({
        kind: "ConfigMap",
        data: {
          "nginx.conf": "server { listen 80; }",
          "feature.flags": "enable_beta=true",
          "log.level": "info",
        },
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.data["nginx.conf"]).toBe("server { listen 80; }");
      expect(parsed.data["feature.flags"]).toBe("enable_beta=true");
      expect(parsed.data["log.level"]).toBe("info");
    });

    it("handles ConfigMapList", () => {
      const input = JSON.stringify({
        kind: "ConfigMapList",
        items: [
          { kind: "ConfigMap", data: { password: "secret" } },
          { kind: "ConfigMap", data: { "log.level": "debug" } },
        ],
      });
      const result = sanitizeJSON(input, "configmap");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.items[0].data.password).toBe("**REDACTED**");
      expect(parsed.items[1].data["log.level"]).toBe("debug");
    });
  });

  describe("Pod — env name pattern redaction", () => {
    it("redacts env vars matching sensitive name patterns", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [{
            name: "app",
            env: [
              { name: "DB_PASSWORD", value: "secret123" },
              { name: "ACCESS_TOKEN", value: "tok-abc" },
              { name: "API_KEY", value: "key-123" },
              { name: "LOG_LEVEL", value: "debug" },
              { name: "NODE_ENV", value: "production" },
            ],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      const env = parsed.spec.containers[0].env;
      expect(env[0].value).toBe("**REDACTED**"); // DB_PASSWORD
      expect(env[1].value).toBe("**REDACTED**"); // ACCESS_TOKEN
      expect(env[2].value).toBe("**REDACTED**"); // API_KEY
      expect(env[3].value).toBe("debug");        // LOG_LEVEL — preserved
      expect(env[4].value).toBe("production");   // NODE_ENV — preserved
    });

    it("preserves valueFrom references", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [{
            env: [
              { name: "SECRET_KEY", valueFrom: { secretKeyRef: { name: "app-secrets", key: "key" } } },
            ],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.spec.containers[0].env[0].valueFrom).toBeDefined();
      expect(parsed.spec.containers[0].env[0].value).toBeUndefined();
    });

    it("handles initContainers", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [],
          initContainers: [{
            env: [{ name: "INIT_SECRET", value: "init-val" }],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.spec.initContainers[0].env[0].value).toBe("**REDACTED**");
    });

    it("handles ephemeralContainers", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [],
          ephemeralContainers: [{
            env: [{ name: "DEBUG_TOKEN", value: "tok-123" }],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.spec.ephemeralContainers[0].env[0].value).toBe("**REDACTED**");
    });

    it("handles PodList", () => {
      const input = JSON.stringify({
        kind: "PodList",
        items: [
          { kind: "Pod", spec: { containers: [{ env: [{ name: "PASSWORD", value: "p1" }] }] } },
          { kind: "Pod", spec: { containers: [{ env: [{ name: "LOG_LEVEL", value: "info" }] }] } },
        ],
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.items[0].spec.containers[0].env[0].value).toBe("**REDACTED**");
      expect(parsed.items[1].spec.containers[0].env[0].value).toBe("info");
    });

    it("does not false-positive on KEY_COUNT or KEYBOARD_LAYOUT", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [{
            env: [
              { name: "KEY_COUNT", value: "42" },
              { name: "KEYBOARD_LAYOUT", value: "us" },
            ],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.spec.containers[0].env[0].value).toBe("42");
      expect(parsed.spec.containers[0].env[1].value).toBe("us");
    });

    it("redacts SSH_KEY and ENCRYPTION_KEY (word-boundary match)", () => {
      const input = JSON.stringify({
        kind: "Pod",
        spec: {
          containers: [{
            env: [
              { name: "SSH_KEY", value: "ssh-rsa AAAA..." },
              { name: "ENCRYPTION_KEY", value: "aes-256-key" },
            ],
          }],
        },
      });
      const result = sanitizeJSON(input, "pod");
      const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
      expect(parsed.spec.containers[0].env[0].value).toBe("**REDACTED**");
      expect(parsed.spec.containers[0].env[1].value).toBe("**REDACTED**");
    });
  });

  describe("error handling", () => {
    it("returns error for invalid JSON", () => {
      const result = sanitizeJSON("not json at all", "secret");
      expect(result).toContain("error");
      expect(result).toContain("Failed to parse");
      expect(result).not.toContain("not json at all");
    });
  });

  describe("warning footer", () => {
    it("appends warning to sanitized output", () => {
      const input = JSON.stringify({ kind: "Secret", data: { a: "b" } });
      const result = sanitizeJSON(input, "secret");
      expect(result).toContain("⚠️ Sensitive values have been redacted");
    });
  });
});

// ── Pattern sanity checks ────────────────────────────────────────────

describe("SENSITIVE_ENV_NAME_PATTERNS", () => {
  const shouldMatch = [
    "DB_PASSWORD", "REDIS_PASSWORD", "password",
    "CLIENT_SECRET", "SECRET_KEY",
    "ACCESS_TOKEN", "AUTH_TOKEN",
    "AWS_CREDENTIAL", "CREDENTIALS",
    "API_KEY", "APIKEY", "API-KEY",
    "PRIVATE_KEY", "PRIVATE-KEY",
    "SSH_KEY", "ENCRYPTION_KEY",
  ];
  const shouldNotMatch = [
    "LOG_LEVEL", "NODE_ENV", "JAVA_OPTS", "PORT", "HOST",
    "KEY_COUNT", "KEYBOARD_LAYOUT", "KEY_PREFIX",
  ];

  for (const name of shouldMatch) {
    it(`matches ${name}`, () => {
      expect(SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(name))).toBe(true);
    });
  }
  for (const name of shouldNotMatch) {
    it(`does not match ${name}`, () => {
      expect(SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(name))).toBe(false);
    });
  }
});

describe("SENSITIVE_VALUE_PATTERNS", () => {
  const shouldMatch = [
    "postgresql://user:pass@db:5432/mydb",
    "mysql://root:secret@localhost/db",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "sk-proj-abc123",
    "ghp_abc123def456",
    "gho_abc123",
    "glpat-xyz789",
  ];
  const shouldNotMatch = [
    "https://api.example.com",
    "debug",
    "true",
    "42",
    "us-east-1",
    "server { listen 80; }",
  ];

  for (const value of shouldMatch) {
    it(`matches "${value.slice(0, 40)}..."`, () => {
      expect(SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))).toBe(true);
    });
  }
  for (const value of shouldNotMatch) {
    it(`does not match "${value}"`, () => {
      expect(SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))).toBe(false);
    });
  }
});
