/**
 * Certificate reloading for the AgentBox's two mTLS consumers.
 *
 * An AgentBox mounts /etc/siclaw/certs from a per-agent Kubernetes Secret and used
 * to read it exactly once — `readFileSync` in the GatewayClient constructor, and
 * again when the HTTPS server was created. That made a certificate RENEWAL invisible
 * to a running pod: kubelet republishes the mounted files, the process keeps serving
 * and presenting the material it read at boot, and nothing surfaces the divergence
 * because the readiness probe only exercises the pod's own loopback /health, never
 * mTLS to the Gateway. A pod in that state stays Ready and in rotation while every
 * call it makes fails (`socket hang up` outbound, `certificate has expired` inbound).
 *
 * Detection is by STAT, not fs.watch. A Secret volume update is an atomic swap of the
 * `..data` directory, which replaces the inode behind each file: a watcher bound to
 * the old inode can miss the swap entirely, while a stat of the path follows the
 * symlink to whatever is current. mtime+size+ino together identify the material
 * without reading it.
 */

import fs from "node:fs";
import path from "node:path";

export interface CertMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  /** Identifies this material, so a caller can tell one generation from the next. */
  fingerprint: string;
}

/** Default gap between stat checks. Renewal is a once-a-month event; this is not a hot path. */
export const CERT_RELOAD_INTERVAL_MS = 30_000;

function certFiles(certPath: string) {
  return {
    certFile: path.join(certPath, "tls.crt"),
    keyFile: path.join(certPath, "tls.key"),
    caFile: path.join(certPath, "ca.crt"),
  };
}

export function certMaterialExists(certPath: string): boolean {
  const { certFile, keyFile, caFile } = certFiles(certPath);
  return fs.existsSync(certFile) && fs.existsSync(keyFile) && fs.existsSync(caFile);
}

/**
 * Stat-only identity of the material at `certPath`, or undefined if unreadable.
 *
 * Covers all three files: a CA rotation can leave tls.crt's own stat unchanged in
 * principle, and statting one file to decide whether three changed is the kind of
 * shortcut that fails once and then looks like a certificate bug.
 */
function fingerprintOf(certPath: string): string | undefined {
  const { certFile, keyFile, caFile } = certFiles(certPath);
  try {
    return [certFile, keyFile, caFile]
      .map((f) => {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}:${st.ino}`;
      })
      .join("|");
  } catch {
    return undefined; // mid-swap or genuinely absent — the caller keeps what it has
  }
}

/**
 * Read the material at `certPath`, or undefined if it cannot be read as a whole.
 *
 * ⚠️ The fingerprint is taken AFTER the reads and only accepted if it still matches
 * the one taken before. A volume swap landing between the tls.crt and tls.key reads
 * would otherwise produce a cert and key from different generations — a pair that
 * fails the TLS handshake with an error naming neither file, and that would be
 * cached until the next swap.
 */
export function readCertMaterial(certPath: string): CertMaterial | undefined {
  const before = fingerprintOf(certPath);
  if (!before) return undefined;
  const { certFile, keyFile, caFile } = certFiles(certPath);
  try {
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    const ca = fs.readFileSync(caFile);
    const after = fingerprintOf(certPath);
    if (after !== before) return undefined; // torn read; the next check picks it up
    return { cert, key, ca, fingerprint: before };
  } catch {
    return undefined;
  }
}

/**
 * Material that re-reads itself when the files on disk change.
 *
 * `current()` is check-on-use with a throttle rather than timer-driven, so a client
 * that only makes occasional calls needs no lifecycle management and leaks no timer.
 * A caller that must be PUSHED the new material (an HTTPS server, which has to be
 * told via setSecureContext) uses `watch()` instead.
 *
 * On any failure to re-read, the last known-good material is kept. That is the one
 * fallback in here and it is deliberate: the failure mode it covers is real and
 * observed (a stat or read landing mid-swap), and the alternative — dropping the
 * material because a re-read blipped — would break a pod whose certificate is fine.
 */
export class ReloadingCertMaterial {
  private material: CertMaterial | undefined;
  /** The generation in force before the current tick, so a failed apply can revert. */
  private materialBefore: CertMaterial | undefined;
  private lastCheck = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly certPath: string,
    private readonly intervalMs: number = CERT_RELOAD_INTERVAL_MS,
    private readonly label = "cert-reloader",
  ) {
    this.material = readCertMaterial(certPath);
    this.lastCheck = Date.now();
  }

  /** The material as of at most `intervalMs` ago. Undefined only if it has never been readable. */
  current(): CertMaterial | undefined {
    const now = Date.now();
    if (now - this.lastCheck >= this.intervalMs) {
      this.lastCheck = now;
      this.refresh();
    }
    return this.material;
  }

  /**
   * Call `onChange` whenever the material changes. Returns a stop function.
   * The interval is unref'd — reloading certificates must never be the reason a
   * process stays alive.
   */
  watch(onChange: (material: CertMaterial) => void): () => void {
    const tick = () => {
      const previous = this.material?.fingerprint;
      this.materialBefore = this.material;
      this.lastCheck = Date.now();
      this.refresh();
      if (this.material && this.material.fingerprint !== previous) {
        const applied = this.material;
        try {
          onChange(applied);
        } catch (err: any) {
          // ⚠️ ROLL BACK, or the handler never gets another chance. The fingerprint
          // would already have advanced, so the next tick sees no change, and a server
          // whose setSecureContext threw would serve the old context forever with one
          // warning as the only trace. Reverting means the next tick retries.
          this.material = this.materialBefore ?? applied;
          console.warn(
            `[${this.label}] applying renewed certificates failed, will retry:`,
            err?.message ?? err,
          );
        }
      }
    };
    // Replacing an existing watch rather than leaking it: LocalSpawner builds several
    // boxes in one process, and an orphaned interval would keep statting forever.
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(tick, this.intervalMs);
    (this.timer as any).unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  private refresh(): void {
    const fingerprint = fingerprintOf(this.certPath);
    if (!fingerprint || fingerprint === this.material?.fingerprint) return;
    const next = readCertMaterial(this.certPath);
    if (!next) return; // torn or unreadable — keep what we have, retry next check
    const had = this.material !== undefined;
    this.material = next;
    if (had) console.log(`[${this.label}] reloaded certificates from ${this.certPath}`);
  }
}
