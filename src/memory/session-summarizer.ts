/**
 * Session Summarizer — extracts conversation from JSONL and saves as memory markdown.
 *
 * Called during session release to persist conversation context for future memory search.
 * Supports two modes:
 * - saveSessionMemory(): raw conversation dump (legacy fallback)
 * - saveSessionKnowledge(): LLM-driven knowledge extraction into topic files
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { extractConversationKnowledge, mergeTopicFiles } from "./knowledge-extractor.js";

const DEFAULT_MAX_MESSAGES = 15;
const MIN_MESSAGES_TO_SAVE = 3;

export interface SaveSessionMemoryOpts {
  /** Path to the session directory containing .jsonl files */
  sessionDir: string;
  /** Path to the memory directory (e.g. <userDataDir>/memory) */
  memoryDir: string;
  /** Maximum number of user/assistant messages to include (default: 15) */
  maxMessages?: number;
}

export interface SaveSessionKnowledgeOpts extends SaveSessionMemoryOpts {
  llmConfig?: { apiKey: string; baseUrl: string; model?: string };
}

interface ExtractedMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Find the most recent .jsonl file in the session directory.
 */
export function findLatestJsonl(sessionDir: string): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Sort by modification time descending
  files.sort((a, b) => {
    const aStat = fs.statSync(path.join(sessionDir, a));
    const bStat = fs.statSync(path.join(sessionDir, b));
    return bStat.mtimeMs - aStat.mtimeMs;
  });

  return path.join(sessionDir, files[0]);
}

/**
 * Extract text content from a message content field.
 * Handles both string content and array content blocks.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && c.text)
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Extract user and assistant messages from a JSONL session file.
 */
export async function extractMessages(jsonlPath: string): Promise<ExtractedMessage[]> {
  const messages: ExtractedMessage[] = [];

  const stream = fs.createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;

      const msg = entry.message;
      if (!msg) continue;

      if (msg.role === "user" || msg.role === "assistant") {
        const text = extractText(msg.content).trim();
        if (!text) continue;
        // Skip command messages (start with /)
        if (msg.role === "user" && text.startsWith("/")) continue;
        // Skip system-injected messages
        if (msg.role === "user" && text.startsWith("[System]")) continue;
        messages.push({ role: msg.role, text });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * Save a session's conversation to a memory markdown file.
 *
 * @returns The written file path, or null if nothing was saved.
 */
export async function saveSessionMemory(opts: SaveSessionMemoryOpts): Promise<string | null> {
  const { sessionDir, memoryDir, maxMessages = DEFAULT_MAX_MESSAGES } = opts;

  // Find the latest JSONL file
  const jsonlPath = findLatestJsonl(sessionDir);
  if (!jsonlPath) {
    return null;
  }

  // Extract messages
  const allMessages = await extractMessages(jsonlPath);
  if (allMessages.length < MIN_MESSAGES_TO_SAVE) {
    return null;
  }

  // Take the last N messages
  const messages = allMessages.slice(-maxMessages);

  // Build markdown content
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16).replace(":", "");

  const lines: string[] = [
    `# Session Summary: ${dateStr} ${now.toISOString().slice(11, 16)}`,
    "",
    "## Conversation",
    "",
  ];

  for (const msg of messages) {
    // Truncate very long messages to keep memory files manageable
    const text = msg.text.length > 2000 ? msg.text.slice(0, 2000) + "..." : msg.text;
    lines.push(`**${msg.role}**: ${text}`);
    lines.push("");
  }

  // Write to memory directory
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }

  const filename = `${dateStr}-${timeStr}.md`;
  const filePath = path.join(memoryDir, filename);

  // Avoid overwriting if file already exists (same minute) — append a counter
  let finalPath = filePath;
  if (fs.existsSync(filePath)) {
    for (let i = 2; i <= 99; i++) {
      const alt = path.join(memoryDir, `${dateStr}-${timeStr}-${i}.md`);
      if (!fs.existsSync(alt)) {
        finalPath = alt;
        break;
      }
    }
  }

  fs.writeFileSync(finalPath, lines.join("\n"), "utf-8");
  console.log(`[session-summarizer] Saved session memory to ${finalPath} (${messages.length} messages)`);
  return finalPath;
}

/**
 * Save session knowledge using LLM-driven extraction.
 * Falls back to raw saveSessionMemory() when LLM config is unavailable or extraction fails.
 *
 * @returns Array of modified topic file paths, or null if nothing was saved.
 */
export async function saveSessionKnowledge(opts: SaveSessionKnowledgeOpts): Promise<string[] | null> {
  const { sessionDir, memoryDir, llmConfig } = opts;

  const jsonlPath = findLatestJsonl(sessionDir);
  if (!jsonlPath) return null;

  const messages = await extractMessages(jsonlPath);
  if (messages.length < MIN_MESSAGES_TO_SAVE) return null;

  // No LLM config → fall back to raw save
  if (!llmConfig?.apiKey) {
    const raw = await saveSessionMemory(opts);
    return raw ? [raw] : null;
  }

  try {
    const entries = await extractConversationKnowledge({ messages, llmConfig });
    if (!entries.length) {
      // LLM judged no extractable knowledge (small talk, too short) — trust the judgment
      return null;
    }
    return mergeTopicFiles(memoryDir, entries);
  } catch (err) {
    console.warn("[session-summarizer] Knowledge extraction failed, falling back to raw save:", err);
    const raw = await saveSessionMemory(opts);
    return raw ? [raw] : null;
  }
}
