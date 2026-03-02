/**
 * User Repository — DB-backed user management
 */

import { eq } from "drizzle-orm";
import type { Database } from "../index.js";
import { users, userProfiles } from "../schema.js";

export class UserRepository {
  constructor(private db: Database) {}

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByUsername(username: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(user: {
    id: string;
    username: string;
    passwordHash: string;
    bindings?: Record<string, string>;
    testOnly?: boolean;
    ssoUser?: boolean;
  }) {
    await this.db.insert(users).values({
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      bindingsJson: user.bindings ?? null,
      testOnly: user.testOnly ?? false,
      ssoUser: user.ssoUser ?? false,
    });
  }

  async updateBindings(userId: string, bindings: Record<string, string>) {
    await this.db
      .update(users)
      .set({ bindingsJson: bindings })
      .where(eq(users.id, userId));
  }

  async list() {
    return this.db.select().from(users);
  }

  async updateTestOnly(userId: string, testOnly: boolean) {
    await this.db
      .update(users)
      .set({ testOnly })
      .where(eq(users.id, userId));
  }

  async updatePassword(userId: string, passwordHash: string) {
    await this.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId));
  }

  // ─── Profile ───

  async getProfile(userId: string) {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertProfile(
    userId: string,
    profile: {
      name?: string;
      role?: string;
      avatarBg?: string;
    },
  ) {
    const existing = await this.getProfile(userId);
    if (existing) {
      await this.db
        .update(userProfiles)
        .set(profile)
        .where(eq(userProfiles.userId, userId));
    } else {
      await this.db.insert(userProfiles).values({
        userId,
        ...profile,
      });
    }
  }
}
