/**
 * Siclaw domain REST API handlers.
 *
 * Registers all CRUD routes for skills, mcp, chat, models,
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
import { getMessages } from "./chat-repo.js";
import { evaluateScriptsStatic, buildAssessment } from "./skills/script-evaluator.js";
import { evaluateScriptsAI } from "./skills/ai-security-reviewer.js";
import { validateSchedule } from "../cron/cron-limits.js";

/** Trace viewer message limit — matches siclaw_main.cron-limits.MAX_TRACE_MESSAGES */
const MAX_TRACE_MESSAGES = 200;

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
  const url = `${config.serverUrl}/api/internal/siclaw/check-access`;
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
  /**
   * Trigger a manual Run-now for the given task. Field is filled in by
   * gateway-main after the TaskCoordinator is constructed; route handlers
   * read it at request time so the late-attach pattern is safe. Undefined
   * in DB-less modes where the coordinator isn't running.
   */
  fireTaskNow?: (taskId: string) => Promise<SiclawTaskFireOutcome>;
}

export type SiclawTaskFireOutcome =
  | { kind: "ok" }
  | { kind: "in_flight" }
  | { kind: "cooldown"; retryAfterSec: number }
  | { kind: "not_found" };

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

    // origin='task' sessions are scheduled-task execution traces — they live
    // in the same table so FK + sse-consumer keep working, but the user-facing
    // Chat list should hide them (entry point is the task runs page).
    const [[countRows], [listRows]] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS count FROM chat_sessions
         WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL
           AND (origin IS NULL OR origin <> 'task')`,
        [params.id, auth.userId],
      ),
      db.query(
        `SELECT * FROM chat_sessions
         WHERE agent_id = ? AND user_id = ? AND deleted_at IS NULL
           AND (origin IS NULL OR origin <> 'task')
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
        // Fetch newest N messages (DESC + LIMIT), then reverse in app to get chronological order.
        // This ensures page=1 returns the most recent messages (for initial load at bottom of chat).
        "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [params.sid, pageSize, offset],
      ),
    ]) as [any, any];

    // Reverse to chronological order (oldest first) for the frontend
    (listRows as any[]).reverse();

    sendJson(res, 200, {
      data: listRows,
      total: Number(countRows[0].count),
      page,
      page_size: pageSize,
    });
  });


  // ================================================================
  // Tasks (Agent sub-resource) — scheduled cron jobs
  //
  // Runtime owns scheduling + execution. Clients (Portal / future upstream)
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
       ORDER BY t.created_at DESC`,
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
       FROM agent_tasks WHERE agent_id = ? AND created_by = ? ORDER BY created_at DESC`,
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

    if (!ctx?.fireTaskNow) {
      sendJson(res, 503, { error: "Task coordinator not available" });
      return;
    }

    const outcome = await ctx.fireTaskNow(params.taskId);
    switch (outcome.kind) {
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
       ORDER BY created_at DESC LIMIT ?`,
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
         ORDER BY created_at DESC LIMIT 1`,
        [params.taskId, r.created_at],
      ),
      db.query(
        `SELECT id FROM agent_task_runs
         WHERE task_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT 1`,
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
    const fetched = await getMessages(sessionId, { limit: MAX_TRACE_MESSAGES + 1 });
    const truncated = fetched.length > MAX_TRACE_MESSAGES;
    const msgs = truncated ? fetched.slice(fetched.length - MAX_TRACE_MESSAGES) : fetched;
    sendJson(res, 200, {
      sessionId,
      truncated,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolInput: m.toolInput,
        outcome: m.outcome,
        durationMs: m.durationMs,
        timestamp: m.createdAt?.toISOString() ?? null,
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
         WHERE cb.agent_id = ? ORDER BY cb.created_at DESC`
      : `SELECT cb.*, c.name as channel_name, c.type as channel_type
         FROM channel_bindings cb
         LEFT JOIN channels c ON cb.channel_id = c.id
         WHERE cb.agent_id = ? AND cb.created_by = ? ORDER BY cb.created_at DESC`;

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
    await db.query("DELETE FROM channel_pairing_codes WHERE expires_at < NOW()");

    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await db.query(
      "INSERT INTO channel_pairing_codes (code, channel_id, agent_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
      [code, body.channel_id, params.id, auth.userId, expiresAt],
    );

    sendJson(res, 200, { code, expires_at: expiresAt.toISOString() });
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

    const [[skillRows], [mcpRows], [activeRows], [msgRows], [taskRows]] = await Promise.all([
      db.query("SELECT COUNT(*) AS count FROM skills WHERE org_id = ?", [orgId]),
      db.query("SELECT COUNT(*) AS count FROM mcp_servers WHERE org_id = ?", [orgId]),
      db.query(
        "SELECT COUNT(*) AS count FROM chat_sessions WHERE last_active_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) AND deleted_at IS NULL",
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
