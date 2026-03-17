import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRequiredKubeconfig } from "./kubeconfig-resolver.js";

describe("resolveRequiredKubeconfig", () => {
  let credDir: string;

  beforeEach(() => {
    credDir = mkdtempSync(join(tmpdir(), "kube-test-"));
  });

  afterEach(() => {
    rmSync(credDir, { recursive: true, force: true });
  });

  function writeManifest(entries: Array<{ name: string; type: string; files: string[] }>) {
    writeFileSync(join(credDir, "manifest.json"), JSON.stringify(entries));
    // Create dummy kubeconfig files
    for (const e of entries) {
      for (const f of e.files) {
        writeFileSync(join(credDir, f), "dummy");
      }
    }
  }

  it("returns null path when no credentialsDir", () => {
    const result = resolveRequiredKubeconfig(undefined, undefined);
    expect(result).toEqual({ path: null });
  });

  it("returns null path when no manifest.json", () => {
    const result = resolveRequiredKubeconfig(credDir, undefined);
    expect(result).toEqual({ path: null });
  });

  it("returns null path when no kubeconfig entries", () => {
    writeManifest([{ name: "ssh", type: "ssh_key", files: ["id_rsa"] }]);
    const result = resolveRequiredKubeconfig(credDir, undefined);
    expect(result).toEqual({ path: null });
  });

  it("auto-selects single kubeconfig without name", () => {
    writeManifest([{ name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] }]);
    const result = resolveRequiredKubeconfig(credDir, undefined);
    expect(result).toEqual({ path: join(credDir, "prod.kubeconfig") });
  });

  it("resolves single kubeconfig by name", () => {
    writeManifest([{ name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] }]);
    const result = resolveRequiredKubeconfig(credDir, "prod");
    expect(result).toEqual({ path: join(credDir, "prod.kubeconfig") });
  });

  it("errors on multiple kubeconfigs without name", () => {
    writeManifest([
      { name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] },
      { name: "staging", type: "kubeconfig", files: ["staging.kubeconfig"] },
    ]);
    const result = resolveRequiredKubeconfig(credDir, undefined);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Multiple kubeconfigs");
      expect(result.error).toContain("prod");
      expect(result.error).toContain("staging");
      expect(result.availableNames).toEqual(["prod", "staging"]);
    }
  });

  it("resolves by name when multiple kubeconfigs", () => {
    writeManifest([
      { name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] },
      { name: "staging", type: "kubeconfig", files: ["staging.kubeconfig"] },
    ]);
    const result = resolveRequiredKubeconfig(credDir, "staging");
    expect(result).toEqual({ path: join(credDir, "staging.kubeconfig") });
  });

  it("errors when name not found among multiple kubeconfigs", () => {
    writeManifest([
      { name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] },
      { name: "staging", type: "kubeconfig", files: ["staging.kubeconfig"] },
    ]);
    const result = resolveRequiredKubeconfig(credDir, "dev");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not found");
      expect(result.error).toContain("dev");
      expect(result.availableNames).toEqual(["prod", "staging"]);
    }
  });

  it("ignores non-kubeconfig entries when counting", () => {
    writeManifest([
      { name: "prod", type: "kubeconfig", files: ["prod.kubeconfig"] },
      { name: "ssh-key", type: "ssh_key", files: ["id_rsa"] },
    ]);
    // Only 1 kubeconfig → auto-select
    const result = resolveRequiredKubeconfig(credDir, undefined);
    expect(result).toEqual({ path: join(credDir, "prod.kubeconfig") });
  });
});
