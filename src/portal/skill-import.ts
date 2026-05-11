/**
 * Skill Import Service — parse, diff, and sync builtin skill packs.
 *
 * Provides three operations:
 *   1. parseSkillPack()     — extract a zip/tar archive buffer into ParsedSkill[]
 *   2. computeImportDiff()  — compare incoming skills against DB builtins
 *   3. executeImport()      — apply the diff transactionally + snapshot
 *
 * Used by the admin import endpoint in siclaw-api.ts.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import * as tar from "tar";
import { getDb } from "../gateway/db.js";
import { parseSkillsDir, type ParsedSkill } from "../gateway/skills/builtin-sync.js";

export type { ParsedSkill };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DiffEntry {
  name: string;
  description: string;
}

export interface ImportDiff {
  added: DiffEntry[];
  updated: DiffEntry[];
  deleted: Array<{ name: string; description: string; bound_agents: Array<{ id: string; name: string }> }>;
  unchanged: DiffEntry[];
}

export interface ImportResult extends ImportDiff {
  import_id: string;
  version: number;
}

/**
 * Import policy for builtins that exist in DB but are absent from the incoming pack.
 *   - "sync"   — delete them (full mirror; used by init / rollback / bootstrap)
 *   - "upsert" — leave them untouched (additive upload; used by admin pack upload)
 */
export type ImportMode = "sync" | "upsert";

// ---------------------------------------------------------------------------
// 1. Parse a skill pack archive into structured skill objects
// ---------------------------------------------------------------------------

export type ArchiveFormat = "zip" | "tar";

/**
 * Detect archive format from the first bytes of the buffer.
 * - zip: PK\x03\x04 (local file header)
 * - tar.gz: gzip magic \x1F\x8B
 * - tar (uncompressed): "ustar" at offset 257
 */
export function detectArchiveFormat(buf: Buffer): ArchiveFormat {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "zip";
  }
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return "tar"; // gzip-wrapped tar — tar.extract auto-detects gzip
  }
  if (buf.length >= 262 && buf.slice(257, 262).toString("utf8") === "ustar") {
    return "tar";
  }
  throw new Error("Unsupported archive format (expected zip or tar)");
}

function extractZip(buf: Buffer, destDir: string): void {
  const zip = new AdmZip(buf);
  for (const entry of zip.getEntries()) {
    // Reject absolute paths and parent-traversal segments — the zip must
    // not be able to write outside destDir.
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`Unsafe path in zip: ${entry.entryName}`);
    }
  }
  zip.extractAllTo(destDir, /*overwrite*/ true);
}

async function extractTar(buf: Buffer, destDir: string, tmpDir: string): Promise<void> {
  const archivePath = path.join(tmpDir, "pack.tar");
  fs.writeFileSync(archivePath, buf);
  // tar.extract auto-detects gzip via the stream; default behavior strips
  // absolute paths and refuses `..` entries, so no extra guard is needed.
  await tar.extract({ file: archivePath, cwd: destDir });
}

/**
 * Extract a skill pack archive (zip or tar / tar.gz) into ParsedSkill[].
 *
 * Handles both layouts:
 *   - Archive root contains skill directories directly
 *   - Archive root contains a single wrapper directory holding the skill dirs
 */
export async function parseSkillPack(archiveBuffer: Buffer): Promise<ParsedSkill[]> {
  const tmpDir = path.join("/tmp", `skill-import-${crypto.randomUUID()}`);
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    const format = detectArchiveFormat(archiveBuffer);
    if (format === "zip") {
      extractZip(archiveBuffer, extractDir);
    } else {
      await extractTar(archiveBuffer, extractDir, tmpDir);
    }

    // Determine the actual skills root directory.
    // If there's a single subdirectory and no meta.json at the extract root,
    // the archive likely has a wrapper directory — descend into it.
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory());
    let skillsRoot = extractDir;
    if (dirs.length === 1 && !entries.some(e => e.name === "meta.json")) {
      skillsRoot = path.join(extractDir, dirs[0].name);
    }

    return parseSkillsDir(skillsRoot);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Compute diff between incoming skills and current DB builtins
// ---------------------------------------------------------------------------

/**
 * Compare incoming skills against the current builtin skills in the database.
 * Pure read — does NOT modify the database.
 */
export async function computeImportDiff(
  orgId: string,
  incoming: ParsedSkill[],
): Promise<ImportDiff> {
  const db = getDb();

  // Current builtin skills
  const [builtinRows] = await db.query(
    "SELECT id, name, description, specs, scripts FROM skills WHERE org_id = ? AND is_builtin = 1",
    [orgId],
  ) as any;
  const builtinMap = new Map<string, { id: string; description: string; specs: string; scripts: string }>();
  for (const row of builtinRows) {
    builtinMap.set(row.name, row);
  }

  const incomingNames = new Set(incoming.map(s => s.name));
  const added: DiffEntry[] = [];
  const updated: DiffEntry[] = [];
  const unchanged: DiffEntry[] = [];

  for (const skill of incoming) {
    const existing = builtinMap.get(skill.name);
    const entry: DiffEntry = { name: skill.name, description: skill.description };
    if (!existing) {
      added.push(entry);
    } else {
      // Normalize scripts — DB may store as JSON string or parsed object
      const existingScripts = typeof existing.scripts === "string"
        ? existing.scripts : JSON.stringify(existing.scripts);
      const incomingScripts = JSON.stringify(skill.scripts);
      if (existing.specs !== skill.specs || existingScripts !== incomingScripts) {
        updated.push(entry);
      } else {
        unchanged.push(entry);
      }
    }
  }

  // Deleted: builtins in DB but not in incoming set
  const deleted: ImportDiff["deleted"] = [];
  for (const [name, row] of builtinMap) {
    if (!incomingNames.has(name)) {
      // Query agents currently bound to this skill
      const [bindRows] = await db.query(
        `SELECT a.id, a.name FROM agent_skills ask
         JOIN agents a ON a.id = ask.agent_id
         WHERE ask.skill_id = ?`,
        [row.id],
      ) as any;
      deleted.push({
        name,
        description: row.description ?? "",
        bound_agents: bindRows.map((r: any) => ({ id: r.id, name: r.name })),
      });
    }
  }

  return { added, updated, deleted, unchanged };
}

// ---------------------------------------------------------------------------
// 3. Execute the import: transactional sync + snapshot
// ---------------------------------------------------------------------------

/**
 * Apply the import diff transactionally, save a history snapshot, and
 * optionally notify affected agents.
 *
 * The `mode` field controls how missing-from-pack builtins are handled —
 * see {@link ImportMode}. No default: every caller must commit to a policy.
 */
export async function executeImport(
  orgId: string,
  incoming: ParsedSkill[],
  userId: string,
  comment: string,
  opts: {
    mode: ImportMode;
    notifyAgentReload?: (agentId: string, resources: string[]) => void;
  },
): Promise<ImportResult> {
  const db = getDb();
  const rawDiff = await computeImportDiff(orgId, incoming);
  // In upsert mode the "deleted" set is informational only — it tells us
  // which builtins exist in DB but are absent from the pack, and we leave
  // them alone. We zero it out in the result so callers (and history rows)
  // truthfully reflect what happened.
  const diff: ImportDiff = opts.mode === "upsert"
    ? { ...rawDiff, deleted: [] }
    : rawDiff;

  // Build a name→id map for existing builtins
  const [builtinRows] = await db.query(
    "SELECT id, name FROM skills WHERE org_id = ? AND is_builtin = 1",
    [orgId],
  ) as any;
  const builtinByName = new Map<string, string>();
  for (const r of builtinRows) builtinByName.set(r.name, r.id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // --- ADD new builtin skills ---
    for (const entry of diff.added) {
      const skill = incoming.find(s => s.name === entry.name)!;
      const id = crypto.randomUUID();
      await conn.query(
        `INSERT INTO skills (id, org_id, name, description, labels, author_id, status, version, specs, scripts, created_by, is_builtin)
         VALUES (?, ?, ?, ?, ?, 'system', 'installed', 1, ?, ?, 'system', 1)`,
        [id, orgId, skill.name, skill.description, JSON.stringify(skill.labels), skill.specs, JSON.stringify(skill.scripts)],
      );
      await conn.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, author_id, is_approved, commit_message)
         VALUES (?, ?, 1, ?, ?, 'system', 1, ?)`,
        [crypto.randomUUID(), id, skill.specs, JSON.stringify(skill.scripts), comment || "Builtin import"],
      );
    }

    // --- UPDATE changed builtin skills ---
    for (const entry of diff.updated) {
      const skill = incoming.find(s => s.name === entry.name)!;
      const existingId = builtinByName.get(entry.name)!;
      // Get next version number
      const [vRows] = await conn.query(
        "SELECT MAX(version) AS v FROM skill_versions WHERE skill_id = ?",
        [existingId],
      ) as any;
      const nextVersion = (vRows[0]?.v ?? 0) + 1;
      // Update skills row
      await conn.query(
        `UPDATE skills SET description = ?, labels = ?, specs = ?, scripts = ?, version = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [skill.description, JSON.stringify(skill.labels), skill.specs, JSON.stringify(skill.scripts), nextVersion, existingId],
      );
      // Create approved version row
      await conn.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, author_id, is_approved, commit_message)
         VALUES (?, ?, ?, ?, ?, 'system', 1, ?)`,
        [crypto.randomUUID(), existingId, nextVersion, skill.specs, JSON.stringify(skill.scripts), comment || "Builtin update"],
      );
    }

    // --- DELETE removed builtin skills ---
    // Skipped in upsert mode — diff.deleted has already been zeroed out above
    // so this loop is a no-op, but the explicit guard keeps intent obvious.
    const affectedAgentIds = new Set<string>();
    if (opts.mode === "sync") {
      for (const del of rawDiff.deleted) {
        const existingId = builtinByName.get(del.name)!;
        // Check for overlay — if one exists, promote it to standalone
        const [overlayRows] = await conn.query(
          "SELECT id FROM skills WHERE overlay_of = ?",
          [existingId],
        ) as any;
        if (overlayRows.length > 0) {
          // Promote overlay: clear overlay_of, keep as regular skill
          await conn.query("UPDATE skills SET overlay_of = NULL, updated_at = CURRENT_TIMESTAMP WHERE overlay_of = ?", [existingId]);
          // Migrate agent bindings from builtin → overlay
          for (const ov of overlayRows) {
            await conn.query(
              "UPDATE agent_skills SET skill_id = ? WHERE skill_id = ?",
              [ov.id, existingId],
            );
          }
        } else {
          // No overlay — unbind agents
          await conn.query("DELETE FROM agent_skills WHERE skill_id = ?", [existingId]);
        }
        // Track affected agents for notification
        for (const agent of del.bound_agents) affectedAgentIds.add(agent.id);
        // Delete builtin skill (cascades to versions, reviews)
        await conn.query("DELETE FROM skills WHERE id = ?", [existingId]);
      }
    }

    await conn.commit();

    // Notify affected agents outside transaction (fire-and-forget)
    if (opts.notifyAgentReload) {
      for (const agentId of affectedAgentIds) {
        opts.notifyAgentReload(agentId, ["skills"]);
      }
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // --- Save snapshot for rollback ---
  const snapshot = JSON.stringify(incoming);
  const [histRows] = await db.query(
    "SELECT COALESCE(MAX(version), 0) AS v FROM skill_import_history",
  ) as any;
  const importVersion = (histRows[0]?.v ?? 0) + 1;
  const importId = crypto.randomUUID();
  await db.query(
    `INSERT INTO skill_import_history (id, version, comment, snapshot, skill_count, added, updated, deleted, imported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      importId, importVersion, comment || null, snapshot, incoming.length,
      // History columns historically held string[] of names — preserve that
      // shape so existing rows and the history-list UI keep working.
      JSON.stringify(diff.added.map(d => d.name)),
      JSON.stringify(diff.updated.map(d => d.name)),
      JSON.stringify(diff.deleted.map(d => d.name)), userId,
    ],
  );

  // Prune old history (keep last 10)
  await db.query(
    `DELETE FROM skill_import_history WHERE version <= (SELECT * FROM (SELECT MAX(version) - 10 FROM skill_import_history) AS t)`,
  );

  return { ...diff, import_id: importId, version: importVersion };
}
