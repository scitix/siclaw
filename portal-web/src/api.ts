const API_BASE = "/api/v1"

function getToken(): string | null {
  return localStorage.getItem("token")
}

export function setToken(token: string) {
  localStorage.setItem("token", token)
}

export function clearToken() {
  localStorage.removeItem("token")
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown
}

export async function api<T>(path: string, options?: ApiOptions): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = getToken()
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...options?.headers as Record<string, string> },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })

  if (res.status === 401) {
    clearToken()
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    // Attach the full response body + status so callers can act on extra
    // fields (e.g. retry_after_sec on 429). Message keeps the flat behavior
    // existing callers expect.
    const err = new Error(body.error || `HTTP ${res.status}`) as Error & {
      status?: number
      body?: Record<string, unknown>
    }
    err.status = res.status
    err.body = body
    throw err
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

// SSE helper for chat
export function chatSSE(
  agentId: string,
  text: string,
  sessionId?: string,
  callbacks?: {
    onSessionId?: (id: string) => void
    onText?: (text: string) => void
    onDone?: () => void
    onError?: (err: Error) => void
  }
): { abort: () => void } {
  const controller = new AbortController()
  const token = getToken()

  ;(async () => {
    try {
      const res = await fetch(`${API_BASE}/siclaw/agents/${agentId}/chat/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text, session_id: sessionId }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const sid = res.headers.get("X-Session-Id")
      if (sid) callbacks?.onSessionId?.(sid)

      const reader = res.body?.getReader()
      if (!reader) throw new Error("No body")

      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split("\n\n")
        buffer = frames.pop() || ""

        for (const frame of frames) {
          if (!frame.trim()) continue
          let event = "message", data = ""
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7)
            else if (line.startsWith("data: ")) data = line.slice(6)
          }
          if (!data) continue
          try {
            const parsed = JSON.parse(data)
            if (event === "session") callbacks?.onSessionId?.(parsed.session_id)
            else if (event === "chat.text") callbacks?.onText?.(parsed.text || "")
            else if (event === "done") callbacks?.onDone?.()
          } catch {}
        }
      }
      callbacks?.onDone?.()
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return { abort: () => controller.abort() }
}

export async function chatSteer(agentId: string, sessionId: string, text: string): Promise<void> {
  await api(`/siclaw/agents/${agentId}/chat/steer`, {
    method: "POST",
    body: { session_id: sessionId, text },
  })
}

export async function chatAbort(agentId: string, sessionId: string): Promise<void> {
  await api(`/siclaw/agents/${agentId}/chat/abort`, {
    method: "POST",
    body: { session_id: sessionId },
  })
}

export async function clearAgentMemory(agentId: string): Promise<{ deletedFiles: number }> {
  return api(`/siclaw/agents/${agentId}/clear-memory`, { method: "POST" })
}
