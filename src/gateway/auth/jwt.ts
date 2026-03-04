/**
 * Simple JWT implementation
 *
 * Uses Node.js built-in crypto — no extra dependencies required.
 */

import crypto from "node:crypto";

export interface JwtPayload {
  userId: string;
  username: string;
  iat: number; // issued at
  exp: number; // expiration
}

const ALGORITHM = "HS256";
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Base64url encode
 */
function base64urlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

/**
 * Base64url decode
 */
function base64urlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

/**
 * Create a signature
 */
function sign(data: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(data);
  return base64urlEncode(hmac.digest());
}

/**
 * Issue a JWT
 */
export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  expirySeconds = DEFAULT_EXPIRY_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expirySeconds,
  };

  const header = base64urlEncode(JSON.stringify({ alg: ALGORITHM, typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(fullPayload));
  const signature = sign(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
}

/**
 * Verify a JWT
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;

    // Verify signature
    const expectedSignature = sign(`${header}.${body}`, secret);
    if (signature !== expectedSignature) {
      return null;
    }

    // Parse payload
    const payload: JwtPayload = JSON.parse(base64urlDecode(body));

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract a token from the Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
