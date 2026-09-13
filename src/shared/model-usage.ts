/** Numeric provider evidence is independent of the legacy SDK usage envelope. */
export interface UsageEvidence {
  protocol: string;
  providerUsagePresent: boolean;
  finality: "terminal" | "intermediate" | "missing";
  rawUsage: Record<string, unknown>;
  invalidFields?: string[];
}
export interface UsageIdentity {
  configId: string;
  name: string;
  sourceKind: "api" | "subscription" | "unknown";
  sourceId: string;
  sourceName: string;
}
export interface UsageObservation {
  schemaVersion: 1;
  callId: string;
  phase: "started" | "finished";
  sessionId: string;
  traceId?: string;
  requestId?: string;
  parentCallId?: string;
  executorRole?: string;
  requestAt: string;
  finishedAt?: string;
  kind: "agent" | "aux";
  executionRole: "root" | "internal_subagent" | "delegated";
  routingAttempt: number;
  outcome?: "success" | "error" | "cancelled" | "incomplete";
  finishReason?: string;
  responseModel?: string;
  responseId?: string;
  model: UsageIdentity & { requestedId: string; runtimeProvider: string };
  usageEvidence?: UsageEvidence;
}
export interface UsageHealth {
  collectorId: string;
  sessionId: string;
  pending: number;
  rejected: number;
  dropped: number;
  oldestAt?: string;
  lastSuccessAt?: string;
  capturedAt: string;
}
export interface UsageBatch { observations: UsageObservation[]; health?: UsageHealth }
export interface UsageBatchResponse {
  results: { callId: string; phase: string; status: "accepted" | "duplicate" | "rejected" | "retryable"; reason?: string }[];
}
export interface UsageSink {
  context(): Pick<UsageObservation, "sessionId" | "traceId" | "executionRole" | "requestId" | "parentCallId" | "executorRole">;
  record(observation: UsageObservation): void;
}
