/**
 * Local mode secrets — auto-generate JWT / Portal secrets on first launch
 * and persist them so subsequent `siclaw local` runs use the same values.
 * Makes zero-config startup possible.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LocalSecrets {
  jwtSecret: string;
  portalSecret: string;
  /**
   * Dedicated secret for the `/api/v1/cli-snapshot` endpoint. Kept separate
   * from `jwtSecret` so the TUI doesn't have to self-sign an admin JWT
   * (which would authenticate against every other admin route) just to
   * read the snapshot.
   */
  cliSnapshotSecret: string;
}

export function loadOrGenerateLocalSecrets(filePath: string): LocalSecrets {
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (
        typeof raw.jwtSecret === "string" &&
        typeof raw.portalSecret === "string"
      ) {
        // Back-fill cliSnapshotSecret for secrets files written by older
        // versions. Preserves existing JWT/Portal secrets so the running
        // Portal doesn't reject in-flight sessions.
        if (typeof raw.cliSnapshotSecret !== "string") {
          raw.cliSnapshotSecret = crypto.randomBytes(32).toString("hex");
          fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));
          try { fs.chmodSync(filePath, 0o600); } catch { /* non-POSIX */ }
        }
        return raw;
      }
    } catch {
      // Malformed — fall through and regenerate.
    }
  }

  const secrets: LocalSecrets = {
    jwtSecret: crypto.randomBytes(32).toString("hex"),
    portalSecret: crypto.randomBytes(32).toString("hex"),
    cliSnapshotSecret: crypto.randomBytes(32).toString("hex"),
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
