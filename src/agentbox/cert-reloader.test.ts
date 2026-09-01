import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReloadingCertMaterial, readCertMaterial, certMaterialExists } from "./cert-reloader.js";

/**
 * The defect these cover: an AgentBox read /etc/siclaw/certs once at startup, so a
 * renewed certificate never reached a running pod. Both mTLS consumers now go
 * through this module — the client re-resolves per request, the HTTPS server is
 * pushed a new secure context.
 */

let dir: string;

/** Write a generation of material. mtime is advanced explicitly so the test never
 *  depends on the filesystem's timestamp resolution. */
function writeCerts(tag: string, ageOffsetMs = 0) {
  fs.writeFileSync(path.join(dir, "tls.crt"), `CERT-${tag}`);
  fs.writeFileSync(path.join(dir, "tls.key"), `KEY-${tag}`);
  fs.writeFileSync(path.join(dir, "ca.crt"), `CA-${tag}`);
  if (ageOffsetMs) {
    const when = new Date(Date.now() + ageOffsetMs);
    for (const f of ["tls.crt", "tls.key", "ca.crt"]) fs.utimesSync(path.join(dir, f), when, when);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-certs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cert material", () => {
  it("reports absence when the trio is incomplete", () => {
    expect(certMaterialExists(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "tls.crt"), "CERT");
    // A cert with no key is not usable material, and answering true here would send
    // the caller down the TLS path to fail on the missing file instead.
    expect(certMaterialExists(dir)).toBe(false);
    writeCerts("a");
    expect(certMaterialExists(dir)).toBe(true);
  });

  it("reads the trio together", () => {
    writeCerts("a");
    const m = readCertMaterial(dir);
    expect(m?.cert.toString()).toBe("CERT-a");
    expect(m?.key.toString()).toBe("KEY-a");
    expect(m?.ca.toString()).toBe("CA-a");
  });

  it("returns undefined rather than a partial read", () => {
    expect(readCertMaterial(dir)).toBeUndefined();
  });
});

describe("ReloadingCertMaterial", () => {
  it("serves the material it started with", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 0);
    expect(r.current()?.cert.toString()).toBe("CERT-a");
  });

  it("picks up a renewal on the next check", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 0); // no throttle: check every call
    expect(r.current()?.cert.toString()).toBe("CERT-a");

    // What a Secret update looks like to the pod: same paths, new contents.
    writeCerts("b", 5_000);
    expect(r.current()?.cert.toString()).toBe("CERT-b");
  });

  it("does not re-read inside the throttle window", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 60_000);
    expect(r.current()?.cert.toString()).toBe("CERT-a");
    writeCerts("b", 5_000);
    // Renewal is a monthly event; statting three files per outbound request is a
    // cost with no matching benefit.
    expect(r.current()?.cert.toString()).toBe("CERT-a");
  });

  it("keeps the last good material when the files go missing mid-swap", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 0);
    expect(r.current()?.cert.toString()).toBe("CERT-a");

    // A volume swap observed between stat and read. Dropping the material here would
    // break a pod whose certificate is perfectly fine, so the previous generation
    // stands until a complete one can be read.
    fs.rmSync(path.join(dir, "tls.key"));
    expect(r.current()?.cert.toString()).toBe("CERT-a");

    writeCerts("b", 5_000);
    expect(r.current()?.cert.toString()).toBe("CERT-b");
  });

  it("notifies a watcher once per change, not once per check", async () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 5);
    const seen: string[] = [];
    const stop = r.watch((m) => seen.push(m.cert.toString()));

    await new Promise((res) => setTimeout(res, 40));
    expect(seen).toEqual([]); // nothing changed yet

    writeCerts("b", 5_000);
    await new Promise((res) => setTimeout(res, 60));
    stop();
    // Exactly one notification: an HTTPS server rebuilding its secure context on
    // every tick would be churn, not freshness.
    expect(seen).toEqual(["CERT-b"]);
  });

  it("stops notifying after the returned stop function is called", async () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 5);
    const seen: string[] = [];
    const stop = r.watch((m) => seen.push(m.cert.toString()));
    stop();

    writeCerts("b", 5_000);
    await new Promise((res) => setTimeout(res, 40));
    expect(seen).toEqual([]);
  });
});

// ── The three guards a mutation pass found unprotected ────────────────
//
// Each of these survived being deleted while the suite above stayed green, which
// means the reasoning in the ⚠️ comments was load-bearing but unenforced.

describe("torn reads and partial material", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a cert and key from different generations", () => {
    writeCerts("a");
    const real = fs.readFileSync;
    // A volume swap landing between the tls.crt read and the tls.key read. Accepting
    // it caches a mismatched pair whose TLS handshake fails naming neither file, and
    // it stays cached until the NEXT swap.
    vi.spyOn(fs, "readFileSync").mockImplementation(((f: any, ...rest: any[]) => {
      const out = (real as any)(f, ...rest);
      if (String(f).endsWith("tls.crt")) writeCerts("b", 5_000);
      return out;
    }) as any);

    expect(readCertMaterial(dir)).toBeUndefined();
  });

  it("keeps the previous generation when a read tears mid-refresh", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 0);
    expect(r.current()?.cert.toString()).toBe("CERT-a");

    writeCerts("b", 5_000);
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((f: any, ...rest: any[]) => {
      const out = (real as any)(f, ...rest);
      if (String(f).endsWith("tls.crt")) writeCerts("c", 10_000);
      return out;
    }) as any);

    // The refresh cannot complete, so the last KNOWN-GOOD material stands rather than
    // the pod being left with none.
    expect(r.current()?.cert.toString()).toBe("CERT-a");

    vi.restoreAllMocks();
    expect(r.current()?.cert.toString()).toBe("CERT-c");
  });

  it("notices a change confined to the key or the CA", () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 0);
    expect(r.current()?.key.toString()).toBe("KEY-a");

    // Only tls.key moves. Fingerprinting tls.crt alone would call this "no change"
    // and serve a key that no longer matches what is on disk.
    const when = new Date(Date.now() + 5_000);
    fs.writeFileSync(path.join(dir, "tls.key"), "KEY-rotated");
    fs.utimesSync(path.join(dir, "tls.key"), when, when);

    expect(r.current()?.key.toString()).toBe("KEY-rotated");
  });

  it("retries the handler on the next tick when applying the material throws", async () => {
    writeCerts("a");
    const r = new ReloadingCertMaterial(dir, 5);
    let attempts = 0;
    // A server whose setSecureContext rejects the material. Without the rollback the
    // fingerprint has already advanced, the next tick sees no change, and the server
    // serves the old context forever with a single warning as the only trace.
    const stop = r.watch(() => {
      attempts++;
      if (attempts === 1) throw new Error("bad context");
    });

    writeCerts("b", 5_000);
    await new Promise((res) => setTimeout(res, 80));
    stop();

    expect(attempts).toBeGreaterThan(1);
  });
});
