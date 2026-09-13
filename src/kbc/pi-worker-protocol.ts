import type { ImageContent, Model, Api, ProviderHeaders } from "@earendil-works/pi-ai";

/** Private parent/worker transport. Credentials appear only in the init frame. */
export const PI_WORKER_PROTOCOL_VERSION = 1;
export const PI_WORKER_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkerInit {
  type: "init";
  v: 1;
  session_id: string;
  cwd: string;
  state_dir: string;
  system_prompt: string;
  model: Model<Api>;
  api_key: string;
  executor_role?: string;
  auth_header?: boolean;
  headers?: ProviderHeaders;
  thinking_level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  max_model_calls: number;
  tools: WorkerTool[];
}

export type WorkerInput = WorkerInit | {
  type: "prompt";
  turn_id: string;
  text: string;
  images?: ImageContent[];
} | {
  type: "tool_result";
  turn_id: string;
  call_id: string;
  content: Array<{ type: "text"; text: string } | ImageContent>;
  is_error?: boolean;
} | {
  type: "interrupt";
  turn_id: string;
} | { type: "close" };

export function parseWorkerInput(value: unknown): WorkerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a worker frame object");
  const frame = value as Record<string, any>;
  const text = (key: string, allowEmpty = false) => {
    if (typeof frame[key] !== "string" || (!allowEmpty && !frame[key].trim())) throw new Error(`Invalid ${key}`);
  };
  switch (frame.type) {
    case "init": {
      if (frame.v !== PI_WORKER_PROTOCOL_VERSION) throw new Error("Unsupported worker protocol");
      for (const key of ["session_id", "cwd", "state_dir", "api_key"]) text(key);
      text("system_prompt", true);
      if (frame.auth_header !== undefined && typeof frame.auth_header !== "boolean") throw new Error("Invalid auth header mode");
      if (frame.executor_role !== undefined && (typeof frame.executor_role !== "string" || frame.executor_role.length > 32)) throw new Error("Invalid executor role");
      const model = frame.model;
      if (!model || typeof model !== "object" ||
          !["id", "provider", "api", "baseUrl"].every(key => typeof model[key] === "string" && model[key].trim()) ||
          !["contextWindow", "maxTokens"].every(key => Number.isSafeInteger(model[key]) && model[key] > 0) ||
          !Array.isArray(model.input) || !model.input.includes("text")) throw new Error("Incomplete model descriptor");
      const url = new URL(model.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid model URL");
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(frame.thinking_level)) throw new Error("Invalid thinking level");
      if (!Number.isSafeInteger(frame.max_model_calls) || frame.max_model_calls < 1 || frame.max_model_calls > 10_000) throw new Error("Invalid model call budget");
      if (!Array.isArray(frame.tools) || frame.tools.some(tool => !tool ||
          typeof tool.name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tool.name) ||
          typeof tool.description !== "string" || tool.parameters?.type !== "object")) throw new Error("Invalid tool definitions");
      if (new Set(frame.tools.map(tool => tool.name)).size !== frame.tools.length) throw new Error("Duplicate tool name");
      break;
    }
    case "prompt":
      text("turn_id"); text("text", true);
      if (frame.images !== undefined && (!Array.isArray(frame.images) || frame.images.some(image =>
        image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string"))) throw new Error("Invalid images");
      break;
    case "tool_result":
      text("turn_id"); text("call_id");
      if (!Array.isArray(frame.content) || frame.content.some(part =>
        part?.type === "text" ? typeof part.text !== "string" :
          part?.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string")) throw new Error("Invalid tool result");
      if (frame.is_error !== undefined && typeof frame.is_error !== "boolean") throw new Error("Invalid tool status");
      break;
    case "interrupt": text("turn_id"); break;
    case "close": break;
    default: throw new Error("Unknown worker frame type");
  }
  return frame as WorkerInput;
}
