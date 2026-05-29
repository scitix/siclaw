import type { PilotMessage } from "../chat/types"
import { foldPlan, type PlanGroup, type PlanTaskView } from "./foldPlan"

const GROUP_ORDER: PlanGroup[] = ["in_progress", "ready", "blocked", "completed"]
const GROUP_LABEL: Record<PlanGroup, string> = {
  in_progress: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  completed: "Done",
}
const GROUP_DOT: Record<PlanGroup, string> = {
  in_progress: "bg-blue-400 animate-pulse",
  ready: "bg-amber-400",
  blocked: "bg-muted-foreground/40",
  completed: "bg-green-400",
}

function TaskRow({ task, onDrillIn }: { task: PlanTaskView; onDrillIn?: (childSessionId: string) => void }) {
  const ownerSessionId = typeof (task as { ownerSessionId?: string }).ownerSessionId === "string"
    ? (task as { ownerSessionId?: string }).ownerSessionId
    : undefined
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-[12px]">
      <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${GROUP_DOT[task.group]}`} />
      <div className="min-w-0 flex-1">
        <p className={`truncate ${task.group === "completed" ? "line-through text-muted-foreground/60" : ""}`}>
          {task.subject}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
          {task.owner && (
            ownerSessionId && onDrillIn ? (
              <button className="hover:text-foreground underline-offset-2 hover:underline" onClick={() => onDrillIn(ownerSessionId)}>
                {task.owner}
              </button>
            ) : (
              <span>{task.owner}</span>
            )
          )}
          {task.group === "blocked" && task.blockedBy.length > 0 && (
            <span>waiting on {task.blockedBy.map((b) => `#${b}`).join(" ")}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export function PlanPanel({
  messages,
  onDrillIn,
  onClose,
}: {
  messages: PilotMessage[]
  onDrillIn?: (childSessionId: string) => void
  onClose?: () => void
}) {
  const plan = foldPlan(messages)
  if (plan.length === 0) return null

  const groups = GROUP_ORDER.map((g) => ({ group: g, tasks: plan.filter((t) => t.group === g) })).filter(
    (s) => s.tasks.length > 0,
  )

  return (
    <aside className="w-72 shrink-0 flex flex-col border-l border-border bg-background overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-[13px] font-medium">Plan</h2>
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-[12px]" title="Hide plan">
            ✕
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {groups.map(({ group, tasks }) => (
          <div key={group} className="mb-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {GROUP_LABEL[group]} ({tasks.length})
            </div>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onDrillIn={onDrillIn} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
