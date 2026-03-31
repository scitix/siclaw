/**
 * Builtin Skill Sync — scans Docker-baked skill directories and upserts into DB.
 *
 * Runs once on gateway startup, after initSchema. After sync, builtin skills
 * are regular DB records (scope="builtin") with content in skill_contents.
 * All downstream code reads from DB, not disk.
 *
 * DB id format: "builtin:<dirName>" (deterministic, backward-compatible with
 * forkedFromId chains and workspace composer refs).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "../db/index.js";
import { SkillFileWriter } from "./file-writer.js";
import { SkillRepository } from "../db/repositories/skill-repo.js";
import { SkillContentRepository, type SkillContentTag } from "../db/repositories/skill-content-repo.js";
import { SkillVersionRepository } from "../db/repositories/skill-version-repo.js";

// ── Label loading (moved from skill-labels.ts) ──────────────────────

interface MetaJson {
  labels?: Record<string, string[]>;
}

function loadLabelsFromMetaJson(skillsDir: string): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const tier of ["core", "extension"]) {
    const metaPath = path.join(skillsDir, tier, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as MetaJson;
      if (raw.labels) {
        for (const [dirName, skillLabels] of Object.entries(raw.labels)) {
          // Merge labels across tiers (core + extension)
          const existing = labels.get(dirName) ?? [];
          labels.set(dirName, [...new Set([...existing, ...skillLabels])]);
        }
      }
    } catch (err) {
      console.warn(`[builtin-sync] Failed to load ${metaPath}:`, err instanceof Error ? err.message : err);
    }
  }
  return labels;
}

// ── Scanning ─────────────────────────────────────────────────────────

interface ScannedBuiltinSkill {
  dirName: string;
  name: string;
  description: string;
  specs: string;
  scripts: Array<{ name: string; content: string }>;
  labels: string[];
  contentHash: string;
}

// Reuse SkillFileWriter's parseFrontmatter for consistent YAML quote handling
const _fmParser = new SkillFileWriter(".");
function parseFrontmatter(specs: string): { name: string; description: string } {
  return _fmParser.parseFrontmatter(specs);
}

function scanBuiltinDir(dir: string, labelMap: Map<string, string[]>): ScannedBuiltinSkill[] {
  if (!fs.existsSync(dir)) return [];
  const results: ScannedBuiltinSkill[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

    const skillMdPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const specs = fs.readFileSync(skillMdPath, "utf-8");
    const { name, description } = parseFrontmatter(specs);

    // Read scripts
    const scripts: Array<{ name: string; content: string }> = [];
    const scriptsDir = path.join(dir, entry.name, "scripts");
    if (fs.existsSync(scriptsDir)) {
      for (const scriptName of fs.readdirSync(scriptsDir).filter(f => !f.startsWith("."))) {
        scripts.push({
          name: scriptName,
          content: fs.readFileSync(path.join(scriptsDir, scriptName), "utf-8"),
        });
      }
    }

    // Content hash for change detection
    const hash = crypto.createHash("sha256");
    hash.update(specs);
    for (const s of scripts.sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(s.name);
      hash.update(s.content);
    }
    const contentHash = hash.digest("hex").slice(0, 16);

    results.push({
      dirName: entry.name,
      name: name || entry.name,
      description,
      specs,
      scripts,
      labels: labelMap.get(entry.name) ?? [],
      contentHash,
    });
  }

  return results;
}

// ── Sync entry point ─────────────────────────────────────────────────

export async function syncBuiltinSkills(db: Database): Promise<number> {
  const skillRepo = new SkillRepository(db);
  const contentRepo = new SkillContentRepository(db);
  const versionRepo = new SkillVersionRepository(db);

  // Scan disk
  const builtinDir = path.join(process.cwd(), "skills");
  const labelMap = loadLabelsFromMetaJson(builtinDir);

  const scanned: ScannedBuiltinSkill[] = [];
  const seen = new Set<string>();
  for (const tier of ["core", "extension"]) {
    for (const skill of scanBuiltinDir(path.join(builtinDir, tier), labelMap)) {
      if (!seen.has(skill.dirName)) {
        seen.add(skill.dirName);
        scanned.push(skill);
      }
    }
  }

  // Get existing builtin records from DB
  const existingBuiltins = await skillRepo.list({ scope: "builtin" });
  const existingMap = new Map(existingBuiltins.map((s: any) => [s.id as string, s]));

  let upserted = 0;
  const scannedIds = new Set<string>();

  for (const skill of scanned) {
    const id = `builtin:${skill.dirName}`;
    scannedIds.add(id);

    const existing = existingMap.get(id);
    if (existing) {
      // Compare content hash — skip if unchanged
      if ((existing as any).contentHash === skill.contentHash) continue;

      // Update changed skill
      await skillRepo.update(id, {
        name: skill.name,
        description: skill.description,
        labels: skill.labels.length > 0 ? skill.labels : null,
        contentHash: skill.contentHash,
      });
      await contentRepo.save(id, "published" as SkillContentTag, {
        specs: skill.specs,
        scripts: skill.scripts,
      });
      // Bump version + create version record for the update
      await skillRepo.bumpVersion(id);
      const updated = await skillRepo.getById(id);
      const ver = updated?.version ?? 1;
      try {
        await versionRepo.create({
          skillId: id, version: ver, tag: "published",
          commitMessage: `builtin update`,
          specs: skill.specs, scriptsJson: skill.scripts,
          files: { metadata: { name: skill.name, description: skill.description ?? null, type: "BuiltIn", labels: skill.labels.length > 0 ? skill.labels : null } },
        });
      } catch { /* ignore if skill_versions schema incomplete */ }
      await skillRepo.update(id, { publishedVersion: ver });
      upserted++;
      console.log(`[builtin-sync] Updated: ${skill.name} (${id})`);
    } else {
      // Insert new builtin skill with deterministic id
      await skillRepo.createWithId(id, {
        name: skill.name,
        description: skill.description,
        type: "BuiltIn",
        scope: "builtin" as any,
        dirName: skill.dirName,
        originId: id,
        contentHash: skill.contentHash,
        labels: skill.labels.length > 0 ? skill.labels : undefined,
      });
      // Mark as approved (builtin is always approved)
      await skillRepo.update(id, { reviewStatus: "approved", publishedVersion: 1 });
      await contentRepo.save(id, "published" as SkillContentTag, {
        specs: skill.specs,
        scripts: skill.scripts,
      });
      // Create base version record (v1)
      try {
        await versionRepo.create({
          skillId: id, version: 1, tag: "published",
          commitMessage: `base version`,
          specs: skill.specs, scriptsJson: skill.scripts,
          files: { metadata: { name: skill.name, description: skill.description ?? null, type: "BuiltIn", labels: skill.labels.length > 0 ? skill.labels : null } },
        });
      } catch { /* ignore if skill_versions schema incomplete */ }
      upserted++;
      console.log(`[builtin-sync] Inserted: ${skill.name} (${id})`);
    }
  }

  // Remove stale builtin records (skill removed from Docker image)
  for (const [existingId] of existingMap) {
    if (!scannedIds.has(existingId)) {
      // Re-link forkedFromId chain before deleting
      await skillRepo.relinkForkedFrom(existingId, null);
      await skillRepo.deleteById(existingId);
      console.log(`[builtin-sync] Removed stale: ${existingId}`);
    }
  }

  // Fix-up: ensure all builtins have at least one version record (base version)
  for (const skill of scanned) {
    const id = `builtin:${skill.dirName}`;
    const versions = await versionRepo.listForSkill(id, { limit: 1 });
    if (versions.length === 0) {
      const meta = await skillRepo.getById(id);
      const ver = meta?.version ?? 1;
      try {
        await versionRepo.create({
          skillId: id, version: ver, tag: "published",
          commitMessage: `base version`,
          specs: skill.specs, scriptsJson: skill.scripts,
          files: { metadata: { name: skill.name, description: skill.description ?? null, type: "BuiltIn", labels: skill.labels.length > 0 ? skill.labels : null } },
        });
        if (!meta?.publishedVersion) await skillRepo.update(id, { publishedVersion: ver });
      } catch { /* ignore */ }
    }
  }

  // Also fix global skills without version records (contributed before version tracking)
  const globalSkills = await skillRepo.list({ scope: "global" });
  for (const g of globalSkills) {
    const versions = await versionRepo.listForSkill(g.id, { limit: 1 });
    if (versions.length === 0) {
      const content = await contentRepo.read(g.id, "published" as SkillContentTag);
      if (content) {
        const ver = g.version ?? 1;
        try {
          await versionRepo.create({
            skillId: g.id, version: ver, tag: "published",
            commitMessage: `initial version`,
            specs: content.specs, scriptsJson: content.scripts,
            files: { metadata: { name: g.name, description: g.description ?? null, type: g.type ?? null, labels: (g as any).labelsJson ?? null } },
          });
          if (!(g as any).publishedVersion) await skillRepo.update(g.id, { publishedVersion: ver });
        } catch { /* ignore */ }
      }
    }
  }

  // Fix-up: backfill null tags on version records based on commit_message
  try {
    const { sql } = await import("drizzle-orm");
    const { skillVersions } = await import("../db/schema.js");
    const { isNull } = await import("drizzle-orm");
    const nullTagVersions = await db.select().from(skillVersions).where(isNull(skillVersions.tag)).limit(500);
    let tagFixed = 0;
    for (const v of nullTagVersions) {
      const msg = (v.commitMessage ?? "").toLowerCase();
      let tag: "published" | "approved" | null = null;
      if (msg.includes("published") || msg.includes("base version") || msg.includes("contributed") || msg.includes("initial version")) tag = "published";
      else if (msg.includes("approved")) tag = "approved";
      else if (msg.includes("rollback")) tag = msg.includes("dev") ? "published" : "approved";
      if (tag) {
        await db.update(skillVersions).set({ tag }).where(sql`${skillVersions.id} = ${v.id}`);
        tagFixed++;
      }
    }
    if (tagFixed > 0) console.log(`[builtin-sync] Fixed tag for ${tagFixed} version records`);
  } catch { /* ignore if schema doesn't support tag yet */ }

  if (upserted > 0 || scanned.length > 0) {
    console.log(`[builtin-sync] Done: ${scanned.length} scanned, ${upserted} changed, ${existingMap.size - scannedIds.size > 0 ? existingMap.size - [...scannedIds].filter(id => existingMap.has(id)).length : 0} removed`);
  }

  return scanned.length;
}
