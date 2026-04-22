const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f472b6", "#22d3ee", "#f87171", "#fb923c"]

interface RankedItem {
  name: string
  subtitle?: string
  total: number
  success: number
  error: number
}

interface Props {
  title: string
  subtitle?: string
  items: RankedItem[]
  limit?: number
}

export function RankedTable({ title, subtitle, items, limit = 10 }: Props) {
  const shown = items.slice(0, limit)
  const max = shown.reduce((m, i) => Math.max(m, i.total), 0) || 1

  return (
    <div className="border border-border rounded-lg bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-[13px] font-semibold">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">top {shown.length}</span>
      </div>

      {shown.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-muted-foreground">No data yet</div>
      ) : (
        <div className="space-y-2">
          {shown.map((item, idx) => {
            const color = PALETTE[idx % PALETTE.length]
            const pct = (item.total / max) * 100
            return (
              <div key={item.name + idx} className="flex items-center gap-3 text-[12px]">
                <div className="w-28 truncate">
                  <div className="text-foreground truncate">{item.name}</div>
                  {item.subtitle && <div className="text-[10px] text-muted-foreground truncate">{item.subtitle}</div>}
                </div>
                <div className="flex-1 h-5 bg-secondary rounded-sm relative overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 rounded-sm transition-all"
                    style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}, ${color}80)` }}
                  />
                  {item.error > 0 && (
                    <div
                      className="absolute inset-y-0 rounded-sm"
                      style={{
                        left: `${(item.success / max) * 100}%`,
                        width: `${(item.error / max) * 100}%`,
                        background: "#f8717180",
                      }}
                      title={`${item.error} errors`}
                    />
                  )}
                </div>
                <div className="w-16 text-right font-mono tabular-nums">{item.total.toLocaleString()}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
