import { Users, MessageSquare, Activity, Wrench, Zap, Package, Server, FileCode, BookOpen, Bot, Plug } from "lucide-react"

interface Props {
  rangeLabel: string
  distinctUsers: number
  totalSessions: number
  totalPrompts: number
  toolCalls: number
  skillsUsed: number
  skillsUsedApprox?: boolean
  inventory: { clusters: number; hosts: number; skills: number; knowledgeRepos: number; agents: number; mcpServers: number }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

export function KpiCards(p: Props) {
  return (
    <div className="space-y-5">
      {/* 纳管规模 — 当前快照(置顶)*/}
      <div>
        <GroupLabel>Managed scale · current</GroupLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Clusters" value={fmt(p.inventory.clusters)} hint="connected" icon={<Package className="h-3.5 w-3.5" style={{ color: "#22d3ee" }} />} accent="#22d3ee" />
          <KpiCard label="Hosts" value={fmt(p.inventory.hosts)} hint="connected" icon={<Server className="h-3.5 w-3.5" style={{ color: "#60a5fa" }} />} accent="#60a5fa" />
          <KpiCard label="Skills" value={fmt(p.inventory.skills)} hint="in catalog" icon={<FileCode className="h-3.5 w-3.5" style={{ color: "#a78bfa" }} />} accent="#a78bfa" />
          <KpiCard label="Knowledge" value={fmt(p.inventory.knowledgeRepos)} hint="repositories" icon={<BookOpen className="h-3.5 w-3.5" style={{ color: "#34d399" }} />} accent="#34d399" />
          <KpiCard label="Agents" value={fmt(p.inventory.agents)} hint="agents" icon={<Bot className="h-3.5 w-3.5" style={{ color: "#fbbf24" }} />} accent="#fbbf24" />
          <KpiCard label="MCP" value={fmt(p.inventory.mcpServers)} hint="servers" icon={<Plug className="h-3.5 w-3.5" style={{ color: "#f472b6" }} />} accent="#f472b6" />
        </div>
      </div>

      {/* 使用规模 — 随时间窗 */}
      <div>
        <GroupLabel>Usage · {p.rangeLabel}</GroupLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <KpiCard label="Users" value={fmt(p.distinctUsers)} hint="distinct" icon={<Users className="h-3.5 w-3.5" style={{ color: "#60a5fa" }} />} accent="#60a5fa" />
          <KpiCard label="Sessions" value={fmt(p.totalSessions)} hint="conversations" icon={<Activity className="h-3.5 w-3.5" style={{ color: "#fbbf24" }} />} accent="#fbbf24" />
          <KpiCard label="Prompts" value={fmt(p.totalPrompts)} hint="user messages" icon={<MessageSquare className="h-3.5 w-3.5" style={{ color: "#34d399" }} />} accent="#34d399" />
          <KpiCard label="Tool Calls" value={fmt(p.toolCalls)} hint="executed" icon={<Wrench className="h-3.5 w-3.5" style={{ color: "#a78bfa" }} />} accent="#a78bfa" />
          <KpiCard label="Skills Used" value={fmt(p.skillsUsed)} hint={p.skillsUsedApprox ? "distinct · sampled" : "distinct"} icon={<Zap className="h-3.5 w-3.5" style={{ color: "#f472b6" }} />} accent="#f472b6" />
        </div>
      </div>
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">{children}</h3>
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
