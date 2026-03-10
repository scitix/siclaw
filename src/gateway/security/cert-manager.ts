/**
 * Certificate Manager for mTLS authentication between Gateway and AgentBox
 *
 * Architecture:
 * - Gateway acts as CA (Certificate Authority)
 * - CA cert + key persisted in DB (system_config table) to survive pod restarts
 * - Each AgentBox receives a unique client certificate
 * - Certificate contains identity info (userId, workspaceId)
 * - Gateway validates certificates and extracts identity for authorization
 */

import crypto from "node:crypto";
import forge from "node-forge";
import type { SystemConfigRepository } from "../db/repositories/system-config-repo.js";

/** CA validity: 10 years */
const CA_VALIDITY_DAYS = 3650;
/** Renew CA when less than 30 days remaining */
const CA_RENEW_THRESHOLD_DAYS = 30;

export interface CertificateIdentity {
  userId: string;
  workspaceId: string;
  boxId: string;
  env: "prod" | "dev" | "test";
  issuedAt: Date;
  expiresAt: Date;
}

export interface CertificateBundle {
  /** Client certificate (PEM format) */
  cert: string;
  /** Client private key (PEM format) */
  key: string;
  /** CA certificate for server verification (PEM format) */
  ca: string;
  /** Parsed identity from certificate */
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
   * - With DB: loads CA from system_config, generates + persists if absent or expiring soon
   * - Without DB (local dev): generates ephemeral CA in memory
   */
  static async create(configRepo: SystemConfigRepository | null): Promise<CertificateManager> {
    if (configRepo) {
      return CertificateManager.createWithDb(configRepo);
    }
    // No DB — ephemeral CA for local development
    console.log("[cert-manager] No database available, generating ephemeral CA");
    const ca = CertificateManager.generateCA();
    return new CertificateManager(ca.cert, ca.key);
  }

  private static async createWithDb(configRepo: SystemConfigRepository): Promise<CertificateManager> {
    const existingCert = await configRepo.get("ca.cert");
    const existingKey = await configRepo.get("ca.key");

    if (existingCert && existingKey) {
      // Check if CA is expiring soon
      const needsRenew = CertificateManager.isCAExpiringSoon(existingCert);
      if (!needsRenew) {
        console.log("[cert-manager] Loaded CA certificate from database");
        return new CertificateManager(existingCert, existingKey);
      }
      console.log("[cert-manager] CA certificate expiring soon, regenerating");
    }

    // Generate new CA and persist to DB
    const ca = CertificateManager.generateCA();
    await configRepo.set("ca.cert", ca.cert);
    await configRepo.set("ca.key", ca.key);
    console.log("[cert-manager] Generated new CA certificate and saved to database");

    return new CertificateManager(ca.cert, ca.key);
  }

  /**
   * Check if CA cert expires within CA_RENEW_THRESHOLD_DAYS
   */
  private static isCAExpiringSoon(certPem: string): boolean {
    try {
      const cert = forge.pki.certificateFromPem(certPem);
      const now = new Date();
      const threshold = new Date(now.getTime() + CA_RENEW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
      return cert.validity.notAfter < threshold;
    } catch {
      // Can't parse — treat as expired
      return true;
    }
  }

  /**
   * Generate CA (Certificate Authority) certificate
   */
  private static generateCA(): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const cert = CertificateManager.createCertificateStatic({
      subject: {
        CN: "Siclaw Gateway CA",
        O: "Siclaw",
        OU: "Security",
      },
      issuer: null,
      publicKey,
      signingKey: privateKey,
      isCA: true,
      validityDays: CA_VALIDITY_DAYS,
    });

    return { cert, key: privateKey };
  }

  /**
   * Issue a server certificate for Gateway
   */
  issueServerCertificate(hostname: string): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const cert = this.createCertificate({
      subject: {
        CN: hostname,
        O: "Siclaw",
        OU: "Gateway",
      },
      issuer: {
        CN: "Siclaw Gateway CA",
        O: "Siclaw",
        OU: "Security",
      },
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
   * Issue a client certificate for an AgentBox instance
   */
  issueAgentBoxCertificate(userId: string, workspaceId: string, boxId: string, env: "prod" | "dev" | "test" = "prod"): CertificateBundle {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const cert = this.createCertificate({
      subject: {
        CN: userId,
        OU: workspaceId,
        O: "Siclaw",
        serialNumber: boxId,
        L: env,
      },
      issuer: {
        CN: "Siclaw Gateway CA",
        O: "Siclaw",
        OU: "Security",
      },
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: 30,
      extendedKeyUsage: ["clientAuth", "serverAuth"],
    });

    console.log(`[cert-manager] Issued certificate for userId=${userId} workspaceId=${workspaceId} boxId=${boxId} env=${env}`);

    return {
      cert,
      key: privateKey,
      ca: this.caCert,
      identity: {
        userId,
        workspaceId,
        boxId,
        env,
        issuedAt,
        expiresAt,
      },
    };
  }

  /**
   * Verify and extract identity from a client certificate
   */
  verifyCertificate(clientCert: string): CertificateIdentity | null {
    try {
      const cert = forge.pki.certificateFromPem(clientCert);
      const caCert = forge.pki.certificateFromPem(this.caCert);

      try {
        const isValid = caCert.verify(cert);
        if (!isValid) {
          console.warn("[cert-manager] Certificate verification failed: not signed by CA");
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
      const userId = subject.find((attr: any) => attr.name === "commonName")?.value as string | undefined;
      const workspaceId = subject.find((attr: any) => attr.name === "organizationalUnitName")?.value as string | undefined;
      const boxId = subject.find((attr: any) => attr.name === "serialNumber")?.value as string | undefined;
      const envRaw = subject.find((attr: any) => attr.name === "localityName")?.value as string | undefined;
      const env = (envRaw === "dev" ? "dev" : envRaw === "test" ? "test" : "prod") as "prod" | "dev" | "test";

      if (!userId || !workspaceId || !boxId) {
        console.warn("[cert-manager] Certificate missing required identity fields");
        return null;
      }

      return {
        userId,
        workspaceId,
        boxId,
        env,
        issuedAt: cert.validity.notBefore,
        expiresAt: cert.validity.notAfter,
      };
    } catch (err) {
      console.error("[cert-manager] Certificate verification error:", err);
      return null;
    }
  }

  /**
   * Get CA certificate (for AgentBox to verify Gateway)
   */
  getCACertificate(): string {
    return this.caCert;
  }

  /**
   * Instance method — delegates to static
   */
  private createCertificate(opts: CertOpts): string {
    return CertificateManager.createCertificateStatic(opts);
  }

  /**
   * Create X.509 certificate using node-forge
   */
  private static createCertificateStatic(opts: CertOpts): string {
    const publicKeyForge = forge.pki.publicKeyFromPem(opts.publicKey);
    const privateKeyForge = forge.pki.privateKeyFromPem(opts.signingKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKeyForge;
    // Ensure positive serial number: clear the high bit to avoid negative ASN.1 INTEGER
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
