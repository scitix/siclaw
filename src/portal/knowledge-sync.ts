/**
 * Knowledge builtin sync — imports baseline wiki from filesystem into DB
 * on first startup (when no knowledge repos exist yet).
 *
 * Similar to builtin-sync.ts for skills: image ships a baseline,
 * DB takes over once populated. Later updates go through the admin UI.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "../gateway/db.js";
import { validateKnowledgePackage } from "../shared/knowledge-package.js";

const KNOWLEDGE_DIR = path.resolve("knowledge/compiled");
const REPO_NAME = "siclaw-wiki";
const REPO_DESC = "Siclaw SRE knowledge base (auto-imported from baseline)";

export async function syncBuiltinKnowledge(): Promise<void> {
  const db = getDb();

  // Skip if any repos already exist (DB has been populated)
  const [repos] = await db.query("SELECT COUNT(*) AS c FROM knowledge_repos") as any;
  if (Number(repos[0].c) > 0) {
    console.log("[knowledge-sync] DB has repos, skipping baseline import");
    return;
  }

  // Skip if no baseline files on disk
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.log("[knowledge-sync] No baseline at knowledge/compiled/, skipping");
    return;
  }
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("[knowledge-sync] Baseline empty, skipping");
    return;
  }

  // Create tar.gz from compiled/ directory
  const tarPath = path.join("/tmp", `knowledge-baseline-${Date.now()}.tar.gz`);
  try {
    execFileSync("tar", ["czf", tarPath, "-C", KNOWLEDGE_DIR, "."], { stdio: "pipe" });
  } catch (err) {
    console.error("[knowledge-sync] Failed to create tar:", err);
    return;
  }

  const tarData = fs.readFileSync(tarPath);
  fs.unlinkSync(tarPath);
  const packageInfo = validateKnowledgePackage(tarData);

  // Insert repo + version
  const repoId = crypto.randomUUID();
  const versionId = crypto.randomUUID();

  await db.query(
    "INSERT INTO knowledge_repos (id, name, description, created_by) VALUES (?, ?, ?, ?)",
    [repoId, REPO_NAME, REPO_DESC, "system"],
  );
  await db.query(
    `INSERT INTO knowledge_versions
     (id, repo_id, version, message, data, size_bytes, sha256, file_count, is_active, status, uploaded_by, activated_by, activated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, 'active', ?, ?, CURRENT_TIMESTAMP(3))`,
    [
      versionId,
      repoId,
      `Baseline import (${files.length} pages)`,
      tarData,
      tarData.length,
      packageInfo.sha256,
      packageInfo.fileCount,
      "system",
      "system",
    ],
  );

  console.log(`[knowledge-sync] Imported baseline: ${files.length} pages, ${tarData.length} bytes`);
}
