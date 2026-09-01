import { describe, it, expect, vi } from "vitest";
import forge from "node-forge";
import {
  AGENTBOX_CERT_RENEW_BEFORE_MS,
  AGENTBOX_CERT_VALIDITY_DAYS,
  certExpiryLabel,
  certificateHasExpired,
  certificateNeedsRenewal,
  parseCertExpiryLabel,
  readCertificateNotAfter,
  renewBeforeMsInForce,
  MAX_RENEW_BEFORE_DAYS,
} from "./cert-validity.js";

/** A self-signed PEM whose validity window is exactly the one asked for. */
function certWithValidity(notBefore: Date, notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair(512);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: "commonName", value: "test-agent" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.pki.certificateToPem(cert);
}

describe("readCertificateNotAfter", () => {
  it("reads the notAfter of a real certificate", () => {
    const notAfter = new Date("2030-06-01T12:00:00Z");
    const pem = certWithValidity(new Date("2030-05-01T12:00:00Z"), notAfter);

    // X.509 stores seconds, so compare at second granularity.
    expect(readCertificateNotAfter(pem)?.toISOString()).toBe(notAfter.toISOString());
  });

  it("returns null rather than throwing on input that is not a certificate", () => {
    expect(readCertificateNotAfter("not a certificate")).toBeNull();
    expect(readCertificateNotAfter("")).toBeNull();
  });
});

describe("certificateNeedsRenewal", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("is true once the certificate is inside the renewal window", () => {
    const notAfter = new Date(now.getTime() + AGENTBOX_CERT_RENEW_BEFORE_MS - 1000);
    expect(certificateNeedsRenewal(notAfter, now)).toBe(true);
  });

  it("is false while the certificate has more life than the window", () => {
    const notAfter = new Date(now.getTime() + AGENTBOX_CERT_RENEW_BEFORE_MS + 1000);
    expect(certificateNeedsRenewal(notAfter, now)).toBe(false);
  });

  it("is true for a certificate that already expired — the case this exists for", () => {
    expect(certificateNeedsRenewal(new Date(now.getTime() - 1), now)).toBe(true);
  });

  /**
   * The distinction the manager relies on to decide whether a box is worthless (drop it
   * now) or merely due for replacement (roll it one at a time).
   */
  it("separates 'due' from 'dead' via the window argument", () => {
    const dueButAlive = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(certificateNeedsRenewal(dueButAlive, now)).toBe(true);
    expect(certificateNeedsRenewal(dueButAlive, now, 0)).toBe(false);
  });

  /**
   * 🔴 Unknown must never read as expired: an unreadable certificate or a pod predating
   * the expiry label would otherwise be recycled on sight.
   */
  it("treats an unknown expiry as not due", () => {
    expect(certificateNeedsRenewal(null, now)).toBe(false);
    expect(certificateHasExpired(null, now)).toBe(false);
  });
});

describe("certificateHasExpired", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("is true at and after the notAfter instant", () => {
    expect(certificateHasExpired(new Date(now.getTime()), now)).toBe(true);
    expect(certificateHasExpired(new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it("is false while the certificate is still valid", () => {
    expect(certificateHasExpired(new Date(now.getTime() + 1000), now)).toBe(false);
  });
});

describe("cert expiry labels", () => {
  it("round-trips through the K8s label form", () => {
    const notAfter = new Date("2026-10-05T08:30:00Z");
    expect(parseCertExpiryLabel(certExpiryLabel(notAfter))?.toISOString()).toBe(notAfter.toISOString());
  });

  it("produces a value K8s accepts as a label", () => {
    const value = certExpiryLabel(new Date("2026-10-05T08:30:00Z"));
    expect(value).toMatch(/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/);
    expect(value.length).toBeLessThanOrEqual(63);
  });

  it("reads anything unusable as unknown, never as a date", () => {
    expect(parseCertExpiryLabel(undefined)).toBeNull();
    expect(parseCertExpiryLabel("")).toBeNull();
    expect(parseCertExpiryLabel("not-a-number")).toBeNull();
    expect(parseCertExpiryLabel("0")).toBeNull();
    expect(parseCertExpiryLabel("-1")).toBeNull();
  });
});

describe("renewBeforeMsInForce", () => {
  const days = (n: number) => n * 24 * 60 * 60 * 1000;

  it("uses the default when the variable is absent or empty", () => {
    expect(renewBeforeMsInForce({})).toBe(AGENTBOX_CERT_RENEW_BEFORE_MS);
    expect(renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: "" })).toBe(AGENTBOX_CERT_RENEW_BEFORE_MS);
  });

  it("honours a value in days", () => {
    expect(renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: "3" })).toBe(days(3));
  });

  /**
   * 🔴 THE CEILING IS THE POINT, and it is measured rather than reasoned. A window at or
   * above the certificate lifetime makes every certificate due the moment it is signed: a
   * box is drained for "nearing expiry", its replacement is signed, and the replacement is
   * judged identically. Observed on a live cluster at 40 days against a 30-day lifetime —
   * eight boxes drained in minutes, ending in the drain budget's "that is a loop, not a
   * deploy".
   */
  it("refuses a window at or above half the certificate lifetime", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const tooBig of ["40", "30", "16"]) {
      expect(renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: tooBig }))
        .toBe(AGENTBOX_CERT_RENEW_BEFORE_MS);
    }
    expect(MAX_RENEW_BEFORE_DAYS).toBeLessThan(AGENTBOX_CERT_VALIDITY_DAYS);
  });

  it("accepts a window at the ceiling", () => {
    expect(renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: String(MAX_RENEW_BEFORE_DAYS) }))
      .toBe(days(MAX_RENEW_BEFORE_DAYS));
  });

  it("says WHY it refused, naming the lifetime and the churn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: "40" });
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain(String(AGENTBOX_CERT_VALIDITY_DAYS));
    expect(msg).toMatch(/churn/i);
  });

  it("falls back to the default on nonsense rather than failing", () => {
    // A typo must never be able to stop renewal entirely — that is the failure this whole
    // mechanism exists to prevent.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["abc", "0", "-5", "NaN", "Infinity"]) {
      expect(renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: bad })).toBe(AGENTBOX_CERT_RENEW_BEFORE_MS);
    }
  });

  it("is what certificateNeedsRenewal defaults to, so the override actually takes effect", () => {
    const original = process.env.SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS;
    try {
      process.env.SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS = "14";
      const now = new Date("2026-09-01T00:00:00Z");
      // 12 days of life left: inside a 14-day window, outside the default 10-day one.
      const notAfter = new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000);
      expect(certificateNeedsRenewal(notAfter, now)).toBe(true);
      expect(certificateNeedsRenewal(notAfter, now, AGENTBOX_CERT_RENEW_BEFORE_MS)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS;
      else process.env.SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS = original;
    }
  });

  /**
   * The invariant the ceiling exists to protect, stated directly: a freshly signed
   * certificate must NOT be due for renewal. If it is, every replacement is born stale.
   */
  it("leaves a freshly signed certificate not due, at any accepted window", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const fresh = new Date(now.getTime() + days(AGENTBOX_CERT_VALIDITY_DAYS));
    const widest = renewBeforeMsInForce({ SICLAW_AGENTBOX_CERT_RENEW_BEFORE_DAYS: String(MAX_RENEW_BEFORE_DAYS) });
    expect(certificateNeedsRenewal(fresh, now, widest)).toBe(false);
  });
});

describe("the renewal window against the certificate lifetime", () => {
  /**
   * The window has to be reachable: shorter than the lifetime, or every certificate would
   * be born due for renewal and every new box would be drained immediately.
   */
  it("is a fraction of the lifetime, not the whole of it", () => {
    const lifetimeMs = AGENTBOX_CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
    expect(AGENTBOX_CERT_RENEW_BEFORE_MS).toBeLessThan(lifetimeMs);
    // And large enough for a drain + respawn cycle to complete inside it.
    expect(AGENTBOX_CERT_RENEW_BEFORE_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});
