import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseProductSupportResult } from "./result.js";

export const TOOL_NAME = "submit_product_support_result";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "info"],
  properties: {
    label: {
      type: "boolean",
      description: "True only when the downstream robot may create a support ticket now.",
    },
    info: {
      type: "object",
      additionalProperties: false,
      required: [
        "ticket_type",
        "product",
        "summary",
        "description",
        "evidence",
        "missing_fields",
      ],
      properties: {
        ticket_type: {
          type: "string",
          enum: ["consultation", "incident", "requirement", "unknown"],
        },
        product: {
          type: "string",
          description:
            "Concrete, knowledge-grounded product for requirements. For incidents and consultations, use a concrete product only when established by the conversation or authoritative product knowledge; otherwise leave this empty and preserve the user-visible entry in description.",
        },
        summary: { type: "string" },
        description: { type: "string" },
        evidence: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        missing_fields: {
          type: "array",
          description:
            "Blocking machine field identifiers only; never user-facing questions or diagnostic instructions.",
          items: {
            type: "string",
            minLength: 1,
            pattern: "^[a-z][a-z0-9_]*$",
          },
        },
      },
    },
  },
} as const;

export function createProductSupportResultServer(): Server {
  const server = new Server(
    { name: "mcp-product-support-result", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Validate and serialize the machine-readable decision for one product-support turn. This tool does not create a ticket or perform any external side effect. Produce exactly one successful result before sending the final user-facing reply; a rejected validation may be corrected and retried.",
        inputSchema,
        outputSchema: inputSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    try {
      const result = parseProductSupportResult(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Invalid product support result: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
