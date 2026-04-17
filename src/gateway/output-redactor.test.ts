import { describe, it, expect } from "vitest";
import {
  buildRedactionConfig,
  buildRedactionConfigForModelConfig,
  redactText,
  type CredentialManifest,
} from "./output-redactor.js";

// ── redactText ─────────────────────────────────────────────────────

describe("redactText", () => {
  it("is a no-op when the config has no patterns", () => {
    const input = "nothing to redact here sk-ANYTHING";
    expect(redactText(input, { patterns: [] })).toBe(input);
  });

  it("replaces matches with [REDACTED]", () => {
    const cfg = { patterns: [/secret-value-123/g] };
    expect(redactText("the secret-value-123 is gone", cfg)).toBe("the [REDACTED] is gone");
  });

  it("applies multiple patterns in order", () => {
    const cfg = { patterns: [/AAA/g, /BBB/g] };
    expect(redactText("AAA-BBB", cfg)).toBe("[REDACTED]-[REDACTED]");
  });

  it("resets lastIndex so repeated calls to the same pattern still match", () => {
    const cfg = { patterns: [/foo/g] };
    const first = redactText("foo foo", cfg);
    expect(first).toBe("[REDACTED] [REDACTED]");
    // Second invocation must still work — the stateful lastIndex is reset internally.
    expect(redactText("foo again", cfg)).toBe("[REDACTED] again");
  });
});

// ── buildRedactionConfig — credentialsDir ─────────────────────────

describe("buildRedactionConfig — credentialsDir", () => {
  it("redacts the credentials dir path and any sub-path", () => {
    const cfg = buildRedactionConfig(undefined, "/app/.siclaw/credentials");
    const input = "file at /app/.siclaw/credentials/foo.kubeconfig plus tail";
    const redacted = redactText(input, cfg);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(".siclaw/credentials/foo");
  });

  it("escapes regex metacharacters in the dir path", () => {
    // Should not throw and the literal path must redact.
    const cfg = buildRedactionConfig(undefined, "/tmp/(weird)/dir+path");
    const redacted = redactText("log /tmp/(weird)/dir+path/file line", cfg);
    expect(redacted).toContain("[REDACTED]");
  });
});

// ── buildRedactionConfig — manifest ────────────────────────────────

describe("buildRedactionConfig — manifest", () => {
  const manifest: CredentialManifest[] = [
    {
      name: "prod-cluster",
      type: "kubeconfig",
      files: ["prod-cluster.kubeconfig"],
      metadata: {
        clusters: [
          { name: "internal-cluster-id-xyz", server: "https://10.0.0.42:6443" },
        ],
      },
    },
  ];

  it("redacts file names listed in the manifest", () => {
    const cfg = buildRedactionConfig(manifest);
    expect(redactText("see prod-cluster.kubeconfig for details", cfg))
      .toBe("see [REDACTED] for details");
  });

  it("redacts cluster server URLs from metadata", () => {
    const cfg = buildRedactionConfig(manifest);
    expect(redactText("connect to https://10.0.0.42:6443", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts internal cluster id when it differs from display name", () => {
    const cfg = buildRedactionConfig(manifest);
    expect(redactText("cluster internal-cluster-id-xyz active", cfg))
      .toContain("[REDACTED]");
  });

  it("does NOT redact cluster name when it equals the credential display name", () => {
    const m: CredentialManifest[] = [{
      name: "same",
      type: "kubeconfig",
      files: [],
      metadata: { clusters: [{ name: "same" }] },
    }];
    const cfg = buildRedactionConfig(m);
    // Only generic patterns and settings path should remain — "same" alone should still appear.
    expect(redactText("cluster same here", cfg)).toBe("cluster same here");
  });

  it("handles manifest entries without metadata", () => {
    const m: CredentialManifest[] = [{ name: "c1", type: "kubeconfig", files: ["c1.kubeconfig"] }];
    expect(() => buildRedactionConfig(m)).not.toThrow();
  });
});

// ── buildRedactionConfig — sensitiveStrings ────────────────────────

describe("buildRedactionConfig — sensitiveStrings", () => {
  it("redacts custom strings longer than 8 chars", () => {
    const cfg = buildRedactionConfig(undefined, undefined, ["MY-SUPER-SECRET"]);
    expect(redactText("value MY-SUPER-SECRET end", cfg))
      .toBe("value [REDACTED] end");
  });

  it("ignores sensitive strings shorter than 8 chars (false-positive guard)", () => {
    const cfg = buildRedactionConfig(undefined, undefined, ["abc"]);
    expect(redactText("abc", cfg)).toBe("abc");
  });

  it("skips empty/undefined entries", () => {
    const cfg = buildRedactionConfig(undefined, undefined, ["", undefined as unknown as string]);
    expect(() => redactText("abcdef ghijkl", cfg)).not.toThrow();
  });
});

// ── buildRedactionConfig — GENERIC_SECRET_PATTERNS ────────────────

describe("buildRedactionConfig — generic secret patterns", () => {
  const cfg = buildRedactionConfig();

  it("always redacts settings.json references", () => {
    expect(redactText("see .siclaw/config/settings.json today", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts OpenAI-style sk- tokens", () => {
    expect(redactText("key sk-abcdefghij0123456789ABCD rest", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts GitHub ghp_ tokens", () => {
    expect(redactText("token ghp_" + "a".repeat(36) + " end", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts github_pat_ tokens", () => {
    expect(redactText("pat github_pat_" + "x".repeat(25) + " end", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts Slack xoxb- style tokens", () => {
    expect(redactText("slack xoxb-" + "1".repeat(25) + " end", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts Google AIza tokens", () => {
    expect(redactText("g AIza" + "Z".repeat(35) + " end", cfg))
      .toContain("[REDACTED]");
  });

  it("redacts Bearer auth header values", () => {
    expect(redactText("Authorization: Bearer " + "A".repeat(32), cfg))
      .toContain("[REDACTED]");
  });

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----";
    expect(redactText(pem, cfg)).toContain("[REDACTED]");
  });

  it("redacts JSON-embedded secret fields", () => {
    const input = '{"apiKey":"topsecretvalue123","name":"visible"}';
    const out = redactText(input, cfg);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("visible");
    expect(out).not.toContain("topsecretvalue123");
  });

  it("redacts ENV-style KEY=value assignments", () => {
    expect(redactText("OPENAI_API_KEY=sk-something-long-enough-123", cfg))
      .toContain("[REDACTED]");
    expect(redactText("SECRET_TOKEN=foo", cfg)).toContain("[REDACTED]");
  });

  it("leaves unrelated text untouched", () => {
    // No known secret pattern; pure prose should pass through unchanged.
    const input = "hello world, pods are healthy.";
    expect(redactText(input, cfg)).toBe(input);
  });
});

// ── buildRedactionConfigForModelConfig ─────────────────────────────

describe("buildRedactionConfigForModelConfig", () => {
  it("includes both apiKey and baseUrl as sensitive strings", () => {
    const cfg = buildRedactionConfigForModelConfig({
      apiKey: "my-long-api-key-123",
      baseUrl: "https://api.example.io/v1",
    });
    expect(redactText("key my-long-api-key-123 and url https://api.example.io/v1", cfg))
      .toContain("[REDACTED]");
  });

  it("still returns a config when modelConfig is undefined", () => {
    const cfg = buildRedactionConfigForModelConfig();
    // settings.json pattern and generic patterns are always present.
    expect(cfg.patterns.length).toBeGreaterThan(0);
  });

  it("skips apiKey/baseUrl when empty", () => {
    const cfg = buildRedactionConfigForModelConfig({ apiKey: "", baseUrl: "" });
    expect(redactText("ordinary prose", cfg)).toBe("ordinary prose");
  });
});
