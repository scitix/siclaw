import { describe, it, expect } from "vitest";
import { resolveRequiredKubeconfig, resolveKubeconfigByName, resolveKubeconfigPath } from "./kubeconfig-resolver.js";
import type { CredentialBroker, ClusterLocalInfo } from "../../agentbox/credential-broker.js";

/**
 * Minimal broker stub for resolver tests. The resolver only touches the sync
 * getLocalInfo / listLocalInfo API, so we don't need the full broker here.
 */
function makeBroker(entries: ClusterLocalInfo[]): CredentialBroker {
  const map = new Map<string, ClusterLocalInfo>();
  for (const e of entries) map.set(e.name, e);
  return {
    getLocalInfo: (name: string) => map.get(name),
    listLocalInfo: () => Array.from(map.values()),
  } as unknown as CredentialBroker;
}

const PROD: ClusterLocalInfo = {
  name: "prod",
  is_production: true,
  path: "/tmp/creds/prod.kubeconfig",
};

const STAGING: ClusterLocalInfo = {
  name: "staging",
  is_production: false,
  path: "/tmp/creds/staging.kubeconfig",
};

describe("resolveRequiredKubeconfig", () => {
  it("returns null path when no broker", () => {
    expect(resolveRequiredKubeconfig({}, undefined)).toEqual({ path: null });
  });

  it("returns null path when broker registry is empty", () => {
    const broker = makeBroker([]);
    expect(resolveRequiredKubeconfig({ broker }, undefined)).toEqual({ path: null });
  });

  it("skips entries without a path (metadata-only)", () => {
    const broker = makeBroker([{ name: "prod", is_production: true }]);
    expect(resolveRequiredKubeconfig({ broker }, undefined)).toEqual({ path: null });
  });

  it("auto-selects a single loaded kubeconfig without name", () => {
    const broker = makeBroker([PROD]);
    expect(resolveRequiredKubeconfig({ broker }, undefined)).toEqual({ path: PROD.path });
  });

  it("resolves single loaded kubeconfig by explicit name", () => {
    const broker = makeBroker([PROD]);
    expect(resolveRequiredKubeconfig({ broker }, "prod")).toEqual({ path: PROD.path });
  });

  it("errors on multiple kubeconfigs without name", () => {
    const broker = makeBroker([PROD, STAGING]);
    const result = resolveRequiredKubeconfig({ broker }, undefined);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Multiple kubeconfigs");
      expect(result.error).toContain("prod");
      expect(result.error).toContain("staging");
      expect(result.availableNames).toEqual(["prod", "staging"]);
    }
  });

  it("resolves by name when multiple are loaded", () => {
    const broker = makeBroker([PROD, STAGING]);
    expect(resolveRequiredKubeconfig({ broker }, "staging")).toEqual({ path: STAGING.path });
  });

  it("errors when requested name is not loaded among multiple", () => {
    const broker = makeBroker([PROD, STAGING]);
    const result = resolveRequiredKubeconfig({ broker }, "dev");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not loaded");
      expect(result.error).toContain("dev");
      expect(result.availableNames).toEqual(["prod", "staging"]);
    }
  });

  it("errors when single kubeconfig + explicit name mismatches", () => {
    const broker = makeBroker([PROD]);
    const result = resolveRequiredKubeconfig({ broker }, "staging");
    expect("error" in result).toBe(true);
  });
});

describe("resolveKubeconfigByName", () => {
  it("throws when broker is absent", () => {
    expect(() => resolveKubeconfigByName({}, "prod")).toThrow("not loaded");
  });

  it("throws when cluster has no path (metadata only)", () => {
    const broker = makeBroker([{ name: "prod", is_production: true }]);
    expect(() => resolveKubeconfigByName({ broker }, "prod")).toThrow("not loaded");
  });

  it("returns the path for a loaded cluster", () => {
    const broker = makeBroker([PROD]);
    expect(resolveKubeconfigByName({ broker }, "prod")).toBe(PROD.path);
  });
});

describe("resolveKubeconfigPath", () => {
  it("returns null when broker is absent", () => {
    expect(resolveKubeconfigPath({})).toBeNull();
  });

  it("returns null when registry has no loaded kubeconfigs", () => {
    const broker = makeBroker([{ name: "prod", is_production: true }]);
    expect(resolveKubeconfigPath({ broker })).toBeNull();
  });

  it("auto-returns the single loaded path", () => {
    const broker = makeBroker([PROD]);
    expect(resolveKubeconfigPath({ broker })).toBe(PROD.path);
  });

  it("throws when multiple kubeconfigs are loaded", () => {
    const broker = makeBroker([PROD, STAGING]);
    expect(() => resolveKubeconfigPath({ broker })).toThrow("Multiple kubeconfigs");
  });
});
