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

  it("uses the loaded CA's actual subject as the issuer of new certs (verifies under OpenSSL/Node)", async () => {
    clearCaEnv();
    // Generate a CA whose subject deliberately does NOT match the legacy
    // hardcoded "Siclaw Runtime CA, O=Siclaw, OU=Security" DN. This mirrors
    // what Helm `genCA "siclaw-runtime-ca"` produces (CN only, no O/OU).
    const kp = forge.pki.rsa.generateKeyPair(1024);
    const ca = forge.pki.createCertificate();
    ca.publicKey = kp.publicKey;
    ca.serialNumber = "03";
    ca.validity.notBefore = new Date();
    ca.validity.notAfter = new Date(Date.now() + 86400_000);
    ca.setSubject([{ name: "commonName", value: "siclaw-runtime-ca" }]);
    ca.setIssuer([{ name: "commonName", value: "siclaw-runtime-ca" }]);
    ca.setExtensions([{ name: "basicConstraints", cA: true }]);
    ca.sign(kp.privateKey, forge.md.sha256.create());

    process.env.SICLAW_CA_CERT = forge.pki.certificateToPem(ca);
    process.env.SICLAW_CA_KEY = forge.pki.privateKeyToPem(kp.privateKey);

    const m = await CertificateManager.create();
    const bundle = m.issueAgentBoxCertificate("agent-x", "org-x", "box-x");

    // Issuer DN of the issued cert must equal the CA's subject DN; otherwise
    // X.509 path validation rejects with "unable to verify the first
    // certificate" (see helm chart-managed CA bug).
    const issued = forge.pki.certificateFromPem(bundle.cert);
    const issuerCN = issued.issuer.attributes.find(a => a.name === "commonName")?.value;
    const issuerO = issued.issuer.attributes.find(a => a.name === "organizationName")?.value;
    expect(issuerCN).toBe("siclaw-runtime-ca");
    expect(issuerO).toBeUndefined();

    // The issuer DN must mirror the CA's subject DN exactly — same attribute
    // count, same names, same values. Anything else breaks chain validation.
    const dnEntries = (attrs: any[]) =>
      attrs
        .map(a => `${a.name}=${a.value}`)
        .sort()
        .join(",");
    expect(dnEntries(issued.issuer.attributes)).toBe(dnEntries(ca.subject.attributes));

    // Signature on the issued cert verifies under the loaded CA's public key.
    expect(ca.verify(issued)).toBe(true);
  }, 60_000);

  it("preserves the full CA Subject DN on issued certs (C/ST/L not just CN/O/OU)", async () => {
    clearCaEnv();
    // Mirror what cert-manager / Vault PKI / corporate CAs typically produce —
    // a multi-component DN with country, state, locality. A lossy {CN, O, OU}
    // projection would drop these and break X.509 chain validation.
    const kp = forge.pki.rsa.generateKeyPair(1024);
    const ca = forge.pki.createCertificate();
    ca.publicKey = kp.publicKey;
    ca.serialNumber = "05";
    ca.validity.notBefore = new Date();
    ca.validity.notAfter = new Date(Date.now() + 86400_000);
    const fullDn = [
      { name: "countryName", value: "US" },
      { name: "stateOrProvinceName", value: "California" },
      { name: "localityName", value: "San Francisco" },
      { name: "organizationName", value: "Acme Corp" },
      { name: "organizationalUnitName", value: "PKI" },
      { name: "commonName", value: "Acme Internal Root" },
    ];
    ca.setSubject(fullDn);
    ca.setIssuer(fullDn);
    ca.setExtensions([{ name: "basicConstraints", cA: true }]);
    ca.sign(kp.privateKey, forge.md.sha256.create());

    process.env.SICLAW_CA_CERT = forge.pki.certificateToPem(ca);
    process.env.SICLAW_CA_KEY = forge.pki.privateKeyToPem(kp.privateKey);

    const m = await CertificateManager.create();
    const bundle = m.issueAgentBoxCertificate("agent-y", "org-y", "box-y");
    const issued = forge.pki.certificateFromPem(bundle.cert);

    // Issued cert's issuer attributes must equal the CA's subject attributes
    // — same names, same values, same order. Anything dropped breaks chain
    // validation downstream.
    const dn = (attrs: any[]) =>
      attrs.map(a => `${a.name}=${a.value}`).join(",");
    expect(dn(issued.issuer.attributes)).toBe(dn(ca.subject.attributes));

    // Signature must verify under the CA's public key.
    expect(ca.verify(issued)).toBe(true);
  }, 60_000);

  it("accepts a CA whose subject has no Common Name (CN is not required by X.509)", async () => {
    clearCaEnv();
    const kp = forge.pki.rsa.generateKeyPair(1024);
    const ca = forge.pki.createCertificate();
    ca.publicKey = kp.publicKey;
    ca.serialNumber = "04";
    ca.validity.notBefore = new Date();
    ca.validity.notAfter = new Date(Date.now() + 86400_000);
    const cnLessDn = [
      { name: "organizationName", value: "no-cn-org" },
      { name: "organizationalUnitName", value: "PKI" },
    ];
    ca.setSubject(cnLessDn);
    ca.setIssuer(cnLessDn);
    ca.setExtensions([{ name: "basicConstraints", cA: true }]);
    ca.sign(kp.privateKey, forge.md.sha256.create());

    process.env.SICLAW_CA_CERT = forge.pki.certificateToPem(ca);
    process.env.SICLAW_CA_KEY = forge.pki.privateKeyToPem(kp.privateKey);

    const m = await CertificateManager.create();
    const bundle = m.issueAgentBoxCertificate("agent-z", "org-z", "box-z");
    const issued = forge.pki.certificateFromPem(bundle.cert);

    // Issuer DN mirrors the CA's CN-less subject DN.
    const dn = (attrs: any[]) => attrs.map(a => `${a.name}=${a.value}`).join(",");
    expect(dn(issued.issuer.attributes)).toBe(dn(ca.subject.attributes));
    expect(ca.verify(issued)).toBe(true);
  }, 60_000);
});

// ── issueAgentBoxCertificate + verifyCertificate round-trip ───────

describe("CertificateManager — issue + verify round-trip", () => {
  it("issues a client cert with the given identity and verifies back the same fields", () => {
    const bundle = manager.issueAgentBoxCertificate("agent-9", "org-42", "box-7");
    expect(bundle.cert).toContain("BEGIN CERTIFICATE");
    expect(bundle.key).toContain("PRIVATE KEY");
    expect(bundle.ca).toBe(manager.getCACertificate());
    expect(bundle.identity.agentId).toBe("agent-9");
    expect(bundle.identity.orgId).toBe("org-42");
    expect(bundle.identity.boxId).toBe("box-7");

    const verified = manager.verifyCertificate(bundle.cert);
    expect(verified).not.toBeNull();
    expect(verified!.agentId).toBe("agent-9");
    expect(verified!.orgId).toBe("org-42");
    expect(verified!.boxId).toBe("box-7");
  }, 60_000);

  it("encodes agentId as CN; no userId, no env — AgentBox is user-unaware and env-agnostic", () => {
    const bundle = manager.issueAgentBoxCertificate("agent-cn-test", "o", "b");
    const parsed = forge.pki.certificateFromPem(bundle.cert);

    const cn = parsed.subject.attributes.find(a => a.name === "commonName")?.value;
    expect(cn).toBe("agent-cn-test");

    // Removed dimensions: no OU (userId/env lived here), no L (env lived here).
    const ou = parsed.subject.attributes.find(a => a.name === "organizationalUnitName")?.value;
    expect(ou).toBeUndefined();
    const l = parsed.subject.attributes.find(a => a.name === "localityName")?.value;
    expect(l).toBeUndefined();

    expect((bundle.identity as any).userId).toBeUndefined();
    expect((bundle.identity as any).env).toBeUndefined();
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
