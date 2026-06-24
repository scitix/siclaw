import { ShieldCheck, Globe } from "lucide-react"
import { CAPABILITY_GROUPS, countToolsForSelection } from "../lib/toolCapabilities"

/**
 * Reusable capability-group multi-select. Used in both the agent create dialog
 * and the agent edit page (Tools tab).
 *
 * Backend semantics: an EMPTY selection means "unrestricted — all tools". The
 * banner makes that explicit so an empty checkbox list is not mistaken for
 * "no tools". A non-empty selection restricts the agent to the union of the
 * selected groups' tools.
 */
export function CapabilityGroupSelector({
  selected,
  onChange,
}: {
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const restricted = selected.size > 0
  const toolCount = countToolsForSelection(selected)
  const allSelected = selected.size === CAPABILITY_GROUPS.length

  const toggle = (key: string) => {
    const next = new Set(selected)
    next.has(key) ? next.delete(key) : next.add(key)
    onChange(next)
  }
  const selectAll = () => onChange(new Set(CAPABILITY_GROUPS.map((g) => g.key)))
  const clear = () => onChange(new Set())

  return (
    <div className="space-y-3">
      {/* Effective-state banner — teaches the empty = unrestricted rule */}
      {restricted ? (
        <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div className="text-[12px]">
            <span className="font-medium text-foreground">Restricted</span>
            <span className="text-muted-foreground"> — {selected.size} group{selected.size > 1 ? "s" : ""} · {toolCount} tools. Everything else (except MCP) is blocked.</span>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <Globe className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-[12px]">
            <span className="font-medium text-foreground">Unrestricted</span>
            <span className="text-muted-foreground"> — agent can use ALL tools (default). Select groups below to restrict it.</span>
          </div>
        </div>
      )}

      {/* Bulk actions */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground font-medium">Capability groups ({selected.size} / {CAPABILITY_GROUPS.length})</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={selectAll} disabled={allSelected} className="h-7 px-2 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40">Select All</button>
          <button type="button" onClick={clear} disabled={!restricted} className="h-7 px-2 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40">Clear (unrestricted)</button>
        </div>
      </div>

      {/* Group checkbox list */}
      <div className="max-h-[52vh] overflow-auto border border-border rounded-md divide-y divide-border">
        {CAPABILITY_GROUPS.map((g) => {
          const checked = selected.has(g.key)
          return (
            <label key={g.key} className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-secondary/30 cursor-pointer">
              <input type="checkbox" checked={checked} onChange={() => toggle(g.key)} className="rounded mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="text-[12px] font-medium text-foreground">{g.name}</span>
                <p className="text-[11px] text-muted-foreground">{g.description}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {g.tools.map((t) => (
                    <span key={t} className="px-1 py-0.5 rounded text-[9px] font-mono bg-secondary text-muted-foreground">{t}</span>
                  ))}
                </div>
              </div>
            </label>
          )
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        MCP server tools are controlled separately (per-agent MCP bindings) and are never blocked by these groups.
      </p>
    </div>
  )
}
