import { StringDecoder } from "node:string_decoder";
import { SCRIPT_MAX_FRAME_BYTES, ScriptSandboxError } from "./types.js";
import { record } from "./validation.js";

/** Bounded incremental parser; chunk boundaries are not JSON frame boundaries. */
export class ScriptFrameParser {
  private decoder = new StringDecoder("utf8");
  private pending = "";

  push(chunk: Buffer | string): Record<string, unknown>[] {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const frames: Record<string, unknown>[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (Buffer.byteLength(line) > SCRIPT_MAX_FRAME_BYTES) throw new ScriptSandboxError("Sandbox protocol frame too large");
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new ScriptSandboxError("Invalid sandbox protocol JSON"); }
      if (!record(value)) throw new ScriptSandboxError("Invalid sandbox protocol frame");
      frames.push(value);
      if (frames.length > 512) throw new ScriptSandboxError("Sandbox protocol flood");
    }
    if (Buffer.byteLength(this.pending) > SCRIPT_MAX_FRAME_BYTES) throw new ScriptSandboxError("Sandbox protocol frame too large");
    return frames;
  }

  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.length) throw new ScriptSandboxError("Incomplete sandbox protocol frame");
  }
}

export function encodeScriptFrame(frame: unknown): string {
  const data = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(data) > SCRIPT_MAX_FRAME_BYTES) throw new ScriptSandboxError("Sandbox protocol payload exceeds 256 KiB");
  return data;
}
