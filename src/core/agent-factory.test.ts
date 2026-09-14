import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// Structural checks complement the real factory/SDK resource-boundary tests
// in agent-factory-boundaries.test.ts.
describe("agent-factory", () => {
  it("keeps the agent-scoped knowledge override as the one citation root", () => {
    // Cross-PR regression guard for #489 + #490. This module cannot be imported
    // in the unit workspace (see above), so pin the conflict-sensitive wiring
    // structurally: a bad resolution that restores the shared root goes red.
    const source = fs.readFileSync(path.resolve(__dirname, "agent-factory.ts"), "utf8");
    expect(source).toMatch(/const knowledgeDir = opts\?\.knowledgeDir\s*\?\?/);
    expect(source).toMatch(/createKnowledgeCitationSupport\(\{\s*knowledgeDir,/);
    expect(source).toContain("buildKnowledgeCitationSystemPrompt(knowledgeDir)");
    expect(source).toMatch(/captureMount\(\)[\s\S]*?fsReadFile\(p\)[\s\S]*?noteRead\(p,/);
    expect(source).not.toMatch(/citationSupport\?\.noteRead\(p\);/);
  });

  it("keeps configured MCP as a resolved resource axis, not a built-in capability name filter", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "agent-factory.ts"), "utf8");
    expect(source).toContain('compiledContext.harness.mcpExposure === "configured"');
    expect(source).toMatch(/opts\?\.mcpServers\s*\?\?\s*config\.mcpServers/);
    expect(source).toContain("customTools.push(...mcpTools)");
    expect(source).not.toContain("appendAllowedTools(customTools, mcpTools");
  });

  it("captures MCP results as scoped artifacts and exposes intrinsic recovery tools", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "agent-factory.ts"), "utf8");
    expect(source).toContain("withToolResultArtifactCapture(tool, toolResultArtifactStore)");
    expect(source).toContain("customTools.push(...createToolResultArtifactTools(toolResultArtifactStore))");
    expect(source).not.toMatch(/if \(mcpTools\.length > 0\)[\s\S]{0,120}createToolResultArtifactTools/);
    expect(source).toContain("toolResultArtifactsDir");
    expect(source).toMatch(/blockedFileDirs[\s\S]*toolResultArtifactsDir/);
    expect(source).toContain("isToolResultArtifactPath(absolutePath)");
    expect(source).toContain("isToolResultArtifactPath(candidate)");
    expect(source).toContain("sessionId: sessionIdRef.current || sessionManagerId");
    expect(source).not.toContain('sessionId: sessionIdRef.current || "standalone"');
  });
});
