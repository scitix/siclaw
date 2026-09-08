import { describe, it, expect } from "vitest";
import { acquireCapabilityBox, type CapabilityBoxAcquirer } from "./box-acquire.js";

class FakeManager implements CapabilityBoxAcquirer {
  calls: string[] = [];
  live: { endpoint: string } | undefined;
  constructor(live?: { endpoint: string }) {
    this.live = live;
  }
  async getAsync(agentId: string, profile?: string) {
    this.calls.push(`getAsync:${agentId}:${profile}`);
    return this.live;
  }
  async getOrCreateWithDisposition(agentId: string, config: { profile: string }) {
    this.calls.push(`getOrCreateWithDisposition:${agentId}:${config.profile}`);
    return { handle: { endpoint: "https://new-box:3000" }, created: true };
  }
  async getOrCreate(agentId: string, config: { profile: string }) {
    this.calls.push(`getOrCreate:${agentId}:${config.profile}`);
    return { endpoint: "https://new-box:3000" };
  }
}

describe("acquireCapabilityBox", () => {
  it("reuses the run's live box as-is and never enters acquisition (no image roll mid-run)", async () => {
    const mgr = new FakeManager({ endpoint: "https://kbc-box-run1:3000" });
    const got = await acquireCapabilityBox(mgr, "run1", "kb-compile", "org1");
    expect(got).toEqual({ endpoint: "https://kbc-box-run1:3000", created: false });
    expect(mgr.calls).toEqual(["getAsync:run1:kb-compile"]);
  });

  it("spawns through acquisition only when no live box exists, reporting the disposition", async () => {
    const mgr = new FakeManager(undefined);
    const got = await acquireCapabilityBox(mgr, "run2", "kb-compile", "org1");
    expect(got).toEqual({ endpoint: "https://new-box:3000", created: true });
    expect(mgr.calls).toEqual(["getAsync:run2:kb-compile", "getOrCreateWithDisposition:run2:kb-compile"]);
  });

  it("falls back to getOrCreate (treated as creator) for managers without disposition", async () => {
    const mgr = new FakeManager(undefined);
    (mgr as Partial<CapabilityBoxAcquirer>).getOrCreateWithDisposition = undefined;
    const got = await acquireCapabilityBox(mgr, "run3", "kb-compile");
    expect(got).toEqual({ endpoint: "https://new-box:3000", created: true });
    expect(mgr.calls).toEqual(["getAsync:run3:kb-compile", "getOrCreate:run3:kb-compile"]);
  });
});
