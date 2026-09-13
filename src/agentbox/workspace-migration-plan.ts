import { validPrivateId } from "../shared/private-workspace.js";
import { safeWorkspacePath } from "./private-workspace.js";
import type { LegacyWorkspaceMapping, LegacySessionMapping } from "./workspace-migration.js";
import type { UnknownArchiveMapping } from "./unknown-workspace-archive.js";

/** The host exports these identities from its authoritative conversation catalog. */
export interface LegacySessionOwner {
  sessionId: string;
  parentSessionId?: string;
  organization: string;
  principalId: string;
  activeLeafId?: string | null;
}
export interface LegacyInventoryEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}
export interface LegacyMigrationCatalog {
  sourceRoot: string;
  sessionsDirectory: string;
  runtimeId: string;
  ownershipVerified: boolean;
  /** Explicit host decision: these sessions have no verified personal owner. */
  unownedSessionIds?: string[];
  unknownDisposition?: "reject" | "archive";
  sessions: LegacySessionOwner[];
}

/** Planning does not freeze writers or read transcript bodies, and grants no ownership. */
export function planLegacyWorkspaces(catalog: LegacyMigrationCatalog, inventory: LegacyInventoryEntry[]) {
  const base = safeWorkspacePath(catalog.sessionsDirectory);
  if (!validPrivateId(catalog.runtimeId) || catalog.ownershipVerified !== true || !catalog.sourceRoot) throw new Error("A verified host catalog is required");
  const unowned = new Set(catalog.unownedSessionIds ?? []);
  const owners = new Map<string, LegacySessionOwner>();
  for (const owner of catalog.sessions) {
    const principalValid = unowned.has(owner.sessionId)
      ? typeof owner.principalId === "string" && owner.principalId.length <= 128
      : validPrivateId(owner.principalId);
    if (![owner.sessionId, owner.organization].every(validPrivateId) || !principalValid || owners.has(owner.sessionId) ||
        (owner.parentSessionId && !validPrivateId(owner.parentSessionId)) ||
        (owner.activeLeafId !== undefined && owner.activeLeafId !== null && typeof owner.activeLeafId !== "string")) throw new Error("Invalid or duplicate catalog identity");
    owners.set(owner.sessionId, owner);
  }
  if ((catalog.unknownDisposition && !["reject", "archive"].includes(catalog.unknownDisposition)) ||
      unowned.size !== (catalog.unownedSessionIds ?? []).length || [...unowned].some(id => !owners.has(id))) throw new Error("Invalid unowned session selection");
  const files = new Map<string, LegacyInventoryEntry>();
  const seen = new Set<string>();
  for (const item of inventory) {
    safeWorkspacePath(item.path);
    if (seen.has(item.path) || !["file", "dir"].includes(item.type) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error("Invalid inventory entry");
    seen.add(item.path);
    if (item.type === "file") files.set(item.path, item);
  }
  const transcripts = new Map<string, string>();
  for (const name of files.keys()) {
    if (!name.startsWith(base + "/")) continue;
    const parts = name.slice(base.length + 1).split("/");
    if (parts.length !== 2 || !parts[1].endsWith(".jsonl")) continue;
    const id = parts[0];
    if (!owners.has(id)) throw new Error(`Transcript has no verified owner: ${id}`);
    if (transcripts.has(id)) throw new Error(`Multiple transcripts require an explicit selection: ${id}`);
    transcripts.set(id, name);
  }
  // A handoff marker invalidates the old cache. Its JSONL, when still present,
  // may precede turns executed elsewhere and cannot be promoted to authority.
  const invalidatedCaches: Array<{ sessionId: string; source: string }> = [];
  for (const id of owners.keys()) {
    const source = `${base}/${id}.handoff`;
    if (!files.has(source)) continue;
    if (transcripts.has(id)) throw new Error(`Invalidated cache requires authoritative host history: ${id}`);
    invalidatedCaches.push({ sessionId: id, source });
  }
  const roots = new Map<string, string[]>();
  for (const id of [...transcripts.keys()].sort()) {
    const owner = owners.get(id)!;
    const visited = new Set<string>();
    let root = id;
    while (true) {
      if (visited.has(root)) throw new Error(`Session parent cycle: ${id}`);
      visited.add(root);
      const node = owners.get(root);
      if (!node || !transcripts.has(root)) throw new Error(`Missing parent transcript or ownership: ${id}`);
      if (node.organization !== owner.organization) throw new Error(`Cross-organization session tree: ${id}`);
      if (!node.parentSessionId) break;
      root = node.parentSessionId;
    }
    const tree = roots.get(root) ?? [];
    tree.push(id); roots.set(root, tree);
  }
  const used = new Set<string>();
  const sessionMapping = (id: string): LegacySessionMapping => {
    const owner = owners.get(id)!;
    const piFile = transcripts.get(id)!; used.add(piFile);
    const prefix = `${base}/${id}/`;
    const sidecars: NonNullable<LegacySessionMapping["sidecars"]> = [];
    for (const source of [...files.keys()].sort()) {
      if (!source.startsWith(prefix)) continue;
      const name = source.slice(prefix.length);
      if ([".plan-ledger.json", ".model-route-state.json", ".turn-ledger.json"].includes(name) || name.startsWith(".tool-results/")) {
        sidecars.push({ source, name }); used.add(source);
      }
    }
    return { sessionId: id, piFile, sidecars, ...(owner.activeLeafId !== undefined ? { activeLeafId: owner.activeLeafId } : {}) };
  };
  const mappings: LegacyWorkspaceMapping[] = [];
  const unknownArchives: UnknownArchiveMapping[] = [];
  for (const [root, tree] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    if (tree.length > 512) throw new Error(`Session tree exceeds workspace limits: ${root}`);
    const owner = owners.get(root)!;
    if (tree.some(id => unowned.has(id))) {
      if (catalog.unknownDisposition !== "archive") throw new Error(`Unowned session requires an explicit archive decision: ${root}`);
      const archiveFiles: UnknownArchiveMapping["files"] = [];
      for (const id of tree) {
        const prefix = `${base}/${id}/`;
        for (const source of [...files.keys()].sort()) {
          if (!source.startsWith(prefix)) continue;
          archiveFiles.push({ source, destination: `archive/${id}/${source.slice(prefix.length)}` }); used.add(source);
        }
      }
      unknownArchives.push({ organization: owner.organization, sourceId: root, runtimeId: catalog.runtimeId,
        sourceRoot: catalog.sourceRoot, sourceFrozen: false, archiveApproved: true,
        sessions: tree.map(id => ({ sessionId: id, parentSessionId: owners.get(id)!.parentSessionId,
          originalPrincipalId: owners.get(id)!.principalId, unowned: unowned.has(id) })), files: archiveFiles });
      continue;
    }
    if (tree.some(id => owners.get(id)!.principalId !== owner.principalId)) throw new Error(`Cross-owner session tree: ${root}`);
    mappings.push({
      ...sessionMapping(root), organization: owner.organization, principalId: owner.principalId,
      runtimeId: catalog.runtimeId, sourceRoot: catalog.sourceRoot,
      ownershipVerified: true, sourceFrozen: false,
      children: tree.filter(id => id !== root).map(id => ({ ...sessionMapping(id), parentSessionId: owners.get(id)!.parentSessionId! })),
      files: [],
    });
  }
  return {
    format: "siclaw-workspace-migration-plan-v1" as const, mappings, unknownArchives,
    summary: { roots: mappings.length, sessions: transcripts.size, files: used.size, bytes: [...used].reduce((n, name) => n + files.get(name)!.size, 0) },
    catalogSessionsWithoutTranscript: [...owners.keys()].filter(id => !transcripts.has(id)).sort(),
    invalidatedCaches: invalidatedCaches.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    excludedFiles: [...files.keys()].filter(name => !used.has(name)).sort(),
  };
}
