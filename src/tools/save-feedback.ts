/**
 * save_feedback tool — persists structured session feedback to Gateway DB
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../core/config.js";
import { GatewayClient } from "../agentbox/gateway-client.js";

const MAX_CONVERSATION_BYTES = 100 * 1024; // 100KB

interface SaveFeedbackParams {
  overallRating: number;
  summary: string;
  decisionPoints?: string;
  strengths?: string;
  improvements?: string;
  tags?: string;
  feedbackConversation?: string;
}

export function createSaveFeedbackTool(
  sessionIdRef: { current: string },
): ToolDefinition {
  return {
    name: "save_feedback",
    label: "Save Session Feedback",
    description: `Save a structured feedback report for the current diagnostic session.
Call this after completing the interactive feedback review with the user.
The report includes overall rating, decision point evaluations, strengths, improvements, and tags.`,
    parameters: Type.Object({
      overallRating: Type.Integer({
        minimum: 1,
        maximum: 5,
        description: "Overall session rating (1=poor, 5=excellent)",
      }),
      summary: Type.String({
        description: "Brief summary of the feedback (1-3 sentences)",
      }),
      decisionPoints: Type.Optional(Type.String({
        description: "JSON array of decision point evaluations: [{ step: number, description: string, wasCorrect: boolean, comment?: string, idealAction?: string }]",
      })),
      strengths: Type.Optional(Type.String({
        description: "JSON array of strengths identified: string[]",
      })),
      improvements: Type.Optional(Type.String({
        description: "JSON array of improvements suggested: string[]",
      })),
      tags: Type.Optional(Type.String({
        description: 'JSON array of category tags: string[] (e.g. "wrong-skill", "slow-path", "missing-check")',
      })),
      feedbackConversation: Type.Optional(Type.String({
        description: "JSON summary of the feedback dialogue (optional)",
      })),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as SaveFeedbackParams;

      const cfg = loadConfig();
      const gatewayUrl = cfg.server.gatewayUrl || `http://localhost:${cfg.server.port}`;
      const userId = cfg.userId;
      const sessionId = sessionIdRef.current;
      const workspaceId = process.env.SICLAW_WORKSPACE_ID;

      if (!userId) {
        return {
          content: [{ type: "text", text: "Cannot save feedback: userId not configured." }],
          details: { error: true },
        };
      }
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "Cannot save feedback: session ID not available." }],
          details: { error: true },
        };
      }

      // Parse JSON string fields
      let decisionPoints: unknown;
      let strengths: unknown;
      let improvements: unknown;
      let tags: unknown;
      let feedbackConversation: unknown;
      let conversationOmitted = false;

      try {
        if (params.decisionPoints) decisionPoints = JSON.parse(params.decisionPoints);
        if (params.strengths) strengths = JSON.parse(params.strengths);
        if (params.improvements) improvements = JSON.parse(params.improvements);
        if (params.tags) tags = JSON.parse(params.tags);
        if (params.feedbackConversation) {
          const parsed = JSON.parse(params.feedbackConversation);
          const serialized = JSON.stringify(parsed);
          // Drop entirely if serialized size exceeds limit (truncating JSON is unsafe)
          if (serialized.length <= MAX_CONVERSATION_BYTES) {
            feedbackConversation = parsed;
          } else {
            conversationOmitted = true;
          }
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Invalid JSON in feedback fields: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }

      try {
        const gatewayClient = new GatewayClient({ gatewayUrl });
        const result = await gatewayClient.toClientLike().request(
          "/api/internal/feedback",
          "POST",
          {
            sessionId,
            userId,
            workspaceId,
            overallRating: params.overallRating,
            summary: params.summary,
            decisionPoints,
            strengths,
            improvements,
            tags,
            feedbackConversation,
          },
        ) as { ok: boolean; id: string };

        return {
          content: [{ type: "text", text: `Feedback saved successfully (id: ${result.id}).${conversationOmitted ? " Note: conversation transcript omitted (exceeded size limit)." : ""}` }],
          details: { id: result.id, sessionId },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to save feedback: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
        };
      }
    },
  };
}
