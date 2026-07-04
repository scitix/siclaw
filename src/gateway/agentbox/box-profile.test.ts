import { describe, it, expect, afterEach } from "vitest";
import { getBoxProfile, AGENT_PROFILE } from "./box-profile.js";

/**
 * BoxProfile registry — the declarative descriptor that replaced the isCompile
 * special-casing. These lock in the shapes A.2/A.4 depend on + the fail-closed
 * resolution that keeps "different scenario = different box" a real trust boundary.
 */
describe("getBoxProfile", () => {
  const saved = process.env.SICLAW_COMPILE_BOX_IMAGE;
  afterEach(() => {
    if (saved === undefined) delete process.env.SICLAW_COMPILE_BOX_IMAGE;
    else process.env.SICLAW_COMPILE_BOX_IMAGE = saved;
  });

  it("undefined / 'agent' → the default agent profile (no extra shape, all tools)", () => {
    expect(getBoxProfile(undefined)).toBe(AGENT_PROFILE);
    expect(getBoxProfile("agent")).toBe(AGENT_PROFILE);
    const p = getBoxProfile("agent");
    expect(p.image).toBeUndefined();
    expect(p.volumes).toBeUndefined();
    expect(p.allowedTools).toBeUndefined();
  });

  it("kb-compile → dedicated image + LLM env + writable /work + HOME, all tools", () => {
    process.env.SICLAW_COMPILE_BOX_IMAGE = "kbc-compile-box:test-tag";
    const p = getBoxProfile("kb-compile");
    expect(p.image).toBe("kbc-compile-box:test-tag");
    expect(p.home).toBe("/work");
    expect(p.volumes).toEqual([{ name: "work", mountPath: "/work", sizeLimit: "1Gi" }]);
    expect(p.envForward).toContain("ANTHROPIC_BASE_URL");
    expect(p.allowedTools).toBeNull();
  });

  it("kb-test → same box shape as kb-compile but a read-only tool envelope", () => {
    const compile = getBoxProfile("kb-compile");
    const test = getBoxProfile("kb-test");
    // Identical infra shape...
    expect(test.image).toBe(compile.image);
    expect(test.home).toBe(compile.home);
    expect(test.volumes).toEqual(compile.volumes);
    // ...the trust difference is expressed purely as allowedTools.
    expect(test.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(test.allowedTools).not.toContain("Write");
    expect(test.allowedTools).not.toContain("Bash");
  });

  it("kb-compile-codex → same box shape as kb-compile, codex image + CODEX auth env", () => {
    const savedCodex = process.env.SICLAW_COMPILE_BOX_CODEX_IMAGE;
    try {
      process.env.SICLAW_COMPILE_BOX_CODEX_IMAGE = "kbc-compile-box-codex:test-tag";
      const compile = getBoxProfile("kb-compile");
      const codex = getBoxProfile("kb-compile-codex");
      // Identical infra shape (writable /work + HOME) — only the engine differs...
      expect(codex.image).toBe("kbc-compile-box-codex:test-tag");
      expect(codex.home).toBe(compile.home);
      expect(codex.volumes).toEqual(compile.volumes);
      expect(codex.allowedTools).toBeNull();
      // ...and the auth envelope is codex's: short-TTL token in, NO ANTHROPIC_*.
      expect(codex.envForward).toContain("CODEX_ACCESS_TOKEN");
      expect(codex.envForward).toContain("CODEX_API_KEY");
      expect(codex.envForward).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      if (savedCodex === undefined) delete process.env.SICLAW_COMPILE_BOX_CODEX_IMAGE;
      else process.env.SICLAW_COMPILE_BOX_CODEX_IMAGE = savedCodex;
    }
  });

  it("fail-closed: an unknown profile throws (no silent downgrade to the all-tools agent)", () => {
    expect(() => getBoxProfile("kb-tset")).toThrow(/unknown BoxProfile/);
  });
});
