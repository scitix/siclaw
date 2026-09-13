/**
 * MCP Client Manager — connects to external MCP servers and exposes their tools
 * as pi-agent ToolDefinitions (raw MCP JSON Schema as parameters) for the
 * pi-agent brain, and as raw config for the Claude SDK brain (native MCP support).
 *
 * Supports three transport types: stdio, sse, streamable-http.
 * Config loaded from .siclaw/config/settings.json mcpServers field.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ResolvedToolDefinition } from "./tool-registry.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Admin-provided server context (e.g. tenant IDs) — surfaced to the model via tool descriptions. */
  description?: string;
}

export interface McpSseServerConfig {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  /** Admin-provided server context (e.g. tenant IDs) — surfaced to the model via tool descriptions. */
  description?: string;
}

export interface McpStreamableHttpServerConfig {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  /** Admin-provided server context (e.g. tenant IDs) — surfaced to the model via tool descriptions. */
  description?: string;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpStreamableHttpServerConfig;

export interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const MCP_STDIO_FORWARDED_ENV = [
  "SICLAW_VISUAL_EXPORT_URL",
  "SICLAW_VISUAL_EXPORT_TIMEOUT_MS",
  "SICLAW_VISUAL_EXPORT_THEME",
  "SICLAW_VISUAL_EXPORT_CHROMIUM",
] as const;
const DEFAULT_VISUAL_EXPORT_TIMEOUT_MS = 60_000;
const VISUAL_EXPORT_MCP_GRACE_MS = 5_000;
const MCP_DISCOVERY_MAX_PAGES = 32;
const MCP_DISCOVERY_MAX_TOOLS = 1000;
const MCP_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
const MCP_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Optionally forward the platform-owned renderer contract into a bundled stdio MCP.
 * The MCP SDK otherwise inherits a deliberately small OS environment.
 */
export function mergeMcpStdioEnv(
  configuredEnv: Record<string, string> | undefined,
  parentEnv: Record<string, string | undefined> = process.env,
  inheritVisualExport = false,
): Record<string, string> | undefined {
  const inherited: Record<string, string> = {};
  if (inheritVisualExport) {
    for (const name of MCP_STDIO_FORWARDED_ENV) {
      const value = parentEnv[name];
      if (value !== undefined && value !== "") inherited[name] = value;
    }
  }
  const merged = { ...inherited, ...configuredEnv };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function isBundledCreateChartCommand(command: unknown, args: unknown = []): boolean {
  const candidates = [command, ...(Array.isArray(args) ? args : [])];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    if (candidate.split(/[\\/]/).at(-1) === "mcp-create-chart") return true;
    return /(?:^|[\\/])mcp[\\/]create-chart[\\/](?:dist[\\/])?index\.js$/.test(candidate);
  });
}

export function visualMcpRequestTimeoutMs(
  serverImplementationName: unknown,
  toolName: string,
  env: Record<string, string | undefined> = {},
): number | undefined {
  if (
    serverImplementationName !== "mcp-create-chart" ||
    !/^render_(?:chart|mermaid)$/.test(toolName)
  ) {
    return undefined;
  }
  const configured = Number(env.SICLAW_VISUAL_EXPORT_TIMEOUT_MS ?? DEFAULT_VISUAL_EXPORT_TIMEOUT_MS);
  const rendererBudget = Number.isFinite(configured) && configured > 0
    ? Math.ceil(configured)
    : DEFAULT_VISUAL_EXPORT_TIMEOUT_MS;
  return rendererBudget + VISUAL_EXPORT_MCP_GRACE_MS;
}

interface ManagedMcpClient {
  serverName: string;
  client: any; // Client from @modelcontextprotocol/sdk
  transport: any;
}

// ---------------------------------------------------------------------------
// Connection observations
// ---------------------------------------------------------------------------

/**
 * Why a configured MCP server could not be connected, as a closed vocabulary
 * the control plane can render and aggregate without parsing free text.
 *
 *   invalid_config     the entry itself is unusable (unknown transport, bad URL)
 *   dns                the host does not resolve
 *   connection_refused TCP-level refusal
 *   timeout            connect or handshake did not finish in time
 *   tls                certificate / TLS negotiation failed
 *   auth               HTTP 401/403 from the endpoint
 *   not_found          HTTP 404 — usually a URL that points at something that
 *                      is not an MCP endpoint (a web page, a wrong path)
 *   not_mcp            the endpoint answered, but with something that is not an
 *                      MCP response (an HTML page, a non-JSON body)
 *   http               any other HTTP status the transport rejected
 *   protocol           MCP-level failure after transport (initialize/listTools)
 *   unknown            nothing above matched
 */
export type McpConnectErrorKind =
  | "invalid_config"
  | "dns"
  | "connection_refused"
  | "timeout"
  | "tls"
  | "auth"
  | "not_found"
  | "not_mcp"
  | "http"
  | "protocol"
  | "unknown";

export interface McpConnectError {
  kind: McpConnectErrorKind;
  /** HTTP status when the transport surfaced one. */
  httpStatus?: number;
  /** Hint about what the endpoint actually returned, e.g. "text/html". */
  contentType?: string;
  /** Short, HTML-stripped, length-capped message. Never a full response body. */
  message: string;
}

/**
 * One configured server's connection outcome, as observed by the process that
 * actually dialled it. `toolCount` is 0 for a failed server by construction.
 */
export interface McpServerConnection {
  name: string;
  transport: string;
  state: "connected" | "failed";
  toolCount: number;
  toolNames: string[];
  durationMs: number;
  observedAt: string;
  error?: McpConnectError;
}

const MCP_CONNECT_ERROR_MESSAGE_MAX = 300;

function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype\s+html|html[\s>])/i.test(text) || /<\/html>\s*$/i.test(text);
}

/** Collapse an error message to something safe to store and show. */
function compactErrorMessage(raw: string): string {
  let text = raw;
  if (looksLikeHtml(text) || /<[a-z][^>]*>/i.test(text)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    text = title ? `HTML page: ${title}` : "HTML page";
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MCP_CONNECT_ERROR_MESSAGE_MAX
    ? `${text.slice(0, MCP_CONNECT_ERROR_MESSAGE_MAX - 1)}…`
    : text;
}

/**
 * Classify a connection failure into {@link McpConnectError}.
 *
 * The SDK's `StreamableHTTPError` / `SseError` carry the HTTP status in `.code`
 * and often the raw response body in the message. A body that is an HTML page
 * is the signature of "this URL is not an MCP endpoint" — the exact mistake a
 * platform MCP owner makes by pasting a page URL — so it gets its own kind even
 * when the status is missing.
 */
export function classifyMcpConnectError(err: unknown): McpConnectError {
  const anyErr = err as any;
  const rawMessage: string = typeof anyErr?.message === "string" ? anyErr.message : String(err);
  const message = compactErrorMessage(rawMessage);
  const code = anyErr?.code;
  let httpStatus: number | undefined;
  if (typeof code === "number" && code >= 100 && code <= 599) {
    httpStatus = code;
  } else {
    const m = /\b(?:HTTP\s+)?(?:status|code)\s*[:=]?\s*(\d{3})\b/i.exec(rawMessage)
      ?? /\bHTTP\s+(\d{3})\b/.exec(rawMessage);
    if (m) httpStatus = Number(m[1]);
  }
  const html = looksLikeHtml(rawMessage) || /<html[\s>]/i.test(rawMessage);
  const base: Omit<McpConnectError, "kind"> = {
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(html ? { contentType: "text/html" } : {}),
  };

  const sysCode: string = typeof code === "string"
    ? code
    : typeof anyErr?.cause?.code === "string" ? anyErr.cause.code : "";
  if (sysCode === "ENOTFOUND" || sysCode === "EAI_AGAIN" || /getaddrinfo/i.test(rawMessage)) {
    return { kind: "dns", ...base };
  }
  if (sysCode === "ECONNREFUSED" || /ECONNREFUSED/.test(rawMessage)) {
    return { kind: "connection_refused", ...base };
  }
  if (sysCode === "ETIMEDOUT" || anyErr?.name === "AbortError" || /timed? ?out/i.test(rawMessage)) {
    return { kind: "timeout", ...base };
  }
  if (/^(?:ERR_TLS|CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO)/.test(sysCode) || /certificate|\bTLS\b|\bSSL\b/i.test(rawMessage)) {
    return { kind: "tls", ...base };
  }
  if (httpStatus === 401 || httpStatus === 403) return { kind: "auth", ...base };
  if (httpStatus === 404) return { kind: "not_found", ...base };
  if (html || /unexpected token|not valid JSON|invalid json/i.test(rawMessage)) {
    return { kind: "not_mcp", ...base };
  }
  if (httpStatus !== undefined) return { kind: "http", ...base };
  if (/^(?:McpError|ProtocolError)$/.test(anyErr?.name ?? "") || /MCP error|protocol/i.test(rawMessage)) {
    return { kind: "protocol", ...base };
  }
  return { kind: "unknown", ...base };
}

// ---------------------------------------------------------------------------
// MCP inputSchema handling
// ---------------------------------------------------------------------------

/**
 * Normalize an MCP tool `inputSchema` into the JSON Schema object passed to the
 * pi runtime as a tool's `parameters`.
 *
 * We intentionally keep this as a *plain JSON Schema* (no TypeBox kind metadata)
 * so the runtime's argument coercion runs — see the detailed note in
 * `createToolDefinition` and scitix/siclaw#355. We only guarantee the object
 * shape the providers and validator expect (`type: "object"` + `properties`),
 * preserving any other fields (`required`, `additionalProperties`, ...).
 */
export function normalizeMcpInputSchema(schema: any): TSchema {
  const base = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {};
  const normalized = {
    ...base,
    type: "object" as const,
    properties: base.properties ?? {},
  };
  // Cast: ToolDefinition.parameters is typed as TSchema, but the pi runtime accepts
  // (and here requires) a raw JSON Schema object at runtime.
  return normalized as unknown as TSchema;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema object (as returned by MCP tool inputSchema) to a
 * TypeBox TSchema. Covers the common subset used by MCP tools.
 *
 * NOTE: No longer used for MCP tool `parameters` (see `normalizeMcpInputSchema`
 * and scitix/siclaw#355). Retained for compatibility / potential reuse.
 */
export function jsonSchemaToTypebox(schema: any): TSchema {
  if (!schema || typeof schema !== "object") return Type.Any();

  const desc = schema.description as string | undefined;

  switch (schema.type) {
    case "string": {
      const opts: any = {};
      if (desc) opts.description = desc;
      if (schema.enum) {
        // String enum → Union of Literals
        const literals = (schema.enum as string[]).map((v) => Type.Literal(v));
        if (literals.length === 1) return literals[0];
        return Type.Union(literals, opts);
      }
      return Type.String(opts);
    }
    case "number":
      return Type.Number(desc ? { description: desc } : {});
    case "integer":
      return Type.Integer(desc ? { description: desc } : {});
    case "boolean":
      return Type.Boolean(desc ? { description: desc } : {});
    case "array": {
      const items = schema.items ? jsonSchemaToTypebox(schema.items) : Type.Any();
      return Type.Array(items, desc ? { description: desc } : {});
    }
    case "object": {
      const props: Record<string, TSchema> = {};
      const required = new Set<string>(schema.required ?? []);
      if (schema.properties) {
        for (const [key, val] of Object.entries(schema.properties)) {
          const converted = jsonSchemaToTypebox(val);
          props[key] = required.has(key) ? converted : Type.Optional(converted);
        }
      }
      return Type.Object(props, desc ? { description: desc } : {});
    }
    default:
      // oneOf / anyOf / allOf / null / mixed — fallback to any
      if (schema.oneOf || schema.anyOf) {
        const variants = (schema.oneOf ?? schema.anyOf) as any[];
        const converted = variants.map(jsonSchemaToTypebox);
        if (converted.length === 1) return converted[0];
        return Type.Union(converted, desc ? { description: desc } : {});
      }
      return Type.Any();
  }
}

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

/** Prefix used for all MCP tool names — use with isMcpTool() for identification. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Build a tool name scoped by server name.
 * Format: mcp__{serverName}__{toolName}
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/** Check whether a tool name belongs to an MCP-sourced tool. */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

export function mcpContentToAgentContent(mcpContent: any[] | undefined): { content: any[]; text: string } {
  const content: any[] = [];
  const textParts: string[] = [];
  for (const item of mcpContent ?? []) {
    if (item?.type === "text") {
      const text = item.text ?? "";
      textParts.push(text);
      content.push({ type: "text" as const, text });
      continue;
    }
    if (item?.type === "image") {
      const data = item.data;
      const mimeType = item.mimeType ?? item.mime_type;
      if (typeof data === "string" && typeof mimeType === "string" && /^image\/(?:png|jpe?g|webp|svg\+xml)$/i.test(mimeType)) {
        content.push({ type: "image" as const, data, mimeType });
      }
    }
  }
  const text = textParts.join("\n") || "(no output)";
  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text }],
    text,
  };
}

// ---------------------------------------------------------------------------
// McpClientManager
// ---------------------------------------------------------------------------

export class McpClientManager {
  private clients: ManagedMcpClient[] = [];
  private tools: ToolDefinition[] = [];
  private config: McpServersConfig;
  /**
   * Per-server connection outcome from the last `initialize()`. Kept alongside
   * the successful clients precisely because failures used to vanish into a
   * console.error: the control plane then saw the configured names, could not
   * tell a connected server from a dead one, and reported both as "installed".
   */
  private connections: McpServerConnection[] = [];
  /**
   * Set by shutdown(). initialize() checks it after every await so a connection
   * that completes AFTER the manager was shut down — a probe that timed out, a
   * session released while a slow server was still dialling — is closed on the
   * spot instead of being registered into a list nobody will close again.
   */
  private disposed = false;

  constructor(config: McpServersConfig) {
    this.config = config;
  }

  /**
   * Initialize all MCP server connections and discover tools.
   */
  async initialize(): Promise<void> {
    const entries = Object.entries(this.config.mcpServers);
    this.connections = [];
    this.disposed = false;
    if (entries.length === 0) return;

    // Lazy-import the SDK (only when actually used)
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    for (const [serverName, serverConfig] of entries) {
      const startedAt = Date.now();
      // Auto-detect transport when not explicitly set: url → streamable-http, command → stdio
      const cfg = serverConfig as any;
      const detectedTransport: string = cfg.transport
        ?? (cfg.url ? "streamable-http" : cfg.command ? "stdio" : "");
      // Set once the transport is up, so the catch below can close a client
      // whose listTools() failed: the SSE stream is open by then, and a client
      // that never reached this.clients is otherwise closed by nobody.
      let connected: any = null;
      const discoverySignal = AbortSignal.timeout(MCP_DISCOVERY_TIMEOUT_MS);
      const recordFailure = (error: McpConnectError) => {
        this.connections.push({
          name: serverName, transport: detectedTransport, state: "failed",
          toolCount: 0, toolNames: [], durationMs: Date.now() - startedAt,
          observedAt: new Date().toISOString(), error,
        });
      };
      try {
        const client = new Client(
          { name: `siclaw-mcp-${serverName}`, version: "1.0.0" },
        );

        let transport: any;
        const stdioEnv = detectedTransport === "stdio"
          ? mergeMcpStdioEnv(cfg.env, process.env, isBundledCreateChartCommand(cfg.command, cfg.args))
          : undefined;
        switch (detectedTransport) {
          case "stdio":
            transport = new StdioClientTransport({
              command: cfg.command,
              args: cfg.args,
              env: stdioEnv,
            });
            break;
          case "sse":
            transport = new SSEClientTransport(
              new URL(cfg.url),
              cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
            );
            break;
          case "streamable-http":
            transport = new StreamableHTTPClientTransport(
              new URL(cfg.url),
              cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
            );
            break;
          default:
            console.warn(`[mcp-client] Unknown transport for "${serverName}": ${detectedTransport}`);
            recordFailure({
              kind: "invalid_config",
              message: `unknown transport "${detectedTransport}"`,
            });
            continue;
        }

        connected = client;
        let expire!: () => void;
        const expired = new Promise<never>((_, reject) => {
          expire = () => reject(discoverySignal.reason);
          discoverySignal.addEventListener("abort", expire, { once: true });
          if (discoverySignal.aborted) expire();
        });
        try { await Promise.race([client.connect(transport, { signal: discoverySignal }), expired]); }
        finally { discoverySignal.removeEventListener("abort", expire); }
        if (this.disposed) {
          await this.closeLate(serverName, client, startedAt, detectedTransport);
          continue;
        }
        console.log(`[mcp-client] Connected to "${serverName}" (${detectedTransport})`);
        const serverImplementationName = client.getServerVersion()?.name;

        // Publish a complete per-server inventory. A failed later page must not
        // leave a partial tool set that silently hides capabilities from the model.
        const mcpTools: McpTool[] = [];
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let schemaBytes = 0;
        for (let page = 0; page < MCP_DISCOVERY_MAX_PAGES; page++) {
          const result = await client.listTools(cursor ? { cursor } : undefined, { signal: discoverySignal });
          if (this.disposed) break;
          schemaBytes += Buffer.byteLength(JSON.stringify(result.tools));
          if (schemaBytes > MCP_DISCOVERY_MAX_BYTES || mcpTools.length + result.tools.length > MCP_DISCOVERY_MAX_TOOLS) {
            throw Object.assign(new Error("MCP tool inventory exceeds discovery budget"), { name: "ProtocolError" });
          }
          for (const tool of result.tools) {
            if (!tool.name || names.has(tool.name)) {
              throw Object.assign(new Error("MCP tool inventory contains missing or duplicate names"), { name: "ProtocolError" });
            }
            names.add(tool.name);
            mcpTools.push(tool);
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
          if (cursor.length > 4096 || cursors.has(cursor) || page + 1 === MCP_DISCOVERY_MAX_PAGES) {
            throw Object.assign(new Error("MCP tool pagination is invalid or exceeds discovery budget"), { name: "ProtocolError" });
          }
          cursors.add(cursor);
        }
        if (this.disposed) {
          await this.closeLate(serverName, client, startedAt, detectedTransport);
          continue;
        }
        console.log(`[mcp-client] "${serverName}" provides ${mcpTools.length} tools: ${mcpTools.map((t: any) => t.name).join(", ")}`);

        for (const mcpTool of mcpTools) {
          const toolDef = createMcpToolDefinition(
            serverName,
            cfg.description,
            mcpTool,
            client,
            detectedTransport === "stdio"
              ? visualMcpRequestTimeoutMs(serverImplementationName, mcpTool.name, stdioEnv)
              : undefined,
          );
          this.tools.push(toolDef);
        }

        this.clients.push({ serverName, client, transport });
        this.connections.push({
          name: serverName, transport: detectedTransport, state: "connected",
          toolCount: mcpTools.length,
          toolNames: mcpTools.map((t: any) => String(t.name)).sort(),
          durationMs: Date.now() - startedAt,
          observedAt: new Date().toISOString(),
        });
      } catch (err) {
        const error = classifyMcpConnectError(err);
        // The classified line is what an operator greps for; the raw error keeps
        // the full detail (it can be a whole response body) on the next line.
        console.error(
          `[mcp-client] Failed to connect to "${serverName}" (${detectedTransport}): ${error.kind}` +
          (error.httpStatus !== undefined ? ` http=${error.httpStatus}` : "") +
          (error.contentType ? ` content-type=${error.contentType}` : "") +
          ` — ${error.message}`,
        );
        console.error(`[mcp-client] Raw error for "${serverName}":`, err);
        recordFailure(error);
        if (connected) {
          try { await connected.close(); } catch (closeErr) {
            console.warn(`[mcp-client] Failed to close "${serverName}" after a failed handshake:`, closeErr);
          }
        }
      }
    }

    console.log(`[mcp-client] Initialized ${this.clients.length} servers, ${this.tools.length} tools total`);
  }

  /** Close a connection that completed after shutdown() and record why it is not usable. */
  private async closeLate(serverName: string, client: any, startedAt: number, transport: string): Promise<void> {
    console.warn(`[mcp-client] "${serverName}" connected after the manager was shut down; closing it`);
    try {
      await client.close();
    } catch (err) {
      console.warn(`[mcp-client] Error closing late connection to "${serverName}":`, err);
    }
    this.connections.push({
      name: serverName, transport, state: "failed", toolCount: 0, toolNames: [],
      durationMs: Date.now() - startedAt, observedAt: new Date().toISOString(),
      error: { kind: "timeout", message: "connection completed after the manager was shut down" },
    });
  }

  /**
   * Connection outcome of every configured server from the last `initialize()`,
   * in configuration order. Failed servers are present with `state: "failed"`
   * and a classified error; this is the list a box reports upstream so the
   * control plane can show "configured but not connected" instead of "installed".
   */
  getServerConnections(): McpServerConnection[] {
    return this.connections.map((item) => ({
      ...item,
      toolNames: [...item.toolNames],
      ...(item.error ? { error: { ...item.error } } : {}),
    }));
  }

  /**
   * Get all discovered tools as pi-agent ToolDefinitions.
   */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * Get the raw MCP servers config for SDK brain (native MCP support).
   */
  getConfig(): McpServersConfig {
    return this.config;
  }

  /**
   * Shutdown all MCP client connections.
   */
  async shutdown(): Promise<void> {
    this.disposed = true;
    for (const { serverName, client } of this.clients) {
      try {
        await client.close();
        console.log(`[mcp-client] Disconnected from "${serverName}"`);
      } catch (err) {
        console.warn(`[mcp-client] Error disconnecting from "${serverName}":`, err);
      }
    }
    this.clients = [];
    this.tools = [];
  }

}

/** Shared Agent/SDK MCP tool factory. Transport authorization belongs to its caller. */
export function createMcpToolDefinition(
  serverName: string,
  serverDescription: string | undefined,
  mcpTool: {
    name: string;
    description?: string;
    inputSchema?: any;
    /**
     * MCP 规范的工具注解。这里只用 `readOnlyHint` —— authority guard 靠它决定
     * 这个工具算不算"读"。见 tool-registry 的 MCP_TOOL_EFFECTS。
     */
    annotations?: { readOnlyHint?: boolean };
  },
  client: any,
  requestTimeoutMs?: number,
  trustedOptions?: { includeRawResult?: boolean },
): ResolvedToolDefinition {
  const fullName = buildMcpToolName(serverName, mcpTool.name);
  const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };
  // Pass the MCP inputSchema through as raw JSON Schema instead of converting it
  // into a @sinclair/typebox TSchema. The pi runtime validates and coerces tool
  // arguments with a *different* TypeBox package (`typebox` 1.x, bundled under
  // @earendil-works/pi-ai) whose schema-kind detection (`~kind` string prop) is
  // incompatible with @sinclair/typebox 0.34's metadata (`Symbol.for('TypeBox.Kind')`).
  // Converting here silently disables string→number/boolean coercion (e.g. "10" → 10):
  // `Value.Convert` no-ops and pi-ai's JSON-Schema coercion fallback is skipped because
  // `hasTypeBoxMetadata` detects the 0.34 symbol — so integer/object params such as
  // get_panel_image's `panelId` fail validation with "must be integer". Raw JSON Schema
  // leaves the kind metadata absent, letting pi-ai's coercion path run, and providers
  // advertise tools straight from `.properties`/`.required`. See scitix/siclaw#355.
  const parameters = normalizeMcpInputSchema(inputSchema);

  // Prepend the admin-provided server description so the model sees server-level
  // context (e.g. monitoring tenant IDs) on every tool from that server.
  const serverContext = serverDescription?.trim()
    ? `[Server "${serverName}" context: ${serverDescription.trim()}]\n`
    : "";
  const toolDescription = mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`;

  return {
    name: fullName,
    toolset: `mcp:${serverName}`,
    label: `${serverName}/${mcpTool.name}`,
    description: serverContext + toolDescription,
    parameters,
    execute: async (_toolCallId, args, signal) => {
      try {
        signal?.throwIfAborted();
        const result = await client.callTool(
          {
            name: mcpTool.name,
            arguments: args ?? {},
          },
          undefined,
          requestTimeoutMs === undefined && !signal ? undefined : { ...(requestTimeoutMs === undefined ? {} : { timeout: requestTimeoutMs }), ...(signal ? { signal } : {}) },
        );

        const isError = !!result.isError;
        const { content, text } = mcpContentToAgentContent(result.content);

        return {
          content,
          details: {
            ...(trustedOptions?.includeRawResult ? { rawResult: result } : {}),
            ...(isError ? { error: text } : {}),
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
          },
        };
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        const execution = err instanceof McpError && ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(err.code)
          ? [ErrorCode.InvalidRequest, ErrorCode.InvalidParams, ErrorCode.MethodNotFound].includes(err.code) ? "NOT_DISPATCHED" : "FINISHED"
          : "UNKNOWN";
        return {
          content: [{ type: "text" as const, text: `MCP tool error: ${errorMsg}` }],
          details: { error: errorMsg, ...(trustedOptions?.includeRawResult ? { execution } : {}) },
        };
      }
    },
  };
}
