import { AlertCircle, BookOpen } from "lucide-react"
import type { PilotMessage } from "./types"
import { readSkillPreview } from "../../lib/skillPreview"

export function SkillCard({ message }: { message: PilotMessage }) {
  const skill = readSkillPreview(message)
  if (!skill) {
    return (
      <div className="pl-12 my-1 text-sm text-muted-foreground flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>Skill preview unavailable</span>
      </div>
    )
  }

  return (
    <div className="pl-12 my-1">
      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10">
        <BookOpen className="w-4 h-4 text-indigo-500 shrink-0" />
        <span className="text-sm font-medium text-foreground">{skill.name}</span>
      </div>
    </div>
  )
}
