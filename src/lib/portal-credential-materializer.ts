/**
 * Materialize Portal credentials (cluster kubeconfigs + SSH hosts) into a
 * directory laid out exactly the way the existing `credential-manager.ts`
 * helpers produce. pi-agent tools (kubectl, ssh) + `/setup` list view see
 * a Portal-sourced credential set with zero format drift.
 *
 * Strategy: delegate to the same `registerKubeconfig` / `registerSshPassword`
 * / `registerSshKey` functions TUI already uses — avoids reimplementing
 * manifest + SSH-config generation. For SSH keys whose content comes from
 * Portal (not a keyfile path), we stage the content in a short-lived tmp
 * file so `registerSshKey` (which reads from disk by design) works
 * unchanged, then delete the tmp.
 *
 * All written files land under `outDir`, which the caller typically sets
 * to `.siclaw/.portal-snapshot/credentials/`. The dir is wiped before
 * materialize so stale entries from a previous session don't linger.
 * SIGINT / SIGTERM cleanup is installed by cli-main, not here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CliSnapshotCredentials,
  CliSnapshotClusterCredential,
  CliSnapshotHostCredential,
} from "../portal/cli-snapshot-api.js";
import {
  registerKubeconfig,
  registerSshKey,
  registerSshPassword,
} from "../tools/infra/credential-manager.js";

export interface CredentialMaterializeResult {
  rootDir: string;
  clusters: number;
  hosts: number;
  failures: Array<{ name: string; kind: "cluster" | "host"; error: string }>;
}

export async function materializePortalCredentials(
  creds: CliSnapshotCredentials,
  outDir: string,
): Promise<CredentialMaterializeResult> {
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const failures: CredentialMaterializeResult["failures"] = [];
  let clusters = 0;
  let hosts = 0;

  for (const c of creds.clusters) {
    try {
      await writeCluster(outDir, c);
      clusters++;
    } catch (err) {
      failures.push({ name: c.name, kind: "cluster", error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const h of creds.hosts) {
    try {
      writeHost(outDir, h);
      hosts++;
    } catch (err) {
      failures.push({ name: h.name, kind: "host", error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { rootDir: outDir, clusters, hosts, failures };
}

export function cleanupPortalCredentials(outDir: string): void {
  if (!fs.existsSync(outDir)) return;
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    // Non-fatal; caller continues regardless.
  }
}

async function writeCluster(outDir: string, cluster: CliSnapshotClusterCredential): Promise<void> {
  const result = await registerKubeconfig(outDir, {
    name: cluster.name,
    content: cluster.kubeconfig,
    description: cluster.description ?? undefined,
  });
  if ("error" in result) {
    throw new Error(result.error);
  }
}

function writeHost(outDir: string, host: CliSnapshotHostCredential): void {
  if (host.authType === "password" && host.password) {
    const result = registerSshPassword(outDir, {
      name: host.name,
      host: host.ip,
      port: host.port,
      username: host.username,
      password: host.password,
      description: host.description ?? undefined,
    });
    if ("error" in result) throw new Error((result as { error: string }).error);
    return;
  }

  if (host.authType === "key" && host.privateKey) {
    // registerSshKey takes a disk path; stage the Portal-delivered key in a
    // short-lived tmp file so we can reuse the existing helper verbatim.
    // Sanitize host.name before interpolating into the path to avoid any
    // directory-traversal shenanigans if a host row ever slipped through
    // Portal's own validation.
    const safeStem = host.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const tmpPath = path.join(os.tmpdir(), `siclaw-cred-key-${safeStem}-${Date.now()}-${process.pid}`);
    fs.writeFileSync(tmpPath, host.privateKey, { mode: 0o600 });
    try {
      const result = registerSshKey(outDir, {
        name: host.name,
        host: host.ip,
        port: host.port,
        username: host.username,
        keyPath: tmpPath,
        description: host.description ?? undefined,
      });
      if ("error" in result) throw new Error((result as { error: string }).error);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    }
    return;
  }

  throw new Error(`host "${host.name}" has auth_type="${host.authType}" but no usable password/private_key`);
}
