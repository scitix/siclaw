/**
 * Certificate Manager for mTLS authentication between Runtime and AgentBox.
 *
 * Architecture:
 * - Runtime acts as CA (Certificate Authority)
 * - CA cert + key loaded from environment or generated ephemerally
 * - Each AgentBox receives a unique client certificate
 * - Certificate contains identity: userId (CN), agentId (OU), orgId (O)
 * - Runtime validates certificates and extracts identity for authorization
 *
 * Certificate subject fields (per integration spec §5.3):
 *   CN = userId
 *   OU = agentId          (was workspaceId)
 *   O  = orgId            (new)
 *   serialNumber = boxId
 *   L  = env              (prod | dev | test)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import forge from "node-forge";

/** CA validity: 10 years */
const CA_VALIDITY_DAYS = 3650;

export interface CertificateIdentity {
  userId: string;
  agentId: string;
  orgId: string;
  boxId: string;
  env: "prod" | "dev" | "test";
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

  private constructor(caCert: string, caKey: string) {
    this.caCert = caCert;
    this.caKey = caKey;
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

  /** Issue a server certificate for the Runtime itself. */
  issueServerCertificate(hostname: string): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: hostname, O: "Siclaw", OU: "Runtime" },
      issuer: { CN: "Siclaw Runtime CA", O: "Siclaw", OU: "Security" },
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: 90,
      extendedKeyUsage: ["serverAuth", "clientAuth"],
    });

    console.log(`[cert-manager] Issued server certificate for ${hostname}`);
    return { cert, key: privateKey };
  }

  /**
   * Issue a client certificate for an AgentBox instance.
   *
   * Identity fields embedded in the certificate:
   *   CN = userId, OU = agentId, O = orgId, serialNumber = boxId, L = env
   */
  issueAgentBoxCertificate(
    userId: string,
    agentId: string,
    orgId: string,
    boxId: string,
    env: "prod" | "dev" | "test" = "prod",
  ): CertificateBundle {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: userId, OU: agentId, O: orgId, serialNumber: boxId, L: env },
      issuer: { CN: "Siclaw Runtime CA", O: "Siclaw", OU: "Security" },
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: 30,
      extendedKeyUsage: ["clientAuth", "serverAuth"],
    });

    console.log(`[cert-manager] Issued certificate userId=${userId} agentId=${agentId} orgId=${orgId} boxId=${boxId} env=${env}`);

    return {
      cert,
      key: privateKey,
      ca: this.caCert,
      identity: { userId, agentId, orgId, boxId, env, issuedAt, expiresAt },
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

      const userId = getAttr("commonName");
      const agentId = getAttr("organizationalUnitName");
      const orgId = getAttr("organizationName") || "";
      const boxId = getAttr("serialNumber");
      const envRaw = getAttr("localityName");
      const env = (envRaw === "dev" ? "dev" : envRaw === "test" ? "test" : "prod") as CertificateIdentity["env"];

      if (!userId || !agentId || !boxId) {
        console.warn("[cert-manager] Certificate missing required identity fields");
        return null;
      }

      return { userId, agentId, orgId, boxId, env, issuedAt: cert.validity.notBefore, expiresAt: cert.validity.notAfter };
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
    if (opts.subject.L) subjectAttrs.push({ name: "localityName", value: opts.subject.L });
    cert.setSubject(subjectAttrs);

    const issuerData = opts.issuer || opts.subject;
    const issuerAttrs = [];
    if (issuerData.CN) issuerAttrs.push({ name: "commonName", value: issuerData.CN });
    if (issuerData.O) issuerAttrs.push({ name: "organizationName", value: issuerData.O });
    if (issuerData.OU) issuerAttrs.push({ name: "organizationalUnitName", value: issuerData.OU });
    cert.setIssuer(issuerAttrs);

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

    cert.setExtensions(extensions);
    cert.sign(privateKeyForge, forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
}

interface CertOpts {
  subject: Record<string, string>;
  issuer: Record<string, string> | null;
  publicKey: string;
  signingKey: string;
  isCA: boolean;
  validityDays: number;
  extendedKeyUsage?: string[];
}
