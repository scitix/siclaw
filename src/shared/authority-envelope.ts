/**
 * AuthorityEnvelope verification — the runtime side of the management plane's
 * trusted-execution contract. The control plane issues a short-lived,
 * HMAC-signed envelope naming what one segment's turns may do (effect ceiling,
 * capability allow/deny lists); the tool-execution layer verifies it LOCALLY
 * (shared secret via SICLAW_AUTHORITY_SECRET) and enforces it on every tool
 * call — not just once at dispatch.
 *
 * Wire format matches the issuer: base64url(JSON claims) + "." + hex(HMAC-SHA256).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface AuthorityEnvelopeClaims {
  authorityId: string;
  issuer: string;
  subject: string;
  targetAgentId: string;
  segmentId?: string;
  resourceScope?: string[];
  effectCeiling: string;
  allowedCapabilities?: string[];
  deniedCapabilities?: string[];
  expiresAt: number; // unix seconds
  nonce: string;
  policyRevision?: string;
}

/** Verifies signature + expiry; null on ANY failure (callers fail closed). */
export function verifyAuthorityEnvelope(
  token: string,
  secret: string | undefined = process.env.SICLAW_AUTHORITY_SECRET,
): AuthorityEnvelopeClaims | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  let payload: Buffer;
  try {
    payload = Buffer.from(payloadB64, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sigHex);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: AuthorityEnvelopeClaims;
  try {
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!claims.subject || !claims.targetAgentId || !claims.effectCeiling) return null;
  if (typeof claims.expiresAt !== "number" || Date.now() / 1000 > claims.expiresAt) return null;
  return claims;
}

/**
 * Capability matching: exact name, or a "prefix.*" glob (e.g. "k8s.*"). The
 * lists are authored by the control plane; the runtime only matches.
 */
export function matchesCapability(list: string[] | undefined, toolName: string): boolean {
  if (!list) return false;
  for (const entry of list) {
    if (!entry) continue;
    if (entry === toolName) return true;
    if (entry.endsWith(".*") && toolName.startsWith(entry.slice(0, -1))) return true;
    if (entry === "*") return true;
  }
  return false;
}
