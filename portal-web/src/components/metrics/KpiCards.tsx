import { MessageSquare, Bot, Activity, Wrench } from "lucide-react"

interface Props {
  totalSessions: number
  totalPrompts: number
  activeSessions: number
  wsConnections: number
  toolCallsTotal: number
  period: "today" | "7d" | "30d"
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

const periodLabel: Record<Props["period"], string> = {
  today: "today",
  "7d": "7d",
  "30d": "30d",
}

export function KpiCards(p: Props) {
  const plabel = periodLabel[p.period]
  return (
    <div className="grid grid-cols-4 gap-4">
      <KpiCard
        label={`Sessions · ${plabel}`}
        value={fmt(p.totalSessions)}
        hint={`active now · ${p.activeSessions}`}
        icon={<Activity className="h-3.5 w-3.5" style={{ color: "#fbbf24" }} />}
        accent="#fbbf24"
      />
      <KpiCard
        label={`Prompts · ${plabel}`}
        value={fmt(p.totalPrompts)}
        hint="user messages"
        icon={<MessageSquare className="h-3.5 w-3.5" style={{ color: "#34d399" }} />}
        accent="#34d399"
      />
      <KpiCard
        label="Tool Calls · live"
        value={fmt(p.toolCallsTotal)}
        hint="top-N total"
        icon={<Wrench className="h-3.5 w-3.5" style={{ color: "#a78bfa" }} />}
        accent="#a78bfa"
      />
      <KpiCard
        label="WS Connections · live"
        value={String(p.wsConnections)}
        hint="connected clients"
        icon={<Bot className="h-3.5 w-3.5" style={{ color: "#60a5fa" }} />}
        accent="#60a5fa"
      />
    </div>
  )
}

function KpiCard({ label, value, hint, icon, accent }: { label: string; value: string; hint: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="border border-border rounded-lg p-4 bg-card transition-colors hover:border-muted-foreground/40">
      <div className="flex items-start justify-between">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold font-mono" style={{ color: accent }}>{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}
