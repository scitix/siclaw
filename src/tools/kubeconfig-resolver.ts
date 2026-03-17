/**
 * Shared kubeconfig resolution utility.
 * Reads manifest.json from the credentials directory and returns the path
 * to the first kubeconfig file, for use by tools that call kubectl internally.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveUnderDir } from "../shared/path-utils.js";

interface CredentialEntry {
  name: string;
  type: string;
  files: string[];
}

/**
 * Resolve the path to the first kubeconfig file from the credentials directory.
 * Returns null if no credentials directory, no manifest, or no kubeconfig entry.
 */
export function resolveKubeconfigPath(credentialsDir?: string): string | null {
  if (!credentialsDir) return null;

  const manifestPath = join(credentialsDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as CredentialEntry[];
    const kubeEntry = entries.find((e) => e.type === "kubeconfig");
    if (!kubeEntry) return null;

    const kubeconfigFile = kubeEntry.files.find((f) => f.endsWith(".kubeconfig")) ?? kubeEntry.files[0];
    if (!kubeconfigFile) return null;

    return resolveUnderDir(credentialsDir, kubeconfigFile);
  } catch {
    return null;
  }
}

/**
 * Resolve a kubeconfig path by credential name.
 * Used to translate `--kubeconfig=<name>` into an actual file path.
 * Returns null if no match found.
 */
export function resolveKubeconfigByName(credentialsDir: string, name: string): string | null {
  const manifestPath = join(credentialsDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as CredentialEntry[];
    const match = entries.find((e) => e.type === "kubeconfig" && e.name === name);
    if (!match) return null;
    const kubeconfigFile = match.files.find((f) => f.endsWith(".kubeconfig")) ?? match.files[0];
    return kubeconfigFile ? resolveUnderDir(credentialsDir, kubeconfigFile) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve kubeconfig with mandatory selection when multiple clusters exist.
 *
 * - 0 kubeconfigs → { path: null }
 * - 1 kubeconfig, no name → auto-select
 * - 1 kubeconfig, name given → resolve by name (error if mismatch)
 * - >1 kubeconfigs, no name → error (ambiguous)
 * - >1 kubeconfigs, name given → resolve by name (error if not found)
 */
export function resolveRequiredKubeconfig(
  credentialsDir: string | undefined,
  name: string | undefined,
): { path: string | null } | { error: string; availableNames?: string[] } {
  if (!credentialsDir) return { path: null };

  const manifestPath = join(credentialsDir, "manifest.json");
  if (!existsSync(manifestPath)) return { path: null };

  let entries: CredentialEntry[];
  try {
    entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as CredentialEntry[];
  } catch {
    return { path: null };
  }

  const kubeEntries = entries.filter((e) => e.type === "kubeconfig");

  if (kubeEntries.length === 0) return { path: null };

  /** Safely resolve file under credentialsDir; returns error on path traversal. */
  const safeResolve = (file: string): { path: string } | { error: string } => {
    try {
      return { path: resolveUnderDir(credentialsDir, file) };
    } catch {
      return { error: `Kubeconfig file path escapes credentials directory: ${file}` };
    }
  };

  // Single kubeconfig — auto-select (name is optional)
  if (kubeEntries.length === 1 && !name) {
    const file = kubeEntries[0].files.find((f) => f.endsWith(".kubeconfig")) ?? kubeEntries[0].files[0];
    return file ? safeResolve(file) : { path: null };
  }

  // Name required from here
  if (!name) {
    const names = kubeEntries.map((e) => e.name);
    return {
      error: `Multiple kubeconfigs available (${names.join(", ")}). You must specify the kubeconfig parameter to select a cluster. Use credential_list to see available credentials.`,
      availableNames: names,
    };
  }

  // Resolve by name
  const match = kubeEntries.find((e) => e.name === name);
  if (!match) {
    const names = kubeEntries.map((e) => e.name);
    return {
      error: `Kubeconfig "${name}" not found. Available: ${names.join(", ")}`,
      availableNames: names,
    };
  }

  const file = match.files.find((f) => f.endsWith(".kubeconfig")) ?? match.files[0];
  return file ? safeResolve(file) : { error: `Kubeconfig "${name}" has no files` };
}
