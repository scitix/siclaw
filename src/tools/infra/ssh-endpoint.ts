/** One endpoint identity for SSH dialing, key pins and shared admission. */
export function sshEndpoint(ip: unknown, value?: unknown): { host: string; port: number; key: string } {
  if (typeof ip !== "string" || !ip || ip !== ip.trim() || /[\s/@?#]/.test(ip)) throw new Error("Invalid SSH host");
  const port = value ?? 22;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH port");
  const host = new URL(`ssh://${ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip}:${port}`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return { host, port, key: `${host}:${port}` };
}
