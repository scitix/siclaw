import { useCallback, useMemo, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { useSummary, useTiming, useUsers, useChannels, useChannelSenders, rangeLabel, ENTRY_LABELS, DEFAULT_RANGE, type EntryMode, type TimeRange } from "../hooks/useMetrics"
import { KpiCards } from "../components/metrics/KpiCards"
import { TrendChart } from "../components/metrics/TrendChart"
import { TimingStatsCard } from "../components/metrics/TimingStatsCard"
import { AuditTable } from "../components/metrics/AuditTable"
import { SessionTable } from "../components/metrics/SessionTable"
import { GrafanaFrame } from "../components/metrics/GrafanaFrame"
import { TimeRangePicker } from "../components/metrics/TimeRangePicker"
import { EntrySelector } from "../components/metrics/EntrySelector"
import { SenderCombobox } from "../components/metrics/SenderCombobox"

type TabKey = "dashboard" | "sessions" | "tools" | "grafana"

const TAB_ORDER: TabKey[] = ["dashboard", "sessions", "tools", "grafana"]
const TAB_LABEL: Record<TabKey, string> = { dashboard: "Dashboard", sessions: "Sessions", tools: "Tools", grafana: "Grafana" }

export function Metrics() {
  const [tab, setTab] = useState<TabKey>("dashboard")
  const [userId, setUserId] = useState<string>("")         // "" = All Users (Sessions/Tools filter only)
  const [channelId, setChannelId] = useState<string>("")   // "" = All Channels (channel entry only)
  const [senderId, setSenderId] = useState<string>("")     // exact channel sender open_id/staffId (channel entry only)
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_RANGE)
  const [entry, setEntry] = useState<EntryMode>("all")     // entry-form axis, shared across tabs

  // The "who" axis is origin-aware. Channel actors are open_ids, NOT portal
  // users, so the portal-user filter does not apply on the channel entry (it
  // would match no channel rows) — channel uses the sender (open_id) filter
  // instead. Only apply the portal-user filter off-channel.
  const filterUserId = entry === "channel" ? null : (userId || null)
  // Channel sub-filters only apply to the channel entry; ignored otherwise.
  const filterChannelId = entry === "channel" ? (channelId || null) : null
  const filterSenderId = entry === "channel" ? (senderId.trim() || null) : null
  const rLabel = rangeLabel(timeRange)
  const isAudit = tab === "sessions" || tab === "tools"
  const showControls = tab !== "grafana"

  const { users } = useUsers()
  const { channels } = useChannels()
  // Distinct channel senders seen in the window — feeds the open_id combobox.
  const { senders } = useChannelSenders(timeRange, filterChannelId, isAudit && entry === "channel")
  // Dashboard is an external-facing showcase: aggregate only, never scoped to
  // an individual — so summary/timing are fetched without a user filter.
  const { data: summary, loading: summaryLoading, refresh: refreshSummary } = useSummary(timeRange, null, entry)
  const { data: timing, loading: timingLoading, refresh: refreshTiming } = useTiming(timeRange, null, entry)

  const [spinning, setSpinning] = useState(false)
  const handleRefresh = useCallback(() => {
    setSpinning(true)
    Promise.all([Promise.resolve(refreshSummary()), Promise.resolve(refreshTiming())]).finally(() => {
      setTimeout(() => setSpinning(false), 600)
    })
  }, [refreshSummary, refreshTiming])

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
                <button
                  onClick={handleRefresh}
                  title="Sync now"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition"
                >
                  <RefreshCw className={`h-3.5 w-3.5 transition-transform duration-500 ${spinning ? "animate-spin" : ""}`} />
                </button>
              )}
              {/* Portal-user filter — audit tabs, and NOT the channel entry
                  (channel actors are open_ids, not portal users; channel uses the
                  sender filter below). The Dashboard is outward-facing and never
                  drills down by user. */}
              {isAudit && entry !== "channel" && (
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
              {/* Channel sub-filter — audit tabs, only when the channel entry is
                  selected (channelId is meaningless for web/api/a2a). */}
              {isAudit && entry === "channel" && (
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  className="h-8 px-2 pr-6 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
                >
                  <option value="">All Channels</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
              {/* Channel sender (open_id / staffId) — dropdown + free input:
                  pick from senders seen in the window (with counts + last-seen)
                  or type/paste an id. Audit tabs, channel entry only. */}
              {isAudit && entry === "channel" && (
                <SenderCombobox value={senderId} onChange={setSenderId} senders={senders} />
              )}
              {/* Entry-form axis + time window — shared by Dashboard/Sessions/Tools. */}
              {showControls && <EntrySelector value={entry} onChange={setEntry} />}
              {showControls && <TimeRangePicker value={timeRange} onChange={setTimeRange} />}
            </div>
          </div>

          <div className="flex items-center gap-6 mt-4 -mb-px">
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2.5 px-1 text-[13px] font-medium border-b-2 transition-colors ${
                  tab === t
                    ? "text-foreground border-blue-500"
                    : "text-muted-foreground hover:text-foreground border-transparent"
                }`}
              >
                {TAB_LABEL[t]}
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
                  rangeLabel={`${ENTRY_LABELS[entry]} · ${rLabel}`}
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

                {/* Response timing — TTFT / thinking / per-tool latency (entry-aware). */}
                {timingLoading ? (
                  <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : (
                  <TimingStatsCard data={timing} rangeLabel={rLabel} entryLabel={ENTRY_LABELS[entry]} entry={entry} />
                )}
              </>
            )}
          </section>
        )}

        {tab === "sessions" && (
          <SessionTable userFilterId={filterUserId} channelFilterId={filterChannelId} senderFilterId={filterSenderId} usernameHint={entry === "channel" ? null : selectedUsername} entry={entry} timeRange={timeRange} />
        )}

        {tab === "tools" && (
          <AuditTable userFilterId={filterUserId} channelFilterId={filterChannelId} senderFilterId={filterSenderId} usernameHint={entry === "channel" ? null : selectedUsername} entry={entry} timeRange={timeRange} />
        )}

        {tab === "grafana" && <GrafanaFrame />}
      </div>
    </div>
  )
}
