/**
 * OAuth2 Authorization Code Flow — Dex / Generic OIDC
 *
 * Handles the server-side OAuth2 flow:
 *   1. Build authorize URL (redirect user to IdP)
 *   2. Exchange authorization code for tokens
 *   3. Fetch user info from IdP
 *
 * Config is loaded from DB overrides → SICLAW_SSO_* environment variables.
 * If neither is set, SSO is disabled and loadOAuth2Config() returns null.
 */

import crypto from "node:crypto";

// ─── Config ─────────────────────────────────────────

export interface OAuth2Config {
  issuer: string;        // e.g. https://dex.example.com
  clientId: string;
  clientSecret: string;
  redirectUri: string;   // e.g. http://localhost:3000/auth/callback
  /** Derived endpoints (from issuer) */
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

/**
 * Load OAuth2 config from DB overrides → environment variables.
 * Returns null if SSO is not configured.
 *
 * Priority: dbOverrides > SICLAW_SSO_* env vars > null
 */
export function loadOAuth2Config(dbOverrides?: Record<string, string>): OAuth2Config | null {
  const issuer = dbOverrides?.["sso.issuer"] ?? process.env.SICLAW_SSO_ISSUER;
  if (!issuer) return null;

  const clientId = dbOverrides?.["sso.clientId"] ?? process.env.SICLAW_SSO_CLIENT_ID;
  const clientSecret = dbOverrides?.["sso.clientSecret"] ?? process.env.SICLAW_SSO_CLIENT_SECRET;
  const redirectUri = dbOverrides?.["sso.redirectUri"] ?? process.env.SICLAW_SSO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.warn(
      "[oauth2] SSO issuer is set but missing clientId, clientSecret, or redirectUri — SSO disabled",
    );
    return null;
  }

  // Standard OIDC endpoints (Dex follows this convention)
  const base = issuer.replace(/\/+$/, "");

  return {
    issuer: base,
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    userInfoUrl: `${base}/userinfo`,
  };
}

// ─── CSRF State Store ───────────────────────────────

const pendingStates = new Map<string, { createdAt: number }>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Generate a cryptographic random state and store it */
export function generateState(): string {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });
  return state;
}

/** Validate and consume a state (returns true if valid) */
export function consumeState(state: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  return Date.now() - entry.createdAt < STATE_TTL_MS;
}

/** Periodic cleanup of expired states */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}, 60_000);

// ─── OAuth2 Flow Steps ──────────────────────────────

/**
 * Step 1: Build the authorization URL that the user's browser should redirect to.
 */
export function buildAuthorizeUrl(config: OAuth2Config, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid profile email",
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/**
 * Step 2: Exchange the authorization code for tokens.
 */
export interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
}

export async function exchangeCode(
  config: OAuth2Config,
  code: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

/**
 * Step 3: Fetch user info using the access token.
 */
export interface SsoUserInfo {
  sub: string;                  // unique identifier from IdP
  email?: string;
  name?: string;
  preferred_username?: string;
}

export async function fetchUserInfo(
  config: OAuth2Config,
  accessToken: string,
): Promise<SsoUserInfo> {
  const res = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`UserInfo fetch failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<SsoUserInfo>;
}
