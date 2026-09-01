import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// NOTE: We deliberately do NOT import "./agent-factory.js" here.
// The agent-factory module's import graph transitively pulls in `ssh2` via
// `src/tools/infra/ssh-client.ts`, which is an optional peer that may not be
// installed in the test workspace. Importing it would cause vitest's collection
// to fail before any test could run.
//
// Coverage of createSiclawSession is integration-only: see agentbox and gateway
// test suites for end-to-end lifecycle verification.

describe("agent-factory", () => {
  it.skip("NOT-UNIT-TESTABLE: createSiclawSession orchestrates ModelRegistry, DefaultResourceLoader, MemoryIndexer, createAgentSession, McpClientManager, and direct filesystem reads for settings.json/skills. No DI seam exists on the exported signature without rewriting the function. Import graph also depends on optional `ssh2` peer; even importing the module for surface checks fails under vitest when that peer is absent. Covered by integration suites (gateway, agentbox).", async () => {
    // Placeholder — see docs/superpowers/specs/2026-04-17-test-coverage-backfill-design.md
    // "Deferred — needs source refactor" section.
  });

  it("placeholder remains present until integration coverage lands", () => {
    expect(true).toBe(true);
  });

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
    expect(source).toMatch(/resolveCitation:[\s\S]*?citationForRead\(absolutePath, body\)/);
  });

  it("keeps configured MCP as a resolved resource axis, not a built-in capability name filter", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "agent-factory.ts"), "utf8");
    expect(source).toContain('compiledContext.harness.mcpExposure === "configured"');
    expect(source).toMatch(/opts\?\.mcpServers\s*\?\?\s*config\.mcpServers/);
    expect(source).toContain("customTools.push(...mcpTools)");
    expect(source).not.toContain("appendAllowedTools(customTools, mcpTools");
  });
});
