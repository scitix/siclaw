/**
 * Siclaw domain REST API handlers.
 *
 * Registers all CRUD routes for skills, mcp, chat, models, cron,
 * channels, diagnostics, api-keys, and dashboard on a RestRouter.
 *
 * All data lives in the shared MySQL database.
 */

import crypto from "node:crypto";
import type { RestRouter } from "./rest-router.js";
import type { RuntimeConfig } from "./config.js";
import {
  sendJson,
  parseBody,
  parseQuery,
  requireAuth,
  type AuthContext,
} from "./rest-router.js";
import { getDb } from "./db.js";
import { evaluateScriptsStatic, buildAssessment } from "./skills/script-evaluator.js";
import { evaluateScriptsAI } from "./skills/ai-security-reviewer.js";

// ── Permission check helper ───────────────────────────────────

interface AccessResult {
  allowed: boolean;
  grantAll: boolean;
  agentGroupIds: string[];
}

async function checkAccess(
  config: RuntimeConfig,
  userId: string,
  orgId: string,
  action: "read" | "write" | "review",
): Promise<AccessResult> {
  const url = `${config.serverUrl}/api/internal/siclaw/adapter/check-access`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": config.portalSecret,
    },
    body: JSON.stringify({
      user_id: userId,
      org_id: orgId,
      module: "siclaw",
      action,
    }),
  });

  if (!resp.ok) {
    return { allowed: false, grantAll: false, agentGroupIds: [] };
  }

  return (await resp.json()) as AccessResult;
}

/**
 * Guard: check module permission and reject if not allowed.
 * Returns true if access was denied (response already sent).
 */
async function guardAccess(
  res: import("node:http").ServerResponse,
  config: RuntimeConfig,
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

export function registerSiclawRoutes(router: RestRouter, config: RuntimeConfig, ctx?: SiclawApiContext): void {
  const P = "/api/v1/siclaw";

  // ================================================================
  // Skills
  // ================================================================

  // List skills
  router.get(`${P}/skills`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const search = query.search || "";

    const db = getDb();

    let countSql = "SELECT COUNT(*) AS count FROM skills WHERE org_id = ?";
    let listSql = "SELECT * FROM skills WHERE org_id = ?";
    const params: unknown[] = [auth.orgId];

    if (search) {
      const clause = " AND (name LIKE ? OR description LIKE ?)";
      countSql += clause;
      listSql += clause;
      params.push(`%${search}%`, `%${search}%`);
    }

    if (query.labels) {
      const labelList = (query.labels as string).split(",").map(l => l.trim());
      for (const label of labelList) {
        const clause = " AND JSON_CONTAINS(labels, ?)";
        countSql += clause;
        listSql += clause;
        params.push(JSON.stringify(label));
      }
    }

    listSql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    const [[countRows], [listRows]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, pageSize, offset]),
    ]) as [any, any];

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
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), id, version,
        body.specs || "", JSON.stringify(body.scripts || []),
        body.commit_message || "Initial version", auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM skills WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
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
    sendJson(res, 200, rows[0]);
  });

  // Update skill
  router.put(`${P}/skills/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    // Verify ownership
    const [existing] = await db.query(
      "SELECT * FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    const skill = existing[0];

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
      await db.query(
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, diff, commit_message, author_id, is_approved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          crypto.randomUUID(), params.id, newVersion,
          newSpecs, newScripts,
          JSON.stringify({
            specs_diff: { old: oldSpecs, new: newSpecs },
            scripts_diff: { old: oldScripts, new: newScripts },
          }),
          body.commit_message || `Version ${newVersion}`,
          auth.userId,
        ],
      );

      await db.query(
        `UPDATE skills SET name = COALESCE(?, name), description = COALESCE(?, description),
         labels = COALESCE(?, labels), status = 'draft',
         version = ?, specs = COALESCE(?, specs), scripts = COALESCE(?, scripts)
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
         specs = COALESCE(?, specs), scripts = COALESCE(?, scripts)
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
    sendJson(res, 200, rows[0]);

    // Draft update: notify dev agents to reload skills
    ctx?.notifySkillDevAgents?.(params.id, ["skills"]);
  });

  // Delete skill
  router.delete(`${P}/skills/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM skills WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Skill not found" });
      return;
    }

    await db.query("DELETE FROM skill_reviews WHERE skill_id = ?", [params.id]);
    await db.query("DELETE FROM skill_versions WHERE skill_id = ?", [params.id]);
    await db.query("DELETE FROM skills WHERE id = ?", [params.id]);

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
    sendJson(res, 200, rows[0]);
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
      "UPDATE skills SET status = 'pending_review' WHERE id = ?",
      [params.id],
    );

    sendJson(res, 200, { review_id: reviewId, status: "pending_review" });

    // Security assessment runs entirely in background — reviewer sees results when they open the review
    const scriptsArr: { name: string; content: string }[] = skill.scripts
      ? (typeof skill.scripts === "string" ? JSON.parse(skill.scripts) : skill.scripts)
      : [];

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
      "UPDATE skills SET status = 'draft' WHERE id = ?",
      [params.id],
    );

    // Close pending review records
    await db.query(
      "UPDATE skill_reviews SET decision = 'withdrawn', reviewed_at = NOW(3) WHERE skill_id = ? AND decision IS NULL",
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
        `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, commit_message, author_id, is_approved)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          crypto.randomUUID(), params.id, skill.version,
          typeof skill.specs === "string" ? skill.specs : JSON.stringify(skill.specs),
          typeof skill.scripts === "string" ? skill.scripts : JSON.stringify(skill.scripts),
          `Approved version ${skill.version}`,
          skill.author_id,
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
      "UPDATE skills SET status = 'installed' WHERE id = ?",
      [params.id],
    );

    // Update the review record
    await db.query(
      `UPDATE skill_reviews SET decision = 'approved', reviewed_by = ?, reviewed_at = NOW(3)
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
      "UPDATE skills SET status = 'draft' WHERE id = ?",
      [params.id],
    );

    // Update the review record
    await db.query(
      `UPDATE skill_reviews SET decision = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = NOW(3)
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

    sendJson(res, 200, rows[0]);
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
       ORDER BY sr.submitted_at DESC`,
      [auth.orgId],
    ) as any;

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
    await db.query(
      `INSERT INTO skill_versions (id, skill_id, version, specs, scripts, diff, commit_message, author_id, is_approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        crypto.randomUUID(), params.id, newVersion,
        targetSpecs, targetScripts,
        JSON.stringify({
          specs_diff: { old: currentSpecs, new: targetSpecs },
          scripts_diff: { old: currentScripts, new: targetScripts },
        }),
        `Rollback to version ${body.version}`,
        auth.userId,
      ],
    );

    // Update skills table with target content
    await db.query(
      `UPDATE skills SET specs = ?, scripts = ?, version = ?, status = 'draft' WHERE id = ?`,
      [targetSpecs, targetScripts, newVersion, params.id],
    );

    const [rows] = await db.query("SELECT * FROM skills WHERE id = ?", [params.id]) as any;
    sendJson(res, 200, rows[0]);
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
      "SELECT * FROM mcp_servers WHERE org_id = ? ORDER BY created_at DESC",
      [auth.orgId],
    ) as any;
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
    sendJson(res, 201, rows[0]);
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
    sendJson(res, 200, rows[0]);
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
       headers = COALESCE(?, headers), description = COALESCE(?, description)
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
    sendJson(res, 200, rows[0]);

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
      "UPDATE mcp_servers SET enabled = ? WHERE id = ?",
      [body.enabled ? 1 : 0, params.id],
    );

    const [rows] = await db.query("SELECT * FROM mcp_servers WHERE id = ?", [params.id]) as any;
    sendJson(res, 200, rows[0]);
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

    const [[countRows], [listRows]] = await Promise.all([
      db.query(
        "SELECT COUNT(*) AS count FROM chat_sessions WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL",
        [params.id, auth.userId],
      ),
      db.query(
        `SELECT * FROM chat_sessions WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL
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
       VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
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
      "UPDATE chat_sessions SET deleted_at = NOW(3) WHERE id = ?",
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
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
        [params.sid, pageSize, offset],
      ),
    ]) as [any, any];

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  // ================================================================
  // Cron Jobs
  // ================================================================

  // List cron jobs
  router.get(`${P}/cron`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const db = getDb();

    let countSql = "SELECT COUNT(*) AS count FROM cron_jobs WHERE org_id = ?";
    let listSql = "SELECT * FROM cron_jobs WHERE org_id = ?";
    const params: unknown[] = [auth.orgId];

    if (query.agent_id) {
      countSql += " AND agent_id = ?";
      listSql += " AND agent_id = ?";
      params.push(query.agent_id);
    }

    listSql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    const [[countRows], [listRows]] = await Promise.all([
      db.query(countSql, params),
      db.query(listSql, [...params, pageSize, offset]),
    ]) as [any, any];

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  // Create cron job
  router.post(`${P}/cron`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO cron_jobs (id, org_id, agent_id, name, description, schedule, prompt, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, auth.orgId, body.agent_id, body.name, body.description || null,
        body.schedule, body.prompt, body.status || "active",
        auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM cron_jobs WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Get cron job
  router.get(`${P}/cron/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM cron_jobs WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (rows.length === 0) {
      sendJson(res, 404, { error: "Cron job not found" });
      return;
    }
    sendJson(res, 200, rows[0]);
  });

  // Update cron job
  router.put(`${P}/cron/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM cron_jobs WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Cron job not found" });
      return;
    }

    await db.query(
      `UPDATE cron_jobs SET
       name = COALESCE(?, name), description = COALESCE(?, description),
       schedule = COALESCE(?, schedule), prompt = COALESCE(?, prompt),
       agent_id = COALESCE(?, agent_id)
       WHERE id = ?`,
      [
        body.name ?? null, body.description ?? null,
        body.schedule ?? null, body.prompt ?? null,
        body.agent_id ?? null, params.id,
      ],
    );

    const [rows] = await db.query("SELECT * FROM cron_jobs WHERE id = ?", [params.id]) as any;
    sendJson(res, 200, rows[0]);
  });

  // Delete cron job
  router.delete(`${P}/cron/:id`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM cron_jobs WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Cron job not found" });
      return;
    }

    await db.query("DELETE FROM cron_job_runs WHERE job_id = ?", [params.id]);
    await db.query("DELETE FROM cron_jobs WHERE id = ?", [params.id]);
    sendJson(res, 200, { ok: true });
  });

  // Set cron job status (active/paused)
  router.put(`${P}/cron/:id/status`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const body = await parseBody<{ status: string }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM cron_jobs WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Cron job not found" });
      return;
    }

    await db.query(
      "UPDATE cron_jobs SET status = ? WHERE id = ?",
      [body.status, params.id],
    );

    const [rows] = await db.query("SELECT * FROM cron_jobs WHERE id = ?", [params.id]) as any;
    sendJson(res, 200, rows[0]);
  });

  // List cron job runs (paginated)
  router.get(`${P}/cron/:id/runs`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const { page, pageSize, offset } = parsePagination(query);
    const db = getDb();

    // Verify job belongs to org
    const [job] = await db.query(
      "SELECT id FROM cron_jobs WHERE id = ? AND org_id = ?",
      [params.id, auth.orgId],
    ) as any;
    if (job.length === 0) {
      sendJson(res, 404, { error: "Cron job not found" });
      return;
    }

    const [[countRows], [listRows]] = await Promise.all([
      db.query("SELECT COUNT(*) AS count FROM cron_job_runs WHERE job_id = ?", [params.id]),
      db.query(
        "SELECT * FROM cron_job_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [params.id, pageSize, offset],
      ),
    ]) as [any, any];

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });

  // ================================================================
  // Channels (Agent sub-resource)
  // ================================================================

  // List channels
  router.get(`${P}/agents/:id/channels`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT * FROM agent_channels WHERE agent_id = ? ORDER BY created_at DESC",
      [params.id],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Create channel
  router.post(`${P}/agents/:id/channels`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    const db = getDb();

    await db.query(
      `INSERT INTO agent_channels (id, agent_id, name, type, config, auth_mode, service_account_id, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.id, body.name, body.type,
        JSON.stringify(body.config || {}), body.auth_mode || null,
        body.service_account_id || null, body.status || "active",
        auth.userId,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_channels WHERE id = ?", [id]) as any;
    sendJson(res, 201, rows[0]);
  });

  // Update channel
  router.put(`${P}/agents/:id/channels/:cid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_channels WHERE id = ? AND agent_id = ?",
      [params.cid, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }

    await db.query(
      `UPDATE agent_channels SET
       name = COALESCE(?, name), type = COALESCE(?, type),
       config = COALESCE(?, config), auth_mode = COALESCE(?, auth_mode),
       service_account_id = COALESCE(?, service_account_id),
       status = COALESCE(?, status)
       WHERE id = ?`,
      [
        body.name ?? null, body.type ?? null,
        body.config ? JSON.stringify(body.config) : null,
        body.auth_mode ?? null, body.service_account_id ?? null,
        body.status ?? null, params.cid,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_channels WHERE id = ?", [params.cid]) as any;
    sendJson(res, 200, rows[0]);
  });

  // Delete channel
  router.delete(`${P}/agents/:id/channels/:cid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_channels WHERE id = ? AND agent_id = ?",
      [params.cid, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "Channel not found" });
      return;
    }

    await db.query("DELETE FROM agent_channels WHERE id = ?", [params.cid]);
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
      "SELECT * FROM agent_diagnostics WHERE agent_id = ? ORDER BY sort_order ASC, created_at DESC",
      [params.id],
    ) as any;
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
    sendJson(res, 201, rows[0]);
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
       params = COALESCE(?, params), sort_order = COALESCE(?, sort_order)
       WHERE id = ?`,
      [
        body.name ?? null, body.description ?? null,
        body.prompt_template ?? null,
        body.params ? JSON.stringify(body.params) : null,
        body.sort_order ?? null, params.did,
      ],
    );

    const [rows] = await db.query("SELECT * FROM agent_diagnostics WHERE id = ?", [params.did]) as any;
    sendJson(res, 200, rows[0]);
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

  // ================================================================
  // API Keys (Agent sub-resource)
  // ================================================================

  // List API keys (return key_plain for copy support)
  router.get(`${P}/agents/:id/api-keys`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const db = getDb();
    const [rows] = await db.query(
      `SELECT id, agent_id, name, key_plain, key_prefix, last_used_at, expires_at, created_by, created_at
       FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC`,
      [params.id],
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // Create API key
  router.post(`${P}/agents/:id/api-keys`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<Record<string, unknown>>(req);
    const id = crypto.randomUUID();
    // Generate key: "sk-" + 32 random hex bytes
    const rawKey = crypto.randomBytes(32).toString("hex");
    const plaintext = `sk-${rawKey}`;
    const keyPrefix = plaintext.slice(0, 7); // "sk-XXXX"
    const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");

    const db = getDb();
    await db.query(
      `INSERT INTO agent_api_keys (id, agent_id, name, key_hash, key_plain, key_prefix, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, params.id, body.name || "API Key",
        keyHash, plaintext, keyPrefix,
        body.expires_at || null, auth.userId,
      ],
    );

    // Return the plaintext key only on creation (query back to get DB-generated created_at)
    const [rows] = await db.query(
      "SELECT id, agent_id, name, key_prefix, expires_at, created_by, created_at FROM agent_api_keys WHERE id = ?",
      [id],
    ) as any;
    sendJson(res, 201, { ...rows[0], key: plaintext });
  });

  // Delete API key
  router.delete(`${P}/agents/:id/api-keys/:kid`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_api_keys WHERE id = ? AND agent_id = ?",
      [params.kid, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "API key not found" });
      return;
    }

    await db.query("DELETE FROM api_key_service_accounts WHERE api_key_id = ?", [params.kid]);
    await db.query("DELETE FROM agent_api_keys WHERE id = ?", [params.kid]);
    sendJson(res, 200, { ok: true });
  });

  // Replace service account whitelist for an API key
  router.put(`${P}/agents/:id/api-keys/:kid/service-accounts`, async (req, res, params) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    if (await guardAccess(res, config, auth, "write")) return;
    const body = await parseBody<{ service_account_ids: string[] }>(req);
    const db = getDb();

    const [existing] = await db.query(
      "SELECT id FROM agent_api_keys WHERE id = ? AND agent_id = ?",
      [params.kid, params.id],
    ) as any;
    if (existing.length === 0) {
      sendJson(res, 404, { error: "API key not found" });
      return;
    }

    // Replace: delete all existing, insert new
    await db.query("DELETE FROM api_key_service_accounts WHERE api_key_id = ?", [params.kid]);

    const saIds = body.service_account_ids || [];
    for (const saId of saIds) {
      await db.query(
        "INSERT INTO api_key_service_accounts (api_key_id, service_account_id) VALUES (?, ?)",
        [params.kid, saId],
      );
    }

    sendJson(res, 200, { ok: true, service_account_ids: saIds });
  });

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
       sort_order = COALESCE(?, sort_order)
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

    const [[skillRows], [mcpRows], [activeRows], [msgRows], [cronRows]] = await Promise.all([
      db.query("SELECT COUNT(*) AS count FROM skills WHERE org_id = ?", [orgId]),
      db.query("SELECT COUNT(*) AS count FROM mcp_servers WHERE org_id = ?", [orgId]),
      db.query(
        "SELECT COUNT(*) AS count FROM chat_sessions WHERE last_active_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) AND deleted_at IS NULL",
      ),
      db.query("SELECT COUNT(*) AS count FROM chat_messages"),
      db.query("SELECT COUNT(*) AS count FROM cron_jobs WHERE org_id = ?", [orgId]),
    ]) as any;

    sendJson(res, 200, {
      total_skills: Number(skillRows[0].count),
      total_mcp: Number(mcpRows[0].count),
      active_sessions: Number(activeRows[0].count),
      total_messages: Number(msgRows[0].count),
      total_cron: Number(cronRows[0].count),
    });
  });

  // Usage per day
  router.get(`${P}/admin/dashboard/usage`, async (req, res) => {
    const auth = requireAuth(req, config.jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Unauthorized" }); return; }

    const query = parseQuery(req.url ?? "");
    const days = Math.min(90, Math.max(1, parseInt(query.days || "7", 10)));
    const db = getDb();

    // MySQL doesn't have generate_series; use application-side date generation
    // and LEFT JOIN with sub-queries for message and session counts
    const [msgRows] = await db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) AS message_count,
              SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_call_count
       FROM chat_messages
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at)`,
      [days],
    ) as any;

    const [sessRows] = await db.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) AS session_count
       FROM chat_sessions
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         AND deleted_at IS NULL
       GROUP BY DATE(created_at)`,
      [days],
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
}
