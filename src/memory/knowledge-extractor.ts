/**
 * Knowledge Extractor — extracts structured knowledge from conversations.
 *
 * Replaces raw conversation dumps with LLM-driven topic extraction.
 * Topics are organized into `memory/topics/*.md` files that the existing
 * indexer can chunk/embed/search automatically.
 *
 * Topic categories:
 * - environment: cluster names, node counts, versions, network config
 * - preferences: user-preferred commands, response style
 * - troubleshooting: problem patterns and solutions
 * - commands: useful commands and tricks
 * - architecture: system architecture facts
 */

import fs from "node:fs";
import path from "node:path";

export interface TopicEntry {
  topic: string;
  facts: string[];
}

export interface ExtractionOpts {
  messages: Array<{ role: string; text: string }>;
  llmConfig: { apiKey: string; baseUrl: string; model?: string };
}

interface ExtractionToolArgs {
  should_extract: boolean;
  entries?: Array<{ topic: string; facts: string[] }>;
}

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    should_extract: {
      type: "boolean" as const,
      description: "Whether the conversation contains extractable knowledge (false for greetings, small talk, or very short exchanges)",
    },
    entries: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          topic: {
            type: "string" as const,
            enum: ["environment", "preferences", "troubleshooting", "commands", "architecture"],
            description: "Knowledge category",
          },
          facts: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Concise factual statements extracted from the conversation",
          },
        },
        required: ["topic", "facts"] as const,
      },
      description: "Extracted knowledge entries grouped by topic",
    },
  },
  required: ["should_extract"] as const,
};

const LLM_MAX_TOKENS = 2048;

/**
 * Extract structured knowledge from conversation messages using LLM.
 * Returns empty array if conversation has no extractable knowledge.
 */
export async function extractConversationKnowledge(opts: ExtractionOpts): Promise<TopicEntry[]> {
  const { messages, llmConfig } = opts;

  const conversationText = messages
    .map(m => `${m.role}: ${m.text.length > 1000 ? m.text.slice(0, 1000) + "..." : m.text}`)
    .join("\n\n");

  const prompt = `You are a knowledge extraction system for an SRE team. Analyze this conversation and extract reusable factual knowledge.

<conversation>
${conversationText}
</conversation>

Extract knowledge into these categories:
- **environment**: cluster names, node counts, K8s versions, network configs, hardware specs
- **preferences**: user-preferred commands, diagnostic approaches, response style preferences
- **troubleshooting**: problem patterns, root causes found, solutions applied
- **commands**: useful commands, script invocations, tool usage tips
- **architecture**: system topology, service dependencies, deployment facts

Rules:
- Only extract FACTUAL information stated or confirmed in the conversation
- Each fact should be a concise, self-contained statement
- Skip opinions, questions, and speculative content
- If the conversation is just greetings, small talk, or too short to contain useful knowledge, set should_extract to false
- Combine related facts into one statement when possible
- Do NOT extract generic knowledge — only team/environment-specific facts

Call the extract_knowledge tool with your result.`;

  const url = `${llmConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const model = llmConfig.model ?? "";

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: LLM_MAX_TOKENS,
    tools: [{
      type: "function",
      function: {
        name: "extract_knowledge",
        description: "Submit extracted knowledge from conversation",
        parameters: EXTRACTION_SCHEMA,
      },
    }],
    tool_choice: { type: "function", function: { name: "extract_knowledge" } },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Knowledge extraction LLM error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    choices: Array<{
      message: {
        content?: string | null;
        tool_calls?: Array<{
          function: { arguments: string };
        }>;
      };
    }>;
  };

  const toolCall = data.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    return [];
  }

  let args: ExtractionToolArgs;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return [];
  }

  if (!args.should_extract || !Array.isArray(args.entries)) {
    return [];
  }

  // Validate topic values against allowed set (defense against LLM returning path-traversal values)
  const ALLOWED_TOPICS = new Set(["environment", "preferences", "troubleshooting", "commands", "architecture"]);
  return args.entries.filter(e => ALLOWED_TOPICS.has(e.topic) && Array.isArray(e.facts) && e.facts.length > 0);
}

/**
 * Merge extracted topic entries into `{memoryDir}/topics/*.md` files.
 * Creates new files or appends to existing ones with date-based sections.
 * Deduplicates facts by normalized text comparison.
 *
 * @returns Array of file paths that were created or modified.
 */
export async function mergeTopicFiles(memoryDir: string, entries: TopicEntry[]): Promise<string[]> {
  const topicsDir = path.join(memoryDir, "topics");
  if (!fs.existsSync(topicsDir)) {
    fs.mkdirSync(topicsDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const modifiedFiles: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(topicsDir, `${entry.topic}.md`);
    const newFacts = entry.facts.filter(f => f.trim());
    if (newFacts.length === 0) continue;

    let existingContent = "";
    if (fs.existsSync(filePath)) {
      existingContent = fs.readFileSync(filePath, "utf-8");
    }

    // Collect existing facts for dedup (normalized: trimmed + lowercase)
    const existingNormalized = new Set(
      existingContent.split("\n")
        .filter(line => line.startsWith("- "))
        .map(line => line.slice(2).trim().toLowerCase()),
    );

    // Filter out duplicates
    const uniqueFacts = newFacts.filter(
      f => !existingNormalized.has(f.trim().toLowerCase()),
    );
    if (uniqueFacts.length === 0) continue;

    const factsBlock = uniqueFacts.map(f => `- ${f}`).join("\n");

    if (!existingContent) {
      // New file
      const topicTitle = entry.topic.charAt(0).toUpperCase() + entry.topic.slice(1);
      const content = `# ${topicTitle}\n\n## ${dateStr}\n${factsBlock}\n`;
      fs.writeFileSync(filePath, content, "utf-8");
    } else {
      // Append: check if today's date section already exists
      const dateSectionHeader = `## ${dateStr}`;
      if (existingContent.includes(dateSectionHeader)) {
        // Find the date section and append facts to it
        const sectionIdx = existingContent.indexOf(dateSectionHeader);
        const afterHeader = sectionIdx + dateSectionHeader.length;
        // Find the next section header or end of file
        const nextSectionIdx = existingContent.indexOf("\n## ", afterHeader);
        const insertPoint = nextSectionIdx >= 0 ? nextSectionIdx : existingContent.length;
        const updated = existingContent.slice(0, insertPoint).trimEnd()
          + "\n" + factsBlock + "\n"
          + existingContent.slice(insertPoint);
        fs.writeFileSync(filePath, updated, "utf-8");
      } else {
        // Add new date section at the top (after the heading)
        const headingEnd = existingContent.indexOf("\n\n");
        if (headingEnd >= 0) {
          const updated = existingContent.slice(0, headingEnd + 2)
            + `${dateSectionHeader}\n${factsBlock}\n\n`
            + existingContent.slice(headingEnd + 2);
          fs.writeFileSync(filePath, updated, "utf-8");
        } else {
          // Fallback: just append
          fs.writeFileSync(filePath, existingContent.trimEnd() + `\n\n${dateSectionHeader}\n${factsBlock}\n`, "utf-8");
        }
      }
    }

    modifiedFiles.push(filePath);
  }

  return modifiedFiles;
}
