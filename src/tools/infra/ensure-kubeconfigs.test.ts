import { describe, it, expect, beforeEach } from "vitest";
import {
  extractKubeconfigNames,
  ensureKubeconfigsForCommand,
  ensureClusterForTool,
  ensureHostForTool,
  KUBECONFIG_NAME_CHARS,
} from "./ensure-kubeconfigs.js";

describe("extractKubeconfigNames", () => {
  it("finds --kubeconfig=<name>", () => {
    const names = extractKubeconfigNames("kubectl --kubeconfig=prod get pods");
    expect(names).toEqual(["prod"]);
  });

  it("finds --kubeconfig <name> with space", () => {
    const names = extractKubeconfigNames("kubectl --kubeconfig prod get pods");
    expect(names).toEqual(["prod"]);
  });

  it("finds multiple distinct names", () => {
    const names = extractKubeconfigNames("kubectl --kubeconfig=a get && kubectl --kubeconfig=b get");
    expect(names.sort()).toEqual(["a", "b"]);
  });

  it("dedups duplicate names", () => {
    const names = extractKubeconfigNames("kubectl --kubeconfig=a && kubectl --kubeconfig=a");
    expect(names).toEqual(["a"]);
  });

  it("returns empty when no kubeconfig flag", () => {
    expect(extractKubeconfigNames("kubectl get pods")).toEqual([]);
  });

  it("does not match --kubeconfig in the middle of a word", () => {
    expect(extractKubeconfigNames("somethingkubeconfig=x")).toEqual([]);
  });

  it("rejects names containing path separators or quotes (charset)", () => {
    // Charset strictly excludes whitespace, slash, quotes, equals
    expect(KUBECONFIG_NAME_CHARS).toBe(String.raw`[^\s/"'=]+`);
  });

  it("handles tabs and newlines as separators", () => {
    const names = extractKubeconfigNames("kubectl\t--kubeconfig=a get pods");
    expect(names).toEqual(["a"]);
  });
});

describe("ensureKubeconfigsForCommand", () => {
  it("no-op when broker is undefined", async () => {
    await expect(ensureKubeconfigsForCommand(undefined, "kubectl --kubeconfig=x", "test")).resolves.toBeUndefined();
  });

  it("no-op when no kubeconfig names in command", async () => {
    const calls: string[] = [];
    const broker = { ensureCluster: async (n: string) => { calls.push(n); } } as any;
    await ensureKubeconfigsForCommand(broker, "kubectl get pods", "test");
    expect(calls).toEqual([]);
  });

  it("calls broker.ensureCluster for each name", async () => {
    const calls: string[] = [];
    const broker = { ensureCluster: async (n: string) => { calls.push(n); } } as any;
    await ensureKubeconfigsForCommand(broker, "kubectl --kubeconfig=a get && kubectl --kubeconfig=b", "purpose");
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  it("propagates ensureCluster errors (fail-fast)", async () => {
    const broker = { ensureCluster: async () => { throw new Error("not bound"); } } as any;
    await expect(
      ensureKubeconfigsForCommand(broker, "kubectl --kubeconfig=x get", "p"),
    ).rejects.toThrow("not bound");
  });
});

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
