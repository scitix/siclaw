/**
 * Generic credential registration, removal, and listing for TUI mode.
 *
 * Writes the same manifest.json + credential files format used by Gateway's
 * buildCredentialPayload(), so credential_list tool works identically.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialManifestEntry {
  name: string;
  type: string;
  description?: string | null;
  files: string[];
  metadata?: Record<string, unknown>;
}

export type CredentialType =
  | "kubeconfig"
  | "ssh_key"
  | "ssh_password"
  | "api_token"
  | "api_basic_auth";

export interface RegisterKubeconfigOpts {
  name: string;
  /** Absolute path to the source kubeconfig file (provide this OR content) */
  sourcePath?: string;
  /** Raw kubeconfig YAML/JSON content (provide this OR sourcePath) */
  content?: string;
  description?: string;
}

export interface RegisterSshPasswordOpts {
  name: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  description?: string;
}

export interface RegisterSshKeyOpts {
  name: string;
  host: string;
  port?: number;
  username: string;
  /** Absolute path to the private key file */
  keyPath: string;
  passphrase?: string;
  description?: string;
}

export interface RegisterApiTokenOpts {
  name: string;
  url?: string;
  token: string;
  description?: string;
}

export interface RegisterApiBasicAuthOpts {
  name: string;
  url?: string;
  username: string;
  password: string;
  description?: string;
}

export interface ProbeResult {
  reachable: boolean;
  version?: string;
  error?: string;
}

export interface CredentialListEntry extends CredentialManifestEntry {
  reachable?: boolean;
  server_version?: string;
  probe_error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) throw new Error("Credential name must contain at least one alphanumeric character");
  return cleaned;
}

/** Reject values that could inject SSH config directives (newlines, leading whitespace). */
function sanitizeSshField(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${fieldName} must not be empty`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${fieldName} must not contain newlines`);
  return trimmed;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Resolve a path and assert it stays under the credentials directory. */
function resolveUnderDir(credentialsDir: string, filename: string): string {
  const resolved = path.resolve(credentialsDir, filename);
  const resolvedDir = path.resolve(credentialsDir);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Path traversal blocked: "${filename}" escapes credentials directory`);
  }
  return resolved;
}

function readManifest(credentialsDir: string): CredentialManifestEntry[] {
  const manifestPath = path.join(credentialsDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(credentialsDir: string, manifest: CredentialManifestEntry[]): void {
  ensureDir(credentialsDir);
  fs.writeFileSync(
    path.join(credentialsDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
}

function writeCredentialFile(credentialsDir: string, filename: string, content: string, mode: number = 0o600): void {
  const filePath = resolveUnderDir(credentialsDir, filename);
  fs.writeFileSync(filePath, content, { mode });
}

// ---------------------------------------------------------------------------
// Kubeconfig probing (extracted from credential-list.ts)
// ---------------------------------------------------------------------------

/** Probe a kubeconfig with `kubectl version` (3s timeout, parallel-safe). */
export function probeKubeconfig(kubeconfigPath: string): Promise<ProbeResult> {
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
// Registration — type-specific handlers
// ---------------------------------------------------------------------------

type RegisterResult =
  | { entry: CredentialManifestEntry; error?: undefined }
  | { entry?: undefined; error: string };

export function registerKubeconfig(
  credentialsDir: string,
  opts: RegisterKubeconfigOpts,
): RegisterResult {
  let content: string;

  if (opts.content) {
    content = opts.content;
  } else if (opts.sourcePath) {
    const resolvedPath = path.resolve(opts.sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      return { error: `File not found: ${resolvedPath}` };
    }
    content = fs.readFileSync(resolvedPath, "utf-8");
  } else {
    return { error: "Either sourcePath or content is required" };
  }

  // Validate YAML
  let metadata: Record<string, unknown> | undefined;
  try {
    const kc = yaml.load(content) as Record<string, unknown>;
    if (!kc || typeof kc !== "object") {
      return { error: "Invalid kubeconfig: not a YAML object" };
    }
    const clusters = (kc?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
    const contexts = (kc?.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
    metadata = {
      clusters: clusters.map((c) => ({ name: c.name, server: c.cluster?.server })),
      contexts: contexts.map((c) => ({
        name: c.name,
        cluster: c.context?.cluster,
        namespace: c.context?.namespace,
      })),
      currentContext: kc?.["current-context"] as string | undefined,
    };
  } catch (err) {
    return { error: `Invalid kubeconfig YAML: ${err instanceof Error ? err.message : String(err)}` };
  }

  const safe = safeName(opts.name);
  const filename = `${safe}.kubeconfig`;

  ensureDir(credentialsDir);
  writeCredentialFile(credentialsDir, filename, content);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "kubeconfig",
    description: opts.description ?? null,
    files: [filename],
    ...(metadata ? { metadata } : {}),
  };

  // Update manifest
  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerSshPassword(
  credentialsDir: string,
  opts: RegisterSshPasswordOpts,
): { entry: CredentialManifestEntry } {
  const safe = safeName(opts.name);
  const fileNames: string[] = [];

  ensureDir(credentialsDir);

  // Sanitize SSH fields against config injection
  const host = sanitizeSshField(opts.host, "host");
  const username = sanitizeSshField(opts.username, "username");

  // SSH config
  const sshConfigLines = [`Host ${safe}`];
  sshConfigLines.push(`  HostName ${host}`);
  if (opts.port) sshConfigLines.push(`  Port ${opts.port}`);
  sshConfigLines.push(`  User ${username}`);
  sshConfigLines.push("  StrictHostKeyChecking accept-new");
  const sshConfigFile = `${safe}.ssh_config`;
  writeCredentialFile(credentialsDir, sshConfigFile, sshConfigLines.join("\n") + "\n");
  fileNames.push(sshConfigFile);

  // Password file
  const pwFile = `${safe}.password`;
  writeCredentialFile(credentialsDir, pwFile, opts.password, 0o600);
  fileNames.push(pwFile);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "ssh_password",
    description: opts.description ?? null,
    files: fileNames,
    metadata: {
      host: opts.host,
      ...(opts.port ? { port: opts.port } : {}),
      username: opts.username,
    },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerSshKey(
  credentialsDir: string,
  opts: RegisterSshKeyOpts,
): RegisterResult {
  const resolvedKeyPath = path.resolve(opts.keyPath);
  if (!fs.existsSync(resolvedKeyPath)) {
    return { error: `Key file not found: ${resolvedKeyPath}` };
  }

  const safe = safeName(opts.name);
  const fileNames: string[] = [];

  ensureDir(credentialsDir);

  // Copy private key
  const keyContent = fs.readFileSync(resolvedKeyPath, "utf-8");
  const keyFile = `${safe}.key`;
  writeCredentialFile(credentialsDir, keyFile, keyContent, 0o600);
  fileNames.push(keyFile);

  // Sanitize SSH fields against config injection
  const host = sanitizeSshField(opts.host, "host");
  const username = sanitizeSshField(opts.username, "username");

  // SSH config
  const sshConfigLines = [`Host ${safe}`];
  sshConfigLines.push(`  HostName ${host}`);
  if (opts.port) sshConfigLines.push(`  Port ${opts.port}`);
  sshConfigLines.push(`  User ${username}`);
  sshConfigLines.push(`  IdentityFile ${path.join(credentialsDir, keyFile)}`);
  sshConfigLines.push("  StrictHostKeyChecking accept-new");
  const sshConfigFile = `${safe}.ssh_config`;
  writeCredentialFile(credentialsDir, sshConfigFile, sshConfigLines.join("\n") + "\n");
  fileNames.push(sshConfigFile);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "ssh_key",
    description: opts.description ?? null,
    files: fileNames,
    metadata: {
      host: opts.host,
      ...(opts.port ? { port: opts.port } : {}),
      username: opts.username,
    },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerApiToken(
  credentialsDir: string,
  opts: RegisterApiTokenOpts,
): { entry: CredentialManifestEntry } {
  const safe = safeName(opts.name);

  ensureDir(credentialsDir);

  const tokenData: Record<string, unknown> = {};
  if (opts.url) tokenData.url = opts.url;
  tokenData.token = opts.token;

  const tokenFile = `${safe}.token`;
  writeCredentialFile(credentialsDir, tokenFile, JSON.stringify(tokenData, null, 2), 0o600);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "api_token",
    description: opts.description ?? null,
    files: [tokenFile],
    metadata: { ...(opts.url ? { url: opts.url } : {}) },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

export function registerApiBasicAuth(
  credentialsDir: string,
  opts: RegisterApiBasicAuthOpts,
): { entry: CredentialManifestEntry } {
  const safe = safeName(opts.name);

  ensureDir(credentialsDir);

  const authData: Record<string, unknown> = {};
  if (opts.url) authData.url = opts.url;
  authData.username = opts.username;
  authData.password = opts.password;

  const authFile = `${safe}.auth`;
  writeCredentialFile(credentialsDir, authFile, JSON.stringify(authData, null, 2), 0o600);

  const entry: CredentialManifestEntry = {
    name: opts.name,
    type: "api_basic_auth",
    description: opts.description ?? null,
    files: [authFile],
    metadata: {
      ...(opts.url ? { url: opts.url } : {}),
      username: opts.username,
    },
  };

  const manifest = readManifest(credentialsDir).filter((e) => e.name !== opts.name);
  manifest.push(entry);
  writeManifest(credentialsDir, manifest);

  return { entry };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export function removeCredential(
  credentialsDir: string,
  name: string,
): { removed: boolean } {
  const manifest = readManifest(credentialsDir);
  const entry = manifest.find((e) => e.name === name);
  if (!entry) return { removed: false };

  // Delete credential files (with path traversal check)
  for (const file of entry.files) {
    try {
      const filePath = resolveUnderDir(credentialsDir, file);
      fs.unlinkSync(filePath);
    } catch { /* file may already be gone or path invalid */ }
  }

  // Update manifest
  const updated = manifest.filter((e) => e.name !== name);
  writeManifest(credentialsDir, updated);

  return { removed: true };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listCredentials(
  credentialsDir: string,
): Promise<CredentialListEntry[]> {
  const manifest = readManifest(credentialsDir);

  // Probe kubeconfigs in parallel
  const entries: CredentialListEntry[] = manifest.map((e) => ({ ...e }));
  const kubeconfigs = entries.filter((e) => e.type === "kubeconfig");

  if (kubeconfigs.length > 0) {
    const probes = await Promise.all(
      kubeconfigs.map(async (c) => {
        const kubeconfigFile = c.files.find((f) => f.endsWith(".kubeconfig")) ?? c.files[0];
        const fullPath = path.join(credentialsDir, kubeconfigFile);
        return { name: c.name, probe: await probeKubeconfig(fullPath) };
      }),
    );
    for (const { name, probe } of probes) {
      const cred = entries.find((c) => c.name === name);
      if (cred) {
        cred.reachable = probe.reachable;
        if (probe.version) cred.server_version = probe.version;
        if (probe.error) cred.probe_error = probe.error;
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Test-only exports (not part of public API)
// ---------------------------------------------------------------------------

/** @internal Exposed for unit testing only. */
export const _testing = { safeName, sanitizeSshField, resolveUnderDir, readManifest };
