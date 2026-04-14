/**
 * Portal authentication — simple user registration, login, and JWT signing.
 *
 * First user registration is open (bootstrap); subsequent registrations require admin auth.
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getDb } from "../gateway/db.js";
import {
  sendJson,
  parseBody,
  requireAuth,
  type RestRouter,
} from "../gateway/rest-router.js";

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

export function signToken(userId: string, username: string, secret: string): string {
  return jwt.sign({ sub: userId, username, org_id: "default" }, secret, { expiresIn: "24h" });
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
      const auth = requireAuth(req, jwtSecret);
      if (!auth) {
        sendJson(res, 401, { error: "Authentication required" });
        return;
      }
      // Verify caller is admin
      const [callerRows] = await db.query("SELECT role FROM siclaw_users WHERE id = ?", [auth.userId]) as any;
      if (callerRows.length === 0 || callerRows[0].role !== "admin") {
        sendJson(res, 403, { error: "Admin role required" });
        return;
      }
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

    const token = signToken(id, body.username, jwtSecret);
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

    const token = signToken(user.id, user.username, jwtSecret);
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
}
