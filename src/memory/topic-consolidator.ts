/**
 * Topic Consolidator — LLM-driven deduplication and merging of topic files.
 *
 * When topic files accumulate many date sections and facts over time, this module
 * consolidates them: deduplicates, resolves contradictions (newer wins), and
 * rewrites to a clean merged format.
 *
 * Triggered after saveSessionKnowledge when thresholds are met.
 */

import fs from "node:fs";
import path from "node:path";
import { llmCompleteWithTool } from "../tools/deep-search/sub-agent.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_DATE_SECTIONS = 3;
const MIN_FACT_LINES = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a topic file needs consolidation based on thresholds.
 * Returns false if already consolidated today.
 */
export function shouldConsolidate(filePath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  // Skip if already consolidated today
  const consolidatedMatch = content.match(/^Last consolidated:\s*(\d{4}-\d{2}-\d{2})/m);
  if (consolidatedMatch) {
    const today = new Date().toISOString().slice(0, 10);
    if (consolidatedMatch[1] === today) return false;
  }

  const lines = content.split("\n");

  // Count date sections (## YYYY-MM-DD)
  const dateSections = lines.filter(l => /^## \d{4}-\d{2}-\d{2}/.test(l)).length;
  if (dateSections >= MIN_DATE_SECTIONS) return true;

  // Count fact lines (- ...)
  const factLines = lines.filter(l => l.startsWith("- ")).length;
  if (factLines >= MIN_FACT_LINES) return true;

  return false;
}

interface ConsolidationResult {
  consolidated_facts: string[];
  changes_summary: string;
}

const CONSOLIDATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    consolidated_facts: {
      type: "array",
      items: { type: "string" },
      description: "Deduplicated, merged list of facts. Each is a concise, self-contained statement.",
    },
    changes_summary: {
      type: "string",
      description: "Brief summary of what was changed (e.g. 'merged 3 duplicate facts, resolved 1 contradiction')",
    },
  },
  required: ["consolidated_facts", "changes_summary"],
};

/**
 * Consolidate a single topic file using LLM.
 * Reads the file, calls LLM to deduplicate and resolve contradictions,
 * then rewrites the file in clean format.
 */
export async function consolidateTopicFile(
  filePath: string,
  llmConfig: { apiKey: string; baseUrl: string; model?: string },
): Promise<void> {
  const content = fs.readFileSync(filePath, "utf-8");
  const mtimeBefore = fs.statSync(filePath).mtimeMs;

  // Extract the topic title from the first heading
  const titleMatch = content.match(/^# (.+)/m);
  const topicTitle = titleMatch ? titleMatch[1].trim() : path.basename(filePath, ".md");

  const prompt = `You are a knowledge consolidation system. Below is a topic file containing facts accumulated over multiple sessions. Your job is to produce a clean, deduplicated list of facts.

<topic_file>
${content}
</topic_file>

Rules:
1. **Semantic dedup**: Merge facts that say the same thing in different words into one concise statement
2. **Contradiction resolution**: When two facts contradict each other, keep the NEWER one (facts from date sections appearing earlier in the file are newer, as new sections are prepended)
3. **Delete superseded facts**: If a newer fact updates/replaces an older one, only keep the newer version
4. **Preserve all unique information**: Do NOT discard facts that are unique and non-redundant
5. **Do NOT invent new information**: Only reorganize and deduplicate what exists
6. **Keep facts concise and self-contained**: Each fact should be understandable on its own

Call the consolidate_knowledge tool with the merged result.`;

  const { toolArgs } = await llmCompleteWithTool<ConsolidationResult>(
    undefined,
    prompt,
    "consolidate_knowledge",
    "Submit consolidated knowledge facts",
    CONSOLIDATION_SCHEMA,
    { apiKey: llmConfig.apiKey, baseUrl: llmConfig.baseUrl, model: llmConfig.model },
  );

  if (!toolArgs || !Array.isArray(toolArgs.consolidated_facts) || toolArgs.consolidated_facts.length === 0) {
    console.warn(`[topic-consolidator] LLM returned empty result for ${path.basename(filePath)}, skipping`);
    return;
  }

  // Optimistic lock: check mtime hasn't changed since we read the file
  const mtimeAfter = fs.statSync(filePath).mtimeMs;
  if (mtimeAfter !== mtimeBefore) {
    console.warn(`[topic-consolidator] File ${path.basename(filePath)} was modified during consolidation, skipping write`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const factsBlock = toolArgs.consolidated_facts.map(f => `- ${f}`).join("\n");
  const newContent = `Last consolidated: ${today}\n# ${topicTitle}\n\n${factsBlock}\n`;

  fs.writeFileSync(filePath, newContent, "utf-8");
  console.log(`[topic-consolidator] Consolidated ${path.basename(filePath)}: ${toolArgs.changes_summary}`);
}

/**
 * Check modified topic files and consolidate any that exceed thresholds.
 * Called fire-and-forget after mergeTopicFiles.
 */
export async function triggerConsolidationIfNeeded(
  memoryDir: string,
  modifiedFiles: string[],
  llmConfig: { apiKey: string; baseUrl: string; model?: string },
): Promise<void> {
  for (const filePath of modifiedFiles) {
    // Only process files in topics/
    const topicsDir = path.join(memoryDir, "topics");
    if (!filePath.startsWith(topicsDir)) continue;

    if (shouldConsolidate(filePath)) {
      try {
        await consolidateTopicFile(filePath, llmConfig);
      } catch (err) {
        console.warn(`[topic-consolidator] Failed to consolidate ${path.basename(filePath)}:`, err);
      }
    }
  }
}

/**
 * Scan all topic files and consolidate any that need it.
 * Used as a catch-up check on new session creation.
 */
export async function consolidateAllPending(
  memoryDir: string,
  llmConfig: { apiKey: string; baseUrl: string; model?: string },
): Promise<void> {
  const topicsDir = path.join(memoryDir, "topics");
  if (!fs.existsSync(topicsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(topicsDir, file);
    if (shouldConsolidate(filePath)) {
      try {
        await consolidateTopicFile(filePath, llmConfig);
      } catch (err) {
        console.warn(`[topic-consolidator] Catch-up consolidation failed for ${file}:`, err);
      }
    }
  }
}
