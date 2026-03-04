/**
 * Vote Repository — skill vote CRUD
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillVotes } from "../schema.js";

export class VoteRepository {
  constructor(private db: Database) {}

  /**
   * Upsert a vote. Same direction again = cancel, different direction = flip.
   * Returns the new vote state (1, -1, or null if cancelled).
   */
  async upsert(
    skillId: string,
    userId: string,
    vote: 1 | -1,
  ): Promise<{ newVote: 1 | -1 | null }> {
    const existing = await this.db
      .select()
      .from(skillVotes)
      .where(
        and(eq(skillVotes.skillId, skillId), eq(skillVotes.userId, userId)),
      )
      .limit(1);

    if (existing.length > 0) {
      if (existing[0].vote === vote) {
        // Same direction → cancel
        await this.db
          .delete(skillVotes)
          .where(eq(skillVotes.id, existing[0].id));
        return { newVote: null };
      }
      // Different direction → flip
      await this.db
        .update(skillVotes)
        .set({ vote })
        .where(eq(skillVotes.id, existing[0].id));
      return { newVote: vote };
    }

    // New vote
    await this.db.insert(skillVotes).values({ skillId, userId, vote });
    return { newVote: vote };
  }

  /** Batch get vote counts for multiple skills */
  async getCountsForSkills(
    skillIds: string[],
  ): Promise<Map<string, { upvotes: number; downvotes: number }>> {
    const result = new Map<string, { upvotes: number; downvotes: number }>();
    if (skillIds.length === 0) return result;

    const rows = await this.db
      .select({
        skillId: skillVotes.skillId,
        vote: skillVotes.vote,
        count: sql<number>`COUNT(*)`,
      })
      .from(skillVotes)
      .where(inArray(skillVotes.skillId, skillIds))
      .groupBy(skillVotes.skillId, skillVotes.vote);

    for (const row of rows) {
      let entry = result.get(row.skillId);
      if (!entry) {
        entry = { upvotes: 0, downvotes: 0 };
        result.set(row.skillId, entry);
      }
      if (row.vote === 1) entry.upvotes = Number(row.count);
      else if (row.vote === -1) entry.downvotes = Number(row.count);
    }

    return result;
  }

  /** Batch get a user's votes for multiple skills */
  async getUserVotes(
    skillIds: string[],
    userId: string,
  ): Promise<Map<string, 1 | -1>> {
    const result = new Map<string, 1 | -1>();
    if (skillIds.length === 0) return result;

    const rows = await this.db
      .select({ skillId: skillVotes.skillId, vote: skillVotes.vote })
      .from(skillVotes)
      .where(
        and(
          inArray(skillVotes.skillId, skillIds),
          eq(skillVotes.userId, userId),
        ),
      );

    for (const row of rows) {
      result.set(row.skillId, row.vote as 1 | -1);
    }

    return result;
  }

  /** Get a single user's vote for one skill */
  async getUserVote(
    skillId: string,
    userId: string,
  ): Promise<1 | -1 | null> {
    const rows = await this.db
      .select({ vote: skillVotes.vote })
      .from(skillVotes)
      .where(
        and(eq(skillVotes.skillId, skillId), eq(skillVotes.userId, userId)),
      )
      .limit(1);

    return rows.length > 0 ? (rows[0].vote as 1 | -1) : null;
  }

  /** Delete all votes for a skill (cleanup on skill delete) */
  async deleteForSkill(skillId: string): Promise<void> {
    await this.db
      .delete(skillVotes)
      .where(eq(skillVotes.skillId, skillId));
  }
}
