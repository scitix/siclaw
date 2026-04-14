/**
 * Builtin skill sync — runs on gateway startup.
 *
 * Scans skills/core/ on the filesystem (baked into the Docker image) and
 * syncs each skill into the DB skills + skill_versions tables.
 *
 * Sync rules:
 *   - New skill:                    INSERT with status='installed', author_id='system', is_approved=1
 *   - Existing, hash unchanged:     SKIP
 *   - Existing, user hasn't edited  UPDATE from image, new version row, is_approved=1
 *     (current hash == v1 hash):
 *   - Existing, user has edited     SKIP
 *     (current hash != v1 hash):
 *
 * "Hash" is SHA-256 of (specs + JSON-sorted scripts), providing a stable
 * content fingerprint independent of insertion order.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the skills/core/ directory relative to the project root.
// In the Docker image the project root is the CWD; in dev it is two levels
// above src/gateway/skills/.
const SKILLS_CORE_DIR = resolve(__dirname, "../../../../skills/core");

interface ScriptEntry {
  name: string;
  content: string;
}

interface BuiltinSkillData {
  dirName: string;
  name: string;
  description: string;
  specs: string;
  scripts: ScriptEntry[];
  labels: string[];
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(md: string): { name: string; description: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const block = match[1];

  // name: single-line value
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "";

  // description: may be a YAML block scalar (>-, >, |) or inline
  let description = "";
  const descMatch = block.match(/^description:\s*([\s\S]*?)(?=\n\S|\n?$)/m);
  if (descMatch) {
    const raw = descMatch[1].trim();
    // Strip YAML block scalar indicators and collapse folded lines
    description = raw
      .replace(/^>-?\s*\n/, "")
      .replace(/^[|>][-+]?\s*\n/, "")
      .split("\n")
      .map((l) => l.trim())
      .join(" ")
      .trim();
    if (!description) {
      // Inline scalar
      description = raw.replace(/^>-?\s*|^[|>][-+]?\s*/, "").trim();
    }
  }

  return { name, description };
}

function readSkillDir(dirName: string, labelsMap: Record<string, string[]>): BuiltinSkillData | null {
  const dirPath = join(SKILLS_CORE_DIR, dirName);

  const skillMdPath = join(dirPath, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  const specs = readFileSync(skillMdPath, "utf8");
  const { name, description } = parseFrontmatter(specs);
  if (!name) return null;

  // Collect scripts (sorted by name for deterministic hashing)
  const scripts: ScriptEntry[] = [];
  const scriptsDir = join(dirPath, "scripts");
  if (existsSync(scriptsDir)) {
    const files = readdirSync(scriptsDir).filter((f) => f.endsWith(".sh") || f.endsWith(".py")).sort();
    for (const file of files) {
      const content = readFileSync(join(scriptsDir, file), "utf8");
      scripts.push({ name: file, content });
    }
  }

  const labels = labelsMap[dirName] ?? [];

  return { dirName, name, description, specs, scripts, labels };
}

function computeHash(specs: string, scripts: ScriptEntry[]): string {
  const h = createHash("sha256");
  h.update(specs);
  // Scripts are already sorted by name; stringify produces a stable string
  h.update(JSON.stringify(scripts));
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function syncBuiltinSkills(
  orgId: string,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (!existsSync(SKILLS_CORE_DIR)) {
    console.warn(`[builtin-sync] skills/core/ not found at ${SKILLS_CORE_DIR} — skipping`);
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  // Load label map
  const metaPath = join(SKILLS_CORE_DIR, "meta.json");
  let labelsMap: Record<string, string[]> = {};
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { labels?: Record<string, string[]> };
      labelsMap = meta.labels ?? {};
    } catch {
      console.warn("[builtin-sync] Failed to parse meta.json — labels will be empty");
    }
  }

  // Read all skill directories
  const entries = readdirSync(SKILLS_CORE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readSkillDir(d.name, labelsMap))
    .filter((s): s is BuiltinSkillData => s !== null);

  const db = getDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const skill of entries) {
    const hash = computeHash(skill.specs, skill.scripts);
    const specsJson = JSON.stringify(skill.specs);
    const scriptsJson = JSON.stringify(skill.scripts);
    const labelsJson = JSON.stringify(skill.labels);

    // Look up existing skill row
    const [rows] = await db.query<any[]>(
      `SELECT id, version, specs, scripts FROM skills WHERE org_id = ? AND name = ? LIMIT 1`,
      [orgId, skill.name],
    );

    if (rows.length === 0) {
      // ── INSERT ────────────────────────────────────────────
      const skillId = crypto.randomUUID();
      const versionId = crypto.randomUUID();

      await db.query(
        `INSERT INTO skills (id, org_id, name, description, labels, author_id, status, version, specs, scripts, created_by)
         VALUES (?, ?, ?, ?, ?, 'system', 'installed', 1, ?, ?, 'system')`,
        [skillId, orgId, skill.name, skill.description, labelsJson, specsJson, scriptsJson],
      );

      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved)
         VALUES (?, ?, 1, ?, ?, 'Initial builtin import', 'system', 1)`,
        [versionId, skillId, specsJson, scriptsJson],
      );

      inserted++;
      continue;
    }

    // ── Existing skill ────────────────────────────────────
    // mysql2 auto-decodes JSON columns; specs is mediumtext (string), scripts is JSON (already parsed).
    const existing = rows[0] as { id: string; version: number; specs: string; scripts: unknown };
    const currentHash = computeHash(
      JSON.parse(existing.specs as string),
      (typeof existing.scripts === "string" ? JSON.parse(existing.scripts) : existing.scripts) as ScriptEntry[],
    );

    if (currentHash === hash) {
      // Content identical — nothing to do
      skipped++;
      continue;
    }

    // Check v1 hash to detect user edits
    const [v1Rows] = await db.query<any[]>(
      `SELECT specs, scripts FROM skill_versions WHERE skill_id = ? AND version = 1 LIMIT 1`,
      [existing.id],
    );

    if (v1Rows.length > 0) {
      const v1 = v1Rows[0] as { specs: string; scripts: unknown };
      const v1Hash = computeHash(
        JSON.parse(v1.specs as string),
        (typeof v1.scripts === "string" ? JSON.parse(v1.scripts) : v1.scripts) as ScriptEntry[],
      );

      if (v1Hash !== currentHash) {
        // User has edited since v1 — leave their version alone
        skipped++;
        continue;
      }
    }

    // ── UPDATE ────────────────────────────────────────────
    // Current content matches v1 (or v1 doesn't exist): safe to update
    const newVersion = existing.version + 1;
    const versionId = crypto.randomUUID();

    await db.query(
      `UPDATE skills SET description = ?, labels = ?, version = ?, specs = ?, scripts = ?, status = 'installed', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [skill.description, labelsJson, newVersion, specsJson, scriptsJson, existing.id],
    );

    await db.query(
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved)
       VALUES (?, ?, ?, ?, ?, 'Builtin update from image', 'system', 1)`,
      [versionId, existing.id, newVersion, specsJson, scriptsJson],
    );

    updated++;
  }

  console.log(`[builtin-sync] done — inserted=${inserted} updated=${updated} skipped=${skipped}`);
  return { inserted, updated, skipped };
}
