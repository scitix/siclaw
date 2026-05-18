import { useCallback, useEffect, useRef, useState } from "react"

// Copy `text` to clipboard. Prefers the async Clipboard API, falls back to a
// legacy textarea + execCommand path for non-secure origins (HTTP access via
// host IP — `navigator.clipboard` is undefined there). Returns true on success.
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (err) {
    console.warn("[copy] clipboard API failed, falling back:", err)
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch (err) {
    console.warn("[copy] fallback failed:", err)
    return false
  }
}

// Tracks "copied" feedback state with a self-cancelling timer so back-to-back
// clicks don't leave a dangling timeout that clears the green check too early.
// `flash` lets callers that copy via a custom path (e.g. rich text/html with
// rasterised charts) still surface the same green-check feedback.
export function useCopyFeedback(): [boolean, (text: string) => Promise<void>, () => void] {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])
  const flash = useCallback(() => {
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 2000)
  }, [])
  const copy = useCallback(async (text: string) => {
    const ok = await copyTextToClipboard(text)
    if (!ok) return
    flash()
  }, [flash])
  return [copied, copy, flash]
}
