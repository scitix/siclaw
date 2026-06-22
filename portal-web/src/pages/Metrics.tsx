import { useCallback, useMemo, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { useSummary, useUsers, rangeLabel, DEFAULT_RANGE, type TimeRange } from "../hooks/useMetrics"
import { KpiCards } from "../components/metrics/KpiCards"
import { TrendChart } from "../components/metrics/TrendChart"
import { AuditTable } from "../components/metrics/AuditTable"
import { GrafanaFrame } from "../components/metrics/GrafanaFrame"
import { TimeRangePicker } from "../components/metrics/TimeRangePicker"

type TabKey = "dashboard" | "audit" | "grafana"

export function Metrics() {
  const [tab, setTab] = useState<TabKey>("dashboard")
  const [userId, setUserId] = useState<string>("")         // "" = All Users (Audit filter only)
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_RANGE)

  const filterUserId = userId || null
  const rLabel = rangeLabel(timeRange)

  const { users } = useUsers()
  // Dashboard is an external-facing showcase: aggregate only, never scoped to
  // an individual — so summary is fetched without a user filter.
  const { data: summary, loading: summaryLoading, refresh: refreshSummary } = useSummary(timeRange, null)

  const [spinning, setSpinning] = useState(false)
  const handleRefresh = useCallback(() => {
    setSpinning(true)
    Promise.resolve(refreshSummary()).finally(() => {
      setTimeout(() => setSpinning(false), 600)
    })
  }, [refreshSummary])

  const selectedUsername = useMemo(() => {
    if (!userId) return null
    return users.find((u) => u.id === userId)?.username ?? userId
  }, [userId, users])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-card border-b border-border">
        <div className="px-6 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Metrics</h2>
              <p className="text-[12px] text-muted-foreground mt-0.5">Adoption &amp; impact · admin-only</p>
            </div>
            <div className="flex items-center gap-2">
              {tab === "dashboard" && (
                <>
                  <button
                    onClick={handleRefresh}
                    title="Sync now"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 transition-transform duration-500 ${spinning ? "animate-spin" : ""}`} />
                  </button>
                  <TimeRangePicker value={timeRange} onChange={setTimeRange} />
                </>
              )}
              {tab === "audit" && (
                <select
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
                >
                  <option value="">All Users</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6 mt-4 -mb-px">
            {(["dashboard", "audit", "grafana"] as TabKey[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2.5 px-1 text-[13px] font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "text-foreground border-blue-500"
                    : "text-muted-foreground hover:text-foreground border-transparent"
                }`}
              >
                {t === "dashboard" ? "Dashboard" : t === "audit" ? "Audit" : "Grafana"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "dashboard" && (
          <section className="px-6 py-6 space-y-6">
            {summaryLoading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <KpiCards
                  rangeLabel={rLabel}
                  distinctUsers={summary?.distinctUsers ?? 0}
                  totalSessions={summary?.totalSessions ?? 0}
                  totalPrompts={summary?.totalPrompts ?? 0}
                  toolCalls={summary?.toolCalls ?? 0}
                  skillsUsed={summary?.skillsUsed ?? 0}
                  skillsUsedApprox={summary?.skillsUsedApprox}
                  inventory={summary?.inventory ?? { clusters: 0, hosts: 0, skills: 0, knowledgeRepos: 0, agents: 0, mcpServers: 0 }}
                />

                {/* Daily trend — hidden for sub-day windows that yield a single point. */}
                {summary && summary.dailySeries.length > 1 && (
                  <div>
                    <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Usage trend · daily · {rLabel}
                    </h3>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <TrendChart
                        title="Prompts"
                        subtitle="user messages per day"
                        color="#34d399"
                        data={summary.dailySeries.map((d) => ({ date: d.date, value: d.prompts }))}
                      />
                      <TrendChart
                        title="Tool Calls"
                        subtitle="tool executions per day"
                        color="#a78bfa"
                        data={summary.dailySeries.map((d) => ({ date: d.date, value: d.toolCalls }))}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {tab === "audit" && (
          <AuditTable userFilterId={filterUserId} usernameHint={selectedUsername} timeRange={timeRange} />
        )}

        {tab === "grafana" && <GrafanaFrame />}
      </div>
    </div>
  )
}
