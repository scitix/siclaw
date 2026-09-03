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
  /**
   * The control-plane task this envelope was issued for. Optional: an envelope
   * may be scoped to an agent (and a segment) without naming a task. When
   * present it is BINDING — see `bindingError`.
   */
  taskId?: string;
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
 * Checks that a verified envelope was issued for THIS request, returning a
 * reason string when it was not (null when the binding holds).
 *
 * Kept separate from `verifyAuthorityEnvelope` on purpose: that function proves
 * the envelope is authentic and unexpired, which needs nothing but the token and
 * the secret. Binding is a different question — "authentic FOR WHAT" — and it
 * needs the request context, which the signature check has no business knowing.
 * Folding the two together would mean every caller had to supply a context, and
 * a caller with none would end up passing something plausible instead.
 *
 * A signed envelope that verifies but was minted for another agent, another
 * segment or another task is REPLAY: without this check a valid envelope for a
 * low-privilege agent could be presented on a dispatch to a high-privilege one.
 * Callers fail closed on a non-null result (`/api/prompt` answers 403
 * AUTHORITY_ENVELOPE_MISBOUND).
 *
 * Absent claims do not bind: `segmentId` / `taskId` are optional, and an
 * envelope that names neither is checked on `targetAgentId` alone. Only a claim
 * the ISSUER stated is enforced, so a narrower envelope is never weakened by a
 * caller that omits context it does not have.
 */
export function bindingError(
  claims: AuthorityEnvelopeClaims,
  ctx: { agentId: string; segmentId?: string; taskId?: string },
): string | null {
  if (claims.targetAgentId !== ctx.agentId) {
    return `authority envelope targets agent ${claims.targetAgentId}, not ${ctx.agentId}`;
  }
  if (claims.segmentId && claims.segmentId !== ctx.segmentId) {
    return `authority envelope is bound to segment ${claims.segmentId}, not ${ctx.segmentId ?? "(none)"}`;
  }
  if (claims.taskId && claims.taskId !== ctx.taskId) {
    return `authority envelope is bound to task ${claims.taskId}, not ${ctx.taskId ?? "(none)"}`;
  }
  return null;
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
