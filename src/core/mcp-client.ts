/**
 * MCP Client Manager — connects to external MCP servers and exposes their tools
 * as pi-agent ToolDefinitions (TypeBox schema) for the pi-agent brain,
 * and as raw config for the Claude SDK brain (native MCP support).
 *
 * Supports three transport types: stdio, sse, streamable-http.
 * Config loaded from .siclaw/config/settings.json mcpServers field.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

interface ManagedMcpClient {
  serverName: string;
  client: any; // Client from @modelcontextprotocol/sdk
  transport: any;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema object (as returned by MCP tool inputSchema) to a
 * TypeBox TSchema. Covers the common subset used by MCP tools.
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

  constructor(config: McpServersConfig) {
    this.config = config;
  }

  /**
   * Initialize all MCP server connections and discover tools.
   */
  async initialize(): Promise<void> {
    const entries = Object.entries(this.config.mcpServers);
    if (entries.length === 0) return;

    // Lazy-import the SDK (only when actually used)
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    for (const [serverName, serverConfig] of entries) {
      try {
        const client = new Client(
          { name: `siclaw-mcp-${serverName}`, version: "1.0.0" },
        );

        let transport: any;
        // Auto-detect transport when not explicitly set: url → streamable-http, command → stdio
        const cfg = serverConfig as any;
        const detectedTransport: string = cfg.transport
          ?? (cfg.url ? "streamable-http" : cfg.command ? "stdio" : "");
        switch (detectedTransport) {
          case "stdio":
            transport = new StdioClientTransport({
              command: cfg.command,
              args: cfg.args,
              env: cfg.env,
            });
            break;
          case "sse":
            transport = new SSEClientTransport(
              new URL(cfg.url),
              cfg.headers
                ? { requestInit: { headers: cfg.headers } }
                : undefined,
            );
            break;
          case "streamable-http":
            transport = new StreamableHTTPClientTransport(
              new URL(cfg.url),
              cfg.headers
                ? { requestInit: { headers: cfg.headers } }
                : undefined,
            );
            break;
          default:
            console.warn(`[mcp-client] Unknown transport for "${serverName}": ${detectedTransport}`);
            continue;
        }

        await client.connect(transport);
        console.log(`[mcp-client] Connected to "${serverName}" (${detectedTransport})`);

        // Discover tools
        const { tools: mcpTools } = await client.listTools();
        console.log(`[mcp-client] "${serverName}" provides ${mcpTools.length} tools: ${mcpTools.map((t: any) => t.name).join(", ")}`);

        for (const mcpTool of mcpTools) {
          const toolDef = this.createToolDefinition(serverName, cfg.description, mcpTool, client);
          this.tools.push(toolDef);
        }

        this.clients.push({ serverName, client, transport });
      } catch (err) {
        console.error(`[mcp-client] Failed to connect to "${serverName}":`, err);
      }
    }

    console.log(`[mcp-client] Initialized ${this.clients.length} servers, ${this.tools.length} tools total`);
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

  /**
   * Create a pi-agent ToolDefinition from an MCP tool descriptor.
   */
  private createToolDefinition(
    serverName: string,
    serverDescription: string | undefined,
    mcpTool: { name: string; description?: string; inputSchema?: any },
    client: any,
  ): ToolDefinition {
    const fullName = buildMcpToolName(serverName, mcpTool.name);
    const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };
    const parameters = jsonSchemaToTypebox(inputSchema);

    // Prepend the admin-provided server description so the model sees server-level
    // context (e.g. monitoring tenant IDs) on every tool from that server.
    const serverContext = serverDescription?.trim()
      ? `[Server "${serverName}" context: ${serverDescription.trim()}]\n`
      : "";
    const toolDescription = mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`;

    return {
      name: fullName,
      label: `${serverName}/${mcpTool.name}`,
      description: serverContext + toolDescription,
      parameters,
      execute: async (_toolCallId, args) => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args ?? {},
          });

          const isError = !!result.isError;
          const { content, text } = mcpContentToAgentContent(result.content);

          return {
            content,
            details: isError ? { error: text } : {},
          };
        } catch (err: any) {
          const errorMsg = err?.message ?? String(err);
          return {
            content: [{ type: "text" as const, text: `MCP tool error: ${errorMsg}` }],
            details: { error: errorMsg },
          };
        }
      },
    };
  }
}
