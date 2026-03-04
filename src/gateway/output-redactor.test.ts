import { describe, it, expect } from "vitest";
import { buildRedactionConfig, redactText } from "./output-redactor.js";

describe("output-redactor", () => {
  describe("buildRedactionConfig", () => {
    it("creates patterns from credential manifest", () => {
      const config = buildRedactionConfig([
        {
          name: "prod-cluster",
          type: "kubeconfig",
          files: ["prod.kubeconfig"],
          metadata: {
            clusters: [{ name: "cz0er7pvw94gmuiq", server: "https://10.155.55.223:6443" }],
          },
        },
      ]);
      expect(config.patterns.length).toBeGreaterThan(0);
    });

    it("includes sensitive strings", () => {
      const config = buildRedactionConfig(undefined, undefined, ["sk-myapikey123456789"]);
      const result = redactText("The key is sk-myapikey123456789", config);
      expect(result).toBe("The key is [REDACTED]");
    });

    it("skips short sensitive strings (< 8 chars)", () => {
      const config = buildRedactionConfig(undefined, undefined, ["short"]);
      const result = redactText("This is short text", config);
      expect(result).toBe("This is short text");
    });
  });

  describe("redactText", () => {
    it("redacts server URLs from credential metadata", () => {
      const config = buildRedactionConfig([{
        name: "test",
        type: "kubeconfig",
        files: ["test.kubeconfig"],
        metadata: {
          clusters: [{ name: "internal-id-123", server: "https://10.155.55.223:6443" }],
        },
      }]);
      const text = "API server: https://10.155.55.223:6443";
      expect(redactText(text, config)).toBe("API server: [REDACTED]");
    });

    it("redacts cluster internal IDs", () => {
      const config = buildRedactionConfig([{
        name: "my-cluster",
        type: "kubeconfig",
        files: [],
        metadata: {
          clusters: [{ name: "cz0er7pvw94gmuiq", server: "https://1.2.3.4:6443" }],
        },
      }]);
      expect(redactText("Cluster cz0er7pvw94gmuiq is healthy", config)).toContain("[REDACTED]");
    });

    it("redacts credentials dir paths", () => {
      const config = buildRedactionConfig([], "/app/.siclaw/credentials");
      expect(redactText("File at /app/.siclaw/credentials/prod.kubeconfig", config)).toContain("[REDACTED]");
    });

    it("redacts settings.json path", () => {
      const config = buildRedactionConfig();
      expect(redactText("Read .siclaw/config/settings.json", config)).toContain("[REDACTED]");
    });

    // Generic token pattern tests
    it("redacts OpenAI-style sk- tokens", () => {
      const config = buildRedactionConfig();
      expect(redactText("key: sk-grYemdBx9ujuhwVWeea6lW9mcsuid9flLkX64DDD4XT4VNYbZW", config)).toContain("[REDACTED]");
    });

    it("redacts GitHub tokens", () => {
      const config = buildRedactionConfig();
      expect(redactText("token: ghp_1234567890abcdef1234567890abcdefABCD", config)).toContain("[REDACTED]");
    });

    it("redacts Bearer tokens", () => {
      const config = buildRedactionConfig();
      expect(redactText("Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6Ikp", config)).toContain("[REDACTED]");
    });

    it("redacts PEM private keys", () => {
      const config = buildRedactionConfig();
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ\n-----END RSA PRIVATE KEY-----";
      expect(redactText(pem, config)).toContain("[REDACTED]");
    });

    it("redacts env var assignments with sensitive names", () => {
      const config = buildRedactionConfig();
      expect(redactText("OPENAI_API_KEY=sk-xxx123456", config)).toContain("[REDACTED]");
    });

    it("returns empty string unchanged", () => {
      const config = buildRedactionConfig();
      expect(redactText("", config)).toBe("");
    });

    it("returns normal text unchanged", () => {
      const config = buildRedactionConfig();
      expect(redactText("kubectl get pods -n default", config)).toBe("kubectl get pods -n default");
    });
  });
});
