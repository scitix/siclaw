import { describe, it, expect, beforeEach } from "vitest";
import { createHostListTool } from "./host-list.js";
import type { KubeconfigRef } from "../../core/types.js";

function makeFakeBroker(overrides: Partial<any> = {}) {
  return {
    hostsReady: false,
    refreshCount: 0,
    hosts: [] as any[],
    isHostsReady() {
      return this.hostsReady;
    },
    async refreshHosts() {
      this.refreshCount++;
      this.hostsReady = true;
    },
    getHostsLocal() {
      return this.hosts;
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

  it("refreshes hosts on first call, serves cache after", async () => {
    broker.hosts = [
      {
        name: "h1", ip: "10.0.0.1", port: 22, username: "root",
        auth_type: "key", is_production: true,
      },
    ];
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    await tool.execute("id-1", {});
    await tool.execute("id-2", {});
    expect(broker.refreshCount).toBe(1);
  });

  it("returns hosts list JSON with key metadata fields", async () => {
    broker.hosts = [
      {
        name: "h1", ip: "10.0.0.1", port: 22, username: "root",
        auth_type: "key", is_production: true, description: "ctrl plane",
        password: "SECRET", // must be omitted
      },
    ];
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const text = (result.content[0] as any).text;
    const parsed = JSON.parse(text.split("\n\n")[0]);
    expect(parsed.hosts).toHaveLength(1);
    expect(parsed.hosts[0].name).toBe("h1");
    expect(parsed.hosts[0].ip).toBe("10.0.0.1");
    expect(parsed.hosts[0].auth_type).toBe("key");
    expect(parsed.hosts[0].description).toBe("ctrl plane");
    expect(parsed.hosts[0].password).toBeUndefined();
  });

  it("omits description field when absent", async () => {
    broker.hosts = [{
      name: "h1", ip: "10.0.0.1", port: 22, username: "root",
      auth_type: "password", is_production: false,
    }];
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text.split("\n\n")[0]);
    expect(parsed.hosts[0].description).toBeUndefined();
  });

  it("returns helper hint when no hosts bound", async () => {
    broker.hosts = [];
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const text = (result.content[0] as any).text;
    expect(text).toContain("No hosts are bound");
  });

  it("returns error when refresh throws", async () => {
    broker.refreshHosts = async () => { throw new Error("gateway down"); };
    const tool = createHostListTool({ credentialsDir: "/tmp", credentialBroker: broker as any });
    const result = await tool.execute("id", {});
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.error).toContain("gateway down");
  });
});
