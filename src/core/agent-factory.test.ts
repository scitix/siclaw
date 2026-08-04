import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// NOTE: We deliberately do NOT import "./agent-factory.js" here.
// The agent-factory module's import graph transitively pulls in `ssh2` via
// `src/tools/infra/ssh-client.ts`, which is an optional peer that may not be
// installed in the test workspace. Importing it would cause vitest's collection
// to fail before any test could run.
//
// Coverage of createSiclawSession is integration-only: see agentbox and gateway
// test suites for end-to-end lifecycle verification.

/**
 * Source-level, for the reason stated above: this file cannot import
 * agent-factory. The contract is a DELETION, so what needs guarding is that it
 * does not come back — which reading the source proves as well as calling it
 * would.
 */
describe("PROFILE.md must not produce a reply-language instruction", () => {
  const src = readFileSync(new URL("./agent-factory.ts", import.meta.url), "utf-8");

  // PROFILE.md lives at user-data/agents/{agentId}. An AgentBox is keyed by
  // agent, so the file is shared by every user of it — an instruction derived
  // from its `**Language**` field told one user to be answered in whatever
  // language another had last written in. Reply language is decided per turn
  // from the message and the conversation instead (shared/agent-locale.ts).
  it("derives no directive from the **Language** field", () => {
    // The field is still WRITTEN into the skeleton profile, which is fine — a
    // user profile may record a language. What must not come back is READING it
    // back out to build an instruction.
    expect(src).not.toMatch(/(?:match|exec|test)\([^)]*\\\*\\\*Language/);
    expect(src).not.toMatch(/preferred language/i);
    expect(src).not.toMatch(/Language Preference/i);
  });

  // The file's own content is still injected as context, which is intended —
  // and separately means the whole profile (name, role, infrastructure) is
  // agent-scoped too. That is a wider issue than language; this only pins that
  // language stopped being an INSTRUCTION.
  it("still injects the profile as context", () => {
    expect(src).toContain("## User Profile");
  });
});

describe("agent-factory", () => {
  it.skip("NOT-UNIT-TESTABLE: createSiclawSession orchestrates ModelRegistry, DefaultResourceLoader, MemoryIndexer, createAgentSession, McpClientManager, and direct filesystem reads for settings.json/skills. No DI seam exists on the exported signature without rewriting the function. Import graph also depends on optional `ssh2` peer; even importing the module for surface checks fails under vitest when that peer is absent. Covered by integration suites (gateway, agentbox).", async () => {
    // Placeholder — see docs/superpowers/specs/2026-04-17-test-coverage-backfill-design.md
    // "Deferred — needs source refactor" section.
  });

  it("placeholder remains present until integration coverage lands", () => {
    expect(true).toBe(true);
  });
});
