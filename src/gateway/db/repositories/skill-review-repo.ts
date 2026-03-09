/**
 * Skill Review Repository — script security review records
 */

import crypto from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../index.js";
import { skillReviews, type ReviewFinding } from "../schema.js";

export interface CreateReviewInput {
  skillId: string;
  version: number;
  reviewerType: "ai" | "admin";
  reviewerId?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
  findings: ReviewFinding[];
  decision: "approve" | "reject" | "info";
}

export class SkillReviewRepository {
  constructor(private db: Database) {}

  async create(input: CreateReviewInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(skillReviews).values({
      id,
      skillId: input.skillId,
      version: input.version,
      reviewerType: input.reviewerType,
      reviewerId: input.reviewerId ?? null,
      riskLevel: input.riskLevel,
      summary: input.summary,
      findings: input.findings,
      decision: input.decision,
    });
    return id;
  }

  async getLatestForSkill(skillId: string) {
    const rows = await this.db
      .select()
      .from(skillReviews)
      .where(eq(skillReviews.skillId, skillId))
      .orderBy(desc(skillReviews.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForSkill(skillId: string) {
    return this.db
      .select()
      .from(skillReviews)
      .where(eq(skillReviews.skillId, skillId))
      .orderBy(desc(skillReviews.createdAt));
  }

  async deleteAiReviewsForSkill(skillId: string) {
    await this.db.delete(skillReviews).where(
      and(eq(skillReviews.skillId, skillId), eq(skillReviews.reviewerType, "ai")),
    );
  }
}
