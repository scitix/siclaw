// @vitest-environment jsdom
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PilotArea } from "./PilotArea"
import type { PilotMessage } from "../../hooks/usePilotChat"

const spec = { type: "waterfall", visual_id: "trace-1", data: {
  origin_time: "2026-09-10T00:00:00Z",
  coverage: { complete: true, observed: ["request"], missing: [] },
  spans: [{ span_id: "root", label: "Request", start_ms: 0, end_ms: 100 }],
} }
const metadata = { structuredContent: { schema_version: 2, visuals: [{ visual_id: "trace-1", kind: "chart", spec }] } }
const messages: PilotMessage[] = [
  { id: "u", role: "user", content: "Why slow?", timestamp: "" },
  { id: "chart", role: "tool", toolName: "render_chart", toolStatus: "success", content: "Trace", metadata, timestamp: "" },
  { id: "answer", role: "assistant", content: "Upstream wait.", timestamp: "" },
]
let root: Root
let container: HTMLDivElement
let frames: Map<number, FrameRequestCallback>
let scrolls: string[]
beforeEach(() => {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  frames = new Map()
  scrolls = []
  let frameId = 0
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} })
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function(this: HTMLElement) {
    scrolls.push(this.dataset.visualId ?? "latest")
  } })
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})
const renderChat = (items: PilotMessage[], sessionKey = "trace-test") => act(() => root.render(
  <StrictMode><PilotArea sessionKey={sessionKey} messages={items} isLoading={false} readOnly sendMessage={vi.fn()} /></StrictMode>,
))
const flushFrames = () => act(() => {
  for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(0)
})

it("focuses and expands the requested card instead of the latest answer, including StrictMode replay", () => {
  window.history.replaceState(null, "", "/?visual=trace-1")
  renderChat(messages)
  flushFrames()
  expect(container.querySelector(".trace-card")?.getAttribute("data-trace-expanded")).toBe("true")
  expect(scrolls).toEqual(["trace-1"])
  renderChat([...messages, { id: "more", role: "assistant", content: "More context", timestamp: "" }])
  flushFrames()
  expect(scrolls).toEqual(["trace-1"])
  renderChat([...messages,
    { id: "more", role: "assistant", content: "More context", timestamp: "" },
    { id: "next", role: "user", content: "Continue", timestamp: "" },
  ])
  flushFrames()
  expect(scrolls[scrolls.length - 1]).toBe("latest")
})

it("replaces pending auto-follow when history supplies the requested attachment", () => {
  window.history.replaceState(null, "", "/?visual=trace-1")
  renderChat(messages.slice(0, 1))
  renderChat(messages)
  flushFrames()
  expect(scrolls).toEqual(["trace-1"])
})

it("scopes navigation to the session and preserves normal scrolling for unknown visuals", () => {
  window.history.replaceState(null, "", "/?visual=trace-1")
  renderChat(messages)
  flushFrames()
  renderChat(messages, "other-session")
  flushFrames()
  expect(scrolls).toEqual(["trace-1", "trace-1"])
  window.history.replaceState(null, "", "/?visual=missing")
  renderChat(messages, "third-session")
  flushFrames()
  expect(scrolls[scrolls.length - 1]).toBe("latest")
})

it("cancels a queued navigation when the transcript unmounts", () => {
  window.history.replaceState(null, "", "/?visual=trace-1")
  renderChat(messages)
  act(() => root.render(null))
  flushFrames()
  expect(scrolls).toEqual([])
})
