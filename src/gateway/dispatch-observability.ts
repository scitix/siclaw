import { wrapRpcError } from "../lib/error-envelope.js";
import { compactDispatchLogMessage } from "../shared/dispatch-observability.js";

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
