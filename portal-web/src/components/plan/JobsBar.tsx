import type { PilotMessage } from "../chat/types"
import { foldJobs, type JobStatus } from "./foldJobs"

const DOT: Record<JobStatus, string> = {
  running: "bg-blue-400 animate-pulse",
  done: "bg-green-400",
  partial: "bg-amber-400",
  failed: "bg-red-400",
  timed_out: "bg-red-400",
}

/** Bottom strip of background sub-agent jobs (design §12). Display-only; cancellation is the agent's job_stop tool. */
export function JobsBar({
  messages,
  onOpenSubagent,
}: {
  messages: PilotMessage[]
  onOpenSubagent?: (childSessionId: string, status?: string, label?: string) => void
}) {
  const jobs = foldJobs(messages)
  if (jobs.length === 0) return null

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 py-1.5 flex items-center gap-3 overflow-x-auto text-[11px]">
      <span className="text-muted-foreground/60 shrink-0">Background</span>
      {jobs.map((j) => {
        const canOpen = Boolean(j.childSessionId && onOpenSubagent)
        return (
          <button
            key={j.jobId}
            disabled={!canOpen}
            onClick={() => j.childSessionId && onOpenSubagent?.(j.childSessionId, j.status, "Sub-agent")}
            className={`flex items-center gap-1.5 shrink-0 ${canOpen ? "hover:text-foreground" : "cursor-default"}`}
            title={j.childSessionId ? "View sub-agent transcript" : undefined}
          >
            <span className={`h-2 w-2 rounded-full ${DOT[j.status]}`} />
            <span className="text-muted-foreground">
              {j.status === "running" ? "running" : j.status} · {j.jobId.slice(0, 8)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
