/**
 * User store
 *
 * DB-first: falls back to in-memory when no DB is available.
 */

import crypto from "node:crypto";
import type { Database } from "../db/index.js";
import { UserRepository } from "../db/repositories/user-repo.js";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
  /** Channel bindings */
  bindings?: {
    feishu?: string; // open_id
    dingtalk?: string; // staff_id
    discord?: string; // user_id
  };
  /** Intern flag: restricted to test environments only */
  testOnly?: boolean;
  /** SSO user flag: password changes are not supported */
  ssoUser?: boolean;
}

export interface CreateUserInput {
  username: string;
  password: string;
  testOnly?: boolean;
  ssoUser?: boolean;
}

/**
 * Hash a password
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a password
 */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const verifyHash = crypto
    .pbkdf2Sync(password, salt, 10000, 64, "sha512")
    .toString("hex");
  return hash === verifyHash;
}

/**
 * Generate a user ID
 */
function generateUserId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class UserStore {
  private users = new Map<string, User>();
  private usernameIndex = new Map<string, string>(); // username → id
  private repo: UserRepository | null;

  constructor(db: Database | null) {
    this.repo = db ? new UserRepository(db) : null;
  }

  /**
   * Async initialization — loads users from DB or creates the default admin
   */
  async init(): Promise<void> {
    if (this.repo) {
      try {
        const rows = await this.repo.list();
        for (const row of rows) {
          const user: User = {
            id: row.id,
            username: row.username,
            passwordHash: row.passwordHash,
            createdAt: row.createdAt ?? new Date(),
            bindings: (row.bindingsJson as User["bindings"]) ?? undefined,
            testOnly: (row as any).testOnly ?? false,
            ssoUser: (row as any).ssoUser ?? false,
          };
          this.users.set(user.id, user);
          this.usernameIndex.set(user.username, user.id);
        }
        console.log(`[user-store] Loaded ${this.users.size} users from DB`);
      } catch (err) {
        console.error("[user-store] Failed to load users from DB:", err);
      }
    }

    // If no users exist, create the default admin
    if (this.users.size === 0) {
      await this.createDefaultAdmin();
    }
  }

  /**
   * Create the default admin user
   */
  private async createDefaultAdmin(): Promise<void> {
    const adminPassword = process.env.SICLAW_ADMIN_PASSWORD || "admin";
    await this.createAsync({ username: "admin", password: adminPassword });
    console.log("[user-store] Created default admin user (username: admin)");
  }

  /**
   * Create a user (async, writes to DB)
   */
  async createAsync(input: CreateUserInput): Promise<User> {
    if (this.usernameIndex.has(input.username)) {
      throw new Error(`User "${input.username}" already exists`);
    }

    const user: User = {
      id: generateUserId(),
      username: input.username,
      passwordHash: hashPassword(input.password),
      createdAt: new Date(),
      testOnly: input.testOnly ?? false,
      ssoUser: input.ssoUser ?? false,
    };

    this.users.set(user.id, user);
    this.usernameIndex.set(user.username, user.id);

    // Persist to DB
    if (this.repo) {
      try {
        await this.repo.create({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
          testOnly: input.testOnly,
          ssoUser: input.ssoUser,
        });
      } catch (err) {
        console.error("[user-store] Failed to save user to DB:", err);
      }
    }

    return user;
  }

  /**
   * Create a user (sync compat, in-memory only)
   */
  create(input: CreateUserInput): User {
    if (this.usernameIndex.has(input.username)) {
      throw new Error(`User "${input.username}" already exists`);
    }

    const user: User = {
      id: generateUserId(),
      username: input.username,
      passwordHash: hashPassword(input.password),
      createdAt: new Date(),
    };

    this.users.set(user.id, user);
    this.usernameIndex.set(user.username, user.id);

    // Fire-and-forget DB write
    if (this.repo) {
      this.repo
        .create({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
        })
        .catch((err) =>
          console.error("[user-store] Failed to save user to DB:", err),
        );
    }

    return user;
  }

  /**
   * Get a user by ID
   */
  getById(id: string): User | undefined {
    return this.users.get(id);
  }

  /**
   * Get a user by username
   */
  getByUsername(username: string): User | undefined {
    const id = this.usernameIndex.get(username);
    return id ? this.users.get(id) : undefined;
  }

  /**
   * Authenticate a login attempt
   */
  authenticate(username: string, password: string): User | null {
    const user = this.getByUsername(username);
    if (!user) return null;

    if (!verifyPassword(password, user.passwordHash)) {
      return null;
    }

    return user;
  }

  /**
   * Find a user by channel binding
   */
  getByBinding(
    channel: "feishu" | "dingtalk" | "discord",
    channelUserId: string,
  ): User | undefined {
    for (const user of this.users.values()) {
      if (user.bindings?.[channel] === channelUserId) {
        return user;
      }
    }
    return undefined;
  }

  /**
   * Add a channel binding
   */
  addBinding(
    userId: string,
    channel: "feishu" | "dingtalk" | "discord",
    channelUserId: string,
  ): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    if (!user.bindings) {
      user.bindings = {};
    }
    user.bindings[channel] = channelUserId;

    // Persist to DB
    if (this.repo) {
      this.repo
        .updateBindings(userId, user.bindings as Record<string, string>)
        .catch((err) =>
          console.error("[user-store] Failed to save binding to DB:", err),
        );
    }
  }

  /**
   * Remove a channel binding
   */
  removeBinding(
    userId: string,
    channel: "feishu" | "dingtalk" | "discord",
  ): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    if (!user.bindings?.[channel]) return;

    delete user.bindings[channel];

    // Clean up empty bindings object
    if (Object.keys(user.bindings).length === 0) {
      user.bindings = undefined;
    }

    // Persist to DB
    if (this.repo) {
      this.repo
        .updateBindings(userId, (user.bindings as Record<string, string>) ?? {})
        .catch((err) =>
          console.error("[user-store] Failed to remove binding from DB:", err),
        );
    }
  }

  /**
   * SSO login: finds an existing user by username, or auto-creates one if not found
   */
  async findOrCreateBySso(ssoInfo: {
    sub: string;
    email?: string;
    name?: string;
    preferredUsername?: string;
  }): Promise<User> {
    // Resolve username: prefer preferred_username, then email prefix, then sub
    const username =
      ssoInfo.preferredUsername ||
      ssoInfo.email?.split("@")[0] ||
      ssoInfo.sub;

    // Check existing user
    const existing = this.getByUsername(username);
    if (existing) return existing;

    // Auto-create with random password (SSO users don't need password login)
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const user = await this.createAsync({ username, password: randomPassword, ssoUser: true });

    // Set profile name if available
    if (ssoInfo.name && this.repo) {
      try {
        await this.repo.upsertProfile(user.id, { name: ssoInfo.name });
      } catch (err) {
        console.warn("[user-store] Failed to set SSO user profile:", err);
      }
    }

    console.log(`[user-store] Auto-created SSO user: ${username} (sub=${ssoInfo.sub})`);
    return user;
  }

  /**
   * Change password (requires verification of the old password)
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    if (!verifyPassword(oldPassword, user.passwordHash)) {
      throw new Error("Old password is incorrect");
    }
    const newHash = hashPassword(newPassword);
    user.passwordHash = newHash;
    if (this.repo) {
      await this.repo.updatePassword(userId, newHash);
    }
  }

  /**
   * Reset password (admin use — no verification of old password)
   */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    const newHash = hashPassword(newPassword);
    user.passwordHash = newHash;
    if (this.repo) {
      await this.repo.updatePassword(userId, newHash);
    }
  }

  /**
   * Set the testOnly flag
   */
  async setTestOnly(userId: string, testOnly: boolean): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    user.testOnly = testOnly;
    if (this.repo) {
      await this.repo.updateTestOnly(userId, testOnly);
    }
  }

  /**
   * List all users
   */
  list(): User[] {
    return Array.from(this.users.values());
  }
}
