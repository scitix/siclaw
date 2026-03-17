/**
 * JSON Schemas for Deep Search structured outputs.
 *
 * Used as function calling (tool_use) parameter schemas in Phase 2 and Phase 4.
 * These schemas define the contract between the LLM and the engine —
 * adding a field here automatically makes it visible to the model.
 */

export const ROOT_CAUSE_CATEGORIES = [
  "mtu_mismatch",
  "pcie_error",
  "driver_issue",
  "firmware_bug",
  "config_error",
  "resource_exhaustion",
  "network_partition",
  "scheduling_failure",
  "hardware_failure",
  "software_bug",
  "permission_denied",
  "unknown",
] as const;

/** Phase 2: Hypothesis generation — submit_hypotheses tool schema. */
export const HYPOTHESES_SCHEMA = {
  type: "object" as const,
  properties: {
    hypotheses: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          text: { type: "string" as const, description: "Specific hypothesis description" },
          confidence: { type: "number" as const, description: "Prior belief confidence 0-100" },
          suggestedTools: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Real skill script paths to validate this hypothesis",
          },
          estimatedCalls: {
            type: "number" as const,
            minimum: 1,
            maximum: 10,
            description: "Estimated tool calls needed to validate: 1-3 for quick checks, 4-6 for standard, 7-10 for deep multi-step validation",
          },
        },
        required: ["text", "confidence", "suggestedTools", "estimatedCalls"],
      },
    },
  },
  required: ["hypotheses"],
};

/** Phase 4: Conclusion — submit_conclusion tool schema. */
export const CONCLUSION_SCHEMA = {
  type: "object" as const,
  properties: {
    conclusion_text: {
      type: "string" as const,
      description: "Clear, actionable conclusion text (3-5 paragraphs) answering the original question",
    },
    root_cause_category: {
      type: "string" as const,
      enum: [...ROOT_CAUSE_CATEGORIES],
      description: "Root cause category",
    },
    affected_entities: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "K8s resource paths like pod/name, node/name, ns/name, svc/name",
    },
    environment_tags: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Cluster/infra identifiers found during investigation",
    },
    causal_chain: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Ordered cause-effect steps leading to the root cause",
    },
    confidence: {
      type: "number" as const,
      description: "Overall confidence in the root cause diagnosis 0-100",
    },
    remediation_steps: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Specific remediation steps to fix the issue",
    },
  },
  required: ["conclusion_text", "root_cause_category", "confidence"],
};

/** Quality gate: conclusion validation — validate_conclusion tool schema. */
export const VALIDATION_SCHEMA = {
  type: "object" as const,
  properties: {
    pass: {
      type: "boolean" as const,
      description: "Whether conclusion passes quality checks",
    },
    critique: {
      type: "string" as const,
      description: "Specific issues found (empty string if pass is true)",
    },
    adjusted_confidence: {
      type: "number" as const,
      description: "Adjusted confidence score if the original was miscalibrated (0-100)",
    },
  },
  required: ["pass"] as const,
};
