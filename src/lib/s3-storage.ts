/**
 * S3/OSS Storage Utility
 *
 * Primary storage for skill versions — must be reliable with retries.
 * Compatible with AWS S3, Aliyun OSS, MinIO, etc.
 */

import fs from "node:fs";
import path from "node:path";

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

export class S3Storage {
  private config: S3StorageConfig;
  private client: any = null;

  constructor(config: S3StorageConfig) {
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
      console.warn("[s3-storage] @aws-sdk/client-s3 not installed, S3 storage disabled");
      return null;
    }
  }

  /** Retry wrapper for reliability (S3 is primary storage) */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error("unreachable");
  }

  /** Upload a single file */
  async uploadFile(key: string, content: Buffer | string): Promise<void> {
    await this.withRetry(async () => {
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
    });
  }

  /** Upload all files in a directory recursively */
  async uploadDir(prefix: string, localDir: string): Promise<void> {
    await this.withRetry(async () => {
      if (!fs.existsSync(localDir)) return;
      await this._uploadDirInner(prefix, localDir);
    });
  }

  private async _uploadDirInner(prefix: string, localDir: string): Promise<void> {
    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const s3Key = `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await this._uploadDirInner(s3Key, localPath);
      } else {
        const content = fs.readFileSync(localPath);
        const client = await this.getClient();
        if (!client) return;
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        await client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: s3Key,
            Body: content,
          }),
        );
      }
    }
  }

  /** Download a single file, returns null on NoSuchKey */
  async downloadFile(key: string): Promise<Buffer | null> {
    return this.withRetry(async () => {
      const client = await this.getClient();
      if (!client) return null;

      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        const resp = await client.send(
          new GetObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
          }),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Buffer>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      } catch (err: any) {
        if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") return null;
        throw err;
      }
    });
  }

  /** Download all files under a prefix to a local directory */
  async downloadDir(prefix: string, localDir: string): Promise<void> {
    await this.withRetry(async () => {
      const keys = await this._listKeysInner(prefix);
      for (const key of keys) {
        const relativePath = key.slice(prefix.length).replace(/^\//, "");
        if (!relativePath) continue;
        const localPath = path.join(localDir, relativePath);
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const content = await this.downloadFile(key);
        if (content) fs.writeFileSync(localPath, content);
      }
    });
  }

  /** List all object keys under a prefix (with pagination) */
  async listKeys(prefix: string): Promise<string[]> {
    return this.withRetry(() => this._listKeysInner(prefix));
  }

  private async _listKeysInner(prefix: string): Promise<string[]> {
    const client = await this.getClient();
    if (!client) return [];

    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      if (resp.Contents) {
        for (const obj of resp.Contents) {
          if (obj.Key) keys.push(obj.Key);
        }
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  /** Delete all objects under a prefix */
  async deleteDir(prefix: string): Promise<void> {
    const client = await this.getClient();
    if (!client) return;

    const keys = await this._listKeysInner(prefix);
    if (keys.length === 0) return;

    const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");

    // Delete in batches of 1000 (S3 limit)
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
          },
        }),
      );
    }
  }

  /** Check if S3 is configured */
  isEnabled(): boolean {
    return !!(this.config.endpoint && this.config.bucket);
  }

  /**
   * Create from DB config → environment variables.
   * Priority: dbConfig > SICLAW_S3_* env vars > null
   */
  static create(dbConfig?: Record<string, string>): S3Storage | null {
    const endpoint = dbConfig?.["s3.endpoint"] ?? process.env.SICLAW_S3_ENDPOINT;
    const bucket = dbConfig?.["s3.bucket"] ?? process.env.SICLAW_S3_BUCKET;
    const accessKey = dbConfig?.["s3.accessKey"] ?? process.env.SICLAW_S3_ACCESS_KEY;
    const secretKey = dbConfig?.["s3.secretKey"] ?? process.env.SICLAW_S3_SECRET_KEY;

    if (!endpoint || !bucket || !accessKey || !secretKey) {
      return null;
    }

    return new S3Storage({ endpoint, bucket, accessKey, secretKey });
  }

  /** @deprecated Use create() instead */
  static fromEnv(): S3Storage | null {
    return S3Storage.create();
  }
}
