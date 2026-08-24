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

  it("a query renders only the kind that matched, not the other kind's irrelevant total", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const t = text(await tool.execute("c1", { query: "roce-test" }));
    expect(t).toContain("clusters matched: roce-test");
    // Was `hosts: no match (N total)` — a count of resources irrelevant to the question, which
    // invites reading a large total as if it were coverage.
    expect(t).not.toContain("no match");
    expect(t).not.toContain("hosts:");
  });

  it("match_basis distinguishes a zero-match query from a successful one and from browsing", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    // A query that matched nothing did NOT perform an exact_resource_binding match. Reporting one
    // made a miss indistinguishable from a hit in telemetry — which is how "46 empty results" was
    // initially misread. details is stripped before the model sees it, so this is telemetry only.
    const miss = await tool.execute("c1", { query: "no-such-cluster" });
    expect((miss as any).details.total).toBe(0);
    expect((miss as any).details.match_basis).toBe("no_match");

    const browse = await tool.execute("c1", {});
    expect((browse as any).details.match_basis).toBe("browse");
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
    expect(t).toMatch(/retry_token="[0-9a-f-]{36}"/);
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

  it("a repeated unconfirmed miss is terminal — the retry offer is not reissuable", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));

    const first = text(await tool.execute("c1", { query: "local-alias" }));
    expect(first).toMatch(/routing-helper skill/i);

    const again = text(await tool.execute("c2", { query: "local-alias" }));
    expect(again).toMatch(/already offered/i);
    expect(again).toMatch(/Do not retry/i);
    expect(again).not.toMatch(/routing-helper skill/i);
  });

  it("alias → canonical without the flag is terminal — the name change cannot earn a second retry", async () => {
    // The real alias flow CHANGES the query string, so a per-string memory would
    // not catch it: the canonical name is a different key, and a caller that drops
    // `binding_name_confirmed` would be offered alias resolution all over again.
    // The outstanding token is what makes this terminal.
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));

    const first = text(await tool.execute("c1", { query: "local-alias" }));
    expect(first).toMatch(/routing-helper skill/i);

    const resolved = text(await tool.execute("c2", { query: "canonical-but-uncovered" }));
    expect(resolved).not.toMatch(/routing-helper skill/i);
    expect(resolved).not.toMatch(/Retry ONCE/i);
    expect(resolved).toMatch(/already offered/i);
    expect(resolved).toMatch(/Do not retry/i);
  });

  it("presenting the token spends the one retry; a further miss is terminal", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));

    const first = text(await tool.execute("c1", { query: "local-alias" }));
    const token = first.match(/retry_token="([0-9a-f-]{36})"/)?.[1];
    expect(token).toBeTruthy();

    const spent = text(await tool.execute("c2", {
      query: "canonical-but-uncovered",
      binding_name_confirmed: true,
      retry_token: token,
    }));
    expect(spent).toMatch(/Do not retry/i);

    // Token is single-use: replaying it cannot reopen the retry.
    const replay = text(await tool.execute("c3", { query: "another-alias", retry_token: token }));
    expect(replay).toMatch(/routing-helper skill/i); // a NEW attempt gets its own offer
    const replayAgain = text(await tool.execute("c4", { query: "another-alias", retry_token: token }));
    expect(replayAgain).toMatch(/already offered/i);
  });

  it("a terminal outcome frees the slot, so the next routing question still gets one retry", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    await tool.execute("c1", { query: "local-alias" });                 // offer
    const terminal = text(await tool.execute("c2", { query: "local-alias" })); // terminal, clears
    expect(terminal).toMatch(/Do not retry/i);

    const fresh = text(await tool.execute("c3", { query: "unrelated-alias" }));
    expect(fresh).toMatch(/routing-helper skill/i);
    expect(fresh).toMatch(/retry_token="[0-9a-f-]{36}"/);
  });

  it("a SUCCESSFUL canonical retry consumes the token, so an unrelated miss still gets its own retry", async () => {
    // The offer must be resolved whether the retry hits or misses. Clearing it only
    // on an empty result left it outstanding after a hit, and the next unrelated
    // routing question was then wrongly told its retry had already been offered.
    const turnRef = { current: 1 };
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER, turnRef }));

    const first = text(await tool.execute("c1", { query: "local-alias" }));
    const token = first.match(/retry_token="([0-9a-f-]{36})"/)?.[1];
    expect(token).toBeTruthy();

    const hit = await tool.execute("c2", {
      query: "cluster-alpha",
      binding_name_confirmed: true,
      retry_token: token,
    });
    expect((hit as any).details.total).toBe(1);

    const unrelated = text(await tool.execute("c3", { query: "unrelated-alias" }));
    expect(unrelated).toMatch(/routing-helper skill/i);
    expect(unrelated).toMatch(/retry_token="[0-9a-f-]{36}"/);
    expect(unrelated).not.toMatch(/already offered/i);
  });

  it("an abandoned offer is retired at the turn boundary, not carried into the next question", async () => {
    // First miss says "consult a helper"; none is attached, so the model correctly
    // answers the user and never calls again. That unspent offer must not make the
    // NEXT user question's first miss look terminal.
    const turnRef = { current: 1 };
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER, turnRef }));

    const first = text(await tool.execute("c1", { query: "local-alias" }));
    expect(first).toMatch(/routing-helper skill/i);

    turnRef.current += 1;  // the user asks something else

    const nextTurn = text(await tool.execute("c2", { query: "another-alias" }));
    expect(nextTurn).toMatch(/routing-helper skill/i);
    expect(nextTurn).toMatch(/retry_token="[0-9a-f-]{36}"/);
    expect(nextTurn).not.toMatch(/already offered/i);
  });

  it("within ONE turn the offer still binds — a name change cannot reissue it", async () => {
    const turnRef = { current: 7 };
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER, turnRef }));

    expect(text(await tool.execute("c1", { query: "local-alias" }))).toMatch(/routing-helper skill/i);
    const renamed = text(await tool.execute("c2", { query: "canonical-but-uncovered" }));
    expect(renamed).toMatch(/already offered/i);
    expect(renamed).toMatch(/Do not retry/i);
  });

  it("a confirmed binding-name miss is terminal", async () => {
    const tool = createListDelegatesTool(makeRefs({ delegationRoster: ROSTER }));
    const r = await tool.execute("c1", {
      query: "canonical-does-not-exist",
      binding_name_confirmed: true,
    });
    const t = text(r);
    expect(t).toMatch(/No delegate agent covers "canonical-does-not-exist" \(confirmed binding name\)/);
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
