/**
 * Shared kubeconfig resolution utility.
 * Reads manifest.json from the credentials directory and returns the path
 * to the first kubeconfig file, for use by tools that call kubectl internally.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

    return join(credentialsDir, kubeconfigFile);
  } catch {
    return null;
  }
}
