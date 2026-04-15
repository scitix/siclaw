import { useState, useEffect } from "react"
import { Loader2, Save, Trash2 } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { AgentTasks } from "./AgentTasks"
import { AgentApiKeys } from "./AgentApiKeys"

interface Agent {
  id: string; name: string; description: string; status: string
  model_provider: string; model_id: string; system_prompt: string
  is_production: boolean; icon: string; color: string; created_at: string
}

interface AgentResources {
  clusters: { id: string; name: string; api_server?: string }[]
  hosts: { id: string; name: string; ip: string; port?: number }[]
  skills: { id: string; name: string; description?: string }[]
  mcp_servers: { id: string; name: string; transport?: string }[]
  channels: { id: string; name: string; type: string }[]
}

interface AvailableCluster { id: string; name: string; api_server: string; is_production: boolean }
interface AvailableHost { id: string; name: string; ip: string; is_production: boolean }
interface ModelEntry { id: string; model_id: string; name: string }
interface Provider { id: string; name: string; models?: ModelEntry[] }

const TABS = [
  { key: "basic", label: "Basic" },
  { key: "model", label: "Model" },
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP" },
  { key: "resources", label: "Resources" },
  { key: "channels", label: "Channels" },
  { key: "tasks", label: "Tasks" },
  { key: "api-keys", label: "API Keys" },
] as const

type TabKey = (typeof TABS)[number]["key"]

interface AgentSettingsProps {
  agent: Agent
  onUpdate: (updated: Agent) => void
  initialTab?: string
}

export function AgentSettings({ agent, onUpdate, initialTab }: AgentSettingsProps) {
  const toast = useToast()
  const [activeTab, setActiveTab] = useState<TabKey>((initialTab as TabKey) || "basic")

  // ── Editable fields ──
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description || "")
  const [modelProvider, setModelProvider] = useState(agent.model_provider || "")
  const [modelId, setModelId] = useState(agent.model_id || "")
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt || "")
  const [isProduction, setIsProduction] = useState(agent.is_production)

  // ── Data ──
  const [providers, setProviders] = useState<Provider[]>([])
  const [resources, setResources] = useState<AgentResources | null>(null)
  const [loadingResources, setLoadingResources] = useState(true)
  const [allClusters, setAllClusters] = useState<AvailableCluster[]>([])
  const [allHosts, setAllHosts] = useState<AvailableHost[]>([])
  const [allSkills, setAllSkills] = useState<{ id: string; name: string; description: string; status: string; labels: string[] | null }[]>([])
  const [allMcpServers, setAllMcpServers] = useState<{ id: string; name: string; transport: string; enabled: number }[]>([])
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set())
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set())
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(new Set())
  const [skillLabelFilter, setSkillLabelFilter] = useState("")
  const [saving, setSaving] = useState(false)

  // Sync form state when agent prop changes
  useEffect(() => {
    setName(agent.name); setDescription(agent.description || "")
    setModelProvider(agent.model_provider || ""); setModelId(agent.model_id || "")
    setSystemPrompt(agent.system_prompt || ""); setIsProduction(agent.is_production)
  }, [agent])

  // Load data
  useEffect(() => {
    api<{ data: Provider[] }>("/siclaw/admin/models/providers").then(r => setProviders(Array.isArray(r.data) ? r.data : [])).catch(() => setProviders([]))
    api<{ data: AvailableCluster[] }>("/clusters").then(r => setAllClusters(Array.isArray(r.data) ? r.data : [])).catch(() => setAllClusters([]))
    api<{ data: AvailableHost[] }>("/hosts").then(r => setAllHosts(Array.isArray(r.data) ? r.data : [])).catch(() => setAllHosts([]))
    api<{ data: typeof allSkills }>("/siclaw/skills?page_size=500").then(r => setAllSkills(Array.isArray(r.data) ? r.data : [])).catch(() => setAllSkills([]))
    api<{ data: typeof allMcpServers }>("/siclaw/mcp").then(r => setAllMcpServers(Array.isArray(r.data) ? r.data : [])).catch(() => setAllMcpServers([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadingResources(true)
    api<AgentResources>(`/agents/${agent.id}/resources`)
      .then(data => { if (!cancelled) setResources(data) })
      .catch(() => { if (!cancelled) setResources(null) })
      .finally(() => { if (!cancelled) setLoadingResources(false) })
    return () => { cancelled = true }
  }, [agent.id])

  useEffect(() => {
    if (resources) {
      setSelectedClusterIds(new Set(resources.clusters?.map(c => c.id) || []))
      setSelectedHostIds(new Set(resources.hosts?.map(h => h.id) || []))
      setSelectedSkillIds(new Set(resources.skills?.map(s => s.id) || []))
      setSelectedMcpIds(new Set(resources.mcp_servers?.map(m => m.id) || []))
      setSelectedChannelIds(new Set(resources.channels?.map(c => c.id) || []))
    }
  }, [resources])

  const selectedProvider = providers.find(p => p.name === modelProvider)
  const availableModels = selectedProvider?.models || []

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: "PUT",
        body: { name: name.trim(), description: description.trim(), model_provider: modelProvider.trim(), model_id: modelId.trim(), system_prompt: systemPrompt.trim(), is_production: isProduction },
      })
      await api(`/agents/${agent.id}/resources`, {
        method: "PUT",
        body: { cluster_ids: Array.from(selectedClusterIds), host_ids: Array.from(selectedHostIds), skill_ids: Array.from(selectedSkillIds), mcp_server_ids: Array.from(selectedMcpIds), channel_ids: Array.from(selectedChannelIds) },
      })
      onUpdate(updated)
      toast.success("Saved — agent will reload automatically")
    } catch (err: any) {
      toast.error(err.message || "Failed to save")
    } finally { setSaving(false) }
  }

  // Tabs that need the Save button
  const saveTabs: TabKey[] = ["basic", "model", "skills", "mcp", "resources", "channels"]
  const showSave = saveTabs.includes(activeTab)

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar + Save */}
      <div className="flex items-center border-b border-border px-6 shrink-0">
        <div className="flex gap-0 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {showSave && (
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="ml-auto flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50 hover:opacity-90 shrink-0"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "basic" && <BasicTab name={name} setName={setName} description={description} setDescription={setDescription} systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} isProduction={isProduction} setIsProduction={setIsProduction} />}
        {activeTab === "model" && <ModelTab providers={providers} modelProvider={modelProvider} setModelProvider={setModelProvider} modelId={modelId} setModelId={setModelId} availableModels={availableModels} />}
        {activeTab === "skills" && <SkillsTab allSkills={allSkills} selectedSkillIds={selectedSkillIds} setSelectedSkillIds={setSelectedSkillIds} skillLabelFilter={skillLabelFilter} setSkillLabelFilter={setSkillLabelFilter} />}
        {activeTab === "mcp" && <McpTab allMcpServers={allMcpServers} selectedMcpIds={selectedMcpIds} setSelectedMcpIds={setSelectedMcpIds} />}
        {activeTab === "resources" && <ResourcesTab allClusters={allClusters} allHosts={allHosts} selectedClusterIds={selectedClusterIds} setSelectedClusterIds={setSelectedClusterIds} selectedHostIds={selectedHostIds} setSelectedHostIds={setSelectedHostIds} loading={loadingResources} />}
        {activeTab === "channels" && <ChannelsTab agentId={agent.id} selectedChannelIds={selectedChannelIds} setSelectedChannelIds={setSelectedChannelIds} />}
        {activeTab === "tasks" && <AgentTasks agentId={agent.id} />}
        {activeTab === "api-keys" && <AgentApiKeys agentId={agent.id} />}
      </div>
    </div>
  )
}

// ── Tab Components ──────────────────────────────────────

function BasicTab({ name, setName, description, setDescription, systemPrompt, setSystemPrompt, isProduction, setIsProduction }: {
  name: string; setName: (v: string) => void; description: string; setDescription: (v: string) => void
  systemPrompt: string; setSystemPrompt: (v: string) => void; isProduction: boolean; setIsProduction: (v: boolean) => void
}) {
  return (
    <div className="px-6 py-6 space-y-5 max-w-2xl">
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground">Name *</label>
        <input value={name} onChange={e => setName(e.target.value)} className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
      </div>
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground">Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring" />
      </div>
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground">System Prompt</label>
        <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={6} className="w-full px-3 py-2 text-[13px] font-mono rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Optional system prompt..." />
      </div>
      <div className="space-y-2 pt-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={isProduction}
            onClick={() => setIsProduction(!isProduction)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isProduction ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isProduction ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          <span className="text-[13px] font-medium text-foreground">
            {isProduction ? "Production" : "Development"}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          {isProduction
            ? "Production agent operates on production resources. Skills must pass review and approval before taking effect."
            : "Development agent operates on test environments only. Draft skills take effect immediately without approval — ideal for rapid skill development and validation."}
        </p>
      </div>
    </div>
  )
}

function ModelTab({ providers, modelProvider, setModelProvider, modelId, setModelId, availableModels }: {
  providers: Provider[]; modelProvider: string; setModelProvider: (v: string) => void
  modelId: string; setModelId: (v: string) => void; availableModels: ModelEntry[]
}) {
  return (
    <div className="px-6 py-6 space-y-5 max-w-2xl">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-[12px] text-muted-foreground">Provider</label>
          <select value={modelProvider} onChange={e => { setModelProvider(e.target.value); setModelId("") }} className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring">
            <option value="">Select Provider</option>
            {providers.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-[12px] text-muted-foreground">Model</label>
          <select value={modelId} onChange={e => setModelId(e.target.value)} disabled={!modelProvider} className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring">
            <option value="">Select Model</option>
            {availableModels.map(m => <option key={m.id} value={m.model_id}>{m.name || m.model_id}</option>)}
          </select>
        </div>
      </div>
    </div>
  )
}

function SkillsTab({ allSkills, selectedSkillIds, setSelectedSkillIds, skillLabelFilter, setSkillLabelFilter }: {
  allSkills: { id: string; name: string; status: string; labels: string[] | null }[]
  selectedSkillIds: Set<string>; setSelectedSkillIds: (v: Set<string>) => void
  skillLabelFilter: string; setSkillLabelFilter: (v: string) => void
}) {
  const allLabels = Array.from(new Set(allSkills.flatMap(s => Array.isArray(s.labels) ? s.labels : []))).sort()
  const filtered = allSkills.filter(s => {
    if (!skillLabelFilter) return true
    return (Array.isArray(s.labels) ? s.labels : []).includes(skillLabelFilter)
  })
  const filteredIds = new Set(filtered.map(s => s.id))
  const allSelected = filtered.length > 0 && filtered.every(s => selectedSkillIds.has(s.id))

  const toggleAll = () => {
    const next = new Set(selectedSkillIds)
    if (allSelected) { for (const id of filteredIds) next.delete(id) }
    else { for (const id of filteredIds) next.add(id) }
    setSelectedSkillIds(next)
  }

  return (
    <div className="px-6 py-6 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground font-medium">Bound Skills ({selectedSkillIds.size} / {allSkills.length})</span>
      </div>
      <div className="flex items-center gap-2">
        <select value={skillLabelFilter} onChange={e => setSkillLabelFilter(e.target.value)} className="flex-1 h-7 px-2 text-[12px] rounded border border-border bg-background">
          <option value="">All labels</option>
          {allLabels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button type="button" onClick={toggleAll} className="h-7 px-2 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground whitespace-nowrap">
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div className="max-h-[60vh] overflow-auto border border-border rounded-md">
        {filtered.map(s => (
          <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary/30 cursor-pointer text-[12px]">
            <input type="checkbox" checked={selectedSkillIds.has(s.id)} onChange={e => { const next = new Set(selectedSkillIds); e.target.checked ? next.add(s.id) : next.delete(s.id); setSelectedSkillIds(next) }} className="rounded" />
            <span className="font-mono flex-1">{s.name}</span>
            {Array.isArray(s.labels) && s.labels.map(l => <span key={l} className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">{l}</span>)}
            <span className={`px-1 py-0.5 rounded text-[9px] ${s.status === "installed" ? "bg-green-500/20 text-green-400" : s.status === "pending_review" ? "bg-blue-500/20 text-blue-400" : "bg-yellow-500/20 text-yellow-400"}`}>
              {s.status === "installed" ? "Installed" : s.status === "pending_review" ? "Pending" : "Draft"}
            </span>
          </label>
        ))}
        {filtered.length === 0 && <p className="px-2 py-3 text-[11px] text-muted-foreground text-center">{allSkills.length === 0 ? "No skills available" : "No skills match this label"}</p>}
      </div>
    </div>
  )
}

function McpTab({ allMcpServers, selectedMcpIds, setSelectedMcpIds }: {
  allMcpServers: { id: string; name: string; transport: string; enabled: number }[]
  selectedMcpIds: Set<string>; setSelectedMcpIds: (v: Set<string>) => void
}) {
  const allSelected = allMcpServers.length > 0 && allMcpServers.every(s => selectedMcpIds.has(s.id))
  return (
    <div className="px-6 py-6 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground font-medium">MCP Servers ({selectedMcpIds.size} / {allMcpServers.length})</span>
        {allMcpServers.length > 0 && (
          <button type="button" onClick={() => allSelected ? setSelectedMcpIds(new Set()) : setSelectedMcpIds(new Set(allMcpServers.map(s => s.id)))} className="h-7 px-2 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground">
            {allSelected ? "Deselect All" : "Select All"}
          </button>
        )}
      </div>
      {allMcpServers.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60">No MCP servers available.</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto border border-border rounded-md">
          {allMcpServers.map(s => (
            <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary/30 cursor-pointer text-[12px]">
              <input type="checkbox" checked={selectedMcpIds.has(s.id)} onChange={e => { const next = new Set(selectedMcpIds); e.target.checked ? next.add(s.id) : next.delete(s.id); setSelectedMcpIds(next) }} className="rounded" />
              <span className="font-mono flex-1">{s.name}</span>
              <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">{s.transport}</span>
              <span className={`h-2 w-2 rounded-full ${s.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`} />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function ResourcesTab({ allClusters, allHosts, selectedClusterIds, setSelectedClusterIds, selectedHostIds, setSelectedHostIds, loading }: {
  allClusters: AvailableCluster[]; allHosts: AvailableHost[]
  selectedClusterIds: Set<string>; setSelectedClusterIds: (v: Set<string>) => void
  selectedHostIds: Set<string>; setSelectedHostIds: (v: Set<string>) => void
  loading: boolean
}) {
  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <div className="px-6 py-6 space-y-5">
      {/* Clusters */}
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground font-medium">Clusters ({selectedClusterIds.size})</label>
        {allClusters.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No clusters available. Add clusters in Settings.</p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-auto border border-border rounded-md p-2">
            {allClusters.map(c => (
              <label key={c.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-secondary/30 cursor-pointer">
                <input type="checkbox" checked={selectedClusterIds.has(c.id)} onChange={e => { const next = new Set(selectedClusterIds); e.target.checked ? next.add(c.id) : next.delete(c.id); setSelectedClusterIds(next) }} />
                <span className="text-[12px] font-mono flex-1">{c.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>{c.is_production ? "PROD" : "DEV"}</span>
                {c.api_server && <span className="text-[10px] text-muted-foreground/50">{c.api_server}</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Hosts */}
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground font-medium">Hosts ({selectedHostIds.size})</label>
        {allHosts.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No hosts available. Add hosts in Settings.</p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-auto border border-border rounded-md p-2">
            {allHosts.map(h => (
              <label key={h.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-secondary/30 cursor-pointer">
                <input type="checkbox" checked={selectedHostIds.has(h.id)} onChange={e => { const next = new Set(selectedHostIds); e.target.checked ? next.add(h.id) : next.delete(h.id); setSelectedHostIds(next) }} />
                <span className="text-[12px] font-mono flex-1">{h.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${h.is_production ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>{h.is_production ? "PROD" : "DEV"}</span>
                {h.ip && <span className="text-[10px] text-muted-foreground/50">{h.ip}</span>}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ChannelsTab({ agentId, selectedChannelIds, setSelectedChannelIds }: {
  agentId: string; selectedChannelIds: Set<string>; setSelectedChannelIds: (v: Set<string>) => void
}) {
  const toast = useToast()
  const [bindings, setBindings] = useState<{ id: string; channel_id: string; channel_name: string; channel_type: string; route_key: string; route_type: string }[]>([])
  const [allChannels, setAllChannels] = useState<{ id: string; name: string; type: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [pairingChannel, setPairingChannel] = useState("")
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    Promise.all([
      api<{ data: typeof bindings }>(`/siclaw/agents/${agentId}/channel-bindings`),
      api<{ data: typeof allChannels }>("/channels"),
    ]).then(([b, c]) => {
      setBindings(Array.isArray(b.data) ? b.data : [])
      setAllChannels(Array.isArray(c.data) ? c.data : [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [agentId])

  const handlePair = async () => {
    if (!pairingChannel) return
    setGenerating(true)
    try {
      const res = await api<{ code: string; expires_at: string }>(`/siclaw/agents/${agentId}/channel-bindings/pair`, {
        method: "POST", body: { channel_id: pairingChannel },
      })
      setPairingCode(res.code)
    } catch (err: any) { toast.error(err.message) } finally { setGenerating(false) }
  }

  const handleUnbind = async (bindingId: string) => {
    try {
      await api(`/siclaw/agents/${agentId}/channel-bindings/${bindingId}`, { method: "DELETE" })
      setBindings(prev => prev.filter(b => b.id !== bindingId))
      toast.success("Binding removed")
    } catch (err: any) { toast.error(err.message) }
  }

  // Channels authorized for this agent (from selectedChannelIds managed by parent Save)
  const authorizedChannels = allChannels.filter(c => selectedChannelIds.has(c.id))

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <div className="px-6 py-6 space-y-6">
      {/* Section 1: Admin — authorize which channels this agent can use */}
      <div className="space-y-3">
        <h4 className="text-[12px] font-medium text-muted-foreground">Authorized Channels (admin)</h4>
        <p className="text-[11px] text-muted-foreground/70">Select which channels this agent can use. Users can only pair within authorized channels.</p>
        {allChannels.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No channels configured. Add channels in Settings → Channels.</p>
        ) : (
          <div className="max-h-48 overflow-auto border border-border rounded-md">
            {allChannels.map(c => (
              <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary/30 cursor-pointer text-[12px]">
                <input type="checkbox" checked={selectedChannelIds.has(c.id)} onChange={e => {
                  const next = new Set(selectedChannelIds)
                  e.target.checked ? next.add(c.id) : next.delete(c.id)
                  setSelectedChannelIds(next)
                }} className="rounded" />
                <span className="font-mono flex-1">{c.name}</span>
                <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground">{c.type}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Section 2: Pair a chat group (using authorized channels only) */}
      <div className="space-y-3 border-t border-border pt-5">
        <h4 className="text-[12px] font-medium text-muted-foreground">Pair a Chat Group</h4>
        <div className="flex items-center gap-2">
          <select value={pairingChannel} onChange={e => { setPairingChannel(e.target.value); setPairingCode(null) }} className="flex-1 h-8 px-3 text-[13px] rounded-md border border-border bg-background">
            <option value="">Select authorized channel...</option>
            {authorizedChannels.map(c => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
          </select>
          <button onClick={handlePair} disabled={!pairingChannel || generating} className="h-8 px-4 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50">
            {generating ? "..." : "Generate Code"}
          </button>
        </div>
        {pairingCode && (
          <div className="p-4 rounded-lg border border-border bg-secondary/30 space-y-2">
            <p className="text-[12px] text-muted-foreground">Send this message in the target chat group:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-md bg-background border border-border font-mono text-lg font-bold text-foreground text-center tracking-widest">
                PAIR {pairingCode}
              </code>
              <button onClick={() => { navigator.clipboard.writeText(`PAIR ${pairingCode}`); toast.success("Copied") }} className="h-9 px-3 text-[12px] rounded-md border border-border text-muted-foreground hover:text-foreground">Copy</button>
            </div>
            <p className="text-[10px] text-muted-foreground">Code expires in 5 minutes.</p>
          </div>
        )}
      </div>

      {/* Section 3: Active bindings */}
      <div className="space-y-3 border-t border-border pt-5">
        <h4 className="text-[12px] font-medium text-muted-foreground">My Bindings ({bindings.length})</h4>
        {bindings.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No bindings yet. Use pairing to connect chat groups.</p>
        ) : (
          <div className="space-y-1.5">
            {bindings.map(b => (
              <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-md border border-border/50">
                <div>
                  <p className="text-[12px] font-mono">{b.channel_name || b.channel_id}</p>
                  <p className="text-[10px] text-muted-foreground">{b.route_type}: {b.route_key}</p>
                </div>
                <button onClick={() => handleUnbind(b.id)} title="Unbind" className="p-1 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
