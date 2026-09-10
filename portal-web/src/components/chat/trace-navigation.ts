import { useCallback, useEffect, useRef, type RefObject } from "react"

/** The transcript owns both auto-follow and visual navigation so they cannot race. */
export function useTraceNavigation(container: RefObject<HTMLElement | null>, scope?: string | null) {
  const requestedVisualId = typeof window === "undefined"
    ? null : new URLSearchParams(window.location.search).get("visual")
  const requestKey = JSON.stringify([scope, requestedVisualId])
  const focusedRequest = useRef<string | null>(null)
  const frame = useRef<number | null>(null)
  const scheduleScroll = useCallback((scroll: () => void) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      scroll()
    })
  }, [])
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    focusedRequest.current = null
  }, [requestKey])
  const focusRequestedTrace = useCallback(() => {
    if (!requestedVisualId || focusedRequest.current === requestKey) return false
    const target = Array.from(container.current?.querySelectorAll<HTMLElement>("[data-visual-id]") ?? [])
      .find(element => element.dataset.visualId === requestedVisualId)
    if (!target) return false // An unloaded/unknown attachment must not freeze normal scrolling.
    focusedRequest.current = requestKey
    scheduleScroll(() => target.scrollIntoView({ block: "start" }))
    return true
  }, [container, requestKey, requestedVisualId, scheduleScroll])
  return { requestedVisualId, focusRequestedTrace, scheduleScroll }
}
