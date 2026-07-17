import { describe, it, expect } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createListDelegatesTool, registration } from "./list-delegates.js";
import type { DelegateRosterMember } from "../../shared/agent-delegate.js";

const ROSTER: DelegateRosterMember[] = [
  { id: "agent-net", name: "net-agent", description: "network SRE", clusters: ["sh-1", "roce-test"], hosts: [] },
  { id: "agent-gpu", name: "gpu-agent", description: "GPU SRE", clusters: [], hosts: ["gpu-1", "gpu-2"] },
];

function makeRefs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return {
    kubeconfigRef: {} as any,
    userId: "u1",
    agentId: "coordinator-1",
    sessionIdRef: { current: "s1" },
    taskListId: "tl1",
    memoryRef: {} as any,
    dpStateRef: {} as any,
    ...overrides,
  };
}

const text = (r: any) => (r.content[0] as any).text as string;

describe("list_delegates tool", () => {
  it("is available only when a roster is present and NOT on a delegated turn", () => {
    expect(registration.available?.(makeRefs())).toBe(false); // no roster
    expect(registration.available?.(makeRefs({ delegationRoster: [] }))).toBe(false); // empty roster
    expect(registration.available?.(makeRefs({ delegationRoster: ROSTER }))).toBe(true);
    // one-level guard: a delegated worker never sees its coordinator's roster
    expect(registration.available?.(makeRefs({
      delegationRoster: ROSTER,
      delegation: { delegationId: "d1", readOnly: true },
    }))).toBe(false);
  });

  it("browse (no query) lists ONE counts-only line per agent — never the binding names", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", {});
    const t = text(r);
    expect(t).toContain("net-agent [id: agent-net]");
    expect(t).toContain("(clusters: 2, hosts: 0)");
    expect(t).toContain("gpu-agent [id: agent-gpu]");
    expect(t).toContain("(clusters: 0, hosts: 2)");
    // The actual binding names must NOT leak into a browse.
    expect(t).not.toContain("roce-test");
    expect(t).not.toContain("gpu-1");
    expect((r as any).details.total).toBe(2);
  });

  it("query returns only agents covering the target, showing the matched binding", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "roce-test" });
    const t = text(r);
    expect(t).toContain('matching "roce-test"');
    expect(t).toContain("net-agent [id: agent-net]");
    expect(t).toContain("clusters matched: roce-test");
    // The non-covering agent is excluded.
    expect(t).not.toContain("gpu-agent");
    expect((r as any).details.total).toBe(1);
  });

  it("query matches host names too (case-insensitive substring)", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "GPU-1" });
    const t = text(r);
    expect(t).toContain("gpu-agent [id: agent-gpu]");
    expect(t).toContain("hosts matched: gpu-1");
    expect(t).not.toContain("net-agent");
  });

  it("tells the coordinator to ask/not-delegate when nothing covers the target", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "does-not-exist" });
    const t = text(r);
    expect(t).toMatch(/No delegate agent covers "does-not-exist"/);
    expect(t).toMatch(/Do not delegate/i);
    expect((r as any).details.total).toBe(0);
  });

  it("caps a page and emits a next_cursor", async () => {
    const many: DelegateRosterMember[] = Array.from({ length: 25 }, (_, i) => ({
      id: `a${i}`, name: `agent-${i}`, description: "", clusters: [`c${i}`], hosts: [],
    }));
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: many }));
    const r = await tool.execute("c1", { limit: 10 });
    expect((r as any).details.shown).toBe(10);
    expect((r as any).details.total).toBe(25);
    expect((r as any).details.next_cursor).toBe("10");
    expect(text(r)).toContain('cursor="10"');
    // Page 2 via the cursor.
    const r2 = await tool.execute("c1", { limit: 10, cursor: "10" });
    expect((r2 as any).details.shown).toBe(10);
    expect((r2 as any).details.next_cursor).toBe("20");
  });
});
