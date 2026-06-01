/**
 * Fold background sub-agent jobs from the message stream (design §12 Jobs bar).
 *
 * A background spawn returns a tool result {status:"launched", job_id}; on completion
 * runSpawnedSubagent persists a delegation_event whose delegation_id === the same id
 * (jobId === spawnId === delegationId). We correlate the two by that id so the Jobs bar
 * can show running vs finished background work, refresh-safe (it's all chat history).
 */

import type { PilotMessage } from "../chat/types"

export type JobStatus = "running" | "done" | "partial" | "failed" | "timed_out"

export interface JobView {
  jobId: string
  status: JobStatus
  label?: string
  childSessionId?: string
}

function parseContentJson(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null
  const trimmed = content.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const v = JSON.parse(trimmed)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A launched background sub-agent: tool result {status:"launched", job_id}. */
function launchedJobId(msg: PilotMessage): string | undefined {
  const body = parseContentJson(msg.content)
  if (body?.status === "launched" && typeof body.job_id === "string") return body.job_id
  return undefined
}

/** A completion event for a delegated/spawned sub-agent (delegation_id === jobId). */
function completionFor(msg: PilotMessage): { jobId: string; status: JobStatus; childSessionId?: string } | undefined {
  const meta = msg.metadata as Record<string, unknown> | undefined
  if (meta?.kind !== "delegation_event") return undefined
  const jobId = typeof meta.delegation_id === "string" ? meta.delegation_id : undefined
  if (!jobId) return undefined
  const raw = typeof meta.status === "string" ? meta.status : "done"
  const status: JobStatus =
    raw === "partial" || raw === "failed" || raw === "timed_out" ? raw : "done"
  const childSessionId = typeof meta.child_session_id === "string" ? meta.child_session_id : undefined
  return { jobId, status, childSessionId }
}

export function foldJobs(messages: PilotMessage[]): JobView[] {
  const jobs = new Map<string, JobView>()
  for (const msg of messages) {
    const launched = launchedJobId(msg)
    if (launched) {
      if (!jobs.has(launched)) jobs.set(launched, { jobId: launched, status: "running" })
      continue
    }
    const done = completionFor(msg)
    if (done) {
      const existing = jobs.get(done.jobId)
      // Only surface a finished job in the bar if it was launched in the background.
      if (existing) jobs.set(done.jobId, { ...existing, status: done.status, childSessionId: done.childSessionId })
    }
  }
  return [...jobs.values()]
}

/** Jobs still running (no completion event yet). */
export function runningJobs(messages: PilotMessage[]): JobView[] {
  return foldJobs(messages).filter((j) => j.status === "running")
}

export function hasJobs(messages: PilotMessage[]): boolean {
  return foldJobs(messages).length > 0
}
