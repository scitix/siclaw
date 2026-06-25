import { ENTRY_MODES, ENTRY_LABELS, type EntryMode } from "../../hooks/useMetrics"

/**
 * Page-level entry-form selector, shared by Dashboard / Sessions / Tools.
 * "Overview" is the combined interactive family (web+api+a2a+channel); the
 * remaining options isolate a single entry form, plus Scheduled (cron runs).
 */
export function EntrySelector({ value, onChange }: { value: EntryMode; onChange: (v: EntryMode) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as EntryMode)}
      title="Entry form"
      className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
    >
      {ENTRY_MODES.map((m) => (
        <option key={m} value={m}>{ENTRY_LABELS[m]}</option>
      ))}
    </select>
  )
}
