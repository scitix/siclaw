/**
 * Integration guard for the read-only DELEGATION tier over the REAL tool
 * registry (allToolEntries). Asserts that a delegated read-only worker is left
 * with genuine read-only diagnostic power (kubectl read-only via restricted_bash
 * + resource/memory lookups + the result-artifact reporter) while every write /
 * remediation / resource-creating / arbitrary-code tool is filtered out.
 *
 * This is the behavioural contract behind docs/design/agent-delegation.md §8; a
 * new mutation tool added without thought will trip the "must be absent" list.
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry, type ToolRefs } from "../core/tool-registry.js";
import { allToolEntries } from "./all-entries.js";

function resolveNames(refs: Partial<ToolRefs>): string[] {
  const registry = new ToolRegistry();
  registry.register(...allToolEntries);
  const full: ToolRefs = {
    kubeconfigRef: {},
    userId: "u1",
    agentId: "agent-1",
    sessionIdRef: { current: "s1" },
    taskListId: "tl1",
    memoryRef: {},
    dpStateRef: { active: false },
    ...refs,
  } as ToolRefs;
  return registry.resolve({ mode: "web", refs: full, allowedTools: null }).map((t) => t.name);
}

describe("read-only delegation tier (real registry)", () => {
  const delegatedNames = () =>
    resolveNames({
      delegation: { delegationId: "d1", readOnly: true },
      sessionEventEmitter: () => {},
      backgroundExecExecutor: undefined,
    });

  it("KEEPS read-only diagnosis tools", () => {
    const names = delegatedNames();
    // kubectl read-only diagnosis + resource lookups + the artifact reporter
    // ("bash" is the restricted-bash tool's model-visible name)
    for (const keep of ["bash", "cluster_list", "host_list", "report_findings"]) {
      expect(names, `${keep} should survive read-only delegation`).toContain(keep);
    }
  });

  it("DROPS every write / remediation / resource-creating / arbitrary-code tool", () => {
    const names = delegatedNames();
    for (const drop of [
      "node_exec", "pod_exec", "host_exec",          // create/pin a debug pod (cluster write)
      "node_script", "pod_script", "local_script", "host_script", // arbitrary model-supplied code
      "write", "edit",                                // file writes
      "spawn_subagent",                               // recursion / privilege amplification
      "channel_update",                               // must route back to coordinator, not own channel
    ]) {
      expect(names, `${drop} must NOT be available under read-only delegation`).not.toContain(drop);
    }
  });

  it("a non-delegated turn keeps the full tool set (exec + scripts present)", () => {
    const names = resolveNames({ backgroundExecExecutor: undefined });
    expect(names).toContain("node_exec");
    expect(names).toContain("bash");
    expect(names).not.toContain("report_findings"); // only under delegation
  });
});
