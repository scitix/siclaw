import { describe, it, expect } from "vitest";
import { sanitizeEnv } from "./sanitize-env.js";

describe("sanitizeEnv", () => {
  it("blocks SICLAW_LLM_API_KEY", () => {
    const result = sanitizeEnv({ SICLAW_LLM_API_KEY: "sk-secret", PATH: "/usr/bin" });
    expect(result).not.toHaveProperty("SICLAW_LLM_API_KEY");
    expect(result).toHaveProperty("PATH", "/usr/bin");
  });

  it("blocks SICLAW_EMBEDDING_API_KEY", () => {
    const result = sanitizeEnv({
      SICLAW_EMBEDDING_API_KEY: "embkey",
    });
    expect(result).not.toHaveProperty("SICLAW_EMBEDDING_API_KEY");
  });

  it("blocks SICLAW_JWT_SECRET and SICLAW_SSO_CLIENT_SECRET", () => {
    const result = sanitizeEnv({
      SICLAW_JWT_SECRET: "jwtsecret",
      SICLAW_SSO_CLIENT_SECRET: "ssosecret",
    });
    expect(result).not.toHaveProperty("SICLAW_JWT_SECRET");
    expect(result).not.toHaveProperty("SICLAW_SSO_CLIENT_SECRET");
  });

  it("allows SICLAW_DEBUG_IMAGE and SICLAW_CREDENTIALS_DIR", () => {
    const result = sanitizeEnv({
      SICLAW_DEBUG_IMAGE: "debug:latest",
      SICLAW_CREDENTIALS_DIR: "/app/.siclaw/credentials",
    });
    expect(result).toHaveProperty("SICLAW_DEBUG_IMAGE", "debug:latest");
    expect(result).toHaveProperty("SICLAW_CREDENTIALS_DIR", "/app/.siclaw/credentials");
  });

  it("blocks common sensitive env vars", () => {
    const result = sanitizeEnv({
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "oai-key",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "ghp_xxx",
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("blocks suffix-matched vars", () => {
    const result = sanitizeEnv({
      CUSTOM_API_KEY: "key1",
      MY_SECRET_TOKEN: "token1",
      DB_PASSWORD: "pass1",
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("passes through safe system vars", () => {
    const result = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      NODE_ENV: "production",
    });
    expect(Object.keys(result)).toHaveLength(5);
  });
});
