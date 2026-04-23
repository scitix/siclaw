import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializePortalCredentials, cleanupPortalCredentials } from "./portal-credential-materializer.js";
import type { CliSnapshotCredentials } from "../portal/cli-snapshot-api.js";

function readManifest(credentialsDir: string): Array<{ name: string; type: string; files: string[] }> {
  const p = path.join(credentialsDir, "manifest.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : [];
}

const FAKE_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: test
  context:
    cluster: test
    namespace: default
current-context: test
users: []
`;

function creds(partial: Partial<CliSnapshotCredentials> = {}): CliSnapshotCredentials {
  return {
    clusters: partial.clusters ?? [],
    hosts: partial.hosts ?? [],
  };
}

describe("materializePortalCredentials", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-cred-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("writes a cluster kubeconfig + manifest entry in the credential-manager format", async () => {
    const out = path.join(tmpRoot, "credentials");
    const result = await materializePortalCredentials(
      creds({ clusters: [{ name: "prod-east", kubeconfig: FAKE_KUBECONFIG, description: "east region" }] }),
      out,
    );
    expect(result.clusters).toBe(1);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(path.join(out, "prod-east.kubeconfig"), "utf-8")).toBe(FAKE_KUBECONFIG);

    const manifest = readManifest(out);
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("prod-east");
    expect(manifest[0].type).toBe("kubeconfig");
    expect(manifest[0].files).toEqual(["prod-east.kubeconfig"]);
  });

  it("writes a password host with a password file + ssh_config", async () => {
    const out = path.join(tmpRoot, "credentials");
    const result = await materializePortalCredentials(
      creds({
        hosts: [{
          name: "bastion-a", ip: "203.0.113.10", port: 22, username: "root",
          authType: "password", password: "correct-horse", privateKey: null, description: null,
        }],
      }),
      out,
    );
    expect(result.hosts).toBe(1);
    expect(fs.readFileSync(path.join(out, "bastion-a.password"), "utf-8")).toBe("correct-horse");
    const config = fs.readFileSync(path.join(out, "bastion-a.ssh_config"), "utf-8");
    expect(config).toContain("HostName 203.0.113.10");
    expect(config).toContain("Port 22");
    expect(config).toContain("User root");

    const manifest = readManifest(out);
    expect(manifest).toHaveLength(1);
    expect(manifest[0].type).toBe("ssh_password");
  });

  it("writes a key host with private-key file and IdentityFile ssh_config directive", async () => {
    const out = path.join(tmpRoot, "credentials");
    const fakeKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n";
    const result = await materializePortalCredentials(
      creds({
        hosts: [{
          name: "ops-box", ip: "10.20.30.40", port: 2222, username: "ops",
          authType: "key", password: null, privateKey: fakeKey, description: null,
        }],
      }),
      out,
    );
    expect(result.hosts).toBe(1);
    const keyPath = path.join(out, "ops-box.key");
    expect(fs.readFileSync(keyPath, "utf-8")).toBe(fakeKey);
    // Private key file must be 0600 (or at minimum not group/other readable).
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    const config = fs.readFileSync(path.join(out, "ops-box.ssh_config"), "utf-8");
    expect(config).toContain(`IdentityFile ${keyPath}`);
  });

  it("reports per-entry failures without aborting siblings", async () => {
    const out = path.join(tmpRoot, "credentials");
    const result = await materializePortalCredentials(
      creds({
        clusters: [
          { name: "good-one", kubeconfig: FAKE_KUBECONFIG, description: null },
          { name: "bad-one", kubeconfig: "not-yaml: : :::", description: null },
        ],
      }),
      out,
    );
    // registerKubeconfig rejects malformed YAML → failure for bad-one, good-one OK.
    expect(result.clusters).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe("bad-one");
    expect(result.failures[0].kind).toBe("cluster");
  });

  it("wipes outDir on re-materialize so stale credentials don't linger", async () => {
    const out = path.join(tmpRoot, "credentials");
    await materializePortalCredentials(
      creds({ clusters: [{ name: "old-cluster", kubeconfig: FAKE_KUBECONFIG, description: null }] }),
      out,
    );
    expect(fs.existsSync(path.join(out, "old-cluster.kubeconfig"))).toBe(true);

    await materializePortalCredentials(
      creds({ clusters: [{ name: "new-cluster", kubeconfig: FAKE_KUBECONFIG, description: null }] }),
      out,
    );
    expect(fs.existsSync(path.join(out, "old-cluster.kubeconfig"))).toBe(false);
    expect(fs.existsSync(path.join(out, "new-cluster.kubeconfig"))).toBe(true);
  });

  it("cleanupPortalCredentials is idempotent", async () => {
    const out = path.join(tmpRoot, "credentials");
    await materializePortalCredentials(
      creds({ clusters: [{ name: "x", kubeconfig: FAKE_KUBECONFIG, description: null }] }),
      out,
    );
    cleanupPortalCredentials(out);
    expect(fs.existsSync(out)).toBe(false);
    cleanupPortalCredentials(out);
  });
});
