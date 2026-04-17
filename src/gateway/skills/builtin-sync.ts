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
import { join, resolve } from "node:path";
import { getDb } from "../db.js";

// Resolve skills/core/ relative to CWD (project root in both dev and Docker).
const SKILLS_CORE_DIR = resolve(process.cwd(), "skills/core");

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
// Public parsed skill type
// ---------------------------------------------------------------------------

export interface ParsedSkill {
  dirName: string;
  name: string;
  description: string;
  labels: string[];
  specs: string;
  scripts: Array<{ name: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Parse a skill's YAML frontmatter and return its `name` and `description`.
 * Handles inline values and block scalars (`>-`, `>`, `|`, `|-`) — built-in
 * skills rely on `description: >-` for multi-line text.
 */
export function parseFrontmatter(md: string): { name: string; description: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const block = match[1];

  // name: single-line value
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : "";

  // description: may be a YAML block scalar (>-, >, |) or inline
  let description = "";
  const lines = block.split("\n");
  const descIdx = lines.findIndex(l => l.match(/^description:\s/));
  if (descIdx >= 0) {
    const firstLine = lines[descIdx].replace(/^description:\s*/, "").trim();
    if (firstLine === ">-" || firstLine === ">" || firstLine === "|" || firstLine === "|-") {
      // Block scalar: collect indented continuation lines
      const contLines: string[] = [];
      for (let i = descIdx + 1; i < lines.length; i++) {
        if (lines[i].match(/^\s+/)) {
          contLines.push(lines[i].trim());
        } else {
          break;
        }
      }
      description = contLines.join(" ");
    } else {
      // Inline scalar
      description = firstLine;
    }
  }

  return { name, description };
}

function readSkillDir(dirName: string, dirPath: string, labelsMap: Record<string, string[]>): BuiltinSkillData | null {
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
// Public API — parsing
// ---------------------------------------------------------------------------

/**
 * Parse a skills directory into structured skill objects.
 * Pure filesystem → data transform. Does NOT touch the database.
 *
 * Expects the directory to follow the standard layout:
 *   <skillsDir>/
 *     meta.json          (optional) — { labels: { [dirName]: string[] } }
 *     <dirName>/
 *       SKILL.md         (required) — frontmatter with name + description
 *       scripts/         (optional) — .sh and .py files
 */
export function parseSkillsDir(skillsDir: string): ParsedSkill[] {
  // Load label map from meta.json if present
  const metaPath = join(skillsDir, "meta.json");
  let labelsMap: Record<string, string[]> = {};
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { labels?: Record<string, string[]> };
      labelsMap = meta.labels ?? {};
    } catch {
      // labels will be empty — caller may warn if needed
    }
  }

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readSkillDir(d.name, join(skillsDir, d.name), labelsMap))
    .filter((s): s is BuiltinSkillData => s !== null);
}

// ---------------------------------------------------------------------------
// Public API — database sync
// ---------------------------------------------------------------------------

export async function syncBuiltinSkills(
  orgId: string,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (!existsSync(SKILLS_CORE_DIR)) {
    console.warn(`[builtin-sync] skills/core/ not found at ${SKILLS_CORE_DIR} — skipping`);
    return { inserted: 0, updated: 0, skipped: 0 };
  }

  // Load label map (also needed for warning on parse failure)
  const metaPath = join(SKILLS_CORE_DIR, "meta.json");
  if (existsSync(metaPath)) {
    try {
      JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      console.warn("[builtin-sync] Failed to parse meta.json — labels will be empty");
    }
  }

  // Read all skill directories via shared parser
  const entries = parseSkillsDir(SKILLS_CORE_DIR);

  const db = getDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const skill of entries) {
    const hash = computeHash(skill.specs, skill.scripts);
    // specs is MEDIUMTEXT — store raw string, not JSON-encoded
    const specsRaw = skill.specs;
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
        [skillId, orgId, skill.name, skill.description, labelsJson, specsRaw, scriptsJson],
      );

      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved)
         VALUES (?, ?, 1, ?, ?, 'Initial builtin import', 'system', 1)`,
        [versionId, skillId, specsRaw, scriptsJson],
      );

      inserted++;
      continue;
    }

    // ── Existing skill ────────────────────────────────────
    const existing = rows[0] as { id: string; version: number; specs: any; scripts: any };
    // specs is MEDIUMTEXT — should be a raw string, but may be double-encoded from old bug
    let existingSpecs: string = typeof existing.specs === "string" ? existing.specs : String(existing.specs || "");
    if (existingSpecs.startsWith('"')) { try { existingSpecs = JSON.parse(existingSpecs); } catch { /* keep */ } }
    // scripts is JSON column — MySQL driver may return string or parsed object
    let existingScripts: ScriptEntry[];
    if (Array.isArray(existing.scripts)) {
      existingScripts = existing.scripts;
    } else if (typeof existing.scripts === "string") {
      try { existingScripts = JSON.parse(existing.scripts); } catch { existingScripts = []; }
    } else {
      existingScripts = [];
    }
    const currentHash = computeHash(existingSpecs, existingScripts);

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
      const v1 = v1Rows[0] as { specs: any; scripts: any };
      let v1Specs: string = typeof v1.specs === "string" ? v1.specs : String(v1.specs || "");
      if (v1Specs.startsWith('"')) { try { v1Specs = JSON.parse(v1Specs); } catch { /* keep */ } }
      let v1Scripts: ScriptEntry[];
      if (Array.isArray(v1.scripts)) { v1Scripts = v1.scripts; }
      else if (typeof v1.scripts === "string") { try { v1Scripts = JSON.parse(v1.scripts); } catch { v1Scripts = []; } }
      else { v1Scripts = []; }
      const v1Hash = computeHash(v1Specs, v1Scripts);

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
      [skill.description, labelsJson, newVersion, specsRaw, scriptsJson, existing.id],
    );

    await db.query(
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved)
       VALUES (?, ?, ?, ?, ?, 'Builtin update from image', 'system', 1)`,
      [versionId, existing.id, newVersion, specsRaw, scriptsJson],
    );

    updated++;
  }

  console.log(`[builtin-sync] done — inserted=${inserted} updated=${updated} skipped=${skipped}`);
  return { inserted, updated, skipped };
}
