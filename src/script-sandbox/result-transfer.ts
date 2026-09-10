import { createHash, randomBytes } from "node:crypto";
import { record } from "./validation.js";

export const SCRIPT_INLINE_RESULT_BYTES = 128 * 1024;
export const SCRIPT_FILE_RESULT_BYTES = 4 * 1024 * 1024;
export const SCRIPT_RUN_FILE_BYTES = 16 * 1024 * 1024;
export const SCRIPT_RESULT_CHUNK_BYTES = 48 * 1024;

export class ScriptResultLimitError extends Error {}

/** One bounded, already-sanitized result per live run. No filesystem or URLs. */
export class ScriptResultTransfer {
  private active?: { id: string; data: Buffer; offset: number; authorize(signal: AbortSignal): Promise<void> };
  private total = 0;
  private closed = false;

  assertAvailable(): void {
    if (this.closed || this.active) throw new Error("Complete the active result transfer first");
    if (this.total >= SCRIPT_RUN_FILE_BYTES) throw new ScriptResultLimitError();
  }

  open(value: unknown, authorize: (signal: AbortSignal) => Promise<void>) {
    this.assertAvailable();
    const data = Buffer.from(JSON.stringify(value), "utf8");
    if (data.length > SCRIPT_FILE_RESULT_BYTES || this.total + data.length > SCRIPT_RUN_FILE_BYTES) throw new ScriptResultLimitError();
    this.total += data.length;
    const id = randomBytes(32).toString("hex");
    this.active = { id, data, offset: 0, authorize };
    return { transfer_id: id, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), encoding: "json-utf8" };
  }

  async read(args: Record<string, unknown>, signal: AbortSignal) {
    const entry = this.active;
    if (this.closed || !entry || Object.keys(args).some(k => k !== "transfer_id" && k !== "offset") ||
      args.transfer_id !== entry.id || !Number.isSafeInteger(args.offset) || args.offset !== entry.offset) throw new Error("Invalid result transfer");
    signal.throwIfAborted();
    await entry.authorize(signal); // Recheck the original resource without executing the tool again.
    signal.throwIfAborted();
    if (this.closed || this.active !== entry) throw new Error("Inactive result transfer");
    const chunk = entry.data.subarray(entry.offset, entry.offset + SCRIPT_RESULT_CHUNK_BYTES);
    entry.offset += chunk.length;
    const done = entry.offset === entry.data.length;
    if (done) this.active = undefined;
    return { data: chunk.toString("base64"), next_offset: entry.offset, done };
  }

  discard(args: unknown) {
    if (!record(args) || Object.keys(args).some(k => k !== "transfer_id") || !this.active || args.transfer_id !== this.active.id) throw new Error("Invalid result transfer");
    this.active = undefined;
    return { discarded: true };
  }

  close(): void { this.closed = true; this.active = undefined; }
}
