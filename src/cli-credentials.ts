/**
 * Interactive credentials manager for TUI mode.
 *
 * Replaces model-driven credential_add — credential management is a user action,
 * not a model action. The model can only read credentials via credential_list.
 *
 * Supports: kubeconfig (future: SSH keys, API tokens, etc.)
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { registerKubeconfig } from "./tools/credential-manager.js";

interface ManifestEntry {
  name: string;
  type: string;
  files: string[];
  metadata?: Record<string, unknown>;
}

function loadManifest(credentialsDir: string): ManifestEntry[] {
  const manifestPath = path.join(credentialsDir, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveManifest(credentialsDir: string, entries: ManifestEntry[]): void {
  const manifestPath = path.join(credentialsDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + "\n");
}

export async function runCredentialsManager(credentialsDir: string): Promise<void> {
  fs.mkdirSync(credentialsDir, { recursive: true });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const entries = loadManifest(credentialsDir);

      console.log("\n  Siclaw Credentials\n");

      if (entries.length === 0) {
        console.log("  (no credentials registered)\n");
      } else {
        for (const entry of entries) {
          const meta = entry.metadata as Record<string, unknown> | undefined;
          const ctx = (meta?.currentContext as string) || "-";
          console.log(`  • ${entry.name}  (${entry.type}, context: ${ctx})`);
        }
        console.log("");
      }

      console.log("  [a] Add kubeconfig");
      if (entries.length > 0) console.log("  [r] Remove credential");
      console.log("  [q] Quit\n");

      const choice = (await ask("  > ")).trim().toLowerCase();

      if (choice === "q" || choice === "") break;

      if (choice === "a") {
        const defaultPath = path.join(homedir(), ".kube", "config");
        const raw = (await ask(`  Kubeconfig path [${defaultPath}]: `)).trim();
        const filePath = raw || defaultPath;

        // Expand ~ and resolve
        const resolved = filePath.startsWith("~/")
          ? path.join(homedir(), filePath.slice(2))
          : path.resolve(filePath);

        // Let user pick a friendly name (avoids leaking cluster IDs to the model)
        const customName = (await ask("  Display name (enter to auto-detect): ")).trim() || undefined;

        try {
          const result = await registerKubeconfig({ sourcePath: resolved, credentialsDir, name: customName });
          const status = result.reachable
            ? `(${result.serverVersion})`
            : `(unreachable: ${result.probeError})`;
          console.log(`  ✓ Added "${result.name}" ${status}`);
        } catch (err) {
          console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (choice === "r" && entries.length > 0) {
        console.log("");
        for (let i = 0; i < entries.length; i++) {
          console.log(`  [${i + 1}] ${entries[i].name}  (${entries[i].type})`);
        }
        console.log("");
        const idx = parseInt((await ask("  Number to remove (or 0 to cancel): ")).trim(), 10);
        if (idx >= 1 && idx <= entries.length) {
          const entry = entries[idx - 1];
          // Remove credential files (with path traversal check)
          for (const f of entry.files) {
            const filePath = path.resolve(path.join(credentialsDir, f));
            if (!filePath.startsWith(path.resolve(credentialsDir) + path.sep)) continue;
            try { fs.unlinkSync(filePath); } catch { /* ignore */ }
          }
          // Update manifest
          const updated = entries.filter((_, i) => i !== idx - 1);
          saveManifest(credentialsDir, updated);
          console.log(`  ✓ Removed "${entry.name}"`);
        }
      }
    }
  } finally {
    rl.close();
  }
}
