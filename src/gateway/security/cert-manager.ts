/**
 * Certificate Manager for mTLS authentication between Gateway and AgentBox
 *
 * Architecture:
 * - Gateway acts as CA (Certificate Authority)
 * - Each AgentBox receives a unique client certificate
 * - Certificate contains identity info (userId, workspaceId)
 * - Gateway validates certificates and extracts identity for authorization
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";

export interface CertificateIdentity {
  userId: string;
  workspaceId: string;
  boxId: string;
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
  private certDir: string;

  constructor(certDir: string = path.join(process.cwd(), ".siclaw", "certs")) {
    this.certDir = certDir;

    // Ensure cert directory exists
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
    }

    const caPath = path.join(certDir, "ca.crt");
    const keyPath = path.join(certDir, "ca.key");

    // Load or generate CA certificate
    if (fs.existsSync(caPath) && fs.existsSync(keyPath)) {
      this.caCert = fs.readFileSync(caPath, "utf-8");
      this.caKey = fs.readFileSync(keyPath, "utf-8");
      console.log("[cert-manager] Loaded existing CA certificate");
    } else {
      const ca = this.generateCA();
      this.caCert = ca.cert;
      this.caKey = ca.key;
      fs.writeFileSync(caPath, this.caCert);
      fs.writeFileSync(keyPath, this.caKey, { mode: 0o600 }); // Private key should be readable only by owner
      console.log("[cert-manager] Generated new CA certificate");
    }
  }

  /**
   * Generate CA (Certificate Authority) certificate
   */
  private generateCA(): { cert: string; key: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Create self-signed CA certificate
    const cert = this.createCertificate({
      subject: {
        CN: "Siclaw Gateway CA",
        O: "Siclaw",
        OU: "Security",
      },
      issuer: null, // Self-signed
      publicKey,
      signingKey: privateKey,
      isCA: true,
      validityDays: 3650, // 10 years
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
        CN: hostname, // Common Name = Gateway hostname
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
      validityDays: 90, // 90 days for server cert
      extendedKeyUsage: ["serverAuth"], // Server authentication only
    });

    console.log(`[cert-manager] Issued server certificate for ${hostname}`);

    return { cert, key: privateKey };
  }

  /**
   * Issue a client certificate for an AgentBox instance
   */
  issueAgentBoxCertificate(userId: string, workspaceId: string, boxId: string): CertificateBundle {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const cert = this.createCertificate({
      subject: {
        CN: userId, // Common Name = userId
        OU: workspaceId, // Organizational Unit = workspaceId
        O: "Siclaw",
        serialNumber: boxId, // Serial Number = boxId
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
      extendedKeyUsage: ["clientAuth"], // Client authentication only
    });

    console.log(`[cert-manager] Issued certificate for userId=${userId} workspaceId=${workspaceId} boxId=${boxId}`);

    return {
      cert,
      key: privateKey,
      ca: this.caCert,
      identity: {
        userId,
        workspaceId,
        boxId,
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
      // Parse client certificate
      const cert = forge.pki.certificateFromPem(clientCert);
      const caCert = forge.pki.certificateFromPem(this.caCert);

      // Verify certificate is signed by our CA
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

      // Check expiration
      const now = new Date();
      if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
        console.warn("[cert-manager] Certificate expired or not yet valid");
        return null;
      }

      // Extract identity from subject fields
      const subject = cert.subject.attributes;
      const userId = subject.find((attr: any) => attr.name === "commonName")?.value as string | undefined;
      const workspaceId = subject.find((attr: any) => attr.name === "organizationalUnitName")?.value as string | undefined;
      const boxId = subject.find((attr: any) => attr.name === "serialNumber")?.value as string | undefined;

      if (!userId || !workspaceId || !boxId) {
        console.warn("[cert-manager] Certificate missing required identity fields");
        return null;
      }

      return {
        userId,
        workspaceId,
        boxId,
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
   * Create X.509 certificate using node-forge
   */
  private createCertificate(opts: {
    subject: Record<string, string>;
    issuer: Record<string, string> | null;
    publicKey: string;
    signingKey: string;
    isCA: boolean;
    validityDays: number;
    extendedKeyUsage?: string[];
  }): string {
    // Convert PEM keys to forge format
    const publicKeyForge = forge.pki.publicKeyFromPem(opts.publicKey);
    const privateKeyForge = forge.pki.privateKeyFromPem(opts.signingKey);

    // Create certificate
    const cert = forge.pki.createCertificate();

    // Public key
    cert.publicKey = publicKeyForge;

    // Serial number (random)
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

    // Validity period
    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setDate(notBefore.getDate() + opts.validityDays);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;

    // Subject
    const subjectAttrs = [];
    if (opts.subject.CN) subjectAttrs.push({ name: "commonName", value: opts.subject.CN });
    if (opts.subject.O) subjectAttrs.push({ name: "organizationName", value: opts.subject.O });
    if (opts.subject.OU) subjectAttrs.push({ name: "organizationalUnitName", value: opts.subject.OU });
    if (opts.subject.serialNumber) subjectAttrs.push({ name: "serialNumber", value: opts.subject.serialNumber });
    cert.setSubject(subjectAttrs);

    // Issuer (self-signed if null)
    const issuerData = opts.issuer || opts.subject;
    const issuerAttrs = [];
    if (issuerData.CN) issuerAttrs.push({ name: "commonName", value: issuerData.CN });
    if (issuerData.O) issuerAttrs.push({ name: "organizationName", value: issuerData.O });
    if (issuerData.OU) issuerAttrs.push({ name: "organizationalUnitName", value: issuerData.OU });
    cert.setIssuer(issuerAttrs);

    // Extensions
    const extensions: any[] = [
      {
        name: "basicConstraints",
        cA: opts.isCA,
      },
      {
        name: "keyUsage",
        keyCertSign: opts.isCA,
        digitalSignature: true,
        keyEncipherment: true,
      },
    ];

    if (opts.extendedKeyUsage) {
      extensions.push({
        name: "extendedKeyUsage",
        clientAuth: opts.extendedKeyUsage.includes("clientAuth"),
        serverAuth: opts.extendedKeyUsage.includes("serverAuth"),
      });
    }

    cert.setExtensions(extensions);

    // Sign certificate
    cert.sign(privateKeyForge, forge.md.sha256.create());

    // Convert to PEM
    return forge.pki.certificateToPem(cert);
  }
}
