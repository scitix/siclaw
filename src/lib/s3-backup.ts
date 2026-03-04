/**
 * S3/OSS Backup Utility
 *
 * Optional — enabled when SICLAW_S3_ENDPOINT + SICLAW_S3_BUCKET env vars are set.
 * Compatible with AWS S3, Aliyun OSS, MinIO, etc.
 */

import fs from "node:fs";
import path from "node:path";

export interface S3BackupConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export class S3Backup {
  private config: S3BackupConfig;
  private client: any = null;

  constructor(config: S3BackupConfig) {
    this.config = config;
  }

  /** Lazy-load S3 client (avoids import cost when not used) */
  private async getClient() {
    if (this.client) return this.client;

    try {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({
        endpoint: this.config.endpoint,
        region: this.config.region || "us-east-1",
        credentials: {
          accessKeyId: this.config.accessKey,
          secretAccessKey: this.config.secretKey,
        },
        forcePathStyle: true,
      });
      return this.client;
    } catch {
      console.warn("[s3-backup] @aws-sdk/client-s3 not installed, S3 backup disabled");
      return null;
    }
  }

  /** Upload a single file */
  async uploadFile(key: string, content: Buffer | string): Promise<void> {
    const client = await this.getClient();
    if (!client) return;

    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: typeof content === "string" ? Buffer.from(content) : content,
      }),
    );
  }

  /** Upload all files in a directory recursively */
  async uploadDir(prefix: string, localDir: string): Promise<void> {
    if (!fs.existsSync(localDir)) return;

    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const s3Key = `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        // Skip .git
        if (entry.name === ".git") continue;
        await this.uploadDir(s3Key, localPath);
      } else {
        const content = fs.readFileSync(localPath);
        await this.uploadFile(s3Key, content);
      }
    }
  }

  /** Check if S3 is configured */
  isEnabled(): boolean {
    return !!(this.config.endpoint && this.config.bucket);
  }

  /** Create from environment variables (returns null if not configured) */
  static fromEnv(): S3Backup | null {
    const endpoint = process.env.SICLAW_S3_ENDPOINT;
    const bucket = process.env.SICLAW_S3_BUCKET;
    const accessKey = process.env.SICLAW_S3_ACCESS_KEY;
    const secretKey = process.env.SICLAW_S3_SECRET_KEY;

    if (!endpoint || !bucket || !accessKey || !secretKey) {
      return null;
    }

    return new S3Backup({ endpoint, bucket, accessKey, secretKey });
  }
}
