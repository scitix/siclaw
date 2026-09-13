/** Shared wire contract. No endpoint, identity or scope comes from user code. */
export const SANDBOX_TOOL_PATH = "/api/v1/siclaw/sandbox/tools";
export const SANDBOX_LEASE_OPEN = "sandbox.lease.open";
export const SANDBOX_LEASE_CLOSE = "sandbox.lease.close";
export const SANDBOX_TOOL_RPC = "sandbox.tool";
export const SANDBOX_HTTP_LIMIT = 256 * 1024;

export function sandboxToolEndpoint(base: string): string {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Sandbox public URL must be a canonical HTTPS origin");
  }
  return new URL(SANDBOX_TOOL_PATH, url).href;
}

export function isSandboxEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const u = new URL(value); return sandboxToolEndpoint(u.origin) === value; } catch { return false; }
}
