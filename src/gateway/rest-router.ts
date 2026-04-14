/**
 * Minimal REST router for the Siclaw Agent Runtime.
 *
 * Works with the existing `http.createServer` — no Express needed.
 * Supports path parameters like `/agents/:id/chat/sessions/:sid`.
 */

import http from "node:http";
import { verifyJwt } from "./jwt.js";

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

export interface RestRouter {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${patternStr}$`), paramNames };
}

export function createRestRouter(): RestRouter {
  const routes: CompiledRoute[] = [];

  function addRoute(method: string, path: string, handler: RouteHandler): void {
    const { pattern, paramNames } = compilePath(path);
    routes.push({ method, pattern, paramNames, handler });
  }

  return {
    get(path, handler) { addRoute("GET", path, handler); },
    post(path, handler) { addRoute("POST", path, handler); },
    put(path, handler) { addRoute("PUT", path, handler); },
    delete(path, handler) { addRoute("DELETE", path, handler); },

    handle(req, res) {
      const method = req.method ?? "GET";
      const urlPath = (req.url ?? "/").split("?")[0];

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = urlPath.match(route.pattern);
        if (!match) continue;

        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
        }

        // Fire-and-forget with error handling
        Promise.resolve(route.handler(req, res, params)).catch((err) => {
          console.error(`[rest-router] Handler error ${method} ${urlPath}:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });

        return true;
      }

      return false;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) as T : {} as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function parseQuery(url: string): Record<string, string> {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return {};
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.slice(qIdx + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}

// ── Auth middleware helper ────────────────────────────────────

export interface AuthContext {
  userId: string;
  orgId?: string;
  username?: string;
  role?: string;
}

export function requireAuth(req: http.IncomingMessage, jwtSecret: string): AuthContext | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const payload = verifyJwt(auth.slice(7), jwtSecret);
  if (!payload?.sub) return null;
  return { userId: payload.sub, orgId: payload.org_id, username: payload.username, role: payload.role };
}
