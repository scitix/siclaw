import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_SCAN_BUFFER_BYTES = 64 * 1024;

interface TranscriptValidation {
  headerId: string;
  rows: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Validate every JSONL row with bounded memory before native recovery can mutate the file. */
function validateTranscript(file: string): TranscriptValidation {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(TRANSCRIPT_SCAN_BUFFER_BYTES);
  const decoder = new StringDecoder("utf8");
  let lineParts: string[] = [];
  let rows = 0;
  let headerId: string | undefined;
  let hasAssistant = false;
  const validateLine = () => {
    const line = lineParts.length === 1 ? lineParts[0] : lineParts.join("");
    lineParts = [];
    if (!line.trim()) return;
    const entry: unknown = JSON.parse(line);
    if (!record(entry)) throw new Error("invalid transcript entry");
    if (rows === 0) {
      if (entry.type !== "session" || typeof entry.id !== "string") throw new Error("invalid transcript header");
      headerId = entry.id;
    } else if (entry.type === "message" && record(entry.message) && entry.message.role === "assistant") {
      hasAssistant = true;
    }
    rows++;
  };
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const decoded = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      let newline = decoded.indexOf("\n");
      while (newline >= 0) {
        lineParts.push(decoded.slice(start, newline));
        validateLine();
        start = newline + 1;
        newline = decoded.indexOf("\n", start);
      }
      lineParts.push(decoded.slice(start));
    }
    lineParts.push(decoder.end());
    validateLine();
    if (!headerId || !hasAssistant) throw new Error("incomplete transcript");
    return { headerId, rows };
  } finally {
    fs.closeSync(fd);
  }
}

/** Resume is fail-closed. Unlike continueRecent, this never creates a new session
 * or falls back to an older transcript when the newest one is unusable. */
export function openSubagentTranscript(directory: string): SessionManager {
  try {
    const dir = fs.lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("invalid directory");
    const files = fs.readdirSync(directory).filter(name => name.endsWith(".jsonl"))
      .map(name => ({ file: path.join(directory, name), stat: fs.lstatSync(path.join(directory, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
    const latest = files[0];
    if (!latest || !latest.stat.isFile() || latest.stat.isSymbolicLink() || !latest.stat.size ||
        latest.stat.size > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
      throw new Error("missing transcript");
    }
    // pi skips malformed rows and may normalize headers while opening. Validate
    // every row first so a rejected continuation neither loses a damaged tail
    // nor mutates an otherwise unusable transcript. Entries are not retained.
    const validated = validateTranscript(latest.file);
    const session = SessionManager.open(latest.file, directory);
    const entries = session.getEntries();
    if (validated.rows !== entries.length + 1 ||
        session.getSessionId() !== validated.headerId ||
        !session.buildSessionContext().messages.length) {
      throw new Error("empty restored context");
    }
    return session;
  } catch {
    throw new Error("This child has no valid recoverable transcript within the 64 MiB resume limit; restore its session data or launch a new task explicitly.");
  }
}
