/**
 * A certificate whose own CA rejects it is not a flaky test, and this file is the guard against the
 * shape that produced it.
 *
 * `"00" + hex(16 random bytes)` wrote a DER INTEGER with a redundant leading zero whenever the random
 * part began with 0x00 and the byte after it was below 0x80. Any reader normalises that away, so the
 * re-encoded TBSCertificate came out one byte shorter than the bytes the signature covered —
 * measured as 421 → 420, the enclosing SEQUENCE length dropping a1 → a0 — and both node-forge and
 * openssl then refused it, openssl calling it `illegal padding`. 1/256 × 1/2 = 1/512 per issuance.
 *
 * The bug needed BOTH conditions, which is why it looked random and survived a first inspection: a
 * leading zero followed by a high-bit byte is legal and verifies fine. So the guard forces the exact
 * combination rather than sampling for it — issuing certificates until one fails would need
 * thousands and minutes, and would still only be probable.
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import forge from "node-forge";
import { CertificateManager, randomSerialHex } from "./cert-manager.js";

/** A fake randomBytes returning a fixed pattern, so a serial shape can be demanded rather than won. */
const fixed = (...bytes: number[]) => (n: number): Buffer => {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = bytes[i] ?? 0xaa;
  return out;
};

/** DER minimality: at most one leading zero, and only to keep the value positive. */
function isMinimalPositive(hex: string): boolean {
  if (hex.length % 2 !== 0 || hex.length === 0) return false;
  const b = Buffer.from(hex, "hex");
  if (b[0] === 0) return b.length > 1 && b[1] >= 0x80; // a zero is allowed only when needed
  return true;                                          // no zero: must not look negative
}

describe("randomSerialHex", () => {
  it("emits no leading zero when the value is already positive", () => {
    expect(randomSerialHex(fixed(0x7f))).toMatch(/^7f/);
    expect(isMinimalPositive(randomSerialHex(fixed(0x7f)))).toBe(true);
  });

  it("emits exactly one leading zero when the top bit would read as negative", () => {
    const s = randomSerialHex(fixed(0xe1));
    expect(s).toMatch(/^00e1/);
    expect(isMinimalPositive(s)).toBe(true);
  });

  it("strips a random leading zero instead of adding a second — the exact broken case", () => {
    // 0x00 then 0x7f: the old code wrote 00 00 7f …, one zero too many, and the signature covered
    // bytes no reader would reproduce.
    const s = randomSerialHex(fixed(0x00, 0x7f));
    expect(s.startsWith("0000")).toBe(false);
    expect(s).toMatch(/^7f/);
    expect(isMinimalPositive(s)).toBe(true);
  });

  it("keeps one zero when stripping would expose a high-bit byte", () => {
    const s = randomSerialHex(fixed(0x00, 0xe1));
    expect(s).toMatch(/^00e1/);
    expect(isMinimalPositive(s)).toBe(true);
  });

  it("strips a run of zeros, not just one", () => {
    expect(randomSerialHex(fixed(0x00, 0x00, 0x00, 0x42))).toMatch(/^42/);
  });

  it("never yields zero, even from all-zero randomness", () => {
    const s = randomSerialHex(() => Buffer.alloc(16));
    expect(Buffer.from(s, "hex").some((b) => b !== 0)).toBe(true);
    expect(isMinimalPositive(s)).toBe(true);
  });

  it("holds the property over the whole space of first two bytes", () => {
    // Exhaustive where it matters and instant, versus thousands of certificates and minutes.
    for (let a = 0; a < 256; a++) {
      for (const b of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
        const s = randomSerialHex(fixed(a, b));
        expect(isMinimalPositive(s), `first=${a} second=${b} -> ${s}`).toBe(true);
      }
    }
  });
});

describe("issued certificates verify", () => {
  // One integration pass over both verifiers. The property tests above are the real guard; this
  // confirms the serial reaches the certificate intact and that nothing else in the path objects.
  it("is accepted by node-forge and by openssl, and its serial survives a round-trip", async () => {
    const mgr = await CertificateManager.create();
    const caPub = new crypto.X509Certificate(mgr.getCACertificate()).publicKey;
    for (let i = 0; i < 40; i++) {
      const { cert } = mgr.issueAgentBoxCertificate(`a-${i}`, "o", "b");
      expect(mgr.verifyCertificate(cert), `forge rejected #${i}`).not.toBeNull();
      expect(new crypto.X509Certificate(cert).verify(caPub), `openssl rejected #${i}`).toBe(true);
      const parsed = forge.pki.certificateFromPem(cert).serialNumber;
      expect(isMinimalPositive(parsed), `serial not minimal: ${parsed}`).toBe(true);
    }
  }, 120_000);

  it("the CA's own certificate is self-consistent", async () => {
    // A CA carrying the broken serial would take out the whole box, not one session.
    const mgr = await CertificateManager.create();
    const caPem = mgr.getCACertificate();
    const ca = forge.pki.certificateFromPem(caPem);
    expect(ca.verify(ca)).toBe(true);
    const x = new crypto.X509Certificate(caPem);
    expect(x.verify(x.publicKey)).toBe(true);
  }, 120_000);
});
