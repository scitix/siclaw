import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
    if (!latest || !latest.stat.isFile() || latest.stat.isSymbolicLink() || !latest.stat.size) {
      throw new Error("missing transcript");
    }
    // pi tolerates malformed lines while reading. A continuation must not silently
    // discard a damaged tail (which can include the latest compact/branch entry).
    const entries = fs.readFileSync(latest.file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    if (entries[0]?.type !== "session" || typeof entries[0].id !== "string" ||
        !entries.some(entry => entry?.type === "message" && entry.message?.role === "assistant")) {
      throw new Error("invalid transcript");
    }
    const session = SessionManager.open(latest.file, directory);
    if (session.getSessionId() !== entries[0].id || !session.buildSessionContext().messages.length) {
      throw new Error("empty restored context");
    }
    return session;
  } catch {
    throw new Error("This child has no valid recoverable transcript; restore its session data or launch a new task explicitly.");
  }
}
