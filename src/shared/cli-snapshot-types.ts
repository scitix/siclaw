/**
 * Types shared between Portal's CLI snapshot endpoint and the agent core.
 *
 * Lives in `src/shared/` so the agentbox build (which excludes `src/portal/`
 * via tsconfig.agentbox.json + Dockerfile.agentbox) can still consume them.
 */

export interface CliSnapshotAgentMeta {
  name: string;
  description: string | null;
  modelProvider: string | null;
  modelId: string | null;
  icon: string | null;
  color: string | null;
}

export interface CliSnapshotActiveAgent {
  name: string;
  description: string | null;
  systemPrompt: string | null;
  modelProvider: string | null;
  modelId: string | null;
}
