import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MoltbotPluginApi } from "./api.js";

interface PluginPackageJson {
  name: string;
  main?: string;
  moltbot?: { extensions?: string[] };
  openclaw?: { extensions?: string[] };
}

interface DiscoveredPlugin {
  name: string;
  dir: string;
  entry: string;
}

function discoverPluginsInDir(dir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  if (!fs.existsSync(dir)) return plugins;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Handle scoped packages (@org/pkg)
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(dir, entry.name);
      const scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      for (const scopeEntry of scopeEntries) {
        if (!scopeEntry.isDirectory()) continue;
        const pkgDir = path.join(scopeDir, scopeEntry.name);
        const found = checkPlugin(pkgDir);
        if (found) plugins.push(found);
      }
      continue;
    }

    const pkgDir = path.join(dir, entry.name);
    const found = checkPlugin(pkgDir);
    if (found) plugins.push(found);
  }

  return plugins;
}

function checkPlugin(pkgDir: string): DiscoveredPlugin | null {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(raw) as PluginPackageJson;

    const extensions = pkg.moltbot?.extensions ?? pkg.openclaw?.extensions;
    if (!extensions || extensions.length === 0) return null;

    const entry = pkg.main ?? "index.js";
    return {
      name: pkg.name,
      dir: pkgDir,
      entry: path.join(pkgDir, entry),
    };
  } catch {
    return null;
  }
}

export async function discoverAndLoadPlugins(
  searchPaths: string[],
  api: MoltbotPluginApi,
): Promise<string[]> {
  const loaded: string[] = [];

  // Default plugin dir
  const defaultPluginDir = path.join(os.homedir(), ".siclaw", "plugins");
  const allPaths = [...searchPaths, defaultPluginDir];

  for (const searchPath of allPaths) {
    const resolved = path.resolve(searchPath);
    const discovered = discoverPluginsInDir(resolved);

    for (const plugin of discovered) {
      try {
        console.log(`[plugins] Loading plugin: ${plugin.name} from ${plugin.dir}`);
        const mod = await import(plugin.entry);
        const register = mod.default ?? mod.register;
        if (typeof register === "function") {
          await register(api);
          loaded.push(plugin.name);
          console.log(`[plugins] Loaded: ${plugin.name}`);
        } else {
          console.warn(`[plugins] ${plugin.name}: no register function found`);
        }
      } catch (err) {
        console.error(`[plugins] Failed to load ${plugin.name}:`, err);
      }
    }
  }

  return loaded;
}
