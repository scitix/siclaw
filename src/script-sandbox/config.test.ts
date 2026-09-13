import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScriptSandboxConfig } from "./config.js";
it("loads the currently projected policy and fails closed on invalid replacements", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-policy-"));
  const file = join(dir, "policy.json");
  try {
    writeFileSync(file, JSON.stringify({ metrics: { query: {} } }));
    const config = loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "fixture",
      SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE: file, SICLAW_SCRIPT_SANDBOX_MAX_TIMEOUT_SECONDS: "" });
    expect(config.maxTimeoutSeconds).toBe(300);
    expect(config.mcpPolicy.metrics.query).toEqual({});
    writeFileSync(file, "{}");
    expect(config.mcpPolicy).toEqual({});
    writeFileSync(file, "invalid-json");
    expect(() => config.mcpPolicy).toThrow();
    writeFileSync(file, JSON.stringify({ metrics: { query: { fixedArguments: { tenant: "new" } } } }));
    expect(config.mcpPolicy.metrics.query.fixedArguments).toEqual({ tenant: "new" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
