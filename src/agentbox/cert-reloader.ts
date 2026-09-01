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
 * Detection is EVENT-DRIVEN with a periodic backstop.
 *
 * A Secret volume update is an atomic swap: kubelet writes a new timestamped
 * directory, then renames a symlink over `..data`. Watching a FILE cannot see it —
 * the swap replaces the inode each visible path resolves through, so a watcher bound
 * to the old inode goes silent forever. Watching the DIRECTORY does see it, because
 * the rename happens inside the watched directory.
 *
 * The backstop poll stays, at a long interval, and is not redundant: inotify queues
 * can overflow, fs.watch has platform-dependent gaps, and a watch that silently stops
 * delivering is indistinguishable from a certificate that never changed. The failure
 * that follows — an agent going dark with nothing reporting it — is the exact shape of
 * the outage this file exists to prevent, so it does not get to depend on one
 * notification arriving.
 *
 * Both paths converge on the same fingerprint comparison (mtime+size+ino of all three
 * files), so a duplicate wake-up costs three stats and changes nothing.
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

/**
 * Backstop poll interval — the safety net behind the directory watch, not the primary
 * mechanism. Long on purpose: renewal lands a week before expiry, so even if every
 * filesystem event were lost, a check this often still notices with days to spare.
 */
export const CERT_RELOAD_INTERVAL_MS = 10 * 60_000;

/**
 * One volume swap emits a burst of rename events (the new directory, `..data`, then
 * each visible symlink). Waiting for the burst to settle means the read happens once,
 * after the swap is complete, rather than repeatedly against a directory mid-rename
 * where readCertMaterial's torn-read guard would reject it anyway.
 *
 * ⚠️ NOT what guarantees one reload per swap — the fingerprint comparison in
 * refreshAndNotify does that, and would even with no debounce at all. This only keeps
 * the work down to one read instead of a dozen.
 */
const CERT_WATCH_DEBOUNCE_MS = 150;

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
  /** The generation in force before the last apply, so a failed one can revert. */
  private materialBefore: CertMaterial | undefined;
  private lastCheck = 0;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: fs.FSWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  private listeners: Array<(material: CertMaterial) => void> = [];

  constructor(
    private readonly certPath: string,
    private readonly intervalMs: number = CERT_RELOAD_INTERVAL_MS,
    private readonly label = "cert-reloader",
  ) {
    this.material = readCertMaterial(certPath);
    this.lastCheck = Date.now();
    this.startDirectoryWatch();
  }

  /**
   * The current material. Undefined only if it has never been readable.
   *
   * The directory watch normally has it up to date already; the throttled check here
   * is the same backstop the timer provides, for a holder that never calls watch().
   */
  current(): CertMaterial | undefined {
    const now = Date.now();
    if (now - this.lastCheck >= this.intervalMs) {
      this.lastCheck = now;
      this.refreshAndNotify();
    }
    return this.material;
  }

  /**
   * Call `onChange` whenever the material changes. Returns a stop function.
   *
   * Fired by the directory watch, and by the backstop interval in case the watch
   * misses. The interval is unref'd — reloading certificates must never be the reason
   * a process stays alive.
   */
  watch(onChange: (material: CertMaterial) => void): () => void {
    this.listeners.push(onChange);
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.lastCheck = Date.now();
        this.refreshAndNotify();
      }, this.intervalMs);
      (this.timer as any).unref?.();
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== onChange);
      if (this.listeners.length === 0) this.stop();
    };
  }

  /** Release the watch and the backstop timer. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = undefined;
  }

  /**
   * Watch the DIRECTORY, never the files.
   *
   * A Secret update renames a symlink over `..data`; the visible paths keep resolving
   * to whatever it points at. A file watcher holds the inode that rename orphaned and
   * never fires again — silently, which is the worst way for this to fail.
   *
   * Failure to establish the watch is not fatal: the backstop interval alone still
   * converges, days ahead of expiry.
   */
  private startDirectoryWatch(): void {
    try {
      this.watcher = fs.watch(this.certPath, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          this.refreshAndNotify();
        }, CERT_WATCH_DEBOUNCE_MS);
        (this.debounce as any).unref?.();
      });
      (this.watcher as any).unref?.();
      this.watcher.on("error", (err: any) => {
        // Keep going on the backstop rather than dying: a lost watch degrades the
        // latency of a renewal from seconds to one interval, which the seven-day head
        // start absorbs completely.
        console.warn(`[${this.label}] certificate directory watch failed, polling only:`, err?.message ?? err);
        try { this.watcher?.close(); } catch { /* already gone */ }
        this.watcher = undefined;
      });
    } catch (err: any) {
      console.warn(`[${this.label}] cannot watch ${this.certPath}, polling only:`, err?.message ?? err);
    }
  }

  private refreshAndNotify(): void {
    const previous = this.material?.fingerprint;
    this.materialBefore = this.material;
    this.refresh();
    const next = this.material;
    if (!next || next.fingerprint === previous) return;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err: any) {
        // ⚠️ ROLL BACK, or the handler never gets another chance. The fingerprint
        // would already have advanced, so the next wake-up sees no change, and a
        // server whose setSecureContext threw would serve the old context forever
        // with one warning as the only trace. Reverting means it is retried.
        this.material = this.materialBefore ?? next;
        console.warn(`[${this.label}] applying renewed certificates failed, will retry:`, err?.message ?? err);
        return;
      }
    }
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
