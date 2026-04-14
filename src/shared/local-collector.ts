/**
 * LocalCollector — per-process metrics collector for the Monitoring Dashboard.
 *
 * Subscribes to the diagnostic event bus and maintains:
 * - Minute-level ring buffer (max 1440 buckets = 24h)
 * - Per-tool call statistics (lifetime cumulative)
 * - Per-session prompt/tool counters (for SessionStatsRecord generation)
 * - Session stats queue (consumed by MetricsAggregator or exported via snapshot)
 *
 * Used directly in Local mode; in K8s mode, Gateway pulls via exportSnapshot().
 * This class does NOT know which mode it runs in — the consumer decides.
 */

import { onDiagnostic, type DiagnosticEvent } from "./diagnostic-events.js";
import {
  type MetricsBucket,
  type ToolCallStats,
  type SkillCallStats,
  type SessionStatsRecord,
  type MetricsSnapshot,
  createEmptyBucket,
} from "./metrics-types.js";

const MAX_BUCKETS = 1440; // 24 hours of minute-level data

function minuteTs(now?: number): number {
  return Math.floor((now ?? Date.now()) / 60_000) * 60_000;
}

class LocalCollector {
  private ringBuffer = new Map<number, MetricsBucket>();
  private toolCallMap = new Map<string, { success: number; error: number }>();
  private skillCallMap = new Map<string, {
    scope: "builtin" | "global";
    success: number;
    error: number;
    totalDurationMs: number;
  }>();
  private perSessionCounters = new Map<string, { prompts: number; tools: number; skills: number }>();
  private sessionStatsQueue: SessionStatsRecord[] = [];

  private currentSessions = 0;
  private currentWsConnections = 0;

  /** Tracks the newest timestamp that was exported via exportSnapshot() */
  private lastExportedTs = 0;

  constructor() {
    onDiagnostic((event) => this.handle(event));
  }

  // ── Event handler ──

  private handle(event: DiagnosticEvent): void {
    switch (event.type) {
      case "prompt_complete": {
        const bucket = this.getOrCreateBucket();
        const deltaInput = event.curr.tokens.input - event.prev.tokens.input;
        const deltaOutput = event.curr.tokens.output - event.prev.tokens.output;
        const deltaCacheRead = event.curr.tokens.cacheRead - event.prev.tokens.cacheRead;
        const deltaCacheWrite = event.curr.tokens.cacheWrite - event.prev.tokens.cacheWrite;

        bucket.tokensInput += deltaInput;
        bucket.tokensOutput += deltaOutput;
        bucket.tokensCacheRead += deltaCacheRead;
        bucket.tokensCacheWrite += deltaCacheWrite;
        bucket.promptDurationSum += event.durationMs;
        bucket.promptDurationMax = Math.max(bucket.promptDurationMax, event.durationMs);

        if (event.outcome === "error") {
          bucket.promptErrors++;
        } else {
          bucket.promptCount++;
        }

        // Per-session counter
        const sc = this.perSessionCounters.get(event.sessionId);
        if (sc) sc.prompts++;
        break;
      }

      case "session_created": {
        this.currentSessions++;
        const bucket = this.getOrCreateBucket();
        bucket.activeSessions = this.currentSessions;
        this.perSessionCounters.set(event.sessionId, { prompts: 0, tools: 0, skills: 0 });
        break;
      }

      case "session_released": {
        this.currentSessions = Math.max(0, this.currentSessions - 1);
        const bucket = this.getOrCreateBucket();
        bucket.activeSessions = this.currentSessions;

        // Generate SessionStatsRecord
        const counters = this.perSessionCounters.get(event.sessionId);
        this.perSessionCounters.delete(event.sessionId);

        const record: SessionStatsRecord = {
          sessionId: event.sessionId,
          userId: event.userId ?? "unknown",
          provider: event.model?.provider ?? null,
          model: event.model?.id ?? event.model?.name ?? null,
          inputTokens: event.stats.tokens.input,
          outputTokens: event.stats.tokens.output,
          cacheReadTokens: event.stats.tokens.cacheRead,
          cacheWriteTokens: event.stats.tokens.cacheWrite,
          durationMs: Date.now() - event.createdAt,
          promptCount: counters?.prompts ?? 0,
          toolCallCount: counters?.tools ?? 0,
          skillCallCount: counters?.skills ?? 0,
          createdAt: event.createdAt,
        };
        this.sessionStatsQueue.push(record);
        break;
      }

      case "tool_call": {
        const bucket = this.getOrCreateBucket();
        if (event.outcome === "error") {
          bucket.toolErrors++;
        } else {
          bucket.toolCalls++;
        }

        // Per-tool cumulative
        let entry = this.toolCallMap.get(event.toolName);
        if (!entry) {
          entry = { success: 0, error: 0 };
          this.toolCallMap.set(event.toolName, entry);
        }
        if (event.outcome === "error") {
          entry.error++;
        } else {
          entry.success++;
        }

        // Per-session counter (best-effort — tool_call has no sessionId)
        // Increments the first session in Map iteration order (insertion order).
        // In practice each AgentBox has one active session at a time.
        for (const sc of this.perSessionCounters.values()) {
          sc.tools++;
          break; // increment first (most recent) only
        }
        break;
      }

      case "skill_call": {
        const bucket = this.getOrCreateBucket();
        if (event.outcome === "error") {
          bucket.skillErrors++;
        } else {
          bucket.skillSuccesses++;
        }

        // Per-skill cumulative
        const key = event.skillName;
        let skillEntry = this.skillCallMap.get(key);
        if (!skillEntry) {
          skillEntry = { scope: event.scope, success: 0, error: 0, totalDurationMs: 0 };
          this.skillCallMap.set(key, skillEntry);
        }
        if (event.outcome === "error") {
          skillEntry.error++;
        } else {
          skillEntry.success++;
        }
        skillEntry.totalDurationMs += event.durationMs;

        // Per-session counter (skill_call carries sessionId for precise matching)
        if (event.sessionId) {
          const sc = this.perSessionCounters.get(event.sessionId);
          if (sc) sc.skills++;
        }
        break;
      }

      case "ws_connected": {
        this.currentWsConnections++;
        const bucket = this.getOrCreateBucket();
        bucket.wsConnections = this.currentWsConnections;
        break;
      }

      case "ws_disconnected": {
        this.currentWsConnections = Math.max(0, this.currentWsConnections - 1);
        const bucket = this.getOrCreateBucket();
        bucket.wsConnections = this.currentWsConnections;
        break;
      }

      // context_usage, session_stuck — not handled in v1
    }
  }

  // ── Bucket management ──

  private getOrCreateBucket(now?: number): MetricsBucket {
    const ts = minuteTs(now);
    let bucket = this.ringBuffer.get(ts);
    if (!bucket) {
      bucket = createEmptyBucket(ts);
      bucket.activeSessions = this.currentSessions;
      bucket.wsConnections = this.currentWsConnections;
      this.ringBuffer.set(ts, bucket);
      this.evict();
    }
    return bucket;
  }

  private evict(): void {
    if (this.ringBuffer.size <= MAX_BUCKETS) return;
    // Remove oldest buckets
    const sorted = [...this.ringBuffer.keys()].sort((a, b) => a - b);
    const excess = sorted.length - MAX_BUCKETS;
    for (let i = 0; i < excess; i++) {
      this.ringBuffer.delete(sorted[i]);
    }
  }

  // ── Public query API ──

  /** Return buckets within the given time range, sorted ascending by timestamp */
  query(range: "1h" | "6h" | "24h"): MetricsBucket[] {
    const rangeMs = range === "1h" ? 3_600_000 : range === "6h" ? 21_600_000 : 86_400_000;
    const cutoff = minuteTs() - rangeMs;
    const result: MetricsBucket[] = [];
    for (const [ts, bucket] of this.ringBuffer) {
      if (ts >= cutoff) result.push(bucket);
    }
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Return current instantaneous values */
  snapshot(): { activeSessions: number; wsConnections: number } {
    return {
      activeSessions: this.currentSessions,
      wsConnections: this.currentWsConnections,
    };
  }

  /** Return tool call rankings, sorted by total descending, top N */
  topTools(n: number): ToolCallStats[] {
    const result: ToolCallStats[] = [];
    for (const [toolName, entry] of this.toolCallMap) {
      result.push({
        toolName,
        success: entry.success,
        error: entry.error,
        total: entry.success + entry.error,
      });
    }
    result.sort((a, b) => b.total - a.total);
    return result.slice(0, n);
  }

  /** Return skill call rankings, sorted by total descending, top N */
  topSkills(n: number): SkillCallStats[] {
    return [...this.skillCallMap.entries()]
      .map(([skillName, v]) => {
        const total = v.success + v.error;
        return {
          skillName,
          scope: v.scope,
          success: v.success,
          error: v.error,
          total,
          avgDurationMs: total > 0 ? Math.round(v.totalDurationMs / total) : 0,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, n);
  }

  /**
   * Drain the session stats queue — returns all pending records and clears the queue.
   * Used by MetricsAggregator in Local mode to consume and write to DB.
   */
  drainSessionStats(): SessionStatsRecord[] {
    const records = this.sessionStatsQueue.splice(0);
    return records;
  }

  /**
   * Export snapshot for Gateway pull (K8s mode).
   *
   * Returns only completed minute buckets (timestamp < current minute) that
   * haven't been exported yet. This prevents the same bucket from being
   * counted twice across consecutive pulls.
   *
   * Session stats queue is cleared after export (best-effort delivery).
   */
  exportSnapshot(): MetricsSnapshot {
    const currentMin = minuteTs();
    const buckets: MetricsBucket[] = [];

    for (const [ts, bucket] of this.ringBuffer) {
      if (ts < currentMin && ts > this.lastExportedTs) {
        buckets.push(bucket);
      }
    }
    buckets.sort((a, b) => a.timestamp - b.timestamp);

    if (buckets.length > 0) {
      this.lastExportedTs = buckets[buckets.length - 1].timestamp;
    }

    // Tool call deltas: export current totals, then reset for next interval
    const toolCallDeltas = this.topTools(Infinity);
    this.toolCallMap.clear();

    // Skill call deltas: export current totals, then reset for next interval
    const skillCallDeltas = this.topSkills(Infinity);
    this.skillCallMap.clear();

    const sessionStats = this.sessionStatsQueue.splice(0);

    return {
      buckets,
      activeSessions: this.currentSessions,
      sessionStats,
      toolCallDeltas,
      skillCallDeltas,
    };
  }
}

export const localCollector = new LocalCollector();
