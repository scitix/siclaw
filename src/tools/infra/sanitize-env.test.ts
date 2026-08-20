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

  it("allows SICLAW_DEBUG_IMAGE but NOT SICLAW_CREDENTIALS_DIR", () => {
    // The credentials dir holds no secret, but it POINTS at the credential tree, and it was classified
    // as harmless on the premise that a child cannot read what it points at — a premise that does not
    // hold in the current image (security.md §4.6). Handing it over is what makes an expansion payload
    // trivial: `"$SICLAW_CREDENTIALS_DIR"/clusters/*` needs no knowledge of the layout. The only reader
    // is the main process reading its own environment, which this does not touch.
    const result = sanitizeEnv({
      SICLAW_DEBUG_IMAGE: "debug:latest",
      SICLAW_CREDENTIALS_DIR: "/app/.siclaw/credentials",
    });
    expect(result).toHaveProperty("SICLAW_DEBUG_IMAGE", "debug:latest");
    expect(result).not.toHaveProperty("SICLAW_CREDENTIALS_DIR");
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

describe("no tool re-injects the credentials pointer after sanitizing", () => {
  it("has no object literal setting SICLAW_CREDENTIALS_DIR anywhere under src/tools", async () => {
    // `sanitizeEnv` strips the variable, and two tools used to add it straight back on the next line —
    // which is why stripping it from the allow-list was not enough on its own. `local-script.ts` built
    // its child env inline rather than through exec-utils, so the guard on exec-utils' builder never
    // covered it: reverting that line failed nothing in the whole suite.
    //
    // A pointer, not a secret. It holds no credential, but it makes an expansion payload trivial to
    // write — `"$SICLAW_CREDENTIALS_DIR"/clusters/*` needs no knowledge of the layout, and the
    // command validator screens text before the shell expands it.
    const { readFileSync, globSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../../..");
    const offenders: string[] = [];
    for (const f of globSync("src/tools/**/*.ts", { cwd: root })) {
      if (f.endsWith(".test.ts")) continue;
      const code = readFileSync(resolve(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // the design notes name it
      if (/SICLAW_CREDENTIALS_DIR\s*:/.test(code)) offenders.push(f);
    }
    expect(offenders, "these files hand a child a pointer to the credential tree").toEqual([]);
  });
});
