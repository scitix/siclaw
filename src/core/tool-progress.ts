import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOOL_PROGRESS_FIELD, splitToolProgress } from "../shared/tool-progress.js";

const progressTools = new WeakSet<ToolDefinition>();
export const hasToolProgress = (tool: ToolDefinition): boolean => progressTools.has(tool);

/** Only interactive owners speak to the user; delegated workers keep their result contracts. */
export function wantsToolProgress(options: { mode?: string; isSubagent?: boolean; delegation?: unknown }): boolean {
  return (options.mode ?? "web") === "web" && !options.isSubagent && !options.delegation;
}

/** Preserve the domain schema/guards/executor, adding a model-visible communication field. */
export function withToolProgress<T extends ToolDefinition>(tool: T): T {
  const schema = tool.parameters as typeof tool.parameters & {
    type?: string; properties?: Record<string, unknown>; required?: string[];
    allOf?: unknown; anyOf?: unknown; oneOf?: unknown; $ref?: unknown;
  };
  // Do not rewrite arbitrary union/non-object MCP schemas or collide with a domain field.
  if (schema.type !== "object" || schema.properties?.[TOOL_PROGRESS_FIELD] ||
      schema.allOf || schema.anyOf || schema.oneOf || schema.$ref) return tool;
  const wrapped: T = {
    ...tool,
    parameters: {
      ...schema,
      properties: {
        ...schema.properties,
        [TOOL_PROGRESS_FIELD]: Type.String({
          minLength: 1,
          pattern: "\\S",
          description: "Brief public progress in the user's language: what you have established, if anything, and why this check is next. State intended actions before executing; never invent results or expose private reasoning. The UI displays this only if this tool batch has no ordinary assistant text.",
        }),
      },
      required: [...(schema.required ?? []), TOOL_PROGRESS_FIELD],
    },
    ...(tool.prepareArguments ? {
      prepareArguments: (raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return tool.prepareArguments!(raw);
        const split = splitToolProgress(raw as Record<string, unknown>);
        return { ...(tool.prepareArguments!(split.args) as Record<string, unknown>), [TOOL_PROGRESS_FIELD]: split.text };
      },
    } : {}),
    execute: (id, params, signal, update, context) => {
      const { args } = splitToolProgress(params as Record<string, unknown>);
      return tool.execute(id, args, signal, update, context);
    },
  };
  progressTools.add(wrapped);
  return wrapped;
}
