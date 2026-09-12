/** The model supplies code and requested scope, never identities or production secrets. */
export interface ScriptRequest {
  language: "python" | "shell";
  code: string;
  input?: unknown;
  network_isolation?: boolean;
  timeout_seconds?: number;
  /** Resource names only. Kubernetes permissions come from the bound credential. */
  clusters?: Array<{ name: string }>;
  hosts?: string[];
  mcp?: Array<{ server: string; tools: string[] }>;
}

export interface ScriptResult {
  run_id: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  error?: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  notices?: string[];
  cleanup?: "not_required" | "confirmed" | "pending";
  output_truncated: boolean;
  network_isolation: boolean;
  tool_calls: number;
  duration_ms: number;
  startup_ms: number;
  warm: boolean;
}

export interface ScriptPrincipal {
  /** Trusted callback grant: never log or forward to runner. */
  callbackToken?: string;
  runId?: string;
  /** Trusted absolute script deadline, established only after runner readiness. */
  deadlineMs?: number;
  agentId: string;
  userId: string;
  sessionId: string;
  boxId: string;
}

export interface ScriptToolCall {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Data delivery only; never a path, credential, resource scope or endpoint. */
  delivery?: "file";
}

export type ScriptExecutor = (request: ScriptRequest, sessionId: string, signal?: AbortSignal) => Promise<ScriptResult>;

/** Public execution budgets only; provider configuration and credentials stay in Runtime. */
export interface ScriptSandboxInfo {
  enabled: boolean;
  network_isolation: boolean;
  require_network_isolation: boolean;
  limits?: {
    default_timeout_seconds: number;
    max_timeout_seconds: number;
    max_tool_calls: number;
    max_output_bytes: number;
    max_concurrent_tools?: number;
  };
}

export interface ScriptSandboxConfig {
  enabled: boolean;
  provider: "k8s" | "docker" | "e2b";
  /** Service configuration only; never exposed in the tool schema or runner environment. */
  e2b?: { apiKey: string; template: string; apiUrl: string; domain: string };
  image: string;
  namespace: string;
  serviceAccount: string;
  runtimeClass?: string;
  networkIsolation: boolean;
  requireNetworkIsolation: boolean;
  maxTimeoutSeconds: number;
  maxConcurrentRuns: number;
  warmPoolSize: number;
  warmIdleSeconds: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  /** Operator-reviewed HTTP MCP operations; annotations are not authorization. */
  hostKeyPins: Record<string, string>;
  mcpPolicy: Record<string, Record<string, { fixedArguments?: Record<string, unknown> }>>;
}

export interface ScriptChannel {
  instanceId: string;
  warm?: boolean;
  stdout: import("node:stream").Readable;
  stderr: import("node:stream").Readable;
  stdin: import("node:stream").Writable;
  done: Promise<number | null>;
  /** Bound after a warm instance is claimed, using the actual authorized run. */
  bindTools?(binding: ScriptToolBinding): Promise<void>;
  close(): Promise<void>;
}

export interface ScriptToolBinding {
  principal: ScriptPrincipal;
  timeoutSeconds: number;
  signal: AbortSignal;
  call(raw: unknown): Promise<unknown>;
}

export interface ScriptSandboxProvider {
  start(runId: string, isolated: boolean, timeoutSeconds: number, signal: AbortSignal): Promise<ScriptChannel>;
  shutdown?(): Promise<void>;
}

export const SCRIPT_MAX_FRAME_BYTES = 256 * 1024;
export const SCRIPT_MAX_CODE_BYTES = 128 * 1024;
export const SCRIPT_MAX_INPUT_BYTES = 128 * 1024;

export class ScriptSandboxError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ScriptSandboxError";
  }
}
