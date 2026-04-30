/**
 * Certificate Manager for mTLS authentication between Runtime and AgentBox.
 *
 * Architecture:
 * - Runtime acts as CA (Certificate Authority)
 * - CA cert + key loaded from environment or generated ephemerally
 * - Each AgentBox receives a unique client certificate keyed on its agentId
 * - Runtime validates certificates and extracts identity for authorization
 *
 * Certificate subject fields (the zero-trust source of truth for agentbox
 * identity — agentbox cannot self-report any of these):
 *   CN           = agentId — primary identity, used for mTLS authz + routing
 *   O            = orgId   — RBAC scope
 *   serialNumber = boxId   — pod/process identifier for audit correlation
 *
 * `is_production` is deliberately NOT encoded in the cert. The current
 * value is looked up from the agents table on every authz decision in
 * Upstream (SQL join on agents.is_production = resource.is_production) —
 * this way a toggle reflects immediately without requiring pod rebuild
 * or cert re-issue. AgentBox is user-unaware end-to-end: no userId in
 * cert, no userId in request payloads; user attribution is resolved at
 * Runtime boundaries via sessionId.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import forge from "node-forge";

/** CA validity: 10 years */
const CA_VALIDITY_DAYS = 3650;

export interface CertificateIdentity {
  agentId: string;
  orgId: string;
  boxId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface CertificateBundle {
  cert: string;
  key: string;
  ca: string;
  identity: CertificateIdentity;
}

export class CertificateManager {
  private caCert: string;
  private caKey: string;
  /**
   * Subject attributes of the loaded CA, in their original forge form.
   *
   * Issued certs MUST reference the exact subject of the signing CA — X.509
   * path validation does a byte-wise DN comparison. We carry the attribute
   * array through verbatim (instead of projecting onto a {CN, O, OU} shape)
   * so external CAs that include C / ST / L / serialNumber / etc.
   * (cert-manager, Vault PKI, corporate roots) still produce a matching
   * Issuer↔Subject pair.
   */
  private readonly caSubjectAttrs: any[];

  private constructor(caCert: string, caKey: string) {
    this.caCert = caCert;
    this.caKey = caKey;
    const ca = forge.pki.certificateFromPem(caCert);
    // Carry the CA's subject attribute array verbatim — every field flows
    // into issued certs as-is. X.509 does not require a Common Name in the
    // subject, and externally-managed CAs (cert-manager / Vault PKI / org
    // roots) sometimes omit it; we accept whatever the CA presents.
    this.caSubjectAttrs = ca.subject.attributes;
  }

  /**
   * Create a CertificateManager instance.
   *
   * Priority:
   *   1. SICLAW_CA_CERT / SICLAW_CA_KEY env vars (PEM strings)
   *   2. SICLAW_CA_CERT_FILE / SICLAW_CA_KEY_FILE env vars (file paths)
   *   3. Generate ephemeral CA (local dev / first run)
   */
  static async create(): Promise<CertificateManager> {
    // Try direct PEM from env
    const envCert = process.env.SICLAW_CA_CERT;
    const envKey = process.env.SICLAW_CA_KEY;
    if (envCert && envKey) {
      console.log("[cert-manager] Loaded CA from environment variables");
      return new CertificateManager(envCert, envKey);
    }

    // Try file paths from env
    const certFile = process.env.SICLAW_CA_CERT_FILE;
    const keyFile = process.env.SICLAW_CA_KEY_FILE;
    if (certFile && keyFile) {
      try {
        const cert = fs.readFileSync(certFile, "utf-8");
        const key = fs.readFileSync(keyFile, "utf-8");
        console.log(`[cert-manager] Loaded CA from files: ${certFile}`);
        return new CertificateManager(cert, key);
      } catch (err) {
        console.warn(`[cert-manager] Failed to read CA files: ${err}`);
      }
    }

    // Ephemeral CA
    console.log("[cert-manager] Generating ephemeral CA (configure SICLAW_CA_CERT/KEY for persistence)");
    const ca = CertificateManager.generateCA();
    return new CertificateManager(ca.cert, ca.key);
  }

  /**
   * Issue a server certificate for the Runtime itself.
   *
   * The SAN list always includes `127.0.0.1` and `localhost` so that
   * in-process (local mode) clients connecting over loopback pass hostname
   * verification. K8s clients use the primary hostname which is also in SAN.
   */
  issueServerCertificate(hostname: string): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: hostname, O: "Siclaw", OU: "Runtime" },
      issuerAttrs: this.caSubjectAttrs,
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: 90,
      extendedKeyUsage: ["serverAuth", "clientAuth"],
      subjectAltNames: buildServerSans(hostname),
    });

    console.log(`[cert-manager] Issued server certificate for ${hostname}`);
    return { cert, key: privateKey };
  }

  /**
   * Issue a client certificate for an AgentBox instance.
   *
   * Identity fields embedded in the certificate:
   *   CN = agentId, O = orgId, serialNumber = boxId
   */
  issueAgentBoxCertificate(
    agentId: string,
    orgId: string,
    boxId: string,
  ): CertificateBundle {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: agentId, O: orgId, serialNumber: boxId },
      issuerAttrs: this.caSubjectAttrs,
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: 30,
      extendedKeyUsage: ["clientAuth", "serverAuth"],
      // AgentBox cert is also used to terminate HTTPS on the AgentBox side.
      // Include SANs so the Runtime (and any mTLS client) can verify hostnames
      // when connecting over loopback (local mode) or K8s service DNS.
      subjectAltNames: [
        { type: 7, ip: "127.0.0.1" },
        { type: 2, value: "localhost" },
        { type: 2, value: agentId },
        { type: 2, value: `siclaw-agentbox-${agentId}` },
      ],
    });

    console.log(`[cert-manager] Issued certificate agentId=${agentId} orgId=${orgId} boxId=${boxId}`);

    return {
      cert,
      key: privateKey,
      ca: this.caCert,
      identity: { agentId, orgId, boxId, issuedAt, expiresAt },
    };
  }

  /** Verify and extract identity from a client certificate. */
  verifyCertificate(clientCert: string): CertificateIdentity | null {
    try {
      const cert = forge.pki.certificateFromPem(clientCert);
      const caCert = forge.pki.certificateFromPem(this.caCert);

      try {
        if (!caCert.verify(cert)) {
          console.warn("[cert-manager] Certificate not signed by CA");
          return null;
        }
      } catch (verifyErr) {
        console.warn("[cert-manager] Certificate verification failed:", verifyErr);
        return null;
      }

      const now = new Date();
      if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
        console.warn("[cert-manager] Certificate expired or not yet valid");
        return null;
      }

      const subject = cert.subject.attributes;
      const getAttr = (name: string) =>
        subject.find((attr: any) => attr.name === name)?.value as string | undefined;

      const agentId = getAttr("commonName");
      const orgId = getAttr("organizationName") || "";
      const boxId = getAttr("serialNumber");

      if (!agentId || !boxId) {
        console.warn("[cert-manager] Certificate missing required identity fields");
        return null;
      }

      return { agentId, orgId, boxId, issuedAt: cert.validity.notBefore, expiresAt: cert.validity.notAfter };
    } catch (err) {
      console.error("[cert-manager] Certificate verification error:", err);
      return null;
    }
  }

  getCACertificate(): string {
    return this.caCert;
  }

  private static generateCA(): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: "Siclaw Runtime CA", O: "Siclaw", OU: "Security" },
      issuer: null,
      publicKey,
      signingKey: privateKey,
      isCA: true,
      validityDays: CA_VALIDITY_DAYS,
    });

    return { cert, key: privateKey };
  }

  private static createCertificateStatic(opts: CertOpts): string {
    const publicKeyForge = forge.pki.publicKeyFromPem(opts.publicKey);
    const privateKeyForge = forge.pki.privateKeyFromPem(opts.signingKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKeyForge;
    const serialBytes = forge.random.getBytesSync(16);
    cert.serialNumber = "00" + forge.util.bytesToHex(serialBytes);

    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setDate(notBefore.getDate() + opts.validityDays);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;

    const subjectAttrs = [];
    if (opts.subject.CN) subjectAttrs.push({ name: "commonName", value: opts.subject.CN });
    if (opts.subject.O) subjectAttrs.push({ name: "organizationName", value: opts.subject.O });
    if (opts.subject.OU) subjectAttrs.push({ name: "organizationalUnitName", value: opts.subject.OU });
    if (opts.subject.serialNumber) subjectAttrs.push({ name: "serialNumber", value: opts.subject.serialNumber });
    cert.setSubject(subjectAttrs);

    if (opts.issuerAttrs) {
      // Byte-exact copy of the CA's subject DN — preserves every attribute
      // (C / ST / L / serialNumber / …) so X.509 path validation, which does
      // a byte-wise Issuer↔Subject comparison, accepts the chain.
      cert.setIssuer(opts.issuerAttrs);
    } else {
      // Self-sign or string-shape fallback (used by `generateCA`).
      const issuerData = opts.issuer || opts.subject;
      const issuerAttrs = [];
      if (issuerData.CN) issuerAttrs.push({ name: "commonName", value: issuerData.CN });
      if (issuerData.O) issuerAttrs.push({ name: "organizationName", value: issuerData.O });
      if (issuerData.OU) issuerAttrs.push({ name: "organizationalUnitName", value: issuerData.OU });
      cert.setIssuer(issuerAttrs);
    }

    const extensions: any[] = [
      { name: "basicConstraints", cA: opts.isCA },
      { name: "keyUsage", keyCertSign: opts.isCA, digitalSignature: true, keyEncipherment: true },
    ];
    if (opts.extendedKeyUsage) {
      extensions.push({
        name: "extKeyUsage",
        clientAuth: opts.extendedKeyUsage.includes("clientAuth"),
        serverAuth: opts.extendedKeyUsage.includes("serverAuth"),
      });
    }
    if (opts.subjectAltNames && opts.subjectAltNames.length > 0) {
      extensions.push({
        name: "subjectAltName",
        altNames: opts.subjectAltNames,
      });
    }

    cert.setExtensions(extensions);
    cert.sign(privateKeyForge, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
}

/**
 * Build SAN entries for a Runtime server cert. Always includes 127.0.0.1 +
 * localhost for loopback clients. If `hostname` parses as IP it's added as
 * type=7 (iPAddress); otherwise as type=2 (dNSName).
 */
function buildServerSans(hostname: string): Array<{ type: number; value?: string; ip?: string }> {
  const sans: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 7, ip: "127.0.0.1" },
    { type: 2, value: "localhost" },
  ];
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
    sans.push(isIpAddress(hostname) ? { type: 7, ip: hostname } : { type: 2, value: hostname });
  }
  return sans;
}

function isIpAddress(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
}

interface CertOpts {
  subject: Record<string, string>;
  /**
   * Byte-exact issuer attributes copied from the signing CA's subject DN.
   * Takes precedence over `issuer` when set.
   */
  issuerAttrs?: any[];
  issuer?: Record<string, string> | null;
  publicKey: string;
  signingKey: string;
  isCA: boolean;
  validityDays: number;
  extendedKeyUsage?: string[];
  subjectAltNames?: Array<{ type: number; value?: string; ip?: string }>;
}
