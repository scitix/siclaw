/**
 * Bind code store
 *
 * Generates 6-digit numeric codes used to bind Feishu/DingTalk users to platform accounts.
 * Codes expire after 5 minutes and are deleted immediately upon verification.
 */

export interface BindCodeEntry {
  userId: string;
  expiresAt: number;
}

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_RETRIES = 10;

export class BindCodeStore {
  private codes = new Map<string, BindCodeEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow process to exit even if timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Generate a 6-digit numeric code
   */
  generateCode(userId: string): string {
    // Remove any existing code for this user
    for (const [code, entry] of this.codes) {
      if (entry.userId === userId) {
        this.codes.delete(code);
      }
    }

    for (let i = 0; i < MAX_RETRIES; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.codes.has(code)) {
        this.codes.set(code, {
          userId,
          expiresAt: Date.now() + CODE_TTL_MS,
        });
        return code;
      }
    }

    throw new Error("Failed to generate unique bind code");
  }

  /**
   * Verify a bind code — returns userId on success, null on failure. Deleted immediately after verification.
   */
  verifyCode(code: string): string | null {
    const entry = this.codes.get(code);
    if (!entry) return null;

    this.codes.delete(code);

    if (Date.now() > entry.expiresAt) {
      return null;
    }

    return entry.userId;
  }

  /**
   * Remove expired codes
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (now > entry.expiresAt) {
        this.codes.delete(code);
      }
    }
  }

  /**
   * Stop the cleanup timer
   */
  dispose(): void {
    clearInterval(this.cleanupTimer);
  }
}
