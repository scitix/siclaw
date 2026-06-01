import { describe, it, expect } from "vitest";
import {
  ensureClusterForTool,
  ensureHostForTool,
} from "./ensure-kubeconfigs.js";

describe("ensureClusterForTool", () => {
  it("no-op when broker undefined", async () => {
    await expect(ensureClusterForTool(undefined, "x", "p")).resolves.toBeUndefined();
  });

  it("calls ensureCluster for specific name", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [],
    } as any;
    await ensureClusterForTool(broker, "prod", "p");
    expect(calls).toEqual(["prod"]);
  });

  it("auto-selects single cluster when no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "only-one" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual(["only-one"]);
  });

  it("does NOT ensure any cluster when multiple bound and no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "a" }, { name: "b" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual([]);
  });
});

describe("ensureHostForTool", () => {
  it("throws when broker missing", async () => {
    await expect(ensureHostForTool(undefined, "h1", "p")).rejects.toThrow("Credential broker required");
  });

  it("calls broker.ensureHost", async () => {
    const calls: string[] = [];
    const broker = { ensureHost: async (n: string) => { calls.push(n); } } as any;
    await ensureHostForTool(broker, "h1", "p");
    expect(calls).toEqual(["h1"]);
  });

  it("propagates ensureHost errors", async () => {
    const broker = { ensureHost: async () => { throw new Error("not bound"); } } as any;
    await expect(ensureHostForTool(broker, "h1", "p")).rejects.toThrow("not bound");
  });
});
