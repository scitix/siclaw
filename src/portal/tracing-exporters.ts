/**
 * Tracing exporter helpers — the single home for the "typed auth material →
 * OTLP headers" mapping, secret masking, masked-secret preservation on update,
 * and the lightweight SSRF guard for the test probe.
 *
 * Shared by adapter.ts (buildTracingConfig assembles plaintext headers for the
 * in-trust-domain export path) and siclaw-api.ts (REST CRUD masks secrets on
 * read, preserves them on write, and probes endpoints). Keeping the platform
 * type-switch in one module means a new platform is added in exactly one place.
 *
 * Design contract (tracing-platforms-DESIGN.md, module 1/2):
 *   - auth stores TYPED material, never finished headers:
 *       langfuse → { publicKey, secretKey }  → Authorization: Basic base64(pk:sk)
 *       phoenix  → { apiKey, projectName }    → authorization: Bearer …  + x-project-name
 *       otlp     → { headers: {...} }          → passed through verbatim
 *   - list/get echo secret fields (langfuse.secretKey, phoenix.apiKey, every
 *     otlp header value) as a masked prefix only.
 *   - PUT auth: a field left empty or carrying a masked echo KEEPS the stored
 *     value — a masked string is NEVER written back to the DB.
 */

export type TracingPlatformType = "langfuse" | "phoenix" | "otlp";

/** Suffix appended to a secret prefix when echoed back to the UI (U+2026). */
export const SECRET_MASK_SUFFIX = "…";

export interface ExporterAuth {
  // langfuse
  publicKey?: string;
  secretKey?: string;
  // phoenix
  apiKey?: string;
  projectName?: string;
  // otlp
  headers?: Record<string, string>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** True when a value looks like a masked echo (the UI sent the masked prefix back). */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value.includes(SECRET_MASK_SUFFIX);
}

/** Show a short prefix then the mask suffix. Short secrets reveal even less. */
function maskValue(value: string): string {
  if (!value) return value;
  const visible = value.length <= 12 ? Math.min(4, value.length) : 10;
  return value.slice(0, visible) + SECRET_MASK_SUFFIX;
}

/**
 * Build the final OTLP request headers from typed auth material. Returns an
 * empty object when no usable credential is present (caller decides whether to
 * attach a `headers` key at all). Plaintext — only ever called inside the trust
 * domain (Portal → settings/getTracingConfig) or the admin test probe.
 */
export function assembleExporterHeaders(
  platformType: string,
  auth: ExporterAuth | null | undefined,
): Record<string, string> {
  const a = auth ?? {};
  if (platformType === "langfuse") {
    const pk = asString(a.publicKey) ?? "";
    const sk = asString(a.secretKey) ?? "";
    if (!pk && !sk) return {};
    const token = Buffer.from(`${pk}:${sk}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  if (platformType === "phoenix") {
    const headers: Record<string, string> = {};
    const apiKey = asString(a.apiKey);
    const projectName = asString(a.projectName);
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (projectName) headers["x-project-name"] = projectName;
    return headers;
  }
  // otlp — verbatim string-valued headers.
  return asHeaders(a.headers) ?? {};
}

/** Mask secret fields for list/get. Non-secret fields (publicKey, projectName) pass through. */
export function maskExporterAuth(
  platformType: string,
  auth: ExporterAuth | null | undefined,
): ExporterAuth {
  const a = auth ?? {};
  if (platformType === "langfuse") {
    const pk = asString(a.publicKey);
    const sk = asString(a.secretKey);
    return {
      ...(pk !== undefined ? { publicKey: pk } : {}),
      ...(sk !== undefined ? { secretKey: maskValue(sk) } : {}),
    };
  }
  if (platformType === "phoenix") {
    const apiKey = asString(a.apiKey);
    const projectName = asString(a.projectName);
    return {
      ...(apiKey !== undefined ? { apiKey: maskValue(apiKey) } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
    };
  }
  // otlp — mask every header value (each is auth material).
  const headers = asHeaders(a.headers);
  if (!headers) return {};
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) masked[k] = maskValue(v);
  return { headers: masked };
}

/** Empty or masked → keep stored secret; a masked string is never persisted. */
function preserveSecret(incoming: unknown, existing: string | undefined): string | undefined {
  if (typeof incoming !== "string" || incoming === "" || isMaskedSecret(incoming)) return existing;
  return incoming;
}

/** Plain (non-secret) field: take a provided string, else keep stored. */
function preservePlain(incoming: unknown, existing: string | undefined): string | undefined {
  return typeof incoming === "string" ? incoming : existing;
}

function dropUndefined(obj: ExporterAuth): ExporterAuth {
  const out: ExporterAuth = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Merge an incoming auth payload over the stored auth for an UPDATE, resolving
 * masked/empty secret fields back to the stored value. When `incoming` is
 * absent entirely (auth omitted on PUT) the stored auth is kept verbatim.
 */
export function mergeExporterAuthForUpdate(
  platformType: string,
  incoming: ExporterAuth | null | undefined,
  existing: ExporterAuth | null | undefined,
): ExporterAuth {
  const ex = existing ?? {};
  if (incoming === undefined || incoming === null) return dropUndefined(ex);
  const inc = incoming;
  if (platformType === "langfuse") {
    return dropUndefined({
      publicKey: preservePlain(inc.publicKey, asString(ex.publicKey)),
      secretKey: preserveSecret(inc.secretKey, asString(ex.secretKey)),
    });
  }
  if (platformType === "phoenix") {
    return dropUndefined({
      apiKey: preserveSecret(inc.apiKey, asString(ex.apiKey)),
      projectName: preservePlain(inc.projectName, asString(ex.projectName)),
    });
  }
  // otlp — incoming.headers is the authoritative set; masked values resolve to
  // the stored secret for the same key. Absent headers → keep stored.
  const incHeaders = asHeaders(inc.headers);
  if (!incHeaders) {
    const exHeaders = asHeaders(ex.headers);
    return exHeaders ? { headers: exHeaders } : {};
  }
  const exHeaders = asHeaders(ex.headers) ?? {};
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(incHeaders)) {
    const kept = preserveSecret(v, exHeaders[k]);
    if (kept !== undefined) merged[k] = kept;
  }
  return { headers: merged };
}

/**
 * Lightweight SSRF guard for the admin test probe. Blocks cloud metadata and
 * link-local / loopback addresses when the host is a LITERAL IP, while leaving
 * RFC1918 private ranges open (internal backends like `phoenix:6006` live
 * there). Hostnames are not resolved — this is a cheap, admin-only guardrail,
 * not a full anti-rebinding defence.
 */
export function tracingTestSsrfGuard(rawUrl: string): { ok: boolean; error?: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${u.protocol} (only http/https)` };
  }
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (isBlockedIpLiteral(host)) {
    return { ok: false, error: `Blocked host (metadata/link-local/loopback): ${host}` };
  }
  return { ok: true };
}

function isBlockedIpLiteral(host: string): boolean {
  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map((n) => Number(n));
    if (o.some((n) => n > 255)) return true; // malformed → block
    // 169.254.0.0/16 link-local (covers 169.254.169.254 cloud metadata)
    if (o[0] === 169 && o[1] === 254) return true;
    // 127.0.0.0/8 loopback
    if (o[0] === 127) return true;
    // 0.0.0.0/8 "this host"
    if (o[0] === 0) return true;
    return false; // RFC1918 (10/8, 172.16/12, 192.168/16) and public → allowed
  }
  // IPv6 literal
  if (host.includes(":")) {
    if (host === "::1") return true; // loopback
    if (host === "::") return true; // unspecified
    // fe80::/10 link-local
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    // IPv4-mapped link-local / loopback (::ffff:169.254.x.x, ::ffff:127.x.x.x)
    const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedIpLiteral(mapped[1]);
    return false; // fc00::/7 unique-local (private) and public → allowed
  }
  return false; // hostname — not resolved here
}
