import { useEffect, useState } from "react"
import { api } from "../api"
import type { PilotMessage } from "../components/chat/types"
import { readSkillPreview, skillPreviewNotice, type SkillPreviewNotice, type SkillPreviewData } from "./skillPreview"

/** Only an opened panel fetches detail. Requests cannot outlive the selected message. */
export function useSkillPreview(message: PilotMessage, detailUrl?: string) {
  const notice = skillPreviewNotice(message)
  const key = `${detailUrl}:${message.id}`
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; skill?: SkillPreviewData; notice?: SkillPreviewNotice; error?: boolean }>()
  const result = loaded?.key === key ? loaded : undefined
  const deferred = notice?.status === "deferred"
  useEffect(() => {
    if (!deferred || !detailUrl) return
    const controller = new AbortController()
    setLoaded(undefined)
    void api<{ data: Array<{ id: string; content?: string; metadata?: unknown }> }>(detailUrl, { signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return
      const row = response.data.find(row => row.id === message.id)
      if (!row) throw new Error("Preview message is unavailable")
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
      const restored = { content: row.content ?? "", metadata: metadata as Record<string, unknown> }
      const skill = readSkillPreview(restored)
      const notice = skillPreviewNotice(restored)
      setLoaded({ key, skill, notice, error: !skill && notice?.status !== "omitted" })
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ key, error: true }) })
    return () => controller.abort()
  }, [deferred, detailUrl, message.id, key, attempt])
  return {
    skill: deferred ? result?.skill : readSkillPreview(message),
    notice: result?.notice ?? notice,
    loading: Boolean(deferred && detailUrl && !result),
    error: result?.error,
    retry: () => setAttempt(value => value + 1),
  }
}
