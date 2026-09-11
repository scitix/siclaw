import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProductSupportResultServer, TOOL_NAME } from "./server.js";

async function withClient(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createProductSupportResultServer();
  const client = new Client({ name: "product-support-result-test", version: "0.2.2" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("product support result MCP", () => {
  it("advertises exactly one strict tool", async () => {
    await withClient(async (client) => {
      const response = await client.listTools();
      expect(response.tools.length).toBe(1);
      expect(response.tools[0]?.name).toBe(TOOL_NAME);
      expect(response.tools[0]?.inputSchema.required).toEqual(["label", "info"]);
      expect(response.tools[0]?.inputSchema.additionalProperties).toBe(false);
      const advertisedSchema = response.tools[0]?.inputSchema as {
        properties?: {
          info?: {
            required?: string[];
            properties?: {
              ticket_type?: { enum?: string[] };
              summary?: { maxLength?: number };
              description?: { maxLength?: number };
              evidence?: { maxItems?: number };
              missing_fields?: { maxItems?: number; items?: { pattern?: string } };
              llm?: {
                properties?: {
                  region?: { enum?: string[] };
                  aspect?: { enum?: string[] };
                };
              };
            };
          };
        };
      };
      expect(advertisedSchema.properties?.info?.properties?.missing_fields?.items?.pattern).toBe("^[a-z][a-z0-9_]*$");
      expect(advertisedSchema.properties?.info?.properties?.ticket_type?.enum).toEqual([
        "consultation",
        "incident",
        "llm_incident",
        "requirement",
        "unknown",
      ]);
      expect(advertisedSchema.properties?.info?.required).not.toContain("llm");
      expect(advertisedSchema.properties?.info?.properties?.llm?.properties?.region?.enum).toEqual(["", "domestic", "overseas"]);
      expect(advertisedSchema.properties?.info?.properties?.llm?.properties?.aspect?.enum).toEqual(["", "platform_api", "network", "model"]);
      expect(advertisedSchema.properties?.info?.properties?.summary?.maxLength).toBe(200);
      expect(advertisedSchema.properties?.info?.properties?.description?.maxLength).toBe(2000);
      expect(advertisedSchema.properties?.info?.properties?.evidence?.maxItems).toBe(20);
      expect(advertisedSchema.properties?.info?.properties?.missing_fields?.maxItems).toBe(20);
      expect(response.tools[0]?.outputSchema).toEqual(response.tools[0]?.inputSchema);
    });
  });

  it("returns canonical JSON as text and structured content", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        {
          name: TOOL_NAME,
          arguments: {
            label: true,
            info: {
              ticket_type: "consultation",
              product: "",
              summary: "  Account access help  ",
              description: "  User cannot find the access setting.  ",
              evidence: [],
              missing_fields: [],
              llm: { region: "", aspect: "", model: "" },
            },
          },
        },
        CallToolResultSchema,
      );

      expect(response.isError).toBe(undefined);
      expect(response.structuredContent).toEqual({
        label: true,
        info: {
          ticket_type: "consultation",
          product: "",
          summary: "Account access help",
          description: "User cannot find the access setting.",
          evidence: [],
          missing_fields: [],
          llm: { region: "", aspect: "", model: "" },
        },
      });
      expect(Array.isArray(response.content)).toBe(true);
      const content = response.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      if (content[0]?.type !== "text" || content[0].text === undefined) {
        throw new Error("expected text content");
      }
      expect(JSON.parse(content[0].text)).toEqual(response.structuredContent);
    });
  });

  it("returns an unknown type for a final handoff after clarification is declined", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        {
          name: TOOL_NAME,
          arguments: {
            label: true,
            info: {
              ticket_type: "unknown",
              product: "",
              summary: "Needs support",
              description: "User cannot describe the issue, declines further clarification, and requests human support.",
              evidence: [],
              missing_fields: [],
              llm: { region: "", aspect: "", model: "" },
            },
          },
        },
        CallToolResultSchema,
      );

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toMatchObject({
        label: true,
        info: { ticket_type: "unknown", product: "", missing_fields: [] },
      });
    });
  });

  it("rejects final results with outstanding clarification or an empty description", async () => {
    await withClient(async (client) => {
      for (const patch of [{ missing_fields: ["issue_description"] }, { description: " " }]) {
        const response = await client.callTool({
          name: TOOL_NAME,
          arguments: {
            label: true,
            info: {
              ticket_type: "unknown",
              product: "",
              summary: "User requests human support",
              description: "User declined further clarification.",
              evidence: [],
              missing_fields: [],
              ...patch,
            },
          },
        }, CallToolResultSchema);

        expect(response.isError).toBe(true);
        expect(response.structuredContent).toBeUndefined();
      }
    });
  });
});
