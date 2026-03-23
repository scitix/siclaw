/**
 * Shared data types for the Monitoring Dashboard.
 *
 * Used by both LocalCollector (AgentBox side) and MetricsAggregator (Gateway side).
 */

/** Minute-level aggregation bucket */
export interface MetricsBucket {
  timestamp: number;          // minute-aligned: Math.floor(now / 60000) * 60000
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  promptCount: number;
  promptErrors: number;
  promptDurationSum: number;  // sum of all prompt durations in this minute (for avg)
  promptDurationMax: number;
  activeSessions: number;     // last sampled value in this minute
  wsConnections: number;      // last sampled value (only meaningful on Gateway side)
  toolCalls: number;
  toolErrors: number;
  skillSuccesses: number;
  skillErrors: number;
}

/** Tool call ranking entry */
export interface ToolCallStats {
  toolName: string;
  success: number;
  error: number;
  total: number;
}

/** Skill call ranking entry */
export interface SkillCallStats {
  skillName: string;
  scope: "builtin" | "team" | "personal" | "global" | "skillset";
  success: number;
  error: number;
  total: number;
  avgDurationMs: number;
}

/** Session stats record — written to Gateway DB when a session is released */
export interface SessionStatsRecord {
  sessionId: string;
  userId: string;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;         // wall-clock time (created → released)
  promptCount: number;
  toolCallCount: number;
  skillCallCount: number;
  createdAt: number;          // session creation timestamp (Unix ms)
}

/** Snapshot exported by LocalCollector for Gateway pull (K8s mode) */
export interface MetricsSnapshot {
  buckets: MetricsBucket[];
  activeSessions: number;
  sessionStats: SessionStatsRecord[];
  toolCallDeltas: ToolCallStats[];
  skillCallDeltas: SkillCallStats[];
}

export function createEmptyBucket(timestamp: number): MetricsBucket {
  return {
    timestamp,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    promptCount: 0,
    promptErrors: 0,
    promptDurationSum: 0,
    promptDurationMax: 0,
    activeSessions: 0,
    wsConnections: 0,
    toolCalls: 0,
    toolErrors: 0,
    skillSuccesses: 0,
    skillErrors: 0,
  };
}
