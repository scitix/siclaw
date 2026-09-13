import type { TLSSocket } from "node:tls";

/** Checking the certificate OU alone accepts self-signed impersonators. */
export function isAuthenticatedRuntime(socket: TLSSocket): boolean {
  if (socket.authorized !== true) return false;
  const ou = socket.getPeerCertificate?.()?.subject?.OU;
  return ou === "Gateway" || ou === "Runtime";
}
