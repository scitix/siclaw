/**
 * System Config Repository — key/value config stored in DB.
 *
 * Used for SSO, S3, system URLs, etc.
 * Keys follow dotted notation: "sso.issuer", "s3.endpoint", etc.
 */

import { eq, like } from "drizzle-orm";
import type { Database } from "../index.js";
import { systemConfig } from "../schema.js";
import { isUniqueViolation } from "../dialect-helpers.js";

/** Sensitive keys whose values are masked in getAll() output */
const SENSITIVE_KEYS = new Set([
  "jwt.secret",
  "sso.clientSecret",
  "s3.accessKey",
  "s3.secretKey",
]);

export class SystemConfigRepository {
  constructor(private db: Database) {}

  /** Get a single config value (null if not set) */
  async get(key: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(systemConfig)
      .where(eq(systemConfig.configKey, key))
      .limit(1);
    return rows[0]?.configValue ?? null;
  }

  /** Set a config value. Pass null to delete. */
  async set(key: string, value: string | null): Promise<void> {
    if (value === null || value === "") {
      await this.db
        .delete(systemConfig)
        .where(eq(systemConfig.configKey, key));
    } else {
      try {
        await this.db
          .insert(systemConfig)
          .values({ configKey: key, configValue: value });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Key already exists — update
        await this.db
          .update(systemConfig)
          .set({ configValue: value, updatedAt: new Date() })
          .where(eq(systemConfig.configKey, key));
      }
    }
  }

  /** Get all config entries, optionally filtered by prefix (e.g. "sso.") */
  async getAll(prefix?: string): Promise<Record<string, string>> {
    const rows = prefix
      ? await this.db.select().from(systemConfig).where(like(systemConfig.configKey, `${prefix}%`))
      : await this.db.select().from(systemConfig);

    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.configValue != null) {
        result[row.configKey] = row.configValue;
      }
    }
    return result;
  }

  /** Get all config entries with sensitive values masked */
  async getAllMasked(): Promise<Record<string, string>> {
    const all = await this.getAll();
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
      masked[key] = SENSITIVE_KEYS.has(key) && value
        ? value.slice(0, 4) + "****"
        : value;
    }
    return masked;
  }

  /** Batch set multiple config values */
  async setMany(entries: Record<string, string | null>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key, value);
    }
  }
}
