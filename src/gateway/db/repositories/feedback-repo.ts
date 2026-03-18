/**
 * Feedback Repository — session feedback report CRUD
 */

import crypto from "node:crypto";
import { eq, desc, and } from "drizzle-orm";
import type { Database } from "../index.js";
import { feedbackReports } from "../schema.js";

export interface FeedbackReportInput {
  sessionId: string;
  userId: string;
  overallRating?: number;
  summary: string;
  decisionPoints?: Array<{
    step: number;
    description: string;
    wasCorrect: boolean;
    comment?: string;
    idealAction?: string;
  }>;
  strengths?: string[];
  improvements?: string[];
  tags?: string[];
  feedbackConversation?: unknown;
}

export class FeedbackRepository {
  constructor(private db: Database) {}

  async saveFeedbackReport(report: FeedbackReportInput): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(feedbackReports).values({
      id,
      sessionId: report.sessionId,
      userId: report.userId,
      overallRating: report.overallRating ?? null,
      summary: report.summary,
      decisionPoints: report.decisionPoints ?? null,
      strengths: report.strengths ?? null,
      improvements: report.improvements ?? null,
      tags: report.tags ?? null,
      feedbackConversation: report.feedbackConversation ?? null,
    });
    return id;
  }

  async listFeedbackReports(opts: {
    userId?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const conditions = opts.userId
      ? [eq(feedbackReports.userId, opts.userId)]
      : [];

    return this.db
      .select()
      .from(feedbackReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(feedbackReports.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getFeedbackReport(id: string) {
    const rows = await this.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
