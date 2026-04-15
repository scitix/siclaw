/**
 * LocalCollector — per-process metrics collector (counter + top-N only).
 *
 * Subscribes to the diagnostic event bus. Tracks:
 * - Cumulative per-(user, agent, tool) and per-(user, agent, skill) counters
 * - Instantaneous active sessions and ws connections
 *
 * Used directly in Local mode; in K8s mode, Gateway pulls via exportSnapshot()
 * every 30s and merges deltas. After each export, the cumulative maps are
 * cleared — consumers must do their own running totals.
 *
 * Time-series buckets and session_stats were removed by design: long-term
 * trends belong in external Grafana (prom-client /metrics), session auditing
 * uses chat_messages/chat_sessions tables directly.
 */

import { onDiagnostic, type DiagnosticEvent } from "./diagnostic-events.js";
import {
  type ToolCallStats,
  type SkillCallStats,
  type MetricsSnapshot,
} from "./metrics-types.js";

function tnKey(userId: string, agentId: string | null, name: string): string {
  return `${userId}|${agentId ?? ""}|${name}`;
}

class LocalCollector {
  private toolCallMap = new Map<string, { userId: string; agentId: string | null; toolName: string; success: number; error: number }>();
  private skillCallMap = new Map<string, {
    userId: string;
    agentId: string | null;
    skillName: string;
    scope: "builtin" | "global";
    success: number;
    error: number;
    totalDurationMs: number;
  }>();

  private currentSessions = 0;
  private currentWsConnections = 0;

  constructor() {
    onDiagnostic((event) => this.handle(event));
  }

  // ── Event handler ──

  private handle(event: DiagnosticEvent): void {
    switch (event.type) {
      case "session_created":
        this.currentSessions++;
        break;

      case "session_released":
        this.currentSessions = Math.max(0, this.currentSessions - 1);
        break;

      case "tool_call": {
        const key = tnKey(event.userId, event.agentId, event.toolName);
        let entry = this.toolCallMap.get(key);
        if (!entry) {
          entry = { userId: event.userId, agentId: event.agentId, toolName: event.toolName, success: 0, error: 0 };
          this.toolCallMap.set(key, entry);
        }
        if (event.outcome === "error") entry.error++;
        else entry.success++;
        break;
      }

      case "skill_call": {
        const key = tnKey(event.userId, event.agentId, event.skillName);
        let skillEntry = this.skillCallMap.get(key);
        if (!skillEntry) {
          skillEntry = { userId: event.userId, agentId: event.agentId, skillName: event.skillName, scope: event.scope, success: 0, error: 0, totalDurationMs: 0 };
          this.skillCallMap.set(key, skillEntry);
        }
        if (event.outcome === "error") skillEntry.error++;
        else skillEntry.success++;
        skillEntry.totalDurationMs += event.durationMs;
        break;
      }

      case "ws_connected":
        this.currentWsConnections++;
        break;

      case "ws_disconnected":
        this.currentWsConnections = Math.max(0, this.currentWsConnections - 1);
        break;

      // prompt_complete / context_usage / session_stuck — not consumed here
    }
  }

  // ── Public query API ──

  /** Return current instantaneous values */
  snapshot(): { activeSessions: number; wsConnections: number } {
    return {
      activeSessions: this.currentSessions,
      wsConnections: this.currentWsConnections,
    };
  }

  /** Return tool call rankings, sorted by total descending, top N; optional userId filter */
  topTools(n: number, userId?: string): ToolCallStats[] {
    const result: ToolCallStats[] = [];
    for (const entry of this.toolCallMap.values()) {
      if (userId && entry.userId !== userId) continue;
      result.push({
        toolName: entry.toolName,
        userId: entry.userId,
        agentId: entry.agentId,
        success: entry.success,
        error: entry.error,
        total: entry.success + entry.error,
      });
    }
    result.sort((a, b) => b.total - a.total);
    return result.slice(0, n);
  }

  /** Return skill call rankings, sorted by total descending, top N; optional userId filter */
  topSkills(n: number, userId?: string): SkillCallStats[] {
    return [...this.skillCallMap.values()]
      .filter(v => !userId || v.userId === userId)
      .map(v => {
        const total = v.success + v.error;
        return {
          skillName: v.skillName,
          scope: v.scope,
          userId: v.userId,
          agentId: v.agentId,
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
   * Export snapshot for Gateway pull (K8s mode). Tool/skill deltas are returned
   * and the internal maps cleared — Gateway aggregator maintains running totals.
   */
  exportSnapshot(): MetricsSnapshot {
    const toolCallDeltas = this.topTools(Infinity);
    this.toolCallMap.clear();

    const skillCallDeltas = this.topSkills(Infinity);
    this.skillCallMap.clear();

    return {
      activeSessions: this.currentSessions,
      toolCallDeltas,
      skillCallDeltas,
    };
  }
}

export const localCollector = new LocalCollector();
