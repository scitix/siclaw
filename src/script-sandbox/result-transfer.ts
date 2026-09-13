import { createHash, randomBytes } from "node:crypto";
import { record } from "./validation.js";

export const SCRIPT_INLINE_RESULT_BYTES = 128 * 1024;
export const SCRIPT_FILE_RESULT_BYTES = 4 * 1024 * 1024;
export const SCRIPT_RUN_FILE_BYTES = 16 * 1024 * 1024;
export const SCRIPT_RESULT_CHUNK_BYTES = 48 * 1024;

export class ScriptResultLimitError extends Error {}

/** Independent sanitized results, with one cumulative byte budget per run. */
export class ScriptResultTransfer {
  private active = new Map<string, { data: Buffer; offset: number; busy: boolean; authorize(signal: AbortSignal): Promise<void> }>();
  private total = 0;
  private closed = false;

  assertAvailable(): void {
    if (this.closed || this.active.size >= 10) throw new Error("Complete an active result transfer first");
    if (this.total >= SCRIPT_RUN_FILE_BYTES) throw new ScriptResultLimitError();
  }

  open(value: unknown, authorize: (signal: AbortSignal) => Promise<void>) {
    this.assertAvailable();
    const data = Buffer.from(JSON.stringify(value), "utf8");
    if (data.length > SCRIPT_FILE_RESULT_BYTES || this.total + data.length > SCRIPT_RUN_FILE_BYTES) throw new ScriptResultLimitError();
    this.total += data.length;
    const id = randomBytes(32).toString("hex");
    this.active.set(id, { data, offset: 0, busy: false, authorize });
    return { transfer_id: id, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), encoding: "json-utf8" };
  }

  async read(args: Record<string, unknown>, signal: AbortSignal) {
    const id = args.transfer_id;
    const entry = typeof id === "string" ? this.active.get(id) : undefined;
    if (this.closed || !entry || entry.busy || Object.keys(args).some(k => k !== "transfer_id" && k !== "offset") ||
      !Number.isSafeInteger(args.offset) || args.offset !== entry.offset) throw new Error("Invalid result transfer");
    signal.throwIfAborted();
    entry.busy = true;
    try {
      await entry.authorize(signal); // Recheck the original resource without executing the tool again.
      signal.throwIfAborted();
      if (this.closed || this.active.get(id as string) !== entry) throw new Error("Inactive result transfer");
      const chunk = entry.data.subarray(entry.offset, entry.offset + SCRIPT_RESULT_CHUNK_BYTES);
      entry.offset += chunk.length;
      const done = entry.offset === entry.data.length;
      if (done) this.active.delete(id as string);
      return { data: chunk.toString("base64"), next_offset: entry.offset, done };
    } finally { entry.busy = false; }
  }

  discard(args: unknown) {
    if (!record(args) || Object.keys(args).some(k => k !== "transfer_id") || typeof args.transfer_id !== "string" || !this.active.has(args.transfer_id)) throw new Error("Invalid result transfer");
    this.active.delete(args.transfer_id);
    return { discarded: true };
  }

  close(): void { this.closed = true; this.active.clear(); }
}
