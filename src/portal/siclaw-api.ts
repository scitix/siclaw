/**
 * Siclaw domain REST API — Portal-owned.
 *
 * All CRUD for skills, mcp, chat sessions, models, diagnostics,
 * channels, and dashboard. Portal owns the database; Runtime is
 * a pure execution engine that never touches these tables.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RestRouter } from "../gateway/rest-router.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

/** Subset of config needed by siclaw API routes */
interface SiclawConfig {
  jwtSecret: string;
  portalSecret: string;
  connectionMap: RuntimeConnectionMap;
}
import {
  sendJson,
  parseBody,
  parseQuery,
  requireAuth,
  requireAdmin,
  type AuthContext,
} from "../gateway/rest-router.js";
import { getDb } from "../gateway/db.js";
import {
  buildUpsert,
  jsonArrayContains,
  jsonArrayFlattenSql,
  safeParseJson,
  toSqlTimestamp,
} from "../gateway/dialect-helpers.js";
import { evaluateScriptsStatic, buildAssessment } from "../gateway/skills/script-evaluator.js";
import { evaluateScriptsAI } from "../gateway/skills/ai-security-reviewer.js";
import { parseFrontmatter } from "../gateway/skills/builtin-sync.js";
import { validateSchedule } from "../cron/cron-limits.js";
import { validateKnowledgePackage } from "../shared/knowledge-package.js";

/** Trace viewer message limit — matches siclaw_main.cron-limits.MAX_TRACE_MESSAGES */
const MAX_TRACE_MESSAGES = 200;

/**
 * Summarise a vector of millisecond latency samples into avg / min / max / p90.
 * Empty input → `count: 0` and the rest 0; the frontend renders a "no data"
 * state in that case. p90 uses nearest-rank: index = ceil(n * 0.9) - 1.
 */
function summariseLatency(values: number[]): {
  count: number; avg: number; min: number; max: number; p90: number;
} {
  if (values.length === 0) return { count: 0, avg: 0, min: 0, max: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p90Index = Math.max(0, Math.ceil(n * 0.9) - 1);
  return {
    count: n,
    avg: Math.round(sum / n),
    min: sorted[0],
    max: sorted[n - 1],
    p90: sorted[p90Index],
  };
}

// ── Permission check helper ───────────────────────────────────

interface AccessResult {
  allowed: boolean;
  grantAll: boolean;
  agentGroupIds: string[];
}

async function checkAccess(
  _config: SiclawConfig,
  userId: string,
  _orgId: string,
  action: "read" | "write" | "review",
): Promise<AccessResult> {
  // "review" requires admin or can_review_skills flag
  if (action === "review") {
    const db = getDb();
    const [rows] = await db.query(
      "SELECT role, can_review_skills FROM siclaw_users WHERE id = ?",
      [userId],
    ) as any;
    if (rows.length === 0) return { allowed: false, grantAll: false, agentGroupIds: [] };
    const user = rows[0];
    const allowed = user.role === "admin" || !!user.can_review_skills;
    return { allowed, grantAll: allowed, agentGroupIds: [] };
  }
  // All other actions (read, write): allow for any authenticated user
  return { allowed: true, grantAll: true, agentGroupIds: [] };
}

/**
 * Guard: check module permission and reject if not allowed.
 * Returns true if access was denied (response already sent).
 */
async function guardAccess(
  res: import("node:http").ServerResponse,
  config: SiclawConfig,
  auth: AuthContext,
  action: "read" | "write" | "review",
): Promise<boolean> {
  if (!auth.orgId) {
    sendJson(res, 403, { error: "Organization context required" });
    return true;
  }
  const access = await checkAccess(config, auth.userId, auth.orgId, action);
  if (!access.allowed) {
    sendJson(res, 403, { error: "Forbidden: insufficient siclaw permissions" });
    return true;
  }
  return false;
}

// ── Pagination helpers ────────────────────────────────────────

function parsePagination(query: Record<string, string>): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size || "20", 10)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ── Route registration ────────────────────────────────────────

export interface SiclawApiContext {
  /** Notify all agents bound to a skill to reload (used on approve). */
  notifySkillAgents?: (skillId: string, resources: string[]) => void;
  /** Notify only dev agents bound to a skill to reload (used on draft update). */
  notifySkillDevAgents?: (skillId: string, resources: string[]) => void;
  /** Notify agents bound to an MCP server to reload. */
  notifyMcpAgents?: (mcpId: string, resources: string[]) => void;
}

export function registerSiclawRoutes(router: RestRouter, config: SiclawConfig, ctx?: SiclawApiContext): void {
  const P = "/api/v1/siclaw";

  // ================================================================
  // Skills
  // ================================================================

  // All distinct labels across skills (for autocomplete)
  router.get(`${P}/skills/labels`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }
    const db = getDb();
    const { joinClause, valueColumn } = jsonArrayFlattenSql(db, "skills", "labels");
    const [rows] = await db.query(
      `SELECT DISTINCT ${valueColumn} AS label FROM ${joinClause} WHERE ${valueColumn} IS NOT NULL ORDER BY ${valueColumn}`,
    ) as any;
    sendJson(res, 200, { labels: (rows as any[]).map((r: any) => r.label) });
  });

  // List skills
  router.get(`${P}/skills`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const search = query.search || "";

    const db = getDb();

    const overlayExclude = " AND NOT (is_builtin = 1 AND id IN (SELECT overlay_of FROM skills WHERE overlay_of IS NOT NULL AND org_id = ?))";
    const overlayExcludeAliased = " AND NOT (s.is_builtin = 1 AND s.id IN (SELECT overlay_of FROM skills WHERE overlay_of IS NOT NULL AND org_id = ?))";
    let countSql = "SELECT COUNT(*) AS count FROM skills WHERE org_id = ?" + overlayExclude;
    let listSql = "SELECT s.*, (SELECT MAX(sv.version) FROM skill_versions sv WHERE sv.skill_id = s.id AND sv.is_approved = 1) AS installed_version FROM skills s WHERE s.org_id = ?" + overlayExcludeAliased;
    const params: unknown[] = [auth.orgId, auth.orgId];

    if (search) {
      const clause = " AND (name LIKE ? OR description LIKE ?)";
      countSql += clause;
      listSql += clause;
      params.push(`%${search}%`, `%${search}%`);
    }

    if (query.labels) {
      const labelList = (query.labels as string).split(",").map(l => l.trim());
      for (const label of labelList) {
        // MySQL JSON_CONTAINS wants a JSON-encoded value; SQLite json_each compares
        // raw string values. Helper picks the right SQL; we pass two param shapes.
        const clause = " AND " + jsonArrayContains(db, "labels");
        countSql += clause;
        listSql += clause;
        params.push(db.driver === "mysql" ? JSON.stringify(label) : label);
      }
    }

    listSql += " ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?";

    const [[countRows], [listRows]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, pageSize, offset]),
    ]) as [any, any];

    for (const row of listRows as any[]) {
      if (row.labels !== undefined) row.labels = safeParseJson(row.labels, []);
      if (row.scripts !== undefined) row.scripts = safeParseJson(row.scripts, []);
    }

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  /** Validate SKILL.md specs format — must have frontmatter with name field */
  function validateSpecs(specs: string | undefined): { valid: boolean; error?: string; name?: string; description?: string } {
    if (!specs || typeof specs !== "string") return { valid: false, error: "specs (SKILL.md content) is required" };
    const fmMatch = specs.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { valid: false, error: "specs must start with YAML frontmatter (--- ... ---). Example:\n---\nname: my-skill\ndescription: What this skill does\n---" };
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    if (!nameMatch || !nameMatch[1].trim()) return { valid: false, error: "specs frontmatter must include a 'name' field" };
    // Extract description from frontmatter
    const lines = fmMatch[1].split("\n");
    const descIdx = lines.findIndex(l => l.match(/^description:\s/));
    let description = "";
    if (descIdx >= 0) {
      const firstLine = lines[descIdx].replace(/^description:\s*/, "").trim();
      if (firstLine === ">-" || firstLine === ">" || firstLine === "|" || firstLine === "|-") {
        const contLines: string[] = [];
        for (let i = descIdx + 1; i < lines.length; i++) {
          if (lines[i].match(/^\s+/)) contLines.push(lines[i].trim());
          else break;
        }
        description = contLines.join(" ");
      } else {
        description = firstLine;
      }
    }
    return { valid: true, name: nameMatch[1].trim(), description };
  }

  // Create skill
  router.post(`${P}/skills`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);

    // Validate specs format
    const specsCheck = validateSpecs(body.specs as string);
    if (!specsCheck.valid) {
      sendJson(res, 400, { error: specsCheck.error });
      return;
    }

    const id = crypto.randomUUID();
    const version = 1;

    const db = getDb();

    // Use name/description from frontmatter if not explicitly provided
    const skillName = (body.name as string)?.trim() || specsCheck.name || "untitled";
    const skillDescription = (body.description as string)?.trim() || specsCheck.description || "";

    await db.query(
      `INSERT INTO skills (id, org_id, name, description, labels, author_id, status, version, specs, scripts, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.orgId, skillName, skillDescription || null,
        JSON.stringify(body.labels || []),
        auth.userId, "draft", version,
        body.specs || "", JSON.stringify(body.scripts || []),
        auth.userId,
      ],
    );

    // Insert initial version
    await db.query(
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), id, version,
        body.specs || "", JSON.stringify(body.scripts || []),
        body.commit_message || "Initial version", auth.userId,
        JSON.stringify(body.labels || []),
      ],
    );

    const [rows] = await db.query("SELECT * FROM skills WHERE id = ?", [id]) as any;
    const created = rows[0];
    if (created) {
      created.labels = safeParseJson(created.labels, []);
      created.scripts = safeParseJson(created.scripts, []);
    }
    sendJson(res, 201, created);
  });

  // Get skill
  router.get(`${P}/skills/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }
    const row = rows[0];
    row.labels = safeParseJson(row.labels, []);
    row.scripts = safeParseJson(row.scripts, []);
    sendJson(res, 200, row);
  });

  // Update skill
  router.put(`${P}/skills/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Check if this is a builtin skill
    const [targetRows] = await db.query("SELECT * FROM skills WHERE id = ? AND org_id = ?", [params.id, auth.orgId]) as any;
    if (targetRows.length === 0) { sendJson(res, 404, { error: "Skill not found" }); return; }
    const targetSkill = targetRows[0];

    if (targetSkill.is_builtin) {
      // Check if overlay already exists
      const [existingOverlay] = await db.query(
        "SELECT id FROM skills WHERE overlay_of = ? AND org_id = ?",
        [params.id, auth.orgId],
      ) as any;
      if (existingOverlay.length > 0) {
        sendJson(res, 409, {
          error: "This builtin skill already has an overlay. Edit the overlay instead.",
          overlay_id: existingOverlay[0].id,
        });
        return;
      }
      // Create overlay — full copy with user's edits applied
      const overlayId = crypto.randomUUID();
      const newSpecs = (body.specs as string) ?? targetSkill.specs;
      const newScripts = body.scripts ? JSON.stringify(body.scripts) : targetSkill.scripts;
      const newLabels = body.labels ? JSON.stringify(body.labels) : targetSkill.labels;
      const newDesc = (body.description as string) ?? targetSkill.description;

      await db.query(
        `INSERT INTO skills (id, org_id, name, description, labels, author_id, status, version, specs, scripts, created_by, is_builtin, overlay_of)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, 0, ?)`,
        [overlayId, auth.orgId, targetSkill.name, newDesc, newLabels, auth.userId, newSpecs, newScripts, auth.userId, params.id],
      );
      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, author_id, is_approved, labels)
         VALUES (?, ?, 1, ?, ?, ?, 0, ?)`,
        [crypto.randomUUID(), overlayId, newSpecs, newScripts, auth.userId, newLabels],
      );

      const [created] = await db.query("SELECT * FROM skills WHERE id = ?", [overlayId]) as any;
      const overlay = created[0];
      if (overlay) {
        overlay.labels = safeParseJson(overlay.labels, []);
        overlay.scripts = safeParseJson(overlay.scripts, []);
      }
      sendJson(res, 201, overlay);
      return;
    }

    const skill = targetSkill;

    // Status-aware edit behavior
    if (skill.status === "pending_review") {
      sendJson(res, 409, { error: "Cannot edit while pending review. Withdraw first." });
      return;
    }

    if (skill.status === "installed") {
      // Bump version, create version record, reset to draft
      const newVersion = (skill.version || 0) + 1;
      // specs is MEDIUMTEXT (raw string), scripts is JSON
      const newSpecs = body.specs ?? skill.specs ?? "";
      const newScripts = body.scripts ? JSON.stringify(body.scripts) : (typeof skill.scripts === "string" ? skill.scripts : JSON.stringify(skill.scripts || []));
      const oldSpecs = skill.specs ?? "";
      const oldScripts = typeof skill.scripts === "string" ? skill.scripts : JSON.stringify(skill.scripts || []);

      // Create version record with diff between old and new
      const newLabels = body.labels ? JSON.stringify(body.labels) : targetSkill.labels;
      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, diff, commit_message, author_id, is_approved, labels)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          crypto.randomUUID(), params.id, newVersion,
          newSpecs, newScripts,
          JSON.stringify({
            specs_diff: { old: oldSpecs, new: newSpecs },
            scripts_diff: { old: oldScripts, new: newScripts },
          }),
          body.commit_message || `Version ${newVersion}`,
          auth.userId,
          newLabels,
        ],
      );

      await db.query(
        `UPDATE skills SET name = COALESCE(?, name), description = COALESCE(?, description),
         labels = COALESCE(?, labels), status = 'draft',
         version = ?, specs = COALESCE(?, specs), scripts = COALESCE(?, scripts),
         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          body.name ?? null, body.description ?? null,
          body.labels ? JSON.stringify(body.labels) : null,
          newVersion,
          body.specs ?? null,
          body.scripts ? JSON.stringify(body.scripts) : null,
          params.id,
        ],
      );
    } else {
      // Draft: in-place update, no version bump
      await db.query(
        `UPDATE skills SET name = COALESCE(?, name), description = COALESCE(?, description),
         labels = COALESCE(?, labels),
         specs = COALESCE(?, specs), scripts = COALESCE(?, scripts),
         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          body.name ?? null, body.description ?? null,
          body.labels ? JSON.stringify(body.labels) : null,
          body.specs ?? null,
          body.scripts ? JSON.stringify(body.scripts) : null,
          params.id,
        ],
      );
    }

    const [rows] = await db.query("SELECT * FROM skills WHERE id = ?", [params.id]) as any;
    const updated = rows[0];
    if (updated) {
      updated.labels = safeParseJson(updated.labels, []);
      updated.scripts = safeParseJson(updated.scripts, []);
    }
    sendJson(res, 200, updated);

    // Draft update: notify dev agents to reload skills
    ctx?.notifySkillDevAgents?.(params.id, ["skills"]);
  });

  // Delete skill
  router.delete(`${P}/skills/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    // Fetch skill to check type
    const [targetRows] = await db.query("SELECT * FROM skills WHERE id = ? AND org_id = ?", [params.id, auth.orgId]) as any;
    if (targetRows.length === 0) { sendJson(res, 404, { error: "Skill not found" }); return; }
    const targetSkill = targetRows[0];

    if (targetSkill.is_builtin) {
      sendJson(res, 403, { error: "Builtin skills cannot be deleted. Use skill import to manage builtin skills." });
      return;
    }

    // Check agent bindings
    const [bindRows] = await db.query(
      `SELECT a.id, a.name FROM agent_skills ask
       JOIN agents a ON a.id = ask.agent_id WHERE ask.skill_id = ?`,
      [params.id],
    ) as any;

    await db.query("DELETE FROM skill_reviews WHERE skill_id = ?", [params.id]);
    await db.query("DELETE FROM skill_versions WHERE skill_id = ?", [params.id]);
    await db.query("DELETE FROM skills WHERE id = ?", [params.id]);

    // Notify affected agents to reload skills
    for (const agent of bindRows) {
      ctx?.notifySkillAgents?.(agent.id, ["skills"]);
    }

    sendJson(res, 200, { ok: true });
  });

  // List skill versions
  router.get(`${P}/skills/:id/versions`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    // Verify skill belongs to org
    const [skill] = await db.query(
      "SELECT id FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (skill.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const [rows] = await db.query(
      "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC",
      [params.id],
    ) as any;
    for (const row of rows as any[]) {
      if (row.scripts !== undefined) row.scripts = safeParseJson(row.scripts, []);
      if (row.labels !== undefined) row.labels = safeParseJson(row.labels, []);
      if (row.diff !== undefined) row.diff = safeParseJson(row.diff, null);
    }
    sendJson(res, 200, { data: rows });
  });

  // Get specific version detail
  router.get(`${P}/skills/:id/versions/:version`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    // Verify skill belongs to org
    const [skill] = await db.query(
      "SELECT id FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (skill.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const [rows] = await db.query(
      "SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?",
      [params.id, Number(params.version)],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Version not found" });
      return;
    }
    const versionRow = rows[0];
    versionRow.scripts = safeParseJson(versionRow.scripts, []);
    versionRow.labels = safeParseJson(versionRow.labels, []);
    versionRow.diff = safeParseJson(versionRow.diff, null);
    sendJson(res, 200, versionRow);
  });

  // ================================================================
  // Skill Reviews & Governance
  // ================================================================

  // Submit skill for review
  router.post(`${P}/skills/:id/submit`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<{ comment?: string }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

    // Verify author or admin
    if (skill.author_id !== auth.userId) {
      if (await guardAccess(res, config, auth, "write")) return;
    }

    if (skill.status !== "draft") {
      sendJson(res, 409, { error: "Only draft skills can be submitted for review" });
      return;
    }

    // Find last approved version for diff baseline
    const [baselineRows] = await db.query(
      "SELECT specs, scripts FROM skill_versions WHERE skill_id = ? AND is_approved = 1 ORDER BY version DESC LIMIT 1",
      [params.id],
    ) as any;
    const baseline = baselineRows.length > 0 ? baselineRows[0] : null;

    // Decode specs — may be double-encoded from earlier bug
    function decodeSpecs(raw: string | null): string | null {
      if (!raw) return null;
      if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch {} }
      return raw;
    }

    const diff = JSON.stringify({
      specs_diff: { old: decodeSpecs(baseline?.specs) || null, new: decodeSpecs(skill.specs) },
      scripts_diff: { old: baseline?.scripts || null, new: skill.scripts },
      ...(body.comment ? { comment: body.comment } : {}),
    });

    // Insert review record — no security assessment yet (computed async)
    const reviewId = crypto.randomUUID();
    await db.query(
      `INSERT INTO skill_reviews (id, skill_id, version, diff, submitted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [reviewId, params.id, skill.version, diff, auth.userId],
    );

    await db.query(
      "UPDATE skills SET status = 'pending_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.id],
    );

    sendJson(res, 200, { review_id: reviewId, status: "pending_review" });

    // Security assessment runs entirely in background — reviewer sees results when they open the review
    const scriptsArr: { name: string; content: string }[] = safeParseJson(skill.scripts, []);

    (async () => {
      try {
        // Phase 1: static
        const staticFindings = evaluateScriptsStatic(scriptsArr);
        const staticAssessment = buildAssessment(staticFindings);

        // Phase 2: AI (may take 10-30s)
        const aiAssessment = await evaluateScriptsAI(scriptsArr, staticFindings);
        const finalAssessment = aiAssessment || staticAssessment;

        await db.query(
          "UPDATE skill_reviews SET security_assessment = ? WHERE id = ?",
          [JSON.stringify(finalAssessment), reviewId],
        );
        console.log(`[skills] Security assessment completed for skill ${params.id} — risk: ${finalAssessment.risk_level}`);
      } catch (err) {
        // Fallback: at least store static assessment
        try {
          const staticFindings = evaluateScriptsStatic(scriptsArr);
          await db.query(
            "UPDATE skill_reviews SET security_assessment = ? WHERE id = ?",
            [JSON.stringify(buildAssessment(staticFindings)), reviewId],
          );
        } catch { /* give up */ }
        console.warn("[skills] Security assessment failed:", err);
      }
    })();
  });

  // Withdraw review
  router.post(`${P}/skills/:id/withdraw`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

    // Verify author or admin
    if (skill.author_id !== auth.userId) {
      if (await guardAccess(res, config, auth, "write")) return;
    }

    if (skill.status !== "pending_review") {
      sendJson(res, 409, { error: "Only skills pending review can be withdrawn" });
      return;
    }

    await db.query(
      "UPDATE skills SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.id],
    );

    // Close pending review records
    await db.query(
      "UPDATE skill_reviews SET decision = 'withdrawn', reviewed_at = CURRENT_TIMESTAMP WHERE skill_id = ? AND decision IS NULL",
      [params.id],
    );

    sendJson(res, 200, { status: "draft" });
  });

  // Approve skill
  router.post(`${P}/skills/:id/approve`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "review")) return;

    const db = getDb();

    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

    if (skill.status !== "pending_review") {
      sendJson(res, 409, { error: "Only skills pending review can be approved" });
      return;
    }

    // Check if a skill_versions record exists for current version
    const [versionRows] = await db.query(
      "SELECT id FROM skill_versions WHERE skill_id = ? AND version = ?",
      [params.id, skill.version],
    ) as any;

    if (versionRows.length === 0) {
      // Create one with current skill content, is_approved=1
      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved, labels)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          crypto.randomUUID(), params.id, skill.version,
          typeof skill.specs === "string" ? skill.specs : JSON.stringify(skill.specs),
          typeof skill.scripts === "string" ? skill.scripts : JSON.stringify(skill.scripts),
          `Approved version ${skill.version}`,
          skill.author_id,
          typeof skill.labels === "string" ? skill.labels : JSON.stringify(skill.labels || []),
        ],
      );
    } else {
      // Mark existing version as approved
      await db.query(
        "UPDATE skill_versions SET is_approved = 1 WHERE skill_id = ? AND version = ?",
        [params.id, skill.version],
      );
    }

    // Update skill status to installed
    await db.query(
      "UPDATE skills SET status = 'installed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.id],
    );

    // Update the review record
    await db.query(
      `UPDATE skill_reviews SET decision = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE skill_id = ? AND decision IS NULL ORDER BY submitted_at DESC LIMIT 1`,
      [auth.userId, params.id],
    );

    sendJson(res, 200, { status: "installed" });

    // Notify agents bound to this skill to reload (fire-and-forget)
    ctx?.notifySkillAgents?.(params.id, ["skills"]);
  });

  // Reject skill
  router.post(`${P}/skills/:id/reject`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "review")) return;

    const body = await parseBody<{ reason?: string }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

    if (skill.status !== "pending_review") {
      sendJson(res, 409, { error: "Only skills pending review can be rejected" });
      return;
    }

    // Reset skill back to draft
    await db.query(
      "UPDATE skills SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.id],
    );

    // Update the review record
    await db.query(
      `UPDATE skill_reviews SET decision = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE skill_id = ? AND decision IS NULL ORDER BY submitted_at DESC LIMIT 1`,
      [body.reason || null, auth.userId, params.id],
    );

    sendJson(res, 200, { status: "draft" });
  });

  // Get current review for a skill
  router.get(`${P}/skills/:id/review`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    // Verify skill belongs to org
    const [skill] = await db.query(
      "SELECT id FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (skill.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const [rows] = await db.query(
      "SELECT * FROM skill_reviews WHERE skill_id = ? ORDER BY submitted_at DESC LIMIT 1",
      [params.id],
    ) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "No review found for this skill" });
      return;
    }

    const review = rows[0];
    review.diff = safeParseJson(review.diff, null);
    review.security_assessment = safeParseJson(review.security_assessment, null);
    sendJson(res, 200, review);
  });

  // List pending reviews (reviewer dashboard)
  router.get(`${P}/reviews/pending`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    const [rows] = await db.query(
      `SELECT sr.*, s.name AS skill_name, s.description AS skill_description, s.author_id AS skill_author_id
       FROM skill_reviews sr
       JOIN skills s ON sr.skill_id = s.id
       WHERE sr.decision IS NULL AND s.org_id = ?
       ORDER BY sr.submitted_at DESC, sr.id DESC`,
      [auth.orgId],
    ) as any;

    for (const row of rows as any[]) {
      row.diff = safeParseJson(row.diff, null);
      row.security_assessment = safeParseJson(row.security_assessment, null);
    }
    sendJson(res, 200, { data: rows });
  });

  // Rollback skill to a previous version
  router.post(`${P}/skills/:id/rollback`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;

    const body = await parseBody<{ version: number }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

    if (skill.status === "pending_review") {
      sendJson(res, 409, { error: "Cannot rollback while pending review. Withdraw first." });
      return;
    }

    // Get target version
    const [targetRows] = await db.query(
      "SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?",
      [params.id, body.version],
    ) as any;
    if (targetRows.length === 0) {
      sendJson(res, 404, { error: "Target version not found" });
      return;
    }

    const target = targetRows[0];
    const newVersion = (skill.version || 0) + 1;

    const currentSpecs = typeof skill.specs === "string" ? skill.specs : JSON.stringify(skill.specs);
    const currentScripts = typeof skill.scripts === "string" ? skill.scripts : JSON.stringify(skill.scripts);
    const targetSpecs = typeof target.specs === "string" ? target.specs : JSON.stringify(target.specs);
    const targetScripts = typeof target.scripts === "string" ? target.scripts : JSON.stringify(target.scripts);

    // Create new version record with target's content and diff vs current
    const targetLabels = target.labels ?? skill.labels;
    await db.query(
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, diff, commit_message, author_id, is_approved, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        crypto.randomUUID(), params.id, newVersion,
        targetSpecs, targetScripts,
        JSON.stringify({
          specs_diff: { old: currentSpecs, new: targetSpecs },
          scripts_diff: { old: currentScripts, new: targetScripts },
        }),
        `Rollback to version ${body.version}`,
        auth.userId,
        typeof targetLabels === "string" ? targetLabels : JSON.stringify(targetLabels || []),
      ],
    );

    // Parse name/description from target specs frontmatter. Use the shared
    // parser — the naive inline regex captures ">-" as the description for
    // skills that use YAML block scalar syntax (every built-in skill does).
    const { name: rollbackName, description: rollbackDesc } = parseFrontmatter(targetSpecs);

    // Update skills table with target content + synced name/description/labels
    const rollbackLabels = targetLabels;
    const setClauses = ["specs = ?", "scripts = ?", "version = ?", "status = 'draft'"];
    const setValues: unknown[] = [targetSpecs, targetScripts, newVersion];
    if (rollbackName) { setClauses.push("name = ?"); setValues.push(rollbackName); }
    if (rollbackDesc) { setClauses.push("description = ?"); setValues.push(rollbackDesc); }
    if (rollbackLabels) { setClauses.push("labels = ?"); setValues.push(typeof rollbackLabels === "string" ? rollbackLabels : JSON.stringify(rollbackLabels)); }
    setClauses.push("updated_at = CURRENT_TIMESTAMP");
    setValues.push(params.id);
    await db.query(`UPDATE skills SET ${setClauses.join(", ")} WHERE id = ?`, setValues);

    const [rows] = await db.query("SELECT * FROM skills WHERE id = ?", [params.id]) as any;
    const row = rows[0];
    if (row) {
      row.labels = safeParseJson(row.labels, []);
      row.scripts = safeParseJson(row.scripts, []);
    }
    sendJson(res, 200, row);
  });

  // ================================================================
  // Skill Import (builtin pack management)
  // ================================================================

  // Upload zip with dry_run or execute
  router.post(`${P}/skills/import`, async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Admin only" }); return; }
    if (!auth.orgId) { sendJson(res, 403, { error: "Organization context required" }); return; }

    // Read raw body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";

    // JSON request: dry_run from builtin directory
    if (contentType.includes("application/json")) {
      const json = JSON.parse(body.toString("utf8"));
      if (json.source === "builtin") {
        const { parseSkillsDir } = await import("../gateway/skills/builtin-sync.js");
        const nodePath = await import("node:path");
        const skills = parseSkillsDir(nodePath.join(process.cwd(), "skills", "core"));
        if (skills.length === 0) { sendJson(res, 400, { error: "No builtin skills found in image" }); return; }
        const { computeImportDiff } = await import("./skill-import.js");
        const diff = await computeImportDiff(auth.orgId, skills);
        sendJson(res, 200, { dry_run: true, ...diff });
        return;
      }
      sendJson(res, 400, { error: "Invalid JSON request" });
      return;
    }

    // Binary zip upload: Content-Type: application/zip or application/octet-stream
    // Query params: ?dry_run=true&comment=...
    const query = parseQuery(req.url ?? "");
    const dryRun = query.dry_run === "true";
    const comment = (query.comment as string) || "";

    const { parseSkillPack, computeImportDiff, executeImport } = await import("./skill-import.js");
    let skills;
    try {
      skills = await parseSkillPack(body);
    } catch (err: any) {
      sendJson(res, 400, { error: `Failed to parse skill pack: ${err.message}` });
      return;
    }
    if (skills.length === 0) { sendJson(res, 400, { error: "No skills found in zip" }); return; }

    if (dryRun) {
      const diff = await computeImportDiff(auth.orgId, skills);
      sendJson(res, 200, { dry_run: true, skill_count: skills.length, ...diff });
      return;
    }

    try {
      const result = await executeImport(auth.orgId, skills, auth.userId, comment,
        (agentId, resources) => ctx?.notifySkillAgents?.(agentId, resources));
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 500, { error: `Import failed: ${err.message}` });
    }
  });

  // Init from bundled skills/core/
  router.post(`${P}/skills/import/init`, async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Admin only" }); return; }
    if (!auth.orgId) { sendJson(res, 403, { error: "Organization context required" }); return; }

    const body = await parseBody<{ comment?: string }>(req);
    const { parseSkillsDir } = await import("../gateway/skills/builtin-sync.js");
    const { executeImport } = await import("./skill-import.js");
    const nodePath = await import("node:path");

    const skillsDir = nodePath.join(process.cwd(), "skills", "core");
    const skills = parseSkillsDir(skillsDir);
    if (skills.length === 0) { sendJson(res, 400, { error: "No builtin skills found in image" }); return; }

    try {
      const result = await executeImport(auth.orgId, skills, auth.userId,
        body.comment || "Initialize from builtin",
        (agentId, resources) => ctx?.notifySkillAgents?.(agentId, resources));
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 500, { error: `Init failed: ${err.message}` });
    }
  });

  // List import versions (history)
  router.get(`${P}/skills/import/history`, async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Admin only" }); return; }
    if (!auth.orgId) { sendJson(res, 403, { error: "Organization context required" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, version, comment, skill_count, added, updated, deleted, imported_by, created_at
       FROM skill_import_history ORDER BY version DESC LIMIT 20`,
    ) as any;
    for (const row of rows as any[]) {
      if (row.added !== undefined) row.added = safeParseJson(row.added, []);
      if (row.updated !== undefined) row.updated = safeParseJson(row.updated, []);
      if (row.deleted !== undefined) row.deleted = safeParseJson(row.deleted, []);
    }
    sendJson(res, 200, { data: rows });
  });

  // Rollback to a previous import version
  router.post(`${P}/skills/import/rollback`, async (req, res) => {
    const auth = requireAdmin(req, config.jwtSecret);
    if (!auth) { sendJson(res, 403, { error: "Admin only" }); return; }
    if (!auth.orgId) { sendJson(res, 403, { error: "Organization context required" }); return; }

    const body = await parseBody<{ version: number; comment?: string }>(req);
    if (!body.version) { sendJson(res, 400, { error: "version required" }); return; }

    const db = getDb();
    const [histRows] = await db.query(
      "SELECT snapshot FROM skill_import_history WHERE version = ?",
      [body.version],
    ) as any;
    if (histRows.length === 0) { sendJson(res, 404, { error: "Import version not found" }); return; }

    const { executeImport } = await import("./skill-import.js");
    const skills = JSON.parse(histRows[0].snapshot);

    try {
      const result = await executeImport(auth.orgId, skills, auth.userId,
        body.comment || `Rollback to v${body.version}`,
        (agentId, resources) => ctx?.notifySkillAgents?.(agentId, resources));
      sendJson(res, 200, result);
    } catch (err: any) {
      sendJson(res, 500, { error: `Rollback failed: ${err.message}` });
    }
  });

  // ================================================================
  // MCP Servers
  // ================================================================

  // List MCP servers
  router.get(`${P}/mcp`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM mcp_servers WHERE org_id = ? ORDER BY created_at DESC, id DESC",
      [auth.orgId],
    ) as any;
    for (const row of rows as any[]) {
      if (row.args !== undefined) row.args = safeParseJson(row.args, null);
      if (row.env !== undefined) row.env = safeParseJson(row.env, null);
      if (row.headers !== undefined) row.headers = safeParseJson(row.headers, null);
    }
    sendJson(res, 200, { data: rows });
  });

  // Create MCP server
  router.post(`${P}/mcp`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();

    const db = getDb();
    await db.query(
      `INSERT INTO mcp_servers (id, org_id, name, transport, url, command, args, env, headers, enabled, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.orgId, body.name, body.transport || "sse",
        body.url || null, body.command || null,
        JSON.stringify(body.args || null), JSON.stringify(body.env || null),
        JSON.stringify(body.headers || null), body.enabled !== false ? 1 : 0,
        body.description || null, auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM mcp_servers WHERE id = ?", [id]) as any;
    const created = rows[0];
    if (created) {
      created.args = safeParseJson(created.args, null);
      created.env = safeParseJson(created.env, null);
      created.headers = safeParseJson(created.headers, null);
    }
    sendJson(res, 201, created);
  });

  // Get MCP server
  router.get(`${P}/mcp/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM mcp_servers WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "MCP server not found" });
      return;
    }
    const row = rows[0];
    row.args = safeParseJson(row.args, null);
    row.env = safeParseJson(row.env, null);
    row.headers = safeParseJson(row.headers, null);
    sendJson(res, 200, row);
  });

  // Update MCP server
  router.put(`${P}/mcp/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM mcp_servers WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "MCP server not found" });
      return;
    }

    await db.query(
      `UPDATE mcp_servers SET
       name = COALESCE(?, name), transport = COALESCE(?, transport),
       url = COALESCE(?, url), command = COALESCE(?, command),
       args = COALESCE(?, args), env = COALESCE(?, env),
       headers = COALESCE(?, headers), description = COALESCE(?, description),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        body.name ?? null, body.transport ?? null,
        body.url ?? null, body.command ?? null,
        body.args ? JSON.stringify(body.args) : null,
        body.env ? JSON.stringify(body.env) : null,
        body.headers ? JSON.stringify(body.headers) : null,
        body.description ?? null,
        params.id,
      ],
    );

    const [rows] = await db.query("SELECT * FROM mcp_servers WHERE id = ?", [params.id]) as any;
    const updated = rows[0];
    if (updated) {
      updated.args = safeParseJson(updated.args, null);
      updated.env = safeParseJson(updated.env, null);
      updated.headers = safeParseJson(updated.headers, null);
    }
    sendJson(res, 200, updated);

    // Notify bound agents to reload MCP config
    ctx?.notifyMcpAgents?.(params.id, ["mcp"]);
  });

  // Delete MCP server
  router.delete(`${P}/mcp/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM mcp_servers WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "MCP server not found" });
      return;
    }

    // Notify BEFORE delete — agent_mcp_servers cascades, so bindings
    // must still be resolvable when the notifier looks them up.
    ctx?.notifyMcpAgents?.(params.id, ["mcp"]);

    await db.query("DELETE FROM mcp_servers WHERE id = ?", [params.id]);
    sendJson(res, 200, { ok: true });
  });

  // Toggle MCP server enabled/disabled
  router.put(`${P}/mcp/:id/toggle`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<{ enabled: boolean }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM mcp_servers WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "MCP server not found" });
      return;
    }

    await db.query(
      "UPDATE mcp_servers SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [body.enabled ? 1 : 0, params.id],
    );

    const [rows] = await db.query("SELECT * FROM mcp_servers WHERE id = ?", [params.id]) as any;
    const toggled = rows[0];
    if (toggled) {
      toggled.args = safeParseJson(toggled.args, null);
      toggled.env = safeParseJson(toggled.env, null);
      toggled.headers = safeParseJson(toggled.headers, null);
    }
    sendJson(res, 200, toggled);

    // Notify bound agents to reload MCP config
    ctx?.notifyMcpAgents?.(params.id, ["mcp"]);
  });

  // ================================================================
  // Chat Sessions & Messages
  // ================================================================

  // List chat sessions for agent+user
  router.get(`${P}/agents/:id/chat/sessions`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const db = getDb();

    // origin='task' and origin='delegation' sessions are execution traces —
    // they live in the same table so FK + audit paths keep working, but the
    // user-facing Chat list should hide them. Their entry points are task-run
    // pages and delegated investigation cards.
    const [[countRows], [listRows]] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS count FROM chat_sessions
         WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL
           AND (origin IS NULL OR origin NOT IN ('task', 'delegation'))`,
        [params.id, auth.userId],
      ),
      db.query(
        `SELECT * FROM chat_sessions
         WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL
           AND (origin IS NULL OR origin NOT IN ('task', 'delegation'))
         ORDER BY last_active_at DESC LIMIT ? OFFSET ?`,
        [params.id, auth.userId, pageSize, offset],
      ),
    ]) as [any, any];

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  // Create chat session
  router.post(`${P}/agents/:id/chat/sessions`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO chat_sessions (id, agent_id, user_id, title, preview, message_count, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        id, params.id, auth.userId,
        body.title || "New Session", body.preview || null, 0,
      ],
    );

    const [rows] = await db.query("SELECT * FROM chat_sessions WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Update chat session (rename)
  router.put(`${P}/agents/:id/chat/sessions/:sid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM chat_sessions WHERE id = ? AND agent_id = ? AND user_id = ? AND deleted_at IS NULL",
      [params.sid, params.id, auth.userId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    if ("title" in body) { fields.push("title = ?"); values.push(body.title); }
    if (fields.length === 0) { sendJson(res, 400, { error: "Nothing to update" }); return; }

    values.push(params.sid);
    await db.query(`UPDATE chat_sessions SET ${fields.join(", ")} WHERE id = ?`, values);

    const [rows] = await db.query("SELECT * FROM chat_sessions WHERE id = ?", [params.sid]) as any;
    sendJson(res, 200, rows[0]);
  });

  // Soft-delete chat session
  router.delete(`${P}/agents/:id/chat/sessions/:sid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM chat_sessions WHERE id = ? AND agent_id = ? AND user_id = ? AND deleted_at IS NULL",
      [params.sid, params.id, auth.userId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    await db.query(
      "UPDATE chat_sessions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
      [params.sid],
    );
    sendJson(res, 200, { ok: true });
  });

  // List chat messages (paginated)
  router.get(`${P}/agents/:id/chat/sessions/:sid/messages`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const db = getDb();

    // Verify session belongs to user
    const [session] = await db.query(
      "SELECT id FROM chat_sessions WHERE id = ? AND agent_id = ? AND user_id = ? AND deleted_at IS NULL",
      [params.sid, params.id, auth.userId],
    ) as any;
    if (session.length === 0) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const [[countRows], [listRows]] = await Promise.all([
      db.query("SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?", [params.sid]),
      db.query(
        // Fetch newest N messages (DESC + LIMIT), then reverse in app to get chronological order.
        // This ensures page=1 returns the most recent messages (for initial load at bottom of chat).
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        [params.sid, pageSize, offset],
      ),
    ]) as [any, any];

    // Reverse to chronological order (oldest first) for the frontend
    (listRows as any[]).reverse();
    // Normalize JSON columns (three data states: legacy MySQL JSON, new MySQL TEXT, SQLite TEXT)
    for (const row of listRows as any[]) {
      if (row.metadata !== undefined) row.metadata = safeParseJson(row.metadata, null);
    }

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  // GET .../chat/sessions/:sid/dp-state
  // Reports whether the session is currently in Deep Investigation mode,
  // derived from the most recent DP marker in the message history:
  //   [Deep Investigation]  → active=true
  //   [DP_EXIT]             → active=false
  //   no marker             → active=false
  // This is the source-of-truth for the frontend to restore DP UI state
  // after page reload or first visit to an existing session.
  router.get(`${P}/agents/:id/chat/sessions/:sid/dp-state`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [session] = await db.query(
      "SELECT id FROM chat_sessions WHERE id = ? AND agent_id = ? AND user_id = ? AND deleted_at IS NULL",
      [params.sid, params.id, auth.userId],
    ) as any;
    if (session.length === 0) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    // Substring match works identically under MySQL + SQLite; avoids any
    // LIKE-wildcard-escape quirks around the literal '[' / ']' characters.
    const [rows] = await db.query(
      `SELECT content FROM chat_messages
       WHERE session_id = ? AND role = 'user'
         AND (substr(content, 1, 20) = '[Deep Investigation]' OR substr(content, 1, 9) = '[DP_EXIT]')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [params.sid],
    ) as any;

    const latest = (rows as any[])[0]?.content as string | undefined;
    const active = typeof latest === "string" && latest.startsWith("[Deep Investigation]");
    sendJson(res, 200, { active });
  });


  // ================================================================
  // Tasks (Agent sub-resource) — scheduled cron jobs
  //
  // Runtime owns scheduling + execution. Clients (Portal / future frontend)
  // hit these over REST; the TaskCoordinator inside Runtime picks up changes
  // on its next DB sync (≤60s) and fires runs via AgentBoxClient directly.
  // ================================================================

  // Schedule validation is shared from cron-limits to guarantee the
  // internal mTLS path uses identical rules. See validateSchedule import.

  // Read-only overview — "My Schedules" across every agent the caller has
  // tasks on. Intentionally no CRUD here: that still lives at the per-agent
  // endpoint so the creation surface stays tied to an explicit agent context.
  router.get(`${P}/my-tasks`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT t.id, t.agent_id, t.name, t.description, t.schedule, t.prompt,
              t.status, t.last_run_at, t.last_result, t.created_at,
              a.name AS agent_name
       FROM agent_tasks t
       LEFT JOIN agents a ON t.agent_id = a.id
       WHERE t.created_by = ?
       ORDER BY t.created_at DESC, t.id DESC`,
      [auth.userId],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // List tasks for an agent — scoped to (agent, user) so each caller only sees
  // their own schedules on a shared agent.
  router.get(`${P}/agents/:agentId/tasks`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status,
              last_run_at, last_result, created_by, created_at
       FROM agent_tasks WHERE agent_id = ? AND created_by = ? ORDER BY created_at DESC, id DESC`,
      [params.agentId, auth.userId],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Get a single task — used by the per-task runs page (L2) to render the
  // task header without paging through the full list.
  router.get(`${P}/agents/:agentId/tasks/:taskId`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, description, schedule, prompt, status,
              last_run_at, last_result, created_by, created_at
       FROM agent_tasks
       WHERE id = ? AND agent_id = ? AND created_by = ?
       LIMIT 1`,
      [params.taskId, params.agentId, auth.userId],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "Task not found" }); return; }
    sendJson(res, 200, rows[0]);
  });

  // Create task
  router.post(`${P}/agents/:agentId/tasks`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    if (!body.name || !body.schedule || !body.prompt) {
      sendJson(res, 400, { error: "name, schedule, and prompt are required" });
      return;
    }
    const invalid = validateSchedule(body.schedule as string);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }

    const id = crypto.randomUUID();
    const db = getDb();
    await db.query(
      `INSERT INTO agent_tasks (id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.agentId, body.name, body.description ?? null,
        body.schedule, body.prompt, body.status ?? "active", auth.userId,
      ],
    );
    const [rows] = await db.query("SELECT * FROM agent_tasks WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Update task
  router.put(`${P}/agents/:agentId/tasks/:taskId`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<Record<string, unknown>>(req);
    if (body.schedule) {
      const invalid = validateSchedule(body.schedule as string);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    }

    const fields = ["name", "description", "schedule", "prompt", "status"];
    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const field of fields) {
      if (field in body) {
        setClauses.push(`${field} = ?`);
        values.push(body[field]);
      }
    }
    if (setClauses.length === 0) {
      sendJson(res, 400, { error: "No fields to update" });
      return;
    }
    setClauses.push("updated_at = CURRENT_TIMESTAMP");
    values.push(params.taskId, params.agentId, auth.userId);

    const db = getDb();
    await db.query(
      `UPDATE agent_tasks SET ${setClauses.join(", ")}
       WHERE id = ? AND agent_id = ? AND created_by = ?`,
      values,
    );
    const [rows] = await db.query(
      "SELECT * FROM agent_tasks WHERE id = ? AND created_by = ?",
      [params.taskId, auth.userId],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "Task not found" }); return; }
    sendJson(res, 200, rows[0]);
  });

  // Delete task
  router.delete(`${P}/agents/:agentId/tasks/:taskId`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [existing] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [params.taskId, params.agentId, auth.userId],
    ) as any;
    if (existing.length === 0) { sendJson(res, 404, { error: "Task not found" }); return; }
    await db.query("DELETE FROM agent_tasks WHERE id = ?", [params.taskId]);
    sendJson(res, 200, { deleted: true });
  });

  // Manually trigger a run for this task now (bypassing the cron schedule
  // but going through the same execution path). Rate-limited by an in-flight
  // check + a configurable cooldown so trivially-fast tasks can't be
  // hammered. Ownership is verified here; the coordinator then does an
  // independent DB check before actually reserving the run row.
  router.post(`${P}/agents/:agentId/tasks/:taskId/runs`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [owner] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [params.taskId, params.agentId, auth.userId],
    ) as any;
    if (owner.length === 0) { sendJson(res, 404, { error: "Task not found" }); return; }

    if (!config.connectionMap.isConnected(params.agentId)) {
      sendJson(res, 503, { error: "Agent runtime is not connected" });
      return;
    }

    // Trigger execution via WS RPC to Runtime's task-coordinator
    const rpcResult = await config.connectionMap.sendCommand(
      params.agentId, "task.fireNow",
      { taskId: params.taskId },
    );

    if (!rpcResult.ok) {
      sendJson(res, 502, { error: rpcResult.error || "Runtime RPC failed" });
      return;
    }

    const outcome = rpcResult.payload as { kind: string; retryAfterSec?: number } | undefined;
    switch (outcome?.kind) {
      case "ok":
        sendJson(res, 202, { ok: true });
        return;
      case "in_flight":
        sendJson(res, 409, { error: "A run is already in flight for this task" });
        return;
      case "cooldown":
        res.setHeader("Retry-After", String(outcome.retryAfterSec));
        sendJson(res, 429, {
          error: `Too soon — wait ${outcome.retryAfterSec}s before triggering another run`,
          retry_after_sec: outcome.retryAfterSec,
        });
        return;
      case "not_found":
        sendJson(res, 404, { error: "Task not found" });
        return;
      default:
        sendJson(res, 500, { error: "Unexpected outcome" });
        return;
    }
  });

  // List runs for a task — only the owner of the task can view its runs.
  // Cursor-paginated: pass ?before=<ISO created_at> to fetch the next page.
  // Cursor (not offset) so new runs arriving mid-scroll don't shift indices.
  router.get(`${P}/agents/:agentId/tasks/:taskId/runs`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [owner] = await db.query(
      "SELECT id FROM agent_tasks WHERE id = ? AND agent_id = ? AND created_by = ?",
      [params.taskId, params.agentId, auth.userId],
    ) as any;
    if (owner.length === 0) { sendJson(res, 404, { error: "Task not found" }); return; }

    const query = parseQuery(req.url ?? "");
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || "30", 10)));
    const before = query.before; // ISO timestamp

    const whereClauses = ["task_id = ?"];
    const sqlParams: unknown[] = [params.taskId];
    if (before) {
      whereClauses.push("created_at < ?");
      sqlParams.push(new Date(before));
    }

    // LIMIT N+1 to detect hasMore without an extra COUNT(*)
    sqlParams.push(limit + 1);
    const [rows] = await db.query(
      `SELECT id, task_id, status, result_text, error, duration_ms, session_id, created_at
       FROM agent_task_runs WHERE ${whereClauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      sqlParams,
    ) as any;

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    sendJson(res, 200, { data, hasMore });
  });

  // Get a single run with its owning task — for the dedicated run-detail page.
  // Verify ownership via (task, agent, user). Messages are NOT included here —
  // the report view loads them lazily via the /messages endpoint below.
  router.get(`${P}/agents/:agentId/tasks/:taskId/runs/:runId`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT r.id, r.task_id, r.status, r.result_text, r.error, r.duration_ms,
              r.session_id, r.created_at,
              t.name AS task_name, t.description AS task_description,
              t.schedule AS task_schedule, t.prompt AS task_prompt,
              t.agent_id AS task_agent_id
       FROM agent_task_runs r
       JOIN agent_tasks t ON r.task_id = t.id
       WHERE r.id = ? AND r.task_id = ? AND t.agent_id = ? AND t.created_by = ?
       LIMIT 1`,
      [params.runId, params.taskId, params.agentId, auth.userId],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "Run not found" }); return; }
    const r = rows[0];

    // Neighbor lookup for L3's prev/next nav. "Older" = earlier created_at
    // within the same task; "newer" = later. Two tiny indexed queries —
    // cheap enough to co-locate here so the page doesn't fan out.
    const [[olderRows], [newerRows]] = await Promise.all([
      db.query(
        `SELECT id FROM agent_task_runs
         WHERE task_id = ? AND created_at < ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [params.taskId, r.created_at],
      ),
      db.query(
        `SELECT id FROM agent_task_runs
         WHERE task_id = ? AND created_at > ?
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [params.taskId, r.created_at],
      ),
    ]) as [any, any];

    sendJson(res, 200, {
      run: {
        id: r.id,
        task_id: r.task_id,
        status: r.status,
        result_text: r.result_text,
        error: r.error,
        duration_ms: r.duration_ms,
        session_id: r.session_id,
        created_at: r.created_at,
      },
      task: {
        id: r.task_id,
        agent_id: r.task_agent_id,
        name: r.task_name,
        description: r.task_description,
        schedule: r.task_schedule,
        prompt: r.task_prompt,
      },
      neighbors: {
        older_run_id: olderRows[0]?.id ?? null,
        newer_run_id: newerRows[0]?.id ?? null,
      },
    });
  });

  // Get full trace for a run — verify through (task, agent, user).
  router.get(`${P}/agents/:agentId/tasks/:taskId/runs/:runId/messages`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT r.session_id
       FROM agent_task_runs r
       JOIN agent_tasks t ON r.task_id = t.id
       WHERE r.id = ? AND r.task_id = ? AND t.agent_id = ? AND t.created_by = ?
       LIMIT 1`,
      [params.runId, params.taskId, params.agentId, auth.userId],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "Run not found" }); return; }

    const sessionId = rows[0].session_id as string | null;
    if (!sessionId) {
      sendJson(res, 200, { sessionId: null, truncated: false, messages: [] });
      return;
    }
    // Query DB directly (Portal owns chat_messages — no HTTP hop needed).
    // Fetch newest N+1 rows DESC, then reverse to chronological order.
    const [msgRows] = await db.query(
      `SELECT id, role, content, tool_name, tool_input, outcome, duration_ms, created_at
       FROM chat_messages WHERE session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [sessionId, MAX_TRACE_MESSAGES + 1],
    ) as any;
    const allMsgs = msgRows as any[];
    const truncated = allMsgs.length > MAX_TRACE_MESSAGES;
    const msgs = truncated ? allMsgs.slice(0, MAX_TRACE_MESSAGES) : allMsgs;
    msgs.reverse();
    sendJson(res, 200, {
      sessionId,
      truncated,
      messages: msgs.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? "",
        toolName: m.tool_name ?? null,
        toolInput: m.tool_input ?? null,
        outcome: m.outcome ?? null,
        durationMs: m.duration_ms ?? null,
        timestamp: m.created_at ? new Date(m.created_at).toISOString() : null,
      })),
    });
  });


  // ================================================================
  // Channel Bindings + Pairing (Agent sub-resource)
  // ================================================================

  // List channel bindings for an agent
  // Admin sees all bindings; regular user sees only their own
  router.get(`${P}/agents/:id/channel-bindings`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const isAdmin = auth.role === "admin";

    const sql = isAdmin
      ? `SELECT cb.*, c.name as channel_name, c.type as channel_type
         FROM channel_bindings cb
         LEFT JOIN channels c ON cb.channel_id = c.id
         WHERE cb.agent_id = ? ORDER BY cb.created_at DESC, cb.id DESC`
      : `SELECT cb.*, c.name as channel_name, c.type as channel_type
         FROM channel_bindings cb
         LEFT JOIN channels c ON cb.channel_id = c.id
         WHERE cb.agent_id = ? AND cb.created_by = ? ORDER BY cb.created_at DESC, cb.id DESC`;

    const params2 = isAdmin ? [params.id] : [params.id, auth.userId];
    const [rows] = await db.query(sql, params2) as any;
    sendJson(res, 200, { data: rows });
  });

  // Generate pairing code — any authenticated user can pair
  // (but only for channels that admin has bound to this agent)
  router.post(`${P}/agents/:id/channel-bindings/pair`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<{ channel_id?: string }>(req);
    if (!body.channel_id) {
      sendJson(res, 400, { error: "channel_id is required" });
      return;
    }

    const db = getDb();

    // Verify channel is authorized for this agent (admin must have bound it)
    const [bound] = await db.query(
      "SELECT 1 FROM agent_channel_auth WHERE agent_id = ? AND channel_id = ?",
      [params.id, body.channel_id],
    ) as any;
    if (bound.length === 0) {
      sendJson(res, 403, { error: "This channel is not authorized for this agent. Ask an admin to bind it." });
      return;
    }

    // Clean expired codes
    await db.query("DELETE FROM channel_pairing_codes WHERE expires_at < ?", [toSqlTimestamp(new Date())]);

    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    const expiresAtDate = new Date(Date.now() + 5 * 60 * 1000);

    await db.query(
      "INSERT INTO channel_pairing_codes (code, channel_id, agent_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
      [code, body.channel_id, params.id, auth.userId, toSqlTimestamp(expiresAtDate)],
    );

    sendJson(res, 200, { code, expires_at: expiresAtDate.toISOString() });
  });

  // Delete a channel binding — admin can delete any, user can delete own
  router.delete(`${P}/agents/:id/channel-bindings/:bindingId`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const isAdmin = auth.role === "admin";

    const sql = isAdmin
      ? "SELECT id FROM channel_bindings WHERE id = ? AND agent_id = ?"
      : "SELECT id FROM channel_bindings WHERE id = ? AND agent_id = ? AND created_by = ?";
    const params2 = isAdmin ? [params.bindingId, params.id] : [params.bindingId, params.id, auth.userId];

    const [existing] = await db.query(sql, params2) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Binding not found" });
      return;
    }

    await db.query("DELETE FROM channel_bindings WHERE id = ?", [params.bindingId]);
    sendJson(res, 200, { ok: true });
  });

  // ================================================================
  // Diagnostics (Agent sub-resource)
  // ================================================================

  // List diagnostics
  router.get(`${P}/agents/:id/diagnostics`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM agent_diagnostics WHERE agent_id = ? ORDER BY sort_order ASC, created_at DESC, id DESC",
      [params.id],
    ) as any;
    for (const row of rows as any[]) {
      if (row.params !== undefined) row.params = safeParseJson(row.params, null);
    }
    sendJson(res, 200, { data: rows });
  });

  // Create diagnostic
  router.post(`${P}/agents/:id/diagnostics`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO agent_diagnostics (id, agent_id, name, description, prompt_template, params, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.id, body.name, body.description || null,
        body.prompt_template, JSON.stringify(body.params || {}),
        body.sort_order ?? 0, auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_diagnostics WHERE id = ?", [id]) as any;
    const created = rows[0];
    if (created) created.params = safeParseJson(created.params, null);
    sendJson(res, 201, created);
  });

  // Update diagnostic
  router.put(`${P}/agents/:id/diagnostics/:did`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_diagnostics WHERE id = ? AND agent_id = ?",
      [params.did, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Diagnostic not found" });
      return;
    }

    await db.query(
      `UPDATE agent_diagnostics SET
       name = COALESCE(?, name), description = COALESCE(?, description),
       prompt_template = COALESCE(?, prompt_template),
       params = COALESCE(?, params), sort_order = COALESCE(?, sort_order),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        body.name ?? null, body.description ?? null,
        body.prompt_template ?? null,
        body.params ? JSON.stringify(body.params) : null,
        body.sort_order ?? null, params.did,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_diagnostics WHERE id = ?", [params.did]) as any;
    const updated = rows[0];
    if (updated) updated.params = safeParseJson(updated.params, null);
    sendJson(res, 200, updated);
  });

  // Delete diagnostic
  router.delete(`${P}/agents/:id/diagnostics/:did`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_diagnostics WHERE id = ? AND agent_id = ?",
      [params.did, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Diagnostic not found" });
      return;
    }

    await db.query("DELETE FROM agent_diagnostics WHERE id = ?", [params.did]);
    sendJson(res, 200, { ok: true });
  });

  // API Keys — moved to Portal (agent-api.ts). Portal owns the table and
  // handles CRUD + validation for /api/v1/run. Runtime does not touch api keys.

  // ================================================================
  // Admin Models (Providers & Entries)
  // ================================================================

  // List model providers
  router.get(`${P}/admin/models/providers`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [providerRows] = await db.query(
      `SELECT * FROM model_providers WHERE org_id = ? OR org_id IS NULL ORDER BY sort_order ASC, created_at ASC`,
      [auth.orgId],
    ) as any;

    // For each provider, fetch its model entries
    const providers = [];
    for (const row of providerRows) {
      const [modelRows] = await db.query(
        "SELECT * FROM model_entries WHERE provider_id = ? ORDER BY sort_order ASC, created_at ASC",
        [row.id],
      ) as any;
      providers.push({ ...row, models: modelRows });
    }

    sendJson(res, 200, { data: providers });
  });

  // Create model provider
  router.post(`${P}/admin/models/providers`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const db = getDb();

    const trim = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);
    await db.query(
      `INSERT INTO model_providers (id, org_id, name, base_url, api_key, api_type, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.orgId, trim(body.name), trim(body.base_url),
        trim(body.api_key) || null, trim(body.api_type) || "openai",
        body.sort_order ?? 0,
      ],
    );

    const [rows] = await db.query("SELECT * FROM model_providers WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Update model provider
  router.put(`${P}/admin/models/providers/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM model_providers WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Provider not found" });
      return;
    }

    const trim = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);
    await db.query(
      `UPDATE model_providers SET
       name = COALESCE(?, name), base_url = COALESCE(?, base_url),
       api_key = COALESCE(?, api_key), api_type = COALESCE(?, api_type),
       sort_order = COALESCE(?, sort_order),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        trim(body.name), trim(body.base_url),
        trim(body.api_key), trim(body.api_type),
        body.sort_order ?? null, params.id,
      ],
    );

    const [rows] = await db.query("SELECT * FROM model_providers WHERE id = ?", [params.id]) as any;
    sendJson(res, 200, rows[0]);
  });

  // Delete model provider (cascade model_entries)
  router.delete(`${P}/admin/models/providers/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM model_providers WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Provider not found" });
      return;
    }

    await db.query("DELETE FROM model_entries WHERE provider_id = ?", [params.id]);
    await db.query("DELETE FROM model_providers WHERE id = ?", [params.id]);
    sendJson(res, 200, { ok: true });
  });

  // Add model entry to provider
  router.post(`${P}/admin/models/providers/:id/models`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Verify provider exists and belongs to org
    const [provider] = await db.query(
      "SELECT id FROM model_providers WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
      [params.id, auth.orgId],
    ) as any;
    if (provider.length === 0) {
      sendJson(res, 404, { error: "Provider not found" });
      return;
    }

    const id = crypto.randomUUID();

    const trim = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);
    const modelId = trim(body.model_id);
    await db.query(
      `INSERT INTO model_entries (id, provider_id, model_id, name, reasoning, context_window, max_tokens, is_default, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.id, modelId, trim(body.name) || modelId,
        body.reasoning ? 1 : 0, body.context_window ?? null,
        body.max_tokens ?? null, body.is_default ? 1 : 0,
        body.sort_order ?? 0,
      ],
    );

    const [rows] = await db.query("SELECT * FROM model_entries WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Update model entry
  router.put(`${P}/admin/models/providers/:pid/models/:mid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT me.id FROM model_entries me JOIN model_providers mp ON me.provider_id = mp.id WHERE me.id = ? AND me.provider_id = ? AND (mp.org_id = ? OR mp.org_id IS NULL)",
      [params.mid, params.pid, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Model entry not found" });
      return;
    }

    const body = await parseBody<Record<string, unknown>>(req);
    const fields = ["model_id", "name", "reasoning", "context_window", "max_tokens", "is_default", "sort_order"];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const f of fields) {
      if (f in body) { sets.push(`${f} = ?`); values.push(body[f]); }
    }
    if (sets.length === 0) { sendJson(res, 400, { error: "Nothing to update" }); return; }

    values.push(params.mid);
    await db.query(`UPDATE model_entries SET ${sets.join(", ")} WHERE id = ?`, values);

    const [rows] = await db.query("SELECT * FROM model_entries WHERE id = ?", [params.mid]) as any;
    sendJson(res, 200, rows[0]);
  });

  // Delete model entry
  router.delete(`${P}/admin/models/providers/:pid/models/:mid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT me.id FROM model_entries me JOIN model_providers mp ON me.provider_id = mp.id WHERE me.id = ? AND me.provider_id = ? AND (mp.org_id = ? OR mp.org_id IS NULL)",
      [params.mid, params.pid, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Model entry not found" });
      return;
    }

    await db.query("DELETE FROM model_entries WHERE id = ?", [params.mid]);
    sendJson(res, 200, { ok: true });
  });

  // ================================================================
  // Dashboard
  // ================================================================

  // Summary counts
  router.get(`${P}/admin/dashboard/summary`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const orgId = auth.orgId;

    const dayAgo = toSqlTimestamp(Date.now() - 24 * 3600e3);
    const [[skillRows], [mcpRows], [activeRows], [msgRows], [taskRows]] = await Promise.all([
      db.query("SELECT COUNT(*) AS count FROM skills WHERE org_id = ?", [orgId]),
      db.query("SELECT COUNT(*) AS count FROM mcp_servers WHERE org_id = ?", [orgId]),
      db.query(
        "SELECT COUNT(*) AS count FROM chat_sessions WHERE last_active_at > ? AND deleted_at IS NULL",
        [dayAgo],
      ),
      db.query("SELECT COUNT(*) AS count FROM chat_messages"),
      db.query("SELECT COUNT(*) AS count FROM agent_tasks"),
    ]) as any;

    sendJson(res, 200, {
      total_skills: Number(skillRows[0].count),
      total_mcp: Number(mcpRows[0].count),
      active_sessions: Number(activeRows[0].count),
      total_messages: Number(msgRows[0].count),
      total_tasks: Number(taskRows[0].count),
    });
  });

  // Usage per day
  router.get(`${P}/admin/dashboard/usage`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const days = Math.min(90, Math.max(1, parseInt(query.days || "7", 10)));
    const db = getDb();

    // Use application-side date cutoff (date-only string) — DATE() function
    // is supported by both MySQL and SQLite
    const cutoffDate = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    const [msgRows] = await db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) AS message_count,
              SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_call_count
       FROM chat_messages
       WHERE created_at >= ?
       GROUP BY DATE(created_at)`,
      [cutoffDate],
    ) as any;

    const [sessRows] = await db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) AS session_count
       FROM chat_sessions
       WHERE created_at >= ?
         AND deleted_at IS NULL
       GROUP BY DATE(created_at)`,
      [cutoffDate],
    ) as any;

    // Build date series in application code
    const msgMap = new Map<string, { message_count: number; tool_call_count: number }>();
    for (const row of msgRows) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      msgMap.set(key, {
        message_count: Number(row.message_count),
        tool_call_count: Number(row.tool_call_count),
      });
    }

    const sessMap = new Map<string, number>();
    for (const row of sessRows) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      sessMap.set(key, Number(row.session_count));
    }

    const data: { date: string; message_count: number; tool_call_count: number; session_count: number }[] = [];
    const today = new Date();
    for (let i = days; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const msg = msgMap.get(key) ?? { message_count: 0, tool_call_count: 0 };
      data.push({
        date: key,
        message_count: msg.message_count,
        tool_call_count: msg.tool_call_count,
        session_count: sessMap.get(key) ?? 0,
      });
    }

    sendJson(res, 200, { data });
  });

  // ================================================================
  // Metrics — summary + audit (admin-only, Portal owns the data)
  // ================================================================

  const PERIODS: Record<string, number> = {
    today: 86_400_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
  };

  // GET /api/v1/siclaw/metrics/summary
  router.get("/api/v1/siclaw/metrics/summary", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const period = query.period || "7d";
    const rangeMs = PERIODS[period];
    if (!rangeMs) { sendJson(res, 400, { error: "Invalid period" }); return; }
    const cutoff = new Date(Date.now() - rangeMs);
    const userFilter = query.userId || null;

    const db = getDb();

    const sessionParams: unknown[] = [cutoff];
    let totalSessionsSql = "SELECT COUNT(*) AS c FROM chat_sessions WHERE created_at >= ? AND (origin IS NULL OR origin NOT IN ('task', 'delegation'))";
    if (userFilter) { totalSessionsSql += " AND user_id = ?"; sessionParams.push(userFilter); }
    const [sRows] = await db.query(totalSessionsSql, sessionParams) as [Array<{ c: number }>, unknown];
    const totalSessions = Number(sRows[0]?.c ?? 0);

    const pParams: unknown[] = [cutoff];
    let totalPromptsSql = `SELECT COUNT(*) AS c FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'user' AND m.created_at >= ?
        AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
        AND (m.metadata IS NULL OR m.metadata NOT LIKE '%"kind":"delegation_event"%')`;
    if (userFilter) { totalPromptsSql += " AND s.user_id = ?"; pParams.push(userFilter); }
    const [pRows] = await db.query(totalPromptsSql, pParams) as [Array<{ c: number }>, unknown];
    const totalPrompts = Number(pRows[0]?.c ?? 0);

    let byUser: Array<{ userId: string; sessions: number; messages: number }> = [];
    if (!userFilter) {
      const [uRows] = await db.query(
        `SELECT s.user_id AS userId, COUNT(DISTINCT s.id) AS sessions, SUM(s.message_count) AS messages
         FROM chat_sessions s WHERE s.created_at >= ?
           AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))
         GROUP BY s.user_id ORDER BY sessions DESC LIMIT 50`,
        [cutoff],
      ) as any;
      byUser = uRows.map((r: any) => ({ userId: r.userId, sessions: Number(r.sessions), messages: Number(r.messages ?? 0) }));
    }

    sendJson(res, 200, { totalSessions, totalPrompts, byUser });
  });

  // GET /api/v1/siclaw/metrics/timing
  // Aggregates per-message timing telemetry stamped by sse-consumer:
  //   ⏳ ttft     — chat_messages.metadata.timing.ttft_ms (assistant rows)
  //   💭 thinking — chat_messages.metadata.timing.thinking_ms (assistant)
  //   ⚙️ tools   — chat_messages.duration_ms grouped by tool_name (top-N
  //                 by invocation count, sorted DESC). Returned as an array
  //                 so the dashboard can show top 3 / 5 / 10 client-side.
  //
  // Aggregation is done in JS rather than via JSON_EXTRACT/GROUP BY so the
  // same code path works under MySQL and SQLite without the dialect-helpers
  // dance — we only read the columns we need (`metadata` / `tool_name` /
  // `duration_ms`) and bucket in memory.
  router.get("/api/v1/siclaw/metrics/timing", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const period = query.period || "7d";
    const rangeMs = PERIODS[period];
    if (!rangeMs) { sendJson(res, 400, { error: "Invalid period" }); return; }
    const cutoff = new Date(Date.now() - rangeMs);
    const userFilter = query.userId || null;

    const db = getDb();

    // Hard cap on rows scanned per query. Each chat_messages.metadata can be
    // multi-KB JSON (timing + tool details + delegation state); a busy tenant
    // over a 30-day window can produce hundreds of thousands of rows, and
    // pulling them all would risk OOM-ing the Portal process. ORDER BY DESC +
    // LIMIT keeps the most-recent slice when the window is too dense; the
    // response carries `truncated: true` so the dashboard can show a hint
    // ("sampled view") rather than the call silently lying.
    //
    // TODO(metrics): replace this with a nightly batch job that materialises
    // a `metrics_timing_daily` table (avg/p90 pre-aggregated per day). The
    // endpoint then SELECTs <30 rows and the limit becomes irrelevant.
    const ROW_LIMIT = 50_000;

    // Build the two SELECTs and fire them in parallel — they're independent
    // and read-only, so awaiting sequentially would just double the response
    // time without buying anything. On SQLite a long-running JSON-pulling
    // query can also block other read paths in the same process; Promise.all
    // returns control to the event loop sooner so /metrics/live and
    // /metrics/summary stay responsive while this one is in flight.

    // Assistant rows: pull metadata JSON, parse client-side, harvest ttft/thinking.
    const aParams: unknown[] = [cutoff];
    let assistantSql = `SELECT m.metadata
      FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'assistant' AND m.created_at >= ? AND m.metadata IS NOT NULL
        AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))`;
    if (userFilter) { assistantSql += " AND s.user_id = ?"; aParams.push(userFilter); }
    assistantSql += " ORDER BY m.created_at DESC LIMIT ?";
    aParams.push(ROW_LIMIT + 1);

    // Tool rows: bucket duration_ms by tool_name. We pull all tools (not
    // just bash) so the dashboard can rank by invocation count — the actual
    // top-N filtering happens client-side so the user can flip 3↔5↔10
    // without re-querying.
    const tParams: unknown[] = [cutoff];
    let toolSql = `SELECT m.tool_name AS toolName, m.duration_ms AS durationMs
      FROM chat_messages m
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE m.role = 'tool' AND m.tool_name IS NOT NULL AND m.duration_ms IS NOT NULL
        AND m.created_at >= ?
        AND (s.origin IS NULL OR s.origin NOT IN ('task', 'delegation'))`;
    if (userFilter) { toolSql += " AND s.user_id = ?"; tParams.push(userFilter); }
    toolSql += " ORDER BY m.created_at DESC LIMIT ?";
    tParams.push(ROW_LIMIT + 1);

    const [aResult, tResult] = await Promise.all([
      db.query(assistantSql, aParams) as Promise<[Array<{ metadata: unknown }>, unknown]>,
      db.query(toolSql, tParams) as Promise<[Array<{ toolName: string; durationMs: number | null }>, unknown]>,
    ]);
    const [aRows] = aResult;
    const [tRows] = tResult;
    const assistantTruncated = aRows.length > ROW_LIMIT;
    const aSlice = assistantTruncated ? aRows.slice(0, ROW_LIMIT) : aRows;

    const ttftValues: number[] = [];
    const thinkingValues: number[] = [];
    for (const r of aSlice) {
      const meta = safeParseJson<Record<string, unknown> | null>(r.metadata, null);
      const timing = meta?.timing as Record<string, unknown> | undefined;
      if (!timing) continue;
      // Filter ≥0: historical rows from before the source-side clamp may
      // carry negatives produced by cross-process clock drift; this matches
      // the tool-branch filter below.
      if (typeof timing.ttft_ms === "number" && timing.ttft_ms >= 0) ttftValues.push(timing.ttft_ms);
      if (typeof timing.thinking_ms === "number" && timing.thinking_ms >= 0) thinkingValues.push(timing.thinking_ms);
    }

    const toolsTruncated = tRows.length > ROW_LIMIT;
    const tSlice = toolsTruncated ? tRows.slice(0, ROW_LIMIT) : tRows;

    // Bucket per tool_name; same negative-value filter as before.
    const toolBuckets = new Map<string, number[]>();
    for (const r of tSlice) {
      const dur = Number(r.durationMs);
      if (!Number.isFinite(dur) || dur < 0) continue;
      const bucket = toolBuckets.get(r.toolName);
      if (bucket) bucket.push(dur);
      else toolBuckets.set(r.toolName, [dur]);
    }
    const tools = Array.from(toolBuckets.entries())
      .map(([toolName, values]) => ({ toolName, ...summariseLatency(values) }))
      // Rank by invocation count DESC — matches the "Top Tools" widget below
      // so the same tool-of-the-day shows up consistently across cards.
      .sort((a, b) => b.count - a.count);

    sendJson(res, 200, {
      ttft: summariseLatency(ttftValues),
      thinking: summariseLatency(thinkingValues),
      tools,
      // Tells callers the window was too dense to scan in full and the
      // figures above reflect a recency-biased sample. Frontend can show a
      // "sampled view" badge rather than failing the request.
      truncated: assistantTruncated || toolsTruncated,
    });
  });

  // GET /api/v1/siclaw/metrics/audit
  router.get("/api/v1/siclaw/metrics/audit", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "50", 10)));
    const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 86_400_000);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();

    const conds: string[] = ["m.role = 'tool'", "m.created_at BETWEEN ? AND ?"];
    const params: unknown[] = [startDate, endDate];
    if (query.userId) { conds.push("s.user_id = ?"); params.push(query.userId); }
    if (query.toolName) { conds.push("m.tool_name = ?"); params.push(query.toolName); }
    if (query.outcome) { conds.push("m.outcome = ?"); params.push(query.outcome); }
    if (query.cursorTs && query.cursorId) {
      const cursorDate = new Date(parseInt(query.cursorTs, 10));
      conds.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
      params.push(cursorDate, cursorDate, query.cursorId);
    }
    params.push(limit + 1);

    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName,
              SUBSTR(m.tool_input, 1, 500) AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE ${conds.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      params,
    ) as any;

    const hasMore = rows.length > limit;
    const logs = rows.slice(0, limit).map((r: any) => ({
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, outcome: r.outcome,
      durationMs: r.durationMs,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));

    sendJson(res, 200, { logs, hasMore });
  });

  // GET /api/v1/siclaw/metrics/audit/:id
  router.get("/api/v1/siclaw/metrics/audit/:id", async (req, res, params) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT m.id, m.session_id AS sessionId, m.tool_name AS toolName, m.tool_input AS toolInput,
              m.outcome, m.duration_ms AS durationMs, m.content, m.created_at AS timestamp,
              s.user_id AS userId, s.agent_id AS agentId
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON m.session_id = s.id
       WHERE m.id = ? AND m.role = 'tool'`,
      [params.id],
    ) as any;
    if (!rows.length) { sendJson(res, 404, { error: "Not found" }); return; }
    const r = rows[0];
    sendJson(res, 200, {
      id: r.id, sessionId: r.sessionId, userId: r.userId, agentId: r.agentId,
      toolName: r.toolName, toolInput: r.toolInput, content: r.content,
      outcome: r.outcome, durationMs: r.durationMs,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    });
  });

  // ================================================================
  // Metrics live — proxied to Runtime (in-memory MetricsAggregator)
  // ================================================================

  // GET /api/v1/siclaw/metrics/live — via phone-home WS RPC to Runtime
  router.get("/api/v1/siclaw/metrics/live", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const query = parseQuery(req.url ?? "");
    const agentIds = config.connectionMap.connectedAgentIds();
    if (agentIds.length === 0) {
      sendJson(res, 502, { error: "Runtime not connected" });
      return;
    }
    // Use first connected agent (Runtime registers as "system" or any agentId)
    const result = await config.connectionMap.sendCommand(agentIds[0], "metrics.live", { userId: query.userId });
    if (!result.ok) {
      sendJson(res, 502, { error: result.error ?? "Runtime metrics unavailable" });
      return;
    }
    sendJson(res, 200, result.payload);
  });

  // ================================================================
  // System config — admin-managed key-value store
  // ================================================================

  const ALLOWED_CONFIG_KEYS = new Set<string>(["system.grafanaUrl"]);

  /** Reject dangerous URL schemes. Only http/https allowed. */
  function validateHttpUrl(value: string): { ok: true } | { ok: false; error: string } {
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, error: `Invalid URL scheme: ${u.protocol} (only http/https allowed)` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
  }

  // GET /api/v1/siclaw/system/config
  router.get("/api/v1/siclaw/system/config", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT config_key, config_value FROM system_config",
    ) as any;
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.config_value != null) result[row.config_key] = row.config_value;
    }
    sendJson(res, 200, { config: result });
  });

  // PUT /api/v1/siclaw/system/config
  router.put("/api/v1/siclaw/system/config", async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }

    const body = await parseBody<{ values?: Record<string, string> }>(req);
    const values = body?.values ?? {};

    const rejected: string[] = [];
    for (const key of Object.keys(values)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) rejected.push(key);
    }
    if (rejected.length > 0) {
      sendJson(res, 400, { error: `Unknown config keys: ${rejected.join(", ")}` });
      return;
    }

    for (const [key, value] of Object.entries(values)) {
      if (key === "system.grafanaUrl") {
        const check = validateHttpUrl(String(value));
        if (!check.ok) { sendJson(res, 400, { error: `${key}: ${check.error}` }); return; }
      }
    }

    const db = getDb();
    for (const [key, value] of Object.entries(values)) {
      const upsert = buildUpsert(
        db,
        "system_config",
        ["config_key", "config_value", "updated_by"],
        [key, String(value), admin.userId],
        ["config_key"],
        ["config_value", "updated_by", { col: "updated_at", expr: "CURRENT_TIMESTAMP" }],
      );
      await db.query(upsert.sql, upsert.params);
    }
    sendJson(res, 200, { ok: true });
  });

  // ================================================================
  // Knowledge Version Management (admin, DB-backed)
  // ================================================================

  // List repos
  router.get(`${P}/admin/knowledge/repos`, async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const db = getDb();
    const [rows] = await db.query(
      `SELECT r.*, (SELECT COUNT(*) FROM knowledge_versions v WHERE v.repo_id = r.id) AS version_count,
       (SELECT v2.version FROM knowledge_versions v2 WHERE v2.repo_id = r.id AND v2.is_active = 1 LIMIT 1) AS active_version
       FROM knowledge_repos r ORDER BY r.created_at DESC, r.id DESC`,
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Create repo
  router.post(`${P}/admin/knowledge/repos`, async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const body = await parseBody<{ name?: string; description?: string }>(req);
    if (!body.name?.trim()) { sendJson(res, 400, { error: "name is required" }); return; }
    const id = crypto.randomUUID();
    const db = getDb();
    await db.query(
      "INSERT INTO knowledge_repos (id, name, description, created_by) VALUES (?, ?, ?, ?)",
      [id, body.name.trim(), body.description?.trim() || null, admin.userId],
    );
    const [rows] = await db.query("SELECT * FROM knowledge_repos WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Delete repo
  router.delete(`${P}/admin/knowledge/repos/:id`, async (req, res, params) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const db = getDb();
    // Query bound agents BEFORE delete (FK cascade will remove bindings)
    const [boundAgents] = await db.query(
      "SELECT agent_id FROM agent_knowledge_repos WHERE repo_id = ?", [params.id],
    ) as any;
    await db.query("DELETE FROM knowledge_repos WHERE id = ?", [params.id]);
    sendJson(res, 200, { deleted: true });
    // Notify bound agents to reload so they drop the deleted repo's knowledge
    for (const r of boundAgents as any[]) {
      config.connectionMap.notify(r.agent_id, "agent.reload", { agentId: r.agent_id, resources: ["knowledge"] });
    }
  });

  // List versions for a repo (metadata only, no data blob)
  router.get(`${P}/admin/knowledge/repos/:id/versions`, async (req, res, params) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, repo_id, version, message, size_bytes, sha256, file_count,
              is_active, status, activated_by, activated_at, error_message, uploaded_by, created_at
       FROM knowledge_versions WHERE repo_id = ? ORDER BY version DESC`,
      [params.id],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Upload new version (base64 tar.gz in JSON body)
  router.post(`${P}/admin/knowledge/repos/:id/versions`, async (req, res, params) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const body = await parseBody<{ message?: string; data?: string }>(req);
    if (!body.data) { sendJson(res, 400, { error: "data (base64 tar.gz) is required" }); return; }

    const buf = Buffer.from(body.data, "base64");
    const packageInfo = validateKnowledgePackage(buf);
    const db = getDb();

    const versionId = crypto.randomUUID();
    const publishEventId = crypto.randomUUID();
    let nextVersion: number;

    // Transaction: version number + deactivate + insert + evict + event
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Serialize concurrent uploads via transaction isolation.
      //   SQLite: BEGIN IMMEDIATE gives serializable — plain SELECT is sufficient.
      //   MySQL:  REPEATABLE READ's consistent snapshot means plain SELECT does
      //           NOT lock rows, so two concurrent uploads would compute the same
      //           next version and one INSERT would fail on UNIQUE(repo_id, version).
      //           We must explicitly take a row lock with FOR UPDATE.
      const forUpdate = db.driver === "mysql" ? " FOR UPDATE" : "";
      const [maxRows] = await conn.query(
        `SELECT COALESCE(MAX(version), 0) AS max_v FROM knowledge_versions WHERE repo_id = ?${forUpdate}`,
        [params.id],
      ) as any;
      nextVersion = Number(maxRows[0].max_v) + 1;

      await conn.query("UPDATE knowledge_versions SET is_active = 0, status = 'inactive' WHERE repo_id = ? AND is_active = 1", [params.id]);
      await conn.query(
        `INSERT INTO knowledge_versions (id, repo_id, version, message, data, size_bytes, sha256, file_count, is_active, status, activated_by, activated_at, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, CURRENT_TIMESTAMP, ?)`,
        [versionId, params.id, nextVersion, body.message?.trim() || null, buf, buf.length,
         packageInfo.sha256, packageInfo.fileCount, admin.userId, admin.userId],
      );

      // Evict oldest non-active versions beyond max_versions
      const [repoRows] = await conn.query("SELECT max_versions FROM knowledge_repos WHERE id = ?", [params.id]) as any;
      const maxVersions = repoRows[0]?.max_versions ?? 10;
      const [allVersions] = await conn.query(
        "SELECT id, is_active FROM knowledge_versions WHERE repo_id = ? ORDER BY version DESC",
        [params.id],
      ) as any;
      const toDelete = (allVersions as any[]).filter((v: any) => !v.is_active).slice(maxVersions - 1);
      for (const v of toDelete) {
        await conn.query("DELETE FROM knowledge_versions WHERE id = ?", [v.id]);
      }

      await conn.query(
        `INSERT INTO knowledge_publish_events (id, action, repo_id, version_id, version, status, requested_by)
         VALUES (?, 'upload', ?, ?, ?, 'success', ?)`,
        [publishEventId, params.id, versionId, nextVersion, admin.userId],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendJson(res, 201, {
      id: versionId,
      version: nextVersion,
      size_bytes: buf.length,
      sha256: packageInfo.sha256,
      file_count: packageInfo.fileCount,
      publish_event_id: publishEventId,
    });

    // Notify agents bound to this repo to reload knowledge (fire-and-forget)
    db.query("SELECT agent_id FROM agent_knowledge_repos WHERE repo_id = ?", [params.id])
      .then(([rows]: any) => { for (const r of rows as any[]) config.connectionMap.notify(r.agent_id, "agent.reload", { agentId: r.agent_id, resources: ["knowledge"] }); })
      .catch(() => {});
  });

  // Activate a version (publish / rollback)
  router.post(`${P}/admin/knowledge/repos/:repoId/versions/:versionId/activate`, async (req, res, params) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const db = getDb();

    // Transaction: deactivate all + activate target + publish event
    const conn = await db.getConnection();
    let publishEventId: string;
    try {
      await conn.beginTransaction();

      const [targetRows] = await conn.query(
        "SELECT id, version FROM knowledge_versions WHERE id = ? AND repo_id = ? LIMIT 1",
        [params.versionId, params.repoId],
      ) as any;
      if (targetRows.length === 0) { await conn.rollback(); conn.release(); sendJson(res, 404, { error: "Version not found" }); return; }
      const target = targetRows[0] as { id: string; version: number };

      const [previousRows] = await conn.query(
        "SELECT id, version FROM knowledge_versions WHERE repo_id = ? AND is_active = 1 LIMIT 1",
        [params.repoId],
      ) as any;
      const previous = previousRows[0] as { id: string; version: number } | undefined;
      const action = previous && target.version < previous.version ? "rollback" : "activate";

      await conn.query("UPDATE knowledge_versions SET is_active = 0, status = 'inactive' WHERE repo_id = ?", [params.repoId]);
      await conn.query(
        "UPDATE knowledge_versions SET is_active = 1, status = 'active', activated_by = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ? AND repo_id = ?",
        [admin.userId, params.versionId, params.repoId],
      );

      publishEventId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO knowledge_publish_events (id, action, repo_id, version_id, version, previous_version_id, previous_version, status, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?)`,
        [publishEventId, action, params.repoId, params.versionId, target.version,
         previous?.id ?? null, previous?.version ?? null, admin.userId],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    sendJson(res, 200, { ok: true, publish_event_id: publishEventId });

    // Notify agents bound to this repo to reload knowledge
    db.query("SELECT agent_id FROM agent_knowledge_repos WHERE repo_id = ?", [params.repoId])
      .then(([rows]: any) => { for (const r of rows as any[]) config.connectionMap.notify(r.agent_id, "agent.reload", { agentId: r.agent_id, resources: ["knowledge"] }); })
      .catch(() => {});
  });

  // Publish event history
  router.get(`${P}/admin/knowledge/publish-events`, async (req, res) => {
    const admin = requireAdmin(req, config.jwtSecret);
    if (!admin) { sendJson(res, 403, { error: "Forbidden: admin only" }); return; }
    const query = parseQuery(req.url ?? "");
    const limit = Math.min(Math.max(parseInt(query.limit ?? "30", 10) || 30, 1), 100);
    const db = getDb();
    const [rows] = await db.query(
      `SELECT e.id, e.action, e.repo_id, r.name AS repo_name, e.version_id, e.version,
              e.previous_version_id, e.previous_version, e.status, e.requested_by, e.created_at
       FROM knowledge_publish_events e
       JOIN knowledge_repos r ON r.id = e.repo_id
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      [limit],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Download active version tar (for AgentBox pull at startup)
  router.get(`${P}/admin/knowledge/repos/:id/active/download`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }
    const db = getDb();
    const [rows] = await db.query(
      "SELECT data FROM knowledge_versions WHERE repo_id = ? AND is_active = 1 LIMIT 1",
      [params.id],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "No active version" }); return; }
    res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": "attachment; filename=knowledge.tar.gz" });
    res.end(rows[0].data);
  });
}
