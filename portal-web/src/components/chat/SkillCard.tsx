import { BookOpen } from "lucide-react"
import type { PilotMessage } from "./types"

export function SkillCard({ message }: { message: PilotMessage }) {
  let parsed: { skill: { name: string } } | null = null
  try {
    parsed = JSON.parse(message.content)
  } catch {
    return null
  }
  if (!parsed?.skill) return null

  return (
    <div className="pl-12 my-1">
      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10">
        <BookOpen className="w-4 h-4 text-indigo-500 shrink-0" />
        <span className="text-sm font-medium text-foreground">{parsed.skill.name}</span>
      </div>
    </div>
  )
}
