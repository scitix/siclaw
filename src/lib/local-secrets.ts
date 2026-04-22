/**
 * Local mode secrets — auto-generate JWT / Portal / Runtime secrets on first
 * launch and persist them so subsequent `siclaw local` runs use the same
 * values. Makes zero-config startup possible.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LocalSecrets {
  jwtSecret: string;
  runtimeSecret: string;
  portalSecret: string;
}

export function loadOrGenerateLocalSecrets(filePath: string): LocalSecrets {
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (
        typeof raw.jwtSecret === "string" &&
        typeof raw.runtimeSecret === "string" &&
        typeof raw.portalSecret === "string"
      ) {
        return raw;
      }
    } catch {
      // Malformed — fall through and regenerate.
    }
  }

  const secrets: LocalSecrets = {
    jwtSecret: crypto.randomBytes(32).toString("hex"),
    runtimeSecret: crypto.randomBytes(32).toString("hex"),
    portalSecret: crypto.randomBytes(32).toString("hex"),
  };

  const dir = path.dirname(filePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(secrets, null, 2));
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-POSIX filesystems may reject chmod — best effort.
  }
  return secrets;
}
