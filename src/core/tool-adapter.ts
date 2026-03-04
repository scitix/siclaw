/**
 * Tool Adapter — converts pi-coding-agent ToolDefinition (TypeBox schema)
 * to Claude Agent SDK MCP tool format (Zod schema).
 *
 * Only covers the TypeBox subset actually used by Siclaw tools:
 * Type.Object, Type.String, Type.Number, Type.Boolean,
 * Type.Optional, Type.Array, Type.Union, Type.Literal
 */

import { z, type ZodTypeAny } from "zod";
import type { TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

// Re-export for external use
export type { ToolDefinition };

/**
 * SDK tool definition — the shape returned by the SDK's tool() helper.
 * We build these manually since we can't import the SDK's internal type
 * without having it installed (it's added in Phase 4).
 */
export interface AdaptedTool {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  handler: (args: any, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

/**
 * Convert a TypeBox TSchema to a Zod type.
 * Handles the subset used by Siclaw tools.
 */
function typeboxToZod(schema: TSchema): ZodTypeAny {
  // TypeBox uses a [Kind] symbol but exposes it as a string property
  const kind = (schema as any)[Symbol.for("TypeBox.Kind")] ?? (schema as any).kind;

  switch (kind) {
    case "String": {
      let s = z.string();
      if (schema.description) s = s.describe(schema.description);
      return s;
    }
    case "Number": {
      let n = z.number();
      if (schema.description) n = n.describe(schema.description);
      return n;
    }
    case "Integer": {
      let i = z.number().int();
      if (schema.description) i = i.describe(schema.description);
      return i;
    }
    case "Boolean": {
      let b = z.boolean();
      if (schema.description) b = b.describe(schema.description);
      return b;
    }
    case "Literal": {
      return z.literal((schema as any).const);
    }
    case "Optional": {
      // TypeBox Optional: newer versions use anyOf: [innerSchema, { type: 'null' }]
      if ((schema as any).anyOf) {
        const inner = typeboxToZod((schema as any).anyOf[0]);
        return inner.optional();
      }
      // Fallback: unwrap .type or use schema itself
      const inner = typeboxToZod((schema as any).type ?? (schema as any).$ref ?? schema);
      return inner.optional();
    }
    case "Array": {
      const items = (schema as any).items;
      const itemZod = items ? typeboxToZod(items) : z.any();
      let arr = z.array(itemZod);
      if (schema.description) arr = arr.describe(schema.description);
      return arr;
    }
    case "Union": {
      const variants = ((schema as any).anyOf as TSchema[]).map(typeboxToZod);
      if (variants.length === 0) return z.any();
      if (variants.length === 1) return variants[0];
      // z.union requires at least 2 elements
      return z.union([variants[0], variants[1], ...variants.slice(2)] as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }
    case "Object": {
      const props = (schema as any).properties as Record<string, TSchema> | undefined;
      if (!props) return z.object({});
      const required = new Set<string>((schema as any).required ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, val] of Object.entries(props)) {
        const converted = typeboxToZod(val);
        shape[key] = required.has(key) ? converted : converted.optional();
      }
      let obj = z.object(shape);
      if (schema.description) obj = obj.describe(schema.description);
      return obj;
    }
    default:
      // Fallback for unknown types
      console.warn(`[tool-adapter] Unknown TypeBox kind: ${kind}, falling back to z.any()`);
      return z.any();
  }
}

/**
 * Convert a TypeBox Object schema's properties to a Zod raw shape.
 * This returns a flat Record<string, ZodTypeAny> suitable for the SDK's tool() inputSchema.
 */
function typeboxObjectToZodShape(schema: TSchema): Record<string, ZodTypeAny> {
  const props = (schema as any).properties as Record<string, TSchema> | undefined;
  if (!props) return {};

  const required = new Set<string>((schema as any).required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, val] of Object.entries(props)) {
    const converted = typeboxToZod(val);
    shape[key] = required.has(key) ? converted : converted.optional();
  }
  return shape;
}

/**
 * Adapt a pi-coding-agent ToolDefinition into an AdaptedTool for the SDK.
 *
 * The returned handler wraps toolDef.execute() and emits events through
 * the optional onToolStart/onToolEnd callbacks (for event normalization).
 */
export function adaptToolForSdk(
  toolDef: ToolDefinition,
  callbacks?: {
    onToolStart?: (toolName: string, args: any) => void;
    onToolEnd?: (toolName: string, result: any, isError: boolean) => void;
  },
): AdaptedTool {
  const zodShape = typeboxObjectToZodShape(toolDef.parameters);

  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: zodShape,
    handler: async (args: any) => {
      callbacks?.onToolStart?.(toolDef.name, args);

      try {
        const toolCallId = `sdk-${Date.now().toString(36)}`;
        const result = await toolDef.execute(toolCallId, args, undefined, undefined, undefined as any);

        const isError = !!(result as any).details?.error;
        callbacks?.onToolEnd?.(toolDef.name, result, isError);

        // Map pi-agent tool result to MCP CallToolResult format
        const textContent = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => ({ type: "text" as const, text: c.text ?? "" }));

        return {
          content: textContent.length > 0 ? textContent : [{ type: "text", text: "(no output)" }],
          isError,
        };
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        callbacks?.onToolEnd?.(toolDef.name, errorMsg, true);
        return {
          content: [{ type: "text", text: `Error: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Adapt multiple ToolDefinitions at once.
 */
export function adaptToolsForSdk(
  tools: ToolDefinition[],
  callbacks?: {
    onToolStart?: (toolName: string, args: any) => void;
    onToolEnd?: (toolName: string, result: any, isError: boolean) => void;
  },
): AdaptedTool[] {
  return tools.map((t) => adaptToolForSdk(t, callbacks));
}
