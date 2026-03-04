/**
 * BoxSpawner interface
 *
 * Defines the abstract interface for AgentBox creation and destruction, supporting multiple implementations:
 * - K8sSpawner: Kubernetes Pod
 * - ProcessSpawner: Local child process (for development)
 * - E2BSpawner: E2B cloud sandbox (future)
 */

import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";

export interface BoxSpawner {
  /** Spawner name */
  readonly name: string;

  /**
   * Create an AgentBox
   */
  spawn(config: AgentBoxConfig): Promise<AgentBoxHandle>;

  /**
   * Stop an AgentBox
   */
  stop(boxId: string): Promise<void>;

  /**
   * Get AgentBox information
   */
  get(boxId: string): Promise<AgentBoxInfo | null>;

  /**
   * List all AgentBoxes
   */
  list(): Promise<AgentBoxInfo[]>;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}
