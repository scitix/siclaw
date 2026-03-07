/**
 * Shared credential management utilities.
 *
 * - probeKubeconfig(): test connectivity to a cluster via kubectl
 * - registerKubeconfig(): validate, copy, and register a kubeconfig file
 *
 * Used by cli-credentials (TUI) and credential_list tools.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Probe a kubeconfig with `kubectl version` (3s timeout, parallel-safe). */
export function probeKubeconfig(kubeconfigPath: string): Promise<{ reachable: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      "kubectl",
      ["version", "--output=json", `--kubeconfig=${kubeconfigPath}`, "--request-timeout=3s"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          const msg = err.message?.includes("timed out")
            ? "connection timeout"
            : err.message?.split("\n")[0] ?? "unknown error";
          resolve({ reachable: false, error: msg });
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const ver = info.serverVersion?.gitVersion ?? "unknown";
          resolve({ reachable: true, version: ver });
        } catch {
          resolve({ reachable: true, version: "unknown" });
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterKubeconfigResult {
  name: string;
  reachable: boolean;
  serverVersion?: string;
  probeError?: string;
}

interface ManifestEntry {
  name: string;
  type: string;
  description?: string | null;
  files: string[];
  metadata?: Record<string, unknown>;
}

export async function registerKubeconfig(opts: {
  sourcePath: string;
  credentialsDir: string;
  name?: string;
}): Promise<RegisterKubeconfigResult> {
  const { sourcePath, credentialsDir } = opts;

  // 1. Validate source file exists and is reasonable
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`File not found: ${sourcePath}`);
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${sourcePath}`);
  }
  if (stat.size > 1024 * 1024) {
    throw new Error(`File too large (${Math.round(stat.size / 1024)}KB > 1MB limit)`);
  }

  // 2. Read and validate
  const content = fs.readFileSync(sourcePath, "utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(content) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid kubeconfig: not a YAML mapping");
  }
  if (!parsed.clusters || !parsed.contexts) {
    throw new Error("Invalid kubeconfig: missing 'clusters' or 'contexts' field");
  }

  // 3. Derive name
  const rawName = opts.name || (parsed["current-context"] as string) || path.basename(sourcePath, path.extname(sourcePath));
  const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeName) {
    throw new Error("Could not derive a valid credential name");
  }

  // 4. Copy to credentials directory
  fs.mkdirSync(credentialsDir, { recursive: true });
  const destFile = `${safeName}.kubeconfig`;
  const destPath = path.join(credentialsDir, destFile);

  // Path traversal check
  const resolvedDest = path.resolve(destPath);
  const resolvedDir = path.resolve(credentialsDir);
  if (!resolvedDest.startsWith(resolvedDir + path.sep) && resolvedDest !== resolvedDir) {
    throw new Error("Invalid credential name (path traversal detected)");
  }

  fs.writeFileSync(destPath, content, { mode: 0o600 });

  // 5. Extract metadata (same format as Gateway rpc-methods.ts)
  const clusters = (parsed.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
  const contexts = (parsed.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
  const metadata: Record<string, unknown> = {
    clusters: clusters.map((c) => ({
      name: c.name,
      server: c.cluster?.server,
    })),
    contexts: contexts.map((c) => ({
      name: c.name,
      cluster: c.context?.cluster,
      namespace: c.context?.namespace,
    })),
    currentContext: parsed["current-context"] as string | undefined,
  };

  // 6. Update manifest.json (upsert by name)
  const manifestPath = path.join(credentialsDir, "manifest.json");
  let manifest: ManifestEntry[] = [];
  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
  } catch { /* start fresh */ }

  const newEntry: ManifestEntry = {
    name: safeName,
    type: "kubeconfig",
    files: [destFile],
    metadata,
  };

  // Remove existing entry with same name (upsert)
  manifest = manifest.filter((e) => e.name !== safeName);
  manifest.push(newEntry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // 7. Probe connectivity
  const probe = await probeKubeconfig(destPath);

  return {
    name: safeName,
    reachable: probe.reachable,
    ...(probe.version ? { serverVersion: probe.version } : {}),
    ...(probe.error ? { probeError: probe.error } : {}),
  };
}
