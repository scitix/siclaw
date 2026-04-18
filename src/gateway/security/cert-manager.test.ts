import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";
import { CertificateManager } from "./cert-manager.js";

/**
 * Clean env of any SICLAW_CA_* vars between tests so create() picks the
 * right loading branch deterministically.
 */
function clearCaEnv() {
  delete process.env.SICLAW_CA_CERT;
  delete process.env.SICLAW_CA_KEY;
  delete process.env.SICLAW_CA_CERT_FILE;
  delete process.env.SICLAW_CA_KEY_FILE;
}

let tmpDir: string;
let manager: CertificateManager;

// Cert generation is expensive (RSA keygen); share a manager across most tests.
beforeAll(async () => {
  clearCaEnv();
  manager = await CertificateManager.create();
}, 60_000);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-mgr-"));
});

afterEach(() => {
  clearCaEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Factory: create() ──────────────────────────────────────────────

describe("CertificateManager.create — loading priority", () => {
  it("generates an ephemeral CA when no env vars are set", async () => {
    clearCaEnv();
    const m = await CertificateManager.create();
    const caPem = m.getCACertificate();
    expect(caPem).toContain("BEGIN CERTIFICATE");
    expect(caPem).toContain("END CERTIFICATE");
  }, 60_000);

  it("loads CA from SICLAW_CA_CERT/KEY env vars when provided", async () => {
    clearCaEnv();
    // Generate a small inline CA (1024-bit for test speed) and inject via env.
    const kp = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = kp.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400_000);
    cert.setSubject([{ name: "commonName", value: "inline-ca" }]);
    cert.setIssuer([{ name: "commonName", value: "inline-ca" }]);
    cert.setExtensions([{ name: "basicConstraints", cA: true }]);
    cert.sign(kp.privateKey, forge.md.sha256.create());

    process.env.SICLAW_CA_CERT = forge.pki.certificateToPem(cert);
    process.env.SICLAW_CA_KEY = forge.pki.privateKeyToPem(kp.privateKey);

    const loaded = await CertificateManager.create();
    expect(loaded.getCACertificate()).toBe(process.env.SICLAW_CA_CERT);
  }, 60_000);

  it("loads CA from file paths when *_FILE env vars are set", async () => {
    const certPath = path.join(tmpDir, "ca.crt");
    const keyPath = path.join(tmpDir, "ca.key");

    // Generate a small CA inline (1024 bits — fast) for the file-load test.
    const kp = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = kp.publicKey;
    cert.serialNumber = "02";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400_000);
    cert.setSubject([{ name: "commonName", value: "file-ca" }]);
    cert.setIssuer([{ name: "commonName", value: "file-ca" }]);
    cert.setExtensions([{ name: "basicConstraints", cA: true }]);
    cert.sign(kp.privateKey, forge.md.sha256.create());

    fs.writeFileSync(certPath, forge.pki.certificateToPem(cert));
    fs.writeFileSync(keyPath, forge.pki.privateKeyToPem(kp.privateKey));

    clearCaEnv();
    process.env.SICLAW_CA_CERT_FILE = certPath;
    process.env.SICLAW_CA_KEY_FILE = keyPath;

    const m = await CertificateManager.create();
    expect(m.getCACertificate()).toContain("BEGIN CERTIFICATE");
  }, 60_000);

  it("falls back to ephemeral CA when file paths point at missing files", async () => {
    clearCaEnv();
    process.env.SICLAW_CA_CERT_FILE = path.join(tmpDir, "does-not-exist.crt");
    process.env.SICLAW_CA_KEY_FILE = path.join(tmpDir, "does-not-exist.key");
    const m = await CertificateManager.create();
    expect(m.getCACertificate()).toContain("BEGIN CERTIFICATE");
  }, 60_000);
});

// ── issueAgentBoxCertificate + verifyCertificate round-trip ───────

describe("CertificateManager — issue + verify round-trip", () => {
  it("issues a client cert with the given identity and verifies back the same fields", () => {
    const bundle = manager.issueAgentBoxCertificate("agent-9", "org-42", "box-7", "dev");
    expect(bundle.cert).toContain("BEGIN CERTIFICATE");
    expect(bundle.key).toContain("PRIVATE KEY");
    expect(bundle.ca).toBe(manager.getCACertificate());
    expect(bundle.identity.agentId).toBe("agent-9");
    expect(bundle.identity.orgId).toBe("org-42");
    expect(bundle.identity.boxId).toBe("box-7");
    expect(bundle.identity.env).toBe("dev");

    const verified = manager.verifyCertificate(bundle.cert);
    expect(verified).not.toBeNull();
    expect(verified!.agentId).toBe("agent-9");
    expect(verified!.orgId).toBe("org-42");
    expect(verified!.boxId).toBe("box-7");
    expect(verified!.env).toBe("dev");
  }, 60_000);

  it("defaults env to 'prod' when not specified", () => {
    const bundle = manager.issueAgentBoxCertificate("a", "o", "b");
    expect(bundle.identity.env).toBe("prod");
    const v = manager.verifyCertificate(bundle.cert);
    expect(v!.env).toBe("prod");
  }, 60_000);

  it("round-trips env=test", () => {
    const bundle = manager.issueAgentBoxCertificate("a", "o", "b", "test");
    const v = manager.verifyCertificate(bundle.cert);
    expect(v!.env).toBe("test");
  }, 60_000);

  it("encodes agentId as CN (not userId) — AgentBox is user-unaware", () => {
    const bundle = manager.issueAgentBoxCertificate("agent-cn-test", "o", "b");
    const parsed = forge.pki.certificateFromPem(bundle.cert);
    const cn = parsed.subject.attributes.find(a => a.name === "commonName")?.value;
    expect(cn).toBe("agent-cn-test");
    // OU should not carry agentId anymore
    const ou = parsed.subject.attributes.find(a => a.name === "organizationalUnitName")?.value;
    expect(ou).toBeUndefined();
    // Identity has no userId field
    expect((bundle.identity as any).userId).toBeUndefined();
  }, 60_000);
});

// ── verifyCertificate — failure modes ─────────────────────────────

describe("CertificateManager.verifyCertificate — rejections", () => {
  it("returns null for a completely invalid PEM string", () => {
    expect(manager.verifyCertificate("not a certificate")).toBeNull();
  });

  it("returns null for a cert not signed by this CA", async () => {
    // Generate an independent CA and issue a cert under it.
    const other = await CertificateManager.create();
    const bundle = other.issueAgentBoxCertificate("a", "o", "b");
    expect(manager.verifyCertificate(bundle.cert)).toBeNull();
  }, 60_000);

  it("returns null for a malformed PEM-shaped string", () => {
    expect(manager.verifyCertificate("-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----")).toBeNull();
  });
});

// ── issueServerCertificate ────────────────────────────────────────

describe("CertificateManager.issueServerCertificate", () => {
  it("emits a PEM cert/key pair for the given hostname", () => {
    const { cert, key } = manager.issueServerCertificate("runtime.internal");
    expect(cert).toContain("BEGIN CERTIFICATE");
    expect(key).toContain("PRIVATE KEY");

    const parsed = forge.pki.certificateFromPem(cert);
    const cn = parsed.subject.attributes.find(a => a.name === "commonName")?.value;
    expect(cn).toBe("runtime.internal");
  }, 60_000);
});

// ── getCACertificate ──────────────────────────────────────────────

describe("CertificateManager.getCACertificate", () => {
  it("returns the CA in PEM form", () => {
    const pem = manager.getCACertificate();
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(pem).toMatch(/-----END CERTIFICATE-----\s*$/);
  });
});
