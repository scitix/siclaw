import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { PlanPanel } from "./PlanPanel"
import type { PilotMessage } from "../chat/types"

const task = (subject: string, status = "pending"): PilotMessage => ({
  id: `event-${status}`, role: "user", content: "", timestamp: "0",
  metadata: { kind: "task_event", action: "upsert", task: { id: "7", subject, status } },
} as PilotMessage)

it("shows the known title after a blank completion snapshot, including history replay", () => {
  const messages = JSON.parse(JSON.stringify([task("Inspect request timing"), task("", "completed")]))
  expect(renderToStaticMarkup(createElement(PlanPanel, { messages }))).toContain("Inspect request timing")
})

it("shows a task ID rather than an empty row when the title is unavailable", () => {
  expect(renderToStaticMarkup(createElement(PlanPanel, { messages: [task("", "in_progress")] }))).toContain("Task #7")
})
