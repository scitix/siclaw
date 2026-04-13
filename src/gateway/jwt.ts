/**
 * JWT verification for the Siclaw Agent Runtime.
 *
 * Verifies JWT tokens using the shared secret between Upstream and Runtime.
 */

import jwt from "jsonwebtoken";

export interface JwtPayload {
  sub: string;
  email?: string;
  username?: string;
  org_id?: string;
  iat?: number;
  exp?: number;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}
