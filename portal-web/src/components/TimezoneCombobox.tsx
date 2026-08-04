import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import {
  allTimezones,
  browserTimezone,
  filterTimezones,
  timezoneClockLabel,
  timezoneOffsetLabel,
} from "../lib/timezones"

/**
 * Timezone picker, in the shape of the macOS one: search by city, every row
 * showing its current offset and local time.
 *
 * Free typing filters but does NOT commit — the value has to be a zone the
 * runtime can resolve, so it is only ever set by picking a row or clearing.
 */
export function TimezoneCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQuery("") }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const zones = useMemo(allTimezones, [])
  const here = useMemo(browserTimezone, [])
  // One instant for the whole render, so every row's clock agrees.
  const now = useMemo(() => new Date(), [open, query])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => filterTimezones(zones, q), [zones, q])

  // Pre-2022 engines cannot enumerate zones, so there is no list to pick from.
  // Degrade to a plain field rather than a picker that shows nothing — the save
  // path validates the name and rejects an unusable one with a message.
  if (zones.length === 0) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Not set — the agent uses UTC"
        className="w-72 h-10 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
      />
    )
  }

  return (
    <div ref={ref} className="relative w-72">
      <div className="flex items-center h-10 rounded-md border border-border bg-background focus-within:ring-1 focus-within:ring-ring">
        <input
          value={open ? query : value}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={value ? value : "Not set — the agent uses UTC"}
          className="flex-1 min-w-0 h-full px-3 text-[13px] bg-transparent text-foreground focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(""); setQuery(""); setOpen(false) }}
            title="Clear"
            className="px-1 text-muted-foreground hover:text-foreground text-[14px] leading-none"
          >×</button>
        )}
        <button
          type="button"
          onClick={() => { setOpen((o) => !o); setQuery("") }}
          title="Toggle timezone list"
          className="px-2 h-full text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-80 max-h-72 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {here && !q && here !== value && (
            <button
              type="button"
              onClick={() => { onChange(here); setOpen(false); setQuery("") }}
              className="block w-full text-left px-3 py-1.5 border-b border-border hover:bg-secondary"
            >
              <div className="text-[13px] text-foreground truncate">{here}</div>
              <div className="text-[11px] text-muted-foreground">
                This browser · {timezoneOffsetLabel(here, now)} · {timezoneClockLabel(here, now)}
              </div>
            </button>
          )}
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">No timezone matches “{query}”</div>
          ) : (
            filtered.map((z) => (
              <button
                type="button"
                key={z}
                onClick={() => { onChange(z); setOpen(false); setQuery("") }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-secondary ${z === value ? "bg-secondary/60" : ""}`}
              >
                <div className="text-[13px] text-foreground truncate">{z}</div>
                <div className="text-[11px] text-muted-foreground">{timezoneOffsetLabel(z, now)} · {timezoneClockLabel(z, now)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
