import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { buildKnowledgeCatalogRoutes } from "./catalog-graph.js";
import { parseKnowledgeLabels, type KnowledgeLabel } from "./labels.js";

export interface KnowledgeLabelBackfillManifest {
  version: 1;
  pages: Record<string, KnowledgeLabel[]>;
  excluded: Record<string, string>;
}

export interface KnowledgeLabelBackfillReport {
  reachableLeafPages: number;
  taggedPages: number;
  excludedPages: number;
}

function normalizeManifestPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid manifest page path: ${value}`);
  }
  return normalized;
}

function frontmatterEndOffset(markdown: string): number {
  const firstBreak = markdown.indexOf("\n");
  if (firstBreak < 0 || markdown.slice(0, firstBreak).trim() !== "---") return -1;
  let cursor = firstBreak + 1;
  while (cursor <= markdown.length) {
    const nextBreak = markdown.indexOf("\n", cursor);
    const end = nextBreak < 0 ? markdown.length : nextBreak;
    const line = markdown.slice(cursor, end).trim();
    if (line === "---" || line === "...") return cursor;
    if (nextBreak < 0) break;
    cursor = nextBreak + 1;
  }
  return -1;
}

function insertLabels(markdown: string, labels: KnowledgeLabel[], file: string): string {
  const endOffset = frontmatterEndOffset(markdown);
  if (endOffset < 0) throw new Error(`Page has no parseable YAML frontmatter: ${file}`);
  const frontmatter = markdown.slice(0, endOffset);
  if (/^labels\s*:/m.test(frontmatter)) {
    throw new Error(`Page already declares labels; refusing to overwrite: ${file}`);
  }
  if (labels.length < 4 || labels.length > 12) {
    throw new Error(`Page must declare 4-12 labels: ${file}`);
  }
  const block = yaml.dump({ labels }, { lineWidth: -1, noRefs: true }).trimEnd();
  const migrated = `${frontmatter}${block}\n${markdown.slice(endOffset)}`;
  const parsed = parseKnowledgeLabels(migrated);
  if (!parsed || parsed.labels.length !== labels.length) {
    throw new Error(`Generated labels failed runtime validation: ${file}`);
  }
  return migrated;
}

/**
 * Apply an explicit, complete typed-label manifest to a frozen Wiki snapshot.
 *
 * Every root-catalog-reachable leaf must be either labeled or excluded with a
 * reason. The source is never modified and the output is published atomically.
 */
export function applyKnowledgeLabelManifest(
  sourceDir: string,
  outputDir: string,
  manifest: KnowledgeLabelBackfillManifest,
): KnowledgeLabelBackfillReport {
  if (manifest.version !== 1) throw new Error(`Unsupported label manifest version: ${manifest.version}`);
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (source === output || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Output directory must be outside the source directory");
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`Source is not a directory: ${source}`);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);

  const pageEntries = new Map(Object.entries(manifest.pages).map(([file, labels]) => [normalizeManifestPath(file), labels]));
  const excludedEntries = new Map(Object.entries(manifest.excluded).map(([file, reason]) => [normalizeManifestPath(file), reason.trim()]));
  for (const file of pageEntries.keys()) {
    if (excludedEntries.has(file)) throw new Error(`Page cannot be both labeled and excluded: ${file}`);
  }
  for (const [file, reason] of excludedEntries) {
    if (!reason) throw new Error(`Excluded page requires a reason: ${file}`);
  }

  const routes = buildKnowledgeCatalogRoutes(source);
  const reachableLeaves = [...routes.entries()]
    .filter(([file, proof]) => proof.trail.at(-1)?.kind === "leaf" && fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile())
    .map(([file]) => file)
    .sort((a, b) => a.localeCompare(b));
  const reachableSet = new Set(reachableLeaves);
  const covered = new Set([...pageEntries.keys(), ...excludedEntries.keys()]);
  const missing = reachableLeaves.filter((file) => !covered.has(file));
  const extra = [...covered].filter((file) => !reachableSet.has(file)).sort((a, b) => a.localeCompare(b));
  if (missing.length > 0) throw new Error(`Manifest does not cover reachable leaf pages: ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`Manifest contains non-reachable pages: ${extra.join(", ")}`);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = `${output}.staging-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    const realStaging = fs.realpathSync(staging);
    for (const [file, labels] of pageEntries) {
      const target = path.join(staging, file);
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error(`Manifest page must resolve to a regular file: ${file}`);
      }
      const realTarget = fs.realpathSync(target);
      if (!realTarget.startsWith(`${realStaging}${path.sep}`)) {
        throw new Error(`Manifest page escapes the staging directory: ${file}`);
      }
      const before = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, insertLabels(before, labels, file));
    }
    fs.renameSync(staging, output);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    reachableLeafPages: reachableLeaves.length,
    taggedPages: pageEntries.size,
    excludedPages: excludedEntries.size,
  };
}
