import type { PilotMessage } from "../components/chat/types"

export interface SkillPreviewData {
  name: string
  description?: string
  type?: string
  specs?: string
  scripts?: Array<{ name: string; content: string }>
  files?: Array<{ path: string; content: string; encoding?: "utf8" | "base64"; size?: number }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parsePreview(value: unknown): SkillPreviewData | undefined {
  const skill = record(record(value)?.skill)
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined
  if (["description", "type", "specs"].some(key => skill[key] !== undefined && typeof skill[key] !== "string")) return undefined
  if (skill.scripts !== undefined && (!Array.isArray(skill.scripts) || skill.scripts.some(item => {
    const script = record(item)
    return !script || typeof script.name !== "string" || typeof script.content !== "string"
  }))) return undefined
  if (skill.files !== undefined && (!Array.isArray(skill.files) || skill.files.some(item => {
    const file = record(item)
    return !file || typeof file.path !== "string" || typeof file.content !== "string"
      || (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64")
      || (file.size !== undefined && (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0))
  }))) return undefined
  return skill as unknown as SkillPreviewData
}

/** Live tool details and restored metadata are authoritative; old rows used JSON text. */
export function readSkillPreview(message: Pick<PilotMessage, "content" | "toolDetails" | "metadata">): SkillPreviewData | undefined {
  const structured = parsePreview(message.toolDetails?.skillPreview) ?? parsePreview(message.metadata?.skillPreview)
  if (structured) return structured
  try {
    return parsePreview(JSON.parse(message.content))
  } catch {
    return undefined
  }
}
