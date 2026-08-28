import { wrapRpcError } from "../lib/error-envelope.js";

const MAX_LOG_MESSAGE_LENGTH = 512;

export function compactDispatchLogMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown error");
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_LOG_MESSAGE_LENGTH
    ? compact
    : `${compact.slice(0, MAX_LOG_MESSAGE_LENGTH)}…`;
}

export function summarizeDispatchError(err: unknown): {
  code: string;
  status?: number;
  retriable: boolean;
  message: string;
} {
  const detail = wrapRpcError(err);
  return {
    code: detail.code,
    ...(detail.status != null ? { status: detail.status } : {}),
    retriable: detail.retriable,
    message: compactDispatchLogMessage(detail.message),
  };
}
