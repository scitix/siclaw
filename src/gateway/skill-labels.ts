/**
 * Skill Labels — loaded from skills/{tier}/meta.json at startup.
 *
 * Each tier directory (core, extension, platform, team) may contain a meta.json:
 *   { "labels": { "skill-dir-name": ["label1", "label2", ...] } }
 *
 * Gateway scans all tiers, merges into a single in-memory Map keyed by "scope:dirName".
 */

import fs from "node:fs";
import path from "node:path";

const TIERS = ["core", "team", "extension", "platform"];

function loadLabelsFromDisk(): Record<string, string[]> {
  // Scan both the built-in skills dir and SICLAW_SKILLS_DIR (if set and different)
  const builtinDir = path.join(process.cwd(), "skills");
  const overrideDir = process.env.SICLAW_SKILLS_DIR;
  const dirs = [builtinDir];
  if (overrideDir && path.resolve(overrideDir) !== path.resolve(builtinDir)) {
    dirs.push(overrideDir);
  }

  const labels: Record<string, string[]> = {};

  for (const skillsDir of dirs) {
  for (const tier of TIERS) {
    const metaPath = path.join(skillsDir, tier, "meta.json");
    if (!fs.existsSync(metaPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
        labels?: Record<string, string[]>;
      };
      if (raw.labels) {
        for (const [dirName, skillLabels] of Object.entries(raw.labels)) {
          labels[`${tier}:${dirName}`] = skillLabels;
        }
      }
    } catch (err) {
      console.warn(`[skill-labels] Failed to load ${metaPath}:`, err instanceof Error ? err.message : err);
    }
  }
  }

  return labels;
}

export const SKILL_LABELS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(loadLabelsFromDisk()),
);

export function getLabelsForSkill(skillKey: string): string[] {
  return [...(SKILL_LABELS.get(skillKey) ?? [])];
}

export function batchGetLabels(skillKeys: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const key of skillKeys) {
    const labels = SKILL_LABELS.get(key);
    if (labels) result.set(key, [...labels]);
  }
  return result;
}

export function listAllLabels(): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const labels of SKILL_LABELS.values()) {
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
