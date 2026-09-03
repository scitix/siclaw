import { describe, it, expect, vi } from "vitest";
import {
  jsonSchemaToTypebox,
  normalizeMcpInputSchema,
  buildMcpToolName,
  isMcpTool,
  MCP_TOOL_PREFIX,
  mcpContentToAgentContent,
  McpClientManager,
  mergeMcpStdioEnv,
  visualMcpRequestTimeoutMs,
} from "./mcp-client.js";

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

describe("mergeMcpStdioEnv", () => {
  it("forwards the visual export contract into stdio MCP child processes", () => {
    expect(mergeMcpStdioEnv(undefined, {
      SICLAW_VISUAL_EXPORT_URL: "https://console.example.com/siclaw-visual-export",
      SICLAW_VISUAL_EXPORT_TIMEOUT_MS: "15000",
      SICLAW_VISUAL_EXPORT_THEME: "dark",
      SICLAW_VISUAL_EXPORT_CHROMIUM: "/opt/chromium",
      SECRET_NOT_FOR_MCP: "must-not-leak",
    })).toEqual({
      SICLAW_VISUAL_EXPORT_URL: "https://console.example.com/siclaw-visual-export",
      SICLAW_VISUAL_EXPORT_TIMEOUT_MS: "15000",
      SICLAW_VISUAL_EXPORT_THEME: "dark",
      SICLAW_VISUAL_EXPORT_CHROMIUM: "/opt/chromium",
    });
  });

  it("lets an explicit MCP server config override the inherited value", () => {
    expect(mergeMcpStdioEnv(
      { SICLAW_VISUAL_EXPORT_THEME: "light", CUSTOM_MCP_VALUE: "configured" },
      { SICLAW_VISUAL_EXPORT_THEME: "dark" },
    )).toEqual({
      SICLAW_VISUAL_EXPORT_THEME: "light",
      CUSTOM_MCP_VALUE: "configured",
    });
  });
});

describe("visualMcpRequestTimeoutMs", () => {
  it("adds transport grace to the configured bundled renderer budget", () => {
    expect(visualMcpRequestTimeoutMs(
      "mcp-create-chart",
      "render_visual_card",
      { SICLAW_VISUAL_EXPORT_TIMEOUT_MS: "120000" },
    )).toBe(125_000);
  });

  it("does not change unrelated MCP request timeouts", () => {
    expect(visualMcpRequestTimeoutMs("other-renderer", "render_chart", {})).toBeUndefined();
    expect(visualMcpRequestTimeoutMs("mcp-create-chart", "query", {})).toBeUndefined();
  });

  it("uses the same merged per-server override that is passed to the child", () => {
    const childEnv = mergeMcpStdioEnv(
      { SICLAW_VISUAL_EXPORT_TIMEOUT_MS: "120000" },
      { SICLAW_VISUAL_EXPORT_TIMEOUT_MS: "10000" },
    );
    expect(visualMcpRequestTimeoutMs("mcp-create-chart", "render_chart", childEnv)).toBe(125_000);
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

  it("tags a dynamic MCP invocation with its exact server", () => {
    expect(makeDef(undefined, "Run a query").toolset).toBe("mcp:grafana");
  });

  it("keeps the plain tool description when no server description is set", () => {
    expect(makeDef(undefined, "Run a PromQL query").description).toBe("Run a PromQL query");
    expect(makeDef("   ", "Run a PromQL query").description).toBe("Run a PromQL query");
  });

  it("applies the server context to the fallback description too", () => {
    const def = makeDef("Monitoring tenant ID: t-123");
    expect(def.description).toBe('[Server "grafana" context: Monitoring tenant ID: t-123]\nMCP tool query from grafana');
  });

  it("preserves official MCP structuredContent for host-side consumers", async () => {
    const structuredContent = { label: true, info: { summary: "ready" } };
    const def = (manager as any).createToolDefinition(
      "product-support-result",
      undefined,
      { name: "submit_product_support_result" },
      {
        callTool: vi.fn(async () => ({
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        })),
      },
    );

    await expect(def.execute("call-1", {})).resolves.toMatchObject({
      details: { structuredContent },
    });
  });

  it("marks MCP call failures as transport errors for channel degradation", async () => {
    const def = (manager as any).createToolDefinition(
      "create-chart",
      undefined,
      { name: "render_visual_card" },
      { callTool: vi.fn(async () => { throw new Error("stdio disconnected"); }) },
    );

    await expect(def.execute("call-1", {})).resolves.toMatchObject({
      details: { error: "stdio disconnected", errorKind: "transport" },
    });
  });

  it("passes a renderer-specific timeout to the MCP SDK call", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const def = (manager as any).createToolDefinition(
      "create-chart",
      undefined,
      { name: "render_visual_card" },
      { callTool },
      125_000,
    );

    await def.execute("call-1", {});

    expect(callTool).toHaveBeenCalledWith(
      { name: "render_visual_card", arguments: {} },
      undefined,
      { timeout: 125_000 },
    );
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
