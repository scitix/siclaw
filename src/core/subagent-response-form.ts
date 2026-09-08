import { SUBAGENT_COMPLETION_INSTRUCTIONS } from "./subagent-registry.js";

/** Parent-owned answer contract. The wire format is plain text: `name:\nanswer`. */
export interface SubagentResponseField {
  name: string;
  question: string;
  /** Omit for free text; otherwise the child selects exactly one key. */
  options?: Record<string, string>;
}

export function validateResponseForm(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return "response_form requires at least one field.";
  const names = new Set<string>();
  for (const field of value) {
    if (!field || typeof field.name !== "string" || !field.name.trim() || /[:\r\n]/.test(field.name)) {
      return "Each response_form field needs a non-empty name without colons or newlines.";
    }
    if (field.name !== field.name.trim() || names.has(field.name)) return "response_form field names must be unique and trimmed.";
    names.add(field.name);
    if (typeof field.question !== "string" || !field.question.trim()) return `response_form ${field.name} needs a question.`;
    if (field.options !== undefined) {
      if (!field.options || typeof field.options !== "object" || Array.isArray(field.options) || Object.keys(field.options).length === 0) {
        return `response_form ${field.name} options must be a non-empty key-to-text object.`;
      }
      for (const [key, label] of Object.entries(field.options)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof label !== "string" || !label.trim()) {
          return `response_form ${field.name} needs uppercase option keys (e.g. A) and non-empty text labels.`;
        }
      }
    }
  }
  return undefined;
}

export const SUBAGENT_RESPONSE_INSTRUCTIONS = "INTERNAL SUB-AGENT RESPONSE CONTRACT (also applies to synthesis):\n" +
    "Your final answer is data for the parent agent. Fill every field below exactly once, in order. " +
    "Use the exact field name followed by a colon and an actual newline, then the answer. " +
    "Do not output JSON, Markdown tables, code fences, visual cards, images, or artifact-only references. " +
    "This contract overrides presentation/report-card skills for this internal response. " +
    "For choice questions output only ONE listed key; the runtime expands it to its text for the parent. " +
    SUBAGENT_COMPLETION_INSTRUCTIONS + " " +
    "Use the declared free-text fields for failure details; for successful questions return only the answer. " +
    "Do not repeat field headings inside answers. No introduction or footer.";

export function buildResponseFormPrompt(form: SubagentResponseField[]): string {
  return "Required response form:\n\n" + form.map((field) => `${field.name}:\nQuestion: ${field.question}\n` +
      (field.options
        ? Object.entries(field.options).map(([key, label]) => `${key}: ${label}`).join("\n")
        : "Answer: free text")).join("\n\n") +
    "\n\nReturn this filled form:\n" + form.map((field) => `${field.name}:\n<answer>`).join("\n\n");
}

/** Parse only declared headings, so timestamps/URLs and multiline evidence remain intact. */
export function parseResponseForm(form: SubagentResponseField[], raw: string): { text: string; valid: boolean } {
  const source = raw.replace(/\r\n/g, "\n").trim();
  const escapedNames = form.map((field) => field.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const headings = [...source.matchAll(new RegExp(`^(${escapedNames.join("|")}):\\n`, "gm"))];
  const answers = new Map<string, string[]>();
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const answer = source.slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? source.length).trim();
    answers.set(heading[1], [...(answers.get(heading[1]) ?? []), answer]);
  }
  const errors: string[] = [];
  if (headings[0]?.index !== 0) errors.push("Expected the filled form without an introduction or code fence.");
  if (/^```/m.test(source)) errors.push("Code fences are not part of the response form.");
  const text = form.map((field) => {
    const values = answers.get(field.name) ?? [];
    let answer = values[0] ?? "";
    if (values.length !== 1 || !answer || answer === "<answer>") {
      errors.push(`${field.name}: ${values.length > 1 ? "duplicate field" : "missing answer"}`);
      answer = `[${values.length > 1 ? "Duplicate field; answer not accepted" : "Answer not supplied"}]`;
    } else if (field.options) {
      if (Object.hasOwn(field.options, answer)) answer = field.options[answer];
      else {
        errors.push(`${field.name}: invalid option ${JSON.stringify(answer)}`);
        answer = `[Invalid option: ${answer}]`;
      }
    }
    return `${field.name}:\n${answer}`;
  }).join("\n\n");
  return {
    text: errors.length ? `${text}\n\nResponse form incomplete:\n${errors.join("\n")}` : text,
    valid: errors.length === 0,
  };
}
