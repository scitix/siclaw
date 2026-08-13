import type { TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import {
  normalizeStructuredResultToolParameters,
  STRUCTURED_RESULT_TOOL_NAME,
} from "../../core/structured-result.js";

function toolResult(text: string, submitted: boolean, resultId?: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { submitted, resultId },
  };
}

export function createSubmitStructuredResultTool(refs: ToolRefs): ToolDefinition {
  const controller = refs.structuredResultController;
  // The registry calls create only after available(). The inert fallback keeps
  // registry metadata/coverage probes side-effect free without exposing a
  // working tool outside a contracted session.
  const contract = controller?.contract ?? {
    description: "Submit the configured structured result.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  };
  return {
    name: STRUCTURED_RESULT_TOOL_NAME,
    label: "Submit Structured Result",
    renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("submit_structured_result")), 0, 0),
    renderResult: renderTextResult,
    description:
      `${contract.description}\n\n` +
      "Submit the final machine-readable result for this turn. Call this tool exactly once, " +
      "only after the result is ready. Its arguments must match the configured schema.",
    parameters: normalizeStructuredResultToolParameters(contract.schema) as unknown as TSchema,
    async execute(_toolCallId, params) {
      if (!controller) return toolResult("No structured result contract is configured.", false);
      const submitted = controller.submit(params);
      return toolResult(submitted.message, submitted.ok, submitted.resultId);
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createSubmitStructuredResultTool,
  available: (refs) => Boolean(refs.structuredResultController),
  readOnlyDelegable: true,
};
