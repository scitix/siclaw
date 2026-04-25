/**
 * Public types for the CLI snapshot payload.
 *
 * Kept separate from cli-snapshot-api.ts (which has runtime imports from
 * gateway/db and gateway/rest-router) so AgentBox builds can consume just
 * the types without pulling Portal runtime code into its tsconfig graph.
 */

export interface CliSnapshotKnowledgeRepo {
  name: string;
  version: number;
  fileCount: number;
  sizeBytes: number;
  sha256: string | null;
  /** Gzip'd tar of the repo's markdown pages, base64-encoded for JSON transport. */
  dataBase64: string;
}

export interface CliSnapshotClusterCredential {
  name: string;
  /** Raw kubeconfig YAML/JSON content. */
  kubeconfig: string;
  description: string | null;
}

export interface CliSnapshotHostCredential {
  name: string;
  ip: string;
  port: number;
  username: string;
  /** "password" or "key". Determines which of password/privateKey is set. */
  authType: string;
  password: string | null;
  privateKey: string | null;
  description: string | null;
}

export interface CliSnapshotCredentials {
  clusters: CliSnapshotClusterCredential[];
  hosts: CliSnapshotHostCredential[];
}

export interface CliSnapshotAgentMeta {
  /** Display name; used as `--agent <name>` value. */
  name: string;
  description: string | null;
  /** Model this agent prefers, if configured in Portal. */
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

export interface CliSnapshotSkill {
  /** Name from SKILL.md frontmatter; used as the materialized directory name. */
  name: string;
  description: string;
  labels: string[];
  /** Raw SKILL.md content including YAML frontmatter. */
  specs: string;
  /** Companion scripts (shell / python) referenced by SKILL.md. */
  scripts: Array<{ name: string; content: string }>;
}
