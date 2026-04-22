/**
 * Portal authentication — simple user registration, login, and JWT signing.
 *
 * First user registration is open (bootstrap); subsequent registrations require admin auth.
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getDb } from "../gateway/db.js";
import http from "node:http";
import {
  sendJson,
  parseBody,
  requireAuth,
  type AuthContext,
  type RestRouter,
} from "../gateway/rest-router.js";

// ── Admin guard (Portal-only, not in gateway) ────────────────

/**
 * Require admin role. Reads role from JWT claims — no DB query needed.
 * Works with both Portal-issued and Upstream-issued tokens as long as
 * the JWT contains a `role` claim.
 */
export function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jwtSecret: string,
): AuthContext | null {
  const auth = requireAuth(req, jwtSecret);
  if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return null; }

  if (auth.role !== "admin") {
    sendJson(res, 403, { error: "Admin role required" });
    return null;
  }
  return auth;
}

// ── Password helpers ─────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(derived, "hex"));
}

// ── JWT helper ───────────────────────────────────────────────

export function signToken(userId: string, username: string, role: string, secret: string): string {
  return jwt.sign({ sub: userId, username, role, org_id: "default" }, secret, { expiresIn: "24h" });
}

// ── Route registration ───────────────────────────────────────

export function registerAuthRoutes(router: RestRouter, jwtSecret: string): void {
  // POST /api/v1/auth/register
  router.post("/api/v1/auth/register", async (req, res) => {
    const db = getDb();

    // Check whether any users exist
    const [countRows] = await db.query("SELECT COUNT(*) AS cnt FROM siclaw_users") as any;
    const userCount: number = Number(countRows[0].cnt);

    // If users exist, require admin auth for registration
    if (userCount > 0) {
      const auth = requireAdmin(req, res, jwtSecret);
      if (!auth) return;
    }

    const body = await parseBody<{ username?: string; password?: string; role?: string }>(req);
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: "username and password are required" });
      return;
    }

    // Check uniqueness
    const [existingRows] = await db.query("SELECT id FROM siclaw_users WHERE username = ?", [body.username]) as any;
    if (existingRows.length > 0) {
      sendJson(res, 409, { error: "Username already exists" });
      return;
    }

    const id = crypto.randomUUID();
    const passwordHash = hashPassword(body.password);
    const role = body.role ?? "admin";

    await db.query(
      "INSERT INTO siclaw_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
      [id, body.username, passwordHash, role],
    );

    const token = signToken(id, body.username, role, jwtSecret);
    sendJson(res, 201, { token, user: { id, username: body.username, role } });
  });

  // POST /api/v1/auth/login
  router.post("/api/v1/auth/login", async (req, res) => {
    const body = await parseBody<{ username?: string; password?: string }>(req);
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: "username and password are required" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, username, password_hash, role, can_review_skills FROM siclaw_users WHERE username = ?",
      [body.username],
    ) as any;

    if (rows.length === 0) {
      sendJson(res, 401, { error: "Invalid credentials" });
      return;
    }

    const user = rows[0];
    if (!verifyPassword(body.password, user.password_hash)) {
      sendJson(res, 401, { error: "Invalid credentials" });
      return;
    }

    const token = signToken(user.id, user.username, user.role, jwtSecret);
    sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, can_review_skills: !!user.can_review_skills } });
  });

  // GET /api/v1/auth/me
  router.get("/api/v1/auth/me", async (req, res) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) {
      sendJson(res, 401, { error: "Authentication required" });
      return;
    }

    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, username, role, can_review_skills, created_at FROM siclaw_users WHERE id = ?",
      [auth.userId],
    ) as any;

    if (rows.length === 0) {
      sendJson(res, 404, { error: "User not found" });
      return;
    }

    sendJson(res, 200, rows[0]);
  });

  // ── User management (admin only) ──────────────────────────

  // GET /api/v1/users — list all users
  router.get("/api/v1/users", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const [rows] = await db.query(
      "SELECT id, username, role, can_review_skills, created_at FROM siclaw_users ORDER BY created_at, id",
    ) as any;
    sendJson(res, 200, { data: rows });
  });

  // POST /api/v1/users — create user (admin only)
  router.post("/api/v1/users", async (req, res) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const body = await parseBody<{
      username?: string; password?: string; role?: string; can_review_skills?: boolean;
    }>(req);
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: "username and password are required" });
      return;
    }

    const [existing] = await db.query("SELECT id FROM siclaw_users WHERE username = ?", [body.username]) as any;
    if (existing.length > 0) {
      sendJson(res, 409, { error: "Username already exists" });
      return;
    }

    const id = crypto.randomUUID();
    const passwordHash = hashPassword(body.password);
    const role = "user";
    const canReview = body.can_review_skills ? 1 : 0;

    await db.query(
      "INSERT INTO siclaw_users (id, username, password_hash, role, can_review_skills) VALUES (?, ?, ?, ?, ?)",
      [id, body.username, passwordHash, role, canReview],
    );

    sendJson(res, 201, { id, username: body.username, role, can_review_skills: !!canReview });
  });

  // PUT /api/v1/users/:userId — update user permissions (admin only)
  router.put("/api/v1/users/:userId", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const db = getDb();
    const body = await parseBody<{ can_review_skills?: boolean }>(req);
    const targetId = params.userId;

    if (body.can_review_skills === undefined) {
      sendJson(res, 400, { error: "Nothing to update" });
      return;
    }

    const values: unknown[] = [body.can_review_skills ? 1 : 0, targetId];
    await db.query("UPDATE siclaw_users SET can_review_skills = ? WHERE id = ?", values);

    const [rows] = await db.query(
      "SELECT id, username, role, can_review_skills, created_at FROM siclaw_users WHERE id = ?",
      [targetId],
    ) as any;
    if (rows.length === 0) { sendJson(res, 404, { error: "User not found" }); return; }
    sendJson(res, 200, rows[0]);
  });

  // PUT /api/v1/users/:userId/password — reset password (admin or self)
  router.put("/api/v1/users/:userId/password", async (req, res, params) => {
    const auth = requireAuth(req, jwtSecret);
    if (!auth) { sendJson(res, 401, { error: "Authentication required" }); return; }

    const targetId = params.userId;
    const isSelf = targetId === auth.userId;

    if (!isSelf && auth.role !== "admin") {
      sendJson(res, 403, { error: "Admin role required to reset other users' passwords" });
      return;
    }

    const body = await parseBody<{ password?: string; current_password?: string }>(req);
    if (!body.password) {
      sendJson(res, 400, { error: "password is required" });
      return;
    }

    const db = getDb();

    // Self password change requires current password
    if (isSelf) {
      if (!body.current_password) {
        sendJson(res, 400, { error: "current_password is required when changing your own password" });
        return;
      }
      const [rows] = await db.query("SELECT password_hash FROM siclaw_users WHERE id = ?", [targetId]) as any;
      if (rows.length === 0) { sendJson(res, 404, { error: "User not found" }); return; }
      if (!verifyPassword(body.current_password, rows[0].password_hash)) {
        sendJson(res, 403, { error: "Current password is incorrect" });
        return;
      }
    }

    const passwordHash = hashPassword(body.password);
    await db.query("UPDATE siclaw_users SET password_hash = ? WHERE id = ?", [passwordHash, targetId]);
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/v1/users/:userId — delete user (admin only)
  router.delete("/api/v1/users/:userId", async (req, res, params) => {
    const auth = requireAdmin(req, res, jwtSecret);
    if (!auth) return;

    const targetId = params.userId;
    if (targetId === auth.userId) {
      sendJson(res, 400, { error: "Cannot delete yourself" });
      return;
    }

    const db = getDb();
    await db.query("DELETE FROM siclaw_users WHERE id = ?", [targetId]);
    sendJson(res, 204, null);
  });
}
