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
    expect(p.nestedSandbox).toBeUndefined();
  });

  it("kb-compile → dedicated image + LLM env + writable /work + box-owned restricted tools", () => {
    process.env.SICLAW_COMPILE_BOX_IMAGE = "siclaw-kbc-box:test-tag";
    const p = getBoxProfile("kb-compile");
    expect(p.image).toBe("siclaw-kbc-box:test-tag");
    expect(p.home).toBe("/work");
    expect(p.nestedSandbox).toBeUndefined();
    expect(p.volumes).toEqual([{ name: "work", mountPath: "/work", sizeLimit: "4Gi" }]);
    expect(p.envForward).toContain("ANTHROPIC_BASE_URL");
    expect(p.envForward).not.toContain("ANTHROPIC_API_KEY");
    expect(p.envForward).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(p.allowedTools).toBeNull();
  });

  it("kb-compile-codex → compile shape plus the declared Bubblewrap requirement", () => {
    const compile = getBoxProfile("kb-compile");
    const codex = getBoxProfile("kb-compile-codex");
    expect(codex).toMatchObject({
      ...compile,
      name: "kb-compile-codex",
      nestedSandbox: "bubblewrap",
    });
  });

  it("kb-test → same box shape as kb-compile but a read-only tool envelope", () => {
    const compile = getBoxProfile("kb-compile");
    const test = getBoxProfile("kb-test");
    // Identical infra shape...
    expect(test.image).toBe(compile.image);
    expect(test.home).toBe(compile.home);
    expect(test.volumes).toEqual(compile.volumes);
    expect(test.nestedSandbox).toBeUndefined();
    // ...the trust difference is expressed purely as allowedTools.
    expect(test.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(test.allowedTools).not.toContain("Write");
    expect(test.allowedTools).not.toContain("Bash");
  });

  it("compile profiles declare the kbc-box pod prefix; agent/test keep the default", () => {
    // Operational distinguishability: a compile box's pod name must read as a KB
    // box, not a chat agentbox, when an operator scans `kubectl get pods`.
    expect(getBoxProfile("kb-compile").podNamePrefix).toBe("kbc-box");
    expect(getBoxProfile("kb-compile-codex").podNamePrefix).toBe("kbc-box");
    // The default agent and the read-only kb-test box keep the agentbox prefix
    // (kb-test is short-lived and out of scope for this rename).
    expect(getBoxProfile("agent").podNamePrefix).toBeUndefined();
    expect(getBoxProfile("kb-test").podNamePrefix).toBeUndefined();
  });

  it("fail-closed: an unknown profile throws (no silent downgrade to the all-tools agent)", () => {
    expect(() => getBoxProfile("kb-tset")).toThrow(/unknown BoxProfile/);
  });
});
