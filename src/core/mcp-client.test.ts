import { describe, it, expect } from "vitest";
import { jsonSchemaToTypebox, buildMcpToolName, isMcpTool, MCP_TOOL_PREFIX, mcpContentToAgentContent, McpClientManager } from "./mcp-client.js";

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
