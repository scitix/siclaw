import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LIMITS, MISSING_FIELD_PATTERN, parseProductSupportResult } from "./result.js";

export const TOOL_NAME = "submit_product_support_result";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "info"],
  properties: {
    label: {
      type: "boolean",
      description: "True when intake is complete and this is the Agent's final conversation turn. The channel may offer its human-handoff button; the user must trigger that workflow. This result does not initiate a handoff or create a ticket.",
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
          enum: ["consultation", "incident", "llm_incident", "requirement", "unknown"],
          description:
            "llm_incident covers failures while calling an LLM / model API or inference endpoint (gateway errors, auth, rate limits, quotas, a named model misbehaving). incident is every other fault. Preserve unknown when the conversation does not establish a type, including a final handoff result after the user cannot or declines to clarify; never guess a type to submit.",
        },
        product: {
          type: "string",
          maxLength: LIMITS.productMaxChars,
          description:
            "Concrete, knowledge-grounded product for requirements. For incidents and consultations, use a concrete product only when established by the conversation or authoritative product knowledge; otherwise leave this empty and preserve the user-visible entry in description.",
        },
        summary: { type: "string", maxLength: LIMITS.summaryMaxChars },
        description: { type: "string", maxLength: LIMITS.descriptionMaxChars },
        evidence: {
          type: "array",
          maxItems: LIMITS.evidenceMaxItems,
          description:
            "Error messages, timestamps, object ids and verified observations. Items are trimmed and post-trim duplicates are removed.",
          items: { type: "string", minLength: 1, maxLength: LIMITS.evidenceItemMaxChars },
        },
        missing_fields: {
          type: "array",
          description:
            "Fields that still justify a user clarification, as machine identifiers only; never user-facing questions or diagnostic instructions. Must be empty for label=true; preserve unavailable facts in description instead of continuing questions after intake ends. Items are trimmed and post-trim duplicates are removed.",
          maxItems: LIMITS.missingFieldsMaxItems,
          items: {
            type: "string",
            minLength: 1,
            maxLength: LIMITS.missingFieldMaxChars,
            pattern: MISSING_FIELD_PATTERN,
          },
        },
        llm: {
          type: "object",
          additionalProperties: false,
          required: ["region", "aspect", "model"],
          description:
            "Optional; omit it or send all three fields empty for any ticket_type other than llm_incident (absent means all empty). Best-effort intake details for ticket_type=llm_incident, shown to first-line support as hints. Fill each field only from what the conversation establishes; leave it empty rather than guess. May already be filled while ticket_type is still unknown; must be empty once the type resolves to consultation, incident or requirement.",
          properties: {
            region: {
              type: "string",
              enum: ["", "domestic", "overseas"],
              description: "Deployment region the user calls the LLM API from, per the operator's classification rules; empty when not established.",
            },
            aspect: {
              type: "string",
              enum: ["", "platform_api", "network", "model"],
              description: "Failing part of the path: the API platform / gateway itself, network reachability, or a specific model; empty when not established.",
            },
            model: {
              type: "string",
              maxLength: LIMITS.modelMaxChars,
              description: "Model name as the user stated it, when a specific model is involved; otherwise empty.",
            },
          },
        },
      },
    },
  },
} as const;

export function createProductSupportResultServer(): Server {
  const server = new Server(
    { name: "mcp-product-support-result", version: "0.2.2" },
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
