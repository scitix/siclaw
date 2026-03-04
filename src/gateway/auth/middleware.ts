/**
 * Authentication middleware
 *
 * Handles authentication for HTTP and WebSocket requests.
 */

import type http from "node:http";
import { extractBearerToken, verifyJwt, type JwtPayload } from "./jwt.js";

/** Authenticated request context */
export interface AuthContext {
  userId: string;
  username: string;
}

/** Extended request type with auth context */
export interface AuthenticatedRequest extends http.IncomingMessage {
  auth?: AuthContext;
}

/**
 * Create the authentication middleware
 */
export function createAuthMiddleware(jwtSecret: string) {
  /**
   * Authenticate an HTTP request
   */
  function authenticateRequest(req: http.IncomingMessage): AuthContext | null {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) return null;

    const payload = verifyJwt(token, jwtSecret);
    if (!payload) return null;

    return {
      userId: payload.userId,
      username: payload.username,
    };
  }

  /**
   * Get token from URL query parameters (used for WebSocket)
   */
  function authenticateFromQuery(url: string | undefined, host: string | undefined): AuthContext | null {
    if (!url) return null;

    try {
      const fullUrl = new URL(url, `http://${host || "localhost"}`);
      const token = fullUrl.searchParams.get("token");

      if (!token) return null;

      const payload = verifyJwt(token, jwtSecret);
      if (!payload) return null;

      return {
        userId: payload.userId,
        username: payload.username,
      };
    } catch {
      return null;
    }
  }

  /**
   * Authenticate a WebSocket upgrade request
   */
  function authenticateWebSocket(req: http.IncomingMessage): AuthContext | null {
    // Try Authorization header first
    const auth = authenticateRequest(req);
    if (auth) return auth;

    // Fall back to query parameter
    return authenticateFromQuery(req.url, req.headers.host);
  }

  return {
    authenticateRequest,
    authenticateWebSocket,
    authenticateFromQuery,
  };
}
