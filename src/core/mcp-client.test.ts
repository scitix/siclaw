import { describe, it, expect, vi, beforeEach } from "vitest";

// MCP SDK doubles. initialize() lazy-imports the SDK, so the connection lifecycle
// is only reachable in a test by standing in for those four modules. Everything
// else in this file exercises pure functions and is unaffected by these mocks.
const sdk = vi.hoisted(() => {
  const state = {
    connect: async (_transport: unknown): Promise<void> => {},
    listTools: async (): Promise<{ tools: unknown[] }> => ({ tools: [] }),
    /** Ordered log of every close() the manager performed. */
    closed: [] as string[],
    /** When set, every transport close() rejects with it. */
    transportCloseError: null as Error | null,
  };
  const transportDouble = (label: string) =>
    class {
      constructor(..._args: unknown[]) {}
      async close(): Promise<void> {
        state.closed.push(label);
        if (state.transportCloseError) throw state.transportCloseError;
      }
    };
  return { state, transportDouble };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(..._args: unknown[]) {}
    async connect(transport: unknown) { return sdk.state.connect(transport); }
    async listTools() { return sdk.state.listTools(); }
    async close() { sdk.state.closed.push("client"); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: sdk.transportDouble("stdio") }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: sdk.transportDouble("sse") }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: sdk.transportDouble("http") }));

import { jsonSchemaToTypebox, normalizeMcpInputSchema, buildMcpToolName, isMcpTool, MCP_TOOL_PREFIX, mcpContentToAgentContent, McpClientManager } from "./mcp-client.js";

describe("jsonSchemaToTypebox", () => {
  it("converts string type", () => {
    const schema = { type: "string", description: "A name" };
    const result = jsonSchemaToTypebox(schema);
    expect(result).toMatchObject({ type: "string", description: "A name" });
  });

  it("converts number type", () => {
    const result = jsonSchemaToTypebox({ type: "number" });
    expect(result).toMatchObject({ type: "number" });
  });

  it("converts integer type", () => {
    const result = jsonSchemaToTypebox({ type: "integer" });
    expect(result).toMatchObject({ type: "integer" });
  });

  it("converts boolean type", () => {
    const result = jsonSchemaToTypebox({ type: "boolean" });
    expect(result).toMatchObject({ type: "boolean" });
  });

  it("converts array type", () => {
    const schema = {
      type: "array",
      items: { type: "string" },
    };
    const result = jsonSchemaToTypebox(schema);
    expect(result).toMatchObject({ type: "array" });
    expect((result as any).items).toMatchObject({ type: "string" });
  });

  it("converts object with required and optional properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "The name" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    const result = jsonSchemaToTypebox(schema);
    expect(result).toMatchObject({ type: "object" });
    const props = (result as any).properties;
    expect(props).toBeDefined();
    expect(props.name).toMatchObject({ type: "string" });
    // age is not required, so it should be Optional (wrapped)
    expect(props.age).toBeDefined();
  });

  it("converts string enum to union of literals", () => {
    const schema = {
      type: "string",
      enum: ["a", "b", "c"],
    };
    const result = jsonSchemaToTypebox(schema);
    expect((result as any).anyOf).toBeDefined();
    expect((result as any).anyOf).toHaveLength(3);
  });

  it("handles null/undefined input gracefully", () => {
    expect(jsonSchemaToTypebox(null)).toBeDefined();
    expect(jsonSchemaToTypebox(undefined)).toBeDefined();
    expect(jsonSchemaToTypebox({})).toBeDefined();
  });

  it("converts nested object", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "integer" },
          },
          required: ["host"],
        },
      },
      required: ["config"],
    };
    const result = jsonSchemaToTypebox(schema);
    const configProp = (result as any).properties.config;
    expect(configProp).toMatchObject({ type: "object" });
    expect(configProp.properties.host).toMatchObject({ type: "string" });
  });
});

describe("buildMcpToolName", () => {
  it("prefixes with mcp__ and joins server/tool with double underscore", () => {
    expect(buildMcpToolName("myserver", "get_data")).toBe("mcp__myserver__get_data");
  });

  it("handles empty strings", () => {
    expect(buildMcpToolName("", "tool")).toBe("mcp____tool");
    expect(buildMcpToolName("server", "")).toBe("mcp__server__");
  });

  it("preserves hyphens and special chars in names", () => {
    expect(buildMcpToolName("my-server", "get-data")).toBe("mcp__my-server__get-data");
  });
});

describe("isMcpTool", () => {
  it("returns true for MCP tool names", () => {
    expect(isMcpTool("mcp__myserver__get_data")).toBe(true);
    expect(isMcpTool(`${MCP_TOOL_PREFIX}server__tool`)).toBe(true);
  });

  it("returns false for non-MCP tool names", () => {
    expect(isMcpTool("local_script")).toBe(false);
    expect(isMcpTool("pod_exec")).toBe(false);
    expect(isMcpTool("server__tool")).toBe(false);
  });
});

describe("mcpContentToAgentContent", () => {
  it("preserves MCP image content blocks for downstream channel forwarding", () => {
    const result = mcpContentToAgentContent([
      { type: "text", text: "chart rendered" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ]);

    expect(result.text).toBe("chart rendered");
    expect(result.content).toEqual([
      { type: "text", text: "chart rendered" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ]);
  });

  it("supports MCP snake_case image mime_type", () => {
    const result = mcpContentToAgentContent([
      { type: "image", data: "aW1n", mime_type: "image/jpeg" },
    ]);

    expect(result.text).toBe("(no output)");
    expect(result.content).toEqual([
      { type: "image", data: "aW1n", mimeType: "image/jpeg" },
    ]);
  });
});

describe("createToolDefinition server description", () => {
  const manager = new McpClientManager({ mcpServers: {} });
  const makeDef = (serverDescription: string | undefined, toolDescription?: string) =>
    (manager as any).createToolDefinition(
      "grafana",
      serverDescription,
      { name: "query", description: toolDescription },
      {},
    );

  it("prepends the admin-provided server description to the tool description", () => {
    const def = makeDef("Monitoring tenant ID: t-123", "Run a PromQL query");
    expect(def.description).toBe('[Server "grafana" context: Monitoring tenant ID: t-123]\nRun a PromQL query');
  });

  it("keeps the plain tool description when no server description is set", () => {
    expect(makeDef(undefined, "Run a PromQL query").description).toBe("Run a PromQL query");
    expect(makeDef("   ", "Run a PromQL query").description).toBe("Run a PromQL query");
  });

  it("applies the server context to the fallback description too", () => {
    const def = makeDef("Monitoring tenant ID: t-123");
    expect(def.description).toBe('[Server "grafana" context: Monitoring tenant ID: t-123]\nMCP tool query from grafana');
  });
});

describe("normalizeMcpInputSchema", () => {
  const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

  it("returns a plain JSON Schema without TypeBox kind metadata", () => {
    // This is the core invariant behind scitix/siclaw#355: MCP tool parameters
    // must NOT carry the @sinclair/typebox Kind symbol, otherwise the pi runtime
    // (typebox 1.x) skips its JSON-Schema arg coercion and string-encoded integers
    // like "10" fail validation with "must be integer".
    const result = normalizeMcpInputSchema({
      type: "object",
      properties: { panelId: { type: "integer" } },
      required: ["panelId"],
    });
    expect(Object.getOwnPropertySymbols(result)).not.toContain(TYPEBOX_KIND);
    // By contrast, the old TypeBox conversion DID carry the symbol.
    const viaTypebox = jsonSchemaToTypebox({ type: "object", properties: {} });
    expect(Object.getOwnPropertySymbols(viaTypebox)).toContain(TYPEBOX_KIND);
  });

  it("preserves properties, required and additionalProperties", () => {
    const result = normalizeMcpInputSchema({
      type: "object",
      properties: { panelId: { type: "integer" }, dashboardUid: { type: "string" } },
      required: ["panelId", "dashboardUid"],
      additionalProperties: { type: "string" },
    }) as any;
    expect(result.type).toBe("object");
    expect(result.properties.panelId).toEqual({ type: "integer" });
    expect(result.required).toEqual(["panelId", "dashboardUid"]);
    expect(result.additionalProperties).toEqual({ type: "string" });
  });

  it("guarantees object shape for missing/empty/invalid schemas", () => {
    expect(normalizeMcpInputSchema(undefined) as any).toMatchObject({ type: "object", properties: {} });
    expect(normalizeMcpInputSchema({}) as any).toMatchObject({ type: "object", properties: {} });
    expect(normalizeMcpInputSchema([1, 2]) as any).toMatchObject({ type: "object", properties: {} });
  });
});

describe("McpClientManager.initialize connection cleanup", () => {
  // A connection that fails before `this.clients.push()` is invisible to
  // shutdown(), which only walks that array. Without an explicit close in the
  // catch, the started transport (stdio child process / open http connection)
  // leaks — and since initialize() runs once per session on a resident box
  // (SICLAW_AGENTBOX_IDLE_TIMEOUT=0), nothing ever reclaims it.
  const stdioServer = { mcpServers: { probe: { command: "/bin/true" } } } as any;

  beforeEach(() => {
    sdk.state.closed = [];
    sdk.state.connect = async () => {};
    sdk.state.listTools = async () => ({ tools: [] });
    sdk.state.transportCloseError = null;
  });

  it("closes the transport when connect() fails", async () => {
    sdk.state.connect = async () => { throw new Error("ECONNREFUSED"); };
    await new McpClientManager(stdioServer).initialize();
    expect(sdk.state.closed).toContain("stdio");
  });

  it("closes the connection when listTools() fails after a completed handshake", async () => {
    sdk.state.listTools = async () => { throw new Error("tools/list timed out"); };
    await new McpClientManager(stdioServer).initialize();
    // connect() returned, so the client owns a live transport: closing either
    // handle releases it. Assert the connection was released, not which handle did it.
    expect(sdk.state.closed.length).toBeGreaterThan(0);
  });

  it("leaves a successful connection open for shutdown() to close", async () => {
    sdk.state.listTools = async () => ({ tools: [{ name: "ping" }] });
    const manager = new McpClientManager(stdioServer);
    await manager.initialize();

    expect(sdk.state.closed).toEqual([]);
    expect(manager.getTools()).toHaveLength(1);

    await manager.shutdown();
    expect(sdk.state.closed).toContain("client");
  });

  it("does not let a cleanup failure escape initialize()", async () => {
    sdk.state.connect = async () => { throw new Error("ECONNREFUSED"); };
    sdk.state.transportCloseError = new Error("close hung");
    await expect(new McpClientManager(stdioServer).initialize()).resolves.toBeUndefined();
  });

  it("keeps initializing the remaining servers after one fails to clean up", async () => {
    // The cleanup is awaited inside the loop, so a throwing close() must not
    // abort the iteration and cost every later server its tools.
    sdk.state.transportCloseError = new Error("close hung");
    sdk.state.connect = async () => {
      // Fail the first server only; the second completes its handshake.
      sdk.state.connect = async () => {};
      throw new Error("ECONNREFUSED");
    };
    sdk.state.listTools = async () => ({ tools: [{ name: "ping" }] });

    const manager = new McpClientManager({
      mcpServers: { broken: { command: "/bin/true" }, healthy: { url: "https://mcp.example/mcp" } },
    } as any);
    await manager.initialize();

    expect(manager.getTools().map((t) => t.name)).toEqual(["mcp__healthy__ping"]);
  });
});
