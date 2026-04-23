import { useEffect, useRef, useState } from "react"
import { Bell, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { api } from "../api"

interface Notification {
  id: string
  userId: string
  type: string
  title: string
  message: string | null
  relatedAgentId: string | null
  relatedTaskId: string | null
  relatedRunId: string | null
  readAt: string | null
  createdAt: string
}

function formatRelative(iso: string): string {
  const now = Date.now()
  const t = new Date(iso).getTime()
  const diff = now - t
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

/**
 * Bell + dropdown. WS subscription to /ws/notifications for live push,
 * REST bootstrap on mount, persistent across reconnects.
 */
export function NotificationBell({ collapsed = false }: { collapsed?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const wsRef = useRef<WebSocket | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  // Initial load from REST
  const refresh = async () => {
    try {
      const res = await api<{ data: Notification[]; unread_count: number }>(
        "/notifications?limit=30",
      )
      setItems(res.data ?? [])
      setUnread(res.unread_count ?? 0)
    } catch {
      // auth may be invalid → the global api helper will redirect; ignore here
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Live WS subscription — pushes new notifications as they arrive.
  //
  // TODO(prod): passing the JWT in the query string leaks it into nginx and
  // k8s access logs. Before production, replace with a one-shot ticket flow:
  // (1) REST POST /ws-ticket → short-lived token bound to this user;
  // (2) WS connects with ?ticket=<opaque> and server trades it for the
  // session. Acceptable for the internal-cluster test environment today.
  useEffect(() => {
    const token = localStorage.getItem("token")
    if (!token) return
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    const url = `${proto}://${window.location.host}/ws/notifications?token=${encodeURIComponent(token)}`

    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === "notification" && msg.data) {
            setItems((prev) => [msg.data as Notification, ...prev].slice(0, 30))
            setUnread((n) => n + 1)
          }
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        if (closed) return
        // Reconnect with small backoff
        reconnectTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => {
        try { ws.close() } catch { /* noop */ }
      }
    }
    connect()

    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    setTimeout(() => document.addEventListener("click", handler), 0)
    return () => document.removeEventListener("click", handler)
  }, [open])

  const handleClick = async (n: Notification) => {
    // Mark as read (optimistic)
    if (!n.readAt) {
      setItems((prev) => prev.map((x) => x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x))
      setUnread((c) => Math.max(0, c - 1))
      api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => {
        // Rollback on failure? Keep optimistic — it's cosmetic.
      })
    }
    // Deep-link into the relevant level: run detail when we know it (L3),
    // otherwise the task's run history (L2). Distinct routes per level mean
    // re-clicks always land cleanly without same-path suppression.
    if (n.relatedAgentId && n.relatedTaskId && n.relatedRunId) {
      navigate(`/agents/${n.relatedAgentId}/tasks/${n.relatedTaskId}/runs/${n.relatedRunId}`)
    } else if (n.relatedAgentId && n.relatedTaskId) {
      navigate(`/agents/${n.relatedAgentId}/tasks/${n.relatedTaskId}`)
    }
    setOpen(false)
  }

  const handleReadAll = () => {
    setItems((prev) => prev.map((x) => x.readAt ? x : { ...x, readAt: new Date().toISOString() }))
    setUnread(0)
    api("/notifications/read-all", { method: "POST" }).catch(() => { /* cosmetic */ })
  }

  return (
    <div ref={anchorRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={collapsed ? "Notifications" : undefined}
        aria-label="Notifications"
        className={`flex items-center ${collapsed ? "justify-center px-0" : "gap-2.5 px-4"} py-3 text-[13px] text-muted-foreground hover:text-foreground border-t border-border w-full`}
      >
        <div className="relative shrink-0">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-[9px] font-medium text-white flex items-center justify-center leading-none">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
        {!collapsed && "Notifications"}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-[360px] max-h-[480px] bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col z-50">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <span className="text-[12px] font-semibold">Notifications</span>
            {unread > 0 && (
              <button
                onClick={handleReadAll}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground text-[12px] gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading...
              </div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-muted-foreground">
                No notifications
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={`w-full flex items-start gap-2.5 px-4 py-3 text-left hover:bg-muted/30 transition-colors ${
                      n.readAt ? "opacity-60" : ""
                    }`}
                  >
                    <div className="shrink-0 mt-0.5">
                      {n.type === "task_success" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                      ) : n.type === "task_failure" ? (
                        <AlertTriangle className="h-4 w-4 text-red-400" />
                      ) : (
                        <Bell className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12px] font-medium truncate">{n.title}</span>
                        {!n.readAt && (
                          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-red-500" />
                        )}
                      </div>
                      {n.message && (
                        <p className="text-[11px] text-muted-foreground/80 truncate mt-0.5">
                          {n.message}
                        </p>
                      )}
                      <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                        {formatRelative(n.createdAt)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
