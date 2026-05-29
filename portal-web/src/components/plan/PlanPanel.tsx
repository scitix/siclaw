import { CheckCircle2, Loader2, Bot, X } from "lucide-react"
import type { PilotMessage } from "../chat/types"
import { foldPlan, type PlanTaskView } from "./foldPlan"

function StatusIcon({ task }: { task: PlanTaskView }) {
  // done → check, in-progress → spinner, pending/ready/blocked → empty ring.
  if (task.group === "completed") return <CheckCircle2 className="w-4 h-4 text-emerald-500/80" />
  if (task.group === "in_progress") return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
  return (
    <span
      className={`block w-3.5 h-3.5 rounded-full border-[1.5px] ${
        task.group === "blocked" ? "border-muted-foreground/30" : "border-muted-foreground/55"
      }`}
    />
  )
}

function ProgressRow({ task }: { task: PlanTaskView }) {
  const done = task.group === "completed"
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5">
      <span className="mt-0.5 shrink-0">
        <StatusIcon task={task} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-snug ${done ? "text-muted-foreground" : "text-foreground"}`}>
          {task.subject}
        </p>
        {task.group === "blocked" && task.blockedBy.length > 0 && (
          <p className="text-[10px] text-muted-foreground/60">
            waiting on {task.blockedBy.map((b) => `#${b}`).join(" ")}
          </p>
        )}
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pt-3">
      <div className="px-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground/60">{label}</div>
      {children}
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

  // Sub-agents = distinct task owners (a task owned by a sub-agent carries its name +
  // session id for drill-in). Preserves first-seen order.
  const seen = new Set<string>()
  const subagents: { owner: string; sessionId?: string }[] = []
  for (const t of plan) {
    const owner = t.owner
    if (!owner || seen.has(owner)) continue
    seen.add(owner)
    const sessionId = typeof (t as { ownerSessionId?: string }).ownerSessionId === "string"
      ? (t as { ownerSessionId?: string }).ownerSessionId
      : undefined
    subagents.push({ owner, sessionId })
  }

  return (
    <aside className="absolute top-3 right-3 z-30 w-72 max-h-[calc(100%-1.5rem)] flex flex-col rounded-xl border border-border bg-card shadow-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
        <span className="text-[12px] font-medium text-muted-foreground">Plan</span>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 inline-flex items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-secondary"
            title="Hide plan"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto pb-3">
        <Section label="Progress">
          {plan.map((t) => (
            <ProgressRow key={t.id} task={t} />
          ))}
        </Section>

        {subagents.length > 0 && (
          <Section label="Subagents">
            {subagents.map((s) =>
              s.sessionId && onDrillIn ? (
                <button
                  key={s.owner}
                  onClick={() => onDrillIn(s.sessionId!)}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 text-left hover:bg-secondary/60"
                >
                  <Bot className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="text-[13px] text-foreground truncate hover:underline underline-offset-2">{s.owner}</span>
                </button>
              ) : (
                <div key={s.owner} className="flex items-center gap-2.5 px-3 py-1.5">
                  <Bot className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="text-[13px] text-foreground truncate">{s.owner}</span>
                </div>
              ),
            )}
          </Section>
        )}
      </div>
    </aside>
  )
}
