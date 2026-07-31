import { describe, it, expect } from "vitest";
import { type ToolRefs } from "../../core/tool-registry.js";
import { createListDelegatesTool, registration } from "./list-delegates.js";
import type { DelegateRosterMember } from "../../shared/agent-delegate.js";

const ROSTER: DelegateRosterMember[] = [
  {
    id: "agent-net",
    name: "net-agent",
    description: "network SRE for production testing",
    clusters: ["sh-1", "roce-test", "cluster-alpha"],
    hosts: [],
  },
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
    expect(t).toContain("(clusters: 3, hosts: 0)");
    expect(t).toContain("gpu-agent [id: agent-gpu]");
    expect(t).toContain("(clusters: 0, hosts: 2)");
    // The actual binding names must NOT leak into a browse.
    expect(t).not.toContain("roce-test");
    expect(t).not.toContain("gpu-1");
    expect((r as any).details.total).toBe(2);
  });

  it("an exact cluster query returns only the delegate covering that binding", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "roce-test" });
    const t = text(r);
    expect(t).toContain('matching "roce-test"');
    expect(t).toContain("net-agent [id: agent-net]");
    expect(t).toContain("clusters matched: roce-test");
    // The non-covering agent is excluded.
    expect(t).not.toContain("gpu-agent");
    expect((r as any).details.total).toBe(1);
    expect((r as any).details.match_basis).toBe("exact_resource_binding");
  });

  it("matches exact host bindings case-insensitively", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "GPU-1" });
    const t = text(r);
    expect(t).toContain("gpu-agent [id: agent-gpu]");
    expect(t).toContain("hosts matched: gpu-1");
    expect(t).not.toContain("net-agent");
  });

  it("does not treat partial bindings, agent names, or descriptions as coverage", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    for (const query of ["test", "net-agent", "production"]) {
      const r = await tool.execute("c1", { query });
      expect((r as any).details.total).toBe(0);
      expect(text(r)).not.toContain("[id: agent-net]");
    }
  });

  it("a first miss offers one optional alias-resolution retry", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", { query: "does-not-exist" });
    const t = text(r);
    expect(t).toMatch(/No exact delegate resource binding matches "does-not-exist"/);
    expect(t).toMatch(/routing-helper skill/i);
    expect(t).toContain("binding_name_confirmed=true");
    expect(t).toMatch(/Do not delegate/i);
    expect((r as any).details.total).toBe(0);
    expect((r as any).details.binding_name_confirmed).toBe(false);
  });

  it("supports one alias-resolution retry with a confirmed binding name", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const first = await tool.execute("c1", { query: "local-alias" });
    expect((first as any).details.total).toBe(0);
    expect((first as any).details.binding_name_confirmed).toBe(false);

    const retry = await tool.execute("c2", {
      query: "cluster-alpha",
      binding_name_confirmed: true,
    });
    expect((retry as any).details.total).toBe(1);
    expect((retry as any).details.binding_name_confirmed).toBe(true);
    expect(text(retry)).toContain("clusters matched: cluster-alpha");
    expect(text(retry)).not.toMatch(/routing-helper skill/i);
  });

  it("a confirmed binding-name miss is terminal", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", {
      query: "canonical-does-not-exist",
      binding_name_confirmed: true,
    });
    const t = text(r);
    expect(t).toMatch(/No delegate agent covers the confirmed binding name/);
    expect(t).not.toMatch(/routing-helper skill/i);
    expect(t).not.toContain("binding_name_confirmed=true");
    expect(t).toMatch(/Do not delegate/i);
    expect((r as any).details.total).toBe(0);
    expect((r as any).details.binding_name_confirmed).toBe(true);
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
