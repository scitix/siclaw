import { describe, it, expect, beforeEach } from "vitest";
import { createHostListTool } from "./host-list.js";
import type { KubeconfigRef } from "../../core/types.js";

// host_list always goes through the broker's server-side queryHosts (a blank
// query = browse). The fake records the call and returns a settable result.
function makeFakeBroker(overrides: Partial<any> = {}) {
  return {
    queryCount: 0,
    lastQuery: null as null | { query: string; opts?: { limit?: number; cursor?: string } },
    result: { hosts: [] as any[], total: 0, next_cursor: null as string | null },
    async queryHosts(query: string, opts?: { limit?: number; cursor?: string }) {
      this.queryCount++;
      this.lastQuery = { query, opts };
      return this.result;
    },
    ...overrides,
  };
}

describe("host_list tool", () => {
  let broker: ReturnType<typeof makeFakeBroker>;

  beforeEach(() => {
    broker = makeFakeBroker();
  });

  it("has correct metadata", () => {
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    expect(tool.name).toBe("host_list");
    expect(tool.label).toBe("Host List");
  });

  it("returns error when broker missing", async () => {
    const ref: KubeconfigRef = { credentialsDir: "/tmp" };
    const tool = createHostListTool(ref);
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("Credential broker not initialized");
  });

  it("browses via queryHosts with an empty query when no args are given", async () => {
    broker.result = {
      hosts: [{ name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true }],
      total: 1, next_cursor: null,
    };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.hosts).toHaveLength(1);
    expect(broker.queryCount).toBe(1);
    expect(broker.lastQuery?.query).toBe(""); // browse, not a filter
  });

  it("returns key metadata fields (id surfaced; never password/private_key)", async () => {
    broker.result = {
      hosts: [{ id: "h1-uuid", name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true, description: "ctrl plane", password: "SECRET" }],
      total: 1, next_cursor: null,
    };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", { query: "h1" });
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.hosts[0].id).toBe("h1-uuid");
    expect(parsed.hosts[0].name).toBe("h1");
    expect(parsed.hosts[0].description).toBe("ctrl plane");
    expect(parsed.hosts[0].password).toBeUndefined();
  });

  it("omits id and description when absent", async () => {
    broker.result = {
      hosts: [{ name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "password", is_production: false }],
      total: 1, next_cursor: null,
    };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.hosts[0].id).toBeUndefined();
    expect(parsed.hosts[0].description).toBeUndefined();
  });

  it("surfaces total + next_cursor and a paging hint when truncated", async () => {
    broker.result = {
      hosts: [{ name: "h1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: true }],
      total: 137, next_cursor: "20",
    };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", { query: "node" });
    const text = (result.content[0] as any).text;
    const parsed = JSON.parse(text.split("\n\n")[0]);
    expect(parsed.total).toBe(137);
    expect(parsed.next_cursor).toBe("20");
    expect(text).toContain('cursor="20"');
  });

  it("passes limit + cursor through to queryHosts", async () => {
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    await tool.execute("id", { query: "gpu", limit: 10, cursor: "40" });
    expect(broker.lastQuery).toEqual({ query: "gpu", opts: { limit: 10, cursor: "40" } });
  });

  it("returns helper hint when no hosts bound (empty browse)", async () => {
    broker.result = { hosts: [], total: 0, next_cursor: null };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    expect((result.content[0] as any).text).toContain("No hosts are bound");
  });

  it("query with no matches returns a 'No hosts match' hint", async () => {
    broker.result = { hosts: [], total: 0, next_cursor: null };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", { query: "nope" });
    expect((result.content[0] as any).text).toContain('No hosts match "nope"');
  });

  it("returns error when queryHosts throws", async () => {
    broker.queryHosts = async () => { throw new Error("gateway down"); };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("gateway down");
  });
});
