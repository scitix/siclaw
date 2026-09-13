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
  if (skillPreviewNotice(message)) return undefined
  const structured = parsePreview(message.toolDetails?.skillPreview) ?? parsePreview(message.metadata?.skillPreview)
  if (structured) return structured
  try {
    return parsePreview(JSON.parse(message.content))
  } catch {
    return undefined
  }
}

export interface SkillPreviewNotice {
  status: "deferred" | "omitted"
  name: string
  reason?: string
}

/** Explicit availability markers must never fall back to stale/truncated text. */
export function skillPreviewNotice(message: Pick<PilotMessage, "toolDetails" | "metadata">): SkillPreviewNotice | undefined {
  for (const raw of [message.toolDetails?.skillPreview, message.metadata?.skillPreview]) {
    const preview = record(raw)
    if (preview?.status === "deferred" || preview?.status === "omitted") {
      return { status: preview.status, name: typeof preview.name === "string" ? preview.name : "Skill preview", reason: typeof preview.reason === "string" ? preview.reason : undefined }
    }
    if (parsePreview(raw)) return undefined
  }
  return undefined
}
