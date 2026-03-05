/**
 * Resource Sync — Core Types & Descriptors
 *
 * Defines the abstraction layer for synchronising resources (MCP servers,
 * skills, etc.) between Gateway and AgentBox.  All resource-specific logic
 * is expressed through these interfaces; transport / retry / notification
 * code stays generic.
 */

// ── Scalar types ──────────────────────────────────────────────────────

/** Every syncable resource has a well-known type key. */
export type ResourceType = "mcp" | "skills";

/** How the Gateway should fan out reload notifications. */
export type NotifyMode = "broadcast" | "per-user";

// ── Config / descriptor interfaces ────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of attempts (including the first). */
  maxRetries: number;
  /** Base delay in ms — actual delay = baseDelayMs * 2^attempt. */
  baseDelayMs: number;
}

/**
 * Static metadata that describes how a resource is synced.
 * One descriptor per ResourceType; registered in RESOURCE_DESCRIPTORS.
 */
export interface ResourceDescriptor {
  type: ResourceType;
  /** Gateway internal API path for fetching the resource. */
  gatewayPath: string;
  /** AgentBox HTTP path the Gateway POSTs to trigger a reload. */
  reloadPath: string;
  /** Supported notification modes. */
  notifyModes: NotifyMode[];
  /** Default retry configuration for initial sync. */
  retry: RetryConfig;
}

// ── Gateway-side interfaces ───────────────────────────────────────────

/**
 * Provides the raw resource payload on the Gateway side.
 * One implementation per ResourceType (e.g. MCP provider, skills provider).
 */
export interface GatewayResourceProvider<T = unknown> {
  type: ResourceType;
  /** Fetch the resource for a given identity (userId / anonymous). */
  fetch(identity?: string): Promise<T>;
}

/**
 * Result of a notify round — how many boxes succeeded / failed.
 */
export interface NotifyResult {
  resourceType: ResourceType;
  success: number;
  failed: number;
}

/**
 * Sends reload notifications to AgentBoxes.
 */
export interface ResourceNotifier {
  /** Notify all active AgentBoxes. */
  notifyAll(descriptor: ResourceDescriptor): Promise<NotifyResult>;
  /** Notify AgentBoxes belonging to a single user. */
  notifyUser(descriptor: ResourceDescriptor, userId: string): Promise<NotifyResult>;
}

// ── AgentBox-side interfaces ──────────────────────────────────────────

/**
 * Minimal interface that the AgentBox resource handlers use to talk to
 * the Gateway.  Keeps handlers decoupled from the concrete GatewayClient.
 */
export interface GatewayClientLike {
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
 * Encapsulates fetch → materialize → post-reload for a single resource
 * type on the AgentBox side.
 */
export interface AgentBoxResourceHandler<T = unknown> {
  type: ResourceType;
  /** Pull the latest resource payload from the Gateway. */
  fetch(client: GatewayClientLike): Promise<T>;
  /** Write the payload to the local filesystem / apply it. Returns a human-friendly count. */
  materialize(payload: T): Promise<number>;
  /** Optional post-reload hook (e.g. tell active sessions to rescan). */
  postReload?(context: ReloadContext): Promise<void>;
}

// ── Descriptor registry ───────────────────────────────────────────────

export const RESOURCE_DESCRIPTORS: Record<ResourceType, ResourceDescriptor> = {
  mcp: {
    type: "mcp",
    gatewayPath: "/api/internal/mcp-servers",
    reloadPath: "/api/reload-mcp",
    notifyModes: ["broadcast"],
    retry: { maxRetries: 3, baseDelayMs: 1000 },
  },
  skills: {
    type: "skills",
    gatewayPath: "/api/internal/skills/bundle",
    reloadPath: "/api/reload-skills",
    notifyModes: ["broadcast", "per-user"],
    retry: { maxRetries: 3, baseDelayMs: 1000 },
  },
};
