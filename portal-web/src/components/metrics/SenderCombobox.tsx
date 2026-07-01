import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { ChannelSender } from "../../hooks/useMetrics"

/** Compact "last seen" — relative for recent, short date beyond a day. */
function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

/**
 * Channel sender picker — a combobox that is BOTH a dropdown and a free input:
 * click the caret (or focus) to see every sender seen in the window (open_id /
 * staffId, ordered by recency, with message/session counts + last-seen), type
 * to filter, or paste an id directly. Raw ids are opaque, so the counts +
 * last-seen are what make the list recognizable.
 */
export function SenderCombobox({
  value,
  onChange,
  senders,
}: {
  value: string
  onChange: (v: string) => void
  senders: ChannelSender[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const q = value.trim().toLowerCase()
  const filtered = useMemo(
    () => (q ? senders.filter((s) => s.senderId.toLowerCase().includes(q)) : senders),
    [senders, q],
  )

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center h-8 w-56 rounded-md bg-secondary border border-border focus-within:border-blue-500">
        <input
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="open_id / staff id"
          className="flex-1 min-w-0 h-full px-2 text-[12px] bg-transparent text-foreground font-mono placeholder:font-sans focus:outline-none"
        />
        {value && (
          <button
            onClick={() => { onChange(""); setOpen(false) }}
            title="Clear"
            className="px-1 text-muted-foreground hover:text-foreground text-[13px] leading-none"
          >×</button>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          title="Toggle sender list"
          className="px-1.5 h-full text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-72 max-h-72 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">No senders in this window</div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.senderId}
                onClick={() => { onChange(s.senderId); setOpen(false) }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-secondary ${s.senderId === value ? "bg-secondary/60" : ""}`}
              >
                <div className="font-mono text-[12px] text-foreground truncate">{s.senderId}</div>
                <div className="text-[11px] text-muted-foreground">
                  {s.messageCount} msgs · {s.sessionCount} sessions · {relTime(s.lastSeen)}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
