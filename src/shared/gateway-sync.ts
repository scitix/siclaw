/**
 * Gateway Sync — Core Types & Descriptors
 *
 * Defines the abstraction layer for synchronising data (MCP servers, skills,
 * cluster/host credentials, ...) from Gateway to AgentBox.  All per-type
 * logic is expressed through these interfaces; transport / retry /
 * notification code stays generic.
 *
 * Previously named "resource-sync" — the word "resource" overloaded with
 * `agent.resources` binding semantics in the Portal/Gateway layer. This
 * abstraction is strictly about "Gateway → AgentBox notify-driven sync",
 * hence the rename.
 */

// ── Scalar types ──────────────────────────────────────────────────────

/** Every syncable type is identified by a well-known key. */
export type GatewaySyncType = "mcp" | "skills" | "cluster" | "host";

// ── Config / descriptor interfaces ────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of attempts (including the first). */
  maxRetries: number;
  /** Base delay in ms — actual delay = baseDelayMs * 2^attempt. */
  baseDelayMs: number;
}

/**
 * Static metadata that describes how a syncable type is synced.
 * One descriptor per GatewaySyncType; registered in GATEWAY_SYNC_DESCRIPTORS.
 */
export interface GatewaySyncDescriptor {
  type: GatewaySyncType;
  /** Gateway internal API path for fetching the payload (ignored when requiresGatewayClient=false). */
  gatewayPath: string;
  /** AgentBox HTTP path the Gateway POSTs to trigger a reload. */
  reloadPath: string;
  /** Default retry configuration for initial sync. */
  retry: RetryConfig;
  /**
   * true = handler.fetch needs a GatewaySyncClientLike (HTTP path to Gateway).
   * false = handler brings its own transport (e.g. credential broker).
   * The http-server reload loop uses this to decide whether to skip the
   * handler when SICLAW_GATEWAY_URL is unset.
   */
  requiresGatewayClient: boolean;
  /**
   * true = syncAllResources() pulls this type at AgentBox startup.
   * false = filled lazily by the consumer (e.g. first tool call triggers
   * a refresh). Keep false for types whose handler depends on a broker
   * that is only created later in the startup flow.
   */
  initialSync: boolean;
}

// ── Gateway-side interfaces ───────────────────────────────────────────

/**
 * Result of a notify round — how many boxes succeeded / failed.
 */
export interface NotifyResult {
  syncType: GatewaySyncType;
  success: number;
  failed: number;
}

/**
 * Sends reload notifications to AgentBoxes.
 */
export interface GatewaySyncNotifier {
  /** Notify all active AgentBoxes. */
  notifyAll(descriptor: GatewaySyncDescriptor): Promise<NotifyResult>;
  /** Notify AgentBoxes belonging to a single user. */
  notifyUser(descriptor: GatewaySyncDescriptor, userId: string): Promise<NotifyResult>;
}

// ── AgentBox-side interfaces ──────────────────────────────────────────

/**
 * Minimal interface that the AgentBox handlers use to talk to the Gateway.
 * Keeps handlers decoupled from the concrete GatewayClient.
 */
export interface GatewaySyncClientLike {
  request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown>;
}

/**
 * Optional context passed to handlers during a reload triggered by an
 * HTTP POST from the Gateway.
 */
export interface ReloadContext {
  /** Active brain sessions that may need to be refreshed after reload. */
  sessions?: Array<{ id: string; brain: { reload(): Promise<void> } }>;
}

/**
 * Encapsulates fetch → materialize → post-reload for a single syncable
 * type on the AgentBox side.
 *
 * Note: `client` may be `null` for handlers whose descriptor has
 * `requiresGatewayClient=false` (e.g. cluster/host handlers that walk
 * through the CredentialBroker's own transport instead).
 */
export interface AgentBoxSyncHandler<T = unknown> {
  type: GatewaySyncType;
  /** Pull the latest payload. */
  fetch(client: GatewaySyncClientLike | null): Promise<T>;
  /** Write the payload to the local filesystem / apply it. Returns a human-friendly count. */
  materialize(payload: T): Promise<number>;
  /** Optional post-reload hook (e.g. tell active sessions to rescan). */
  postReload?(context: ReloadContext): Promise<void>;
}

// ── Descriptor registry ───────────────────────────────────────────────

export const GATEWAY_SYNC_DESCRIPTORS: Record<GatewaySyncType, GatewaySyncDescriptor> = {
  mcp: {
    type: "mcp",
    gatewayPath: "/api/internal/mcp-servers",
    reloadPath: "/api/reload-mcp",
    retry: { maxRetries: 3, baseDelayMs: 1000 },
    requiresGatewayClient: true,
    initialSync: true,
  },
  skills: {
    type: "skills",
    gatewayPath: "/api/internal/skills/bundle",
    reloadPath: "/api/reload-skills",
    retry: { maxRetries: 3, baseDelayMs: 1000 },
    requiresGatewayClient: true,
    initialSync: true,
  },
  cluster: {
    type: "cluster",
    // gatewayPath unused: handler walks through the CredentialBroker's
    // own HttpTransport (same for K8s and Local mode).
    gatewayPath: "",
    reloadPath: "/api/reload-cluster",
    retry: { maxRetries: 3, baseDelayMs: 1000 },
    requiresGatewayClient: false,
    initialSync: false,
  },
  host: {
    type: "host",
    gatewayPath: "",
    reloadPath: "/api/reload-host",
    retry: { maxRetries: 3, baseDelayMs: 1000 },
    requiresGatewayClient: false,
    initialSync: false,
  },
};
