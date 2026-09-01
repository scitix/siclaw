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

/**
 * How long an AgentBox client certificate lives.
 *
 * ⚠️ COUPLED TO k8s-spawner's CERT_RENEW_THRESHOLD_MS, which must stay comfortably
 * below it — renewal replaces a certificate once it is within the threshold of
 * expiring, so a validity SHORTER than the threshold would mean every certificate is
 * always due for renewal: re-minted on every tick and on every cold spawn. There is a
 * test binding the two; shortening this without revisiting that is the trap.
 */
export const AGENTBOX_CERT_VALIDITY_DAYS = 30;

/** CA validity: 10 years */
const CA_VALIDITY_DAYS = 3650;

/**
 * A random serial as a MINIMAL positive DER integer.
 *
 * `"00" + hex(16 random bytes)` produced roughly one certificate in 512 that its own CA rejected,
 * and this is why. A DER INTEGER must carry no redundant leading zero: one is required only when the
 * first byte would otherwise look negative. The blind prefix broke that whenever the random part
 * already began with 0x00 AND the byte after it was below 0x80 — the encoder wrote 17 bytes, any
 * reader normalised them back to 16, and the re-encoded TBSCertificate was then one byte shorter
 * than the bytes the signature covered. Measured: the TBS went 421 → 420 with the enclosing SEQUENCE
 * length dropping a1 → a0, so both node-forge and openssl refused the signature, openssl calling it
 * `illegal padding`. 1/256 for the leading zero times 1/2 for the high bit is 1/512, which is the
 * rate observed over several thousand issuances.
 *
 * The bug needed BOTH conditions, which is what made it look random and survive a first inspection:
 * a leading zero followed by a high-bit byte is legal and verifies fine.
 */
export function randomSerialHex(randomBytes: (n: number) => Buffer = crypto.randomBytes): string {
  // Strip the leading zeros DER would not allow.
  let bytes = Array.from(randomBytes(16));
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
  // A serial must be positive and non-zero; ensure a value even in the astronomically unlikely
  // all-zero case.
  if (bytes.length === 1 && bytes[0] === 0) bytes = [1];
  // ONE zero, and only when the top bit would otherwise mark it negative.
  if (bytes[0] >= 0x80) bytes.unshift(0);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    const expiresAt = new Date(issuedAt.getTime() + AGENTBOX_CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

    const cert = CertificateManager.createCertificateStatic({
      subject: { CN: agentId, O: orgId, serialNumber: boxId },
      issuerAttrs: this.caSubjectAttrs,
      publicKey,
      signingKey: this.caKey,
      isCA: false,
      validityDays: AGENTBOX_CERT_VALIDITY_DAYS,
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

  /**
   * Read the identity a certificate ASSERTS, without judging whether it is still
   * usable. Returns undefined only when the PEM cannot be parsed at all.
   *
   * ⚠️ NOT AN AUTHENTICATION PRIMITIVE — it checks neither the CA signature nor the
   * validity window, so it must never gate a request; verifyCertificate is what does
   * that. It exists for renewal: reissuing a certificate has to carry the SAME
   * subject forward (the org in particular, which nothing else on the stored Secret
   * records). Steady-state renewal runs a week early and so normally sees a valid
   * certificate; the reason verifyCertificate cannot be used anyway is the RECOVERY
   * case — an already-lapsed certificate, which it correctly refuses to say anything
   * about, and which is exactly what an agent that has already gone dark is holding.
   *
   * The caller must cross-check what this returns against an independent witness
   * before acting on it; k8s-spawner compares it with the Secret's own agent label.
   */
  readAssertedIdentity(clientCert: string): { agentId: string; orgId: string; boxId: string } | undefined {
    try {
      const cert = forge.pki.certificateFromPem(clientCert);
      const getAttr = (name: string) =>
        cert.subject.attributes.find((attr: any) => attr.name === name)?.value as string | undefined;
      const agentId = getAttr("commonName");
      const boxId = getAttr("serialNumber");
      if (!agentId || !boxId) return undefined;
      return { agentId, orgId: getAttr("organizationName") || "", boxId };
    } catch {
      return undefined;
    }
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

  /**
   * Short, stable fingerprint of the current CA certificate (sha256 of the PEM,
   * first 16 hex chars). Used to stamp AgentBox pods so the runtime can detect
   * pods whose mTLS certs were signed by a now-rotated CA — those pods can no
   * longer complete mTLS in either direction and must be recycled. Two managers
   * loading the same CA PEM produce the same fingerprint; a regenerated CA
   * produces a different one.
   */
  caFingerprint(): string {
    return crypto.createHash("sha256").update(this.caCert).digest("hex").slice(0, 16);
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
    // See randomSerialHex — the previous `"00" + hex(random)` made ~1 certificate in 512
    // unverifiable by its own CA.
    const publicKeyForge = forge.pki.publicKeyFromPem(opts.publicKey);
    const privateKeyForge = forge.pki.privateKeyFromPem(opts.signingKey);

    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKeyForge;
    cert.serialNumber = randomSerialHex();

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
