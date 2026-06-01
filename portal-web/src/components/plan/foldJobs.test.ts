import { describe, it, expect } from "vitest"
import { foldJobs, runningJobs, hasJobs } from "./foldJobs"
import type { PilotMessage } from "../chat/types"

function launched(jobId: string): PilotMessage {
  return { id: `l-${jobId}`, role: "assistant", content: JSON.stringify({ status: "launched", job_id: jobId }), timestamp: 0 } as unknown as PilotMessage
}
function completion(jobId: string, status: string, childSessionId = "child-x"): PilotMessage {
  return {
    id: `c-${jobId}`, role: "user", content: "", timestamp: 0,
    metadata: { kind: "delegation_event", delegation_id: jobId, status, child_session_id: childSessionId },
  } as unknown as PilotMessage
}

describe("foldJobs", () => {
  it("shows a launched background job as running until it completes", () => {
    const msgs = [launched("job-1")]
    expect(runningJobs(msgs).map((j) => j.jobId)).toEqual(["job-1"])
    expect(hasJobs(msgs)).toBe(true)
  })

  it("marks a job done when its delegation_event (matching delegation_id) arrives", () => {
    const msgs = [launched("job-1"), completion("job-1", "done", "child-1")]
    const jobs = foldJobs(msgs)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ jobId: "job-1", status: "done", childSessionId: "child-1" })
    expect(runningJobs(msgs)).toEqual([])
  })

  it("maps failure/timeout statuses", () => {
    expect(foldJobs([launched("a"), completion("a", "failed")])[0].status).toBe("failed")
    expect(foldJobs([launched("b"), completion("b", "timed_out")])[0].status).toBe("timed_out")
  })

  it("ignores completion events with no matching launched job (foreground sub-agents)", () => {
    // A foreground sub-agent also persists a delegation_event, but was never 'launched'.
    expect(foldJobs([completion("fg-1", "done")])).toEqual([])
  })

  it("ignores unrelated messages", () => {
    const msgs = [
      { id: "1", role: "assistant", content: "hello", timestamp: 0 } as unknown as PilotMessage,
      { id: "2", role: "user", content: "", timestamp: 0, metadata: { kind: "task_event" } } as unknown as PilotMessage,
    ]
    expect(foldJobs(msgs)).toEqual([])
    expect(hasJobs(msgs)).toBe(false)
  })
})
