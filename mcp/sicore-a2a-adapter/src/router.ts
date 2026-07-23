import type { SiclawA2aApi } from "./a2a-client.js";

export interface AgentEntry {
  alias: string;
  agentId: string;
  api: SiclawA2aApi;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

export interface TaskRoute {
  entry: AgentEntry;
  /** Set when the caller's `agent` argument was overridden by the recorded creator. */
  note?: string;
}

// AgentRouter maps user-facing aliases to A2A clients and routes tool calls.
// task_id and context_id are per-key server resources, so the router also
// remembers which alias created each task_id (process-local, for the MCP
// server's lifetime). Errors never carry key material, only aliases and the
// agent ids resolved at startup.
export class AgentRouter {
  private readonly entries: Map<string, AgentEntry>;
  private readonly order: string[];
  private readonly taskAlias = new Map<string, string>();

  constructor(entries: AgentEntry[]) {
    if (entries.length === 0) throw new RoutingError("At least one agent must be configured");
    this.entries = new Map();
    for (const entry of entries) {
      if (this.entries.has(entry.alias)) {
        throw new RoutingError(`Duplicate agent alias "${entry.alias}"`);
      }
      this.entries.set(entry.alias, entry);
    }
    this.order = entries.map((entry) => entry.alias);
  }

  get aliases(): string[] {
    return [...this.order];
  }

  get isSingle(): boolean {
    return this.order.length === 1;
  }

  listEntries(): AgentEntry[] {
    return this.order.map((alias) => this.entries.get(alias)!);
  }

  /** "sre = <agentId>, kb = <agentId>" for tool descriptions and error messages. */
  describeAgents(): string {
    return this.order.map((alias) => `${alias} = ${this.entries.get(alias)!.agentId}`).join(", ");
  }

  requireAlias(alias: string): AgentEntry {
    const entry = this.entries.get(alias);
    if (!entry) {
      throw new RoutingError(`Unknown agent alias "${alias}". Configured agents: ${this.describeAgents()}`);
    }
    return entry;
  }

  /**
   * Pick the agent for a create/list call. With a single configured agent the
   * argument is optional; with several, an absent argument is an error rather
   * than a guess.
   */
  selectExplicit(alias: string | undefined): AgentEntry {
    if (alias !== undefined) return this.requireAlias(alias);
    if (this.isSingle) return this.entries.get(this.order[0])!;
    throw new RoutingError(
      `Multiple Siclaw agents are configured; pass "agent" to choose one. Configured agents: ${this.describeAgents()}`,
    );
  }

  /**
   * Pick the agent for a task-scoped call (wait/get/cancel). The recorded
   * creator wins over the caller's argument, because task_id belongs to the key
   * that created it; when they disagree the returned note records the override.
   */
  selectForTask(taskId: string, alias: string | undefined): TaskRoute {
    const mapped = this.taskAlias.get(taskId);
    if (mapped) {
      const entry = this.entries.get(mapped)!;
      if (alias !== undefined && alias !== mapped) {
        this.requireAlias(alias); // validate for a clean message; mapping still wins
        return {
          entry,
          note: `Routed to agent "${mapped}" that created this task; ignored agent="${alias}".`,
        };
      }
      return { entry };
    }
    if (alias !== undefined) return { entry: this.requireAlias(alias) };
    if (this.isSingle) return { entry: this.entries.get(this.order[0])! };
    throw new RoutingError(
      `Task "${taskId}" was not created in this session and multiple agents are configured; `
      + `pass "agent", or run siclaw_list_tasks first. Configured agents: ${this.describeAgents()}`,
    );
  }

  remember(taskId: string, alias: string): void {
    if (taskId) this.taskAlias.set(taskId, alias);
  }
}
