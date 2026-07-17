import { useState, useEffect } from "react"
import { ArrowDown, ArrowUp, Check, ChevronRight, Cpu, Loader2, Plus, Save, Trash2, Users } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { AgentTasks } from "./AgentTasks"
import { AgentApiKeys } from "./AgentApiKeys"
import { CapabilityGroupSelector } from "./CapabilityGroupSelector"
import { toCapabilitySet } from "../lib/toolCapabilities"
import { AGENT_TYPES, agentTypeOption, type AgentTypeKey } from "../lib/agentTypes"

interface Agent {
  id: string; name: string; description: string; status: string
  model_provider: string; model_id: string; system_prompt: string
  is_production: boolean; icon: string; color: string; created_at: string
  model_routing?: unknown
  idle_timeout_sec?: number
  agent_type?: string
  // Wire form: the raw `agents` TEXT column — a JSON string ('["read_files"]')
  // or null, not a decoded array (mirrors model_routing). toCapabilitySet
  // coerces both forms.
  tool_capabilities?: string | string[] | null
}

interface AgentResources {
  clusters: { id: string; name: string; api_server?: string }[]
  hosts: { id: string; name: string; ip: string; port?: number }[]
  skills: { id: string; name: string; description?: string }[]
  mcp_servers: { id: string; name: string; transport?: string }[]
  channels: { id: string; name: string; type: string }[]
  knowledge_repos: { id: string; name: string; description?: string }[]
  delegates?: { id: string; name: string; description?: string }[]
}

interface AvailableCluster { id: string; name: string; api_server: string; is_production: boolean }
interface AvailableHost { id: string; name: string; ip: string; is_production: boolean }
interface ModelEntry { id: string; model_id: string; name: string }
interface Provider { id: string; name: string; models?: ModelEntry[] }
interface ModelRouteCandidateForm { provider: string; modelId: string }
interface ModelRoutePolicy {
  enabled?: boolean
  strategy?: string
  candidates?: Array<{ provider?: unknown; modelId?: unknown; model_id?: unknown }>
  fallbackOn?: unknown
  noFallbackOn?: unknown
  cooldownMsByKind?: unknown
}

const ROUTE_COOLDOWN_LABEL = "by condition"

const TABS = [
  { key: "basic", label: "Basic" },
  { key: "model", label: "Model" },
  { key: "tools", label: "Tools" },
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP" },
  { key: "knowledge", label: "Knowledge" },
  { key: "resources", label: "Resources" },
  { key: "delegates", label: "Delegates" },
  { key: "channels", label: "Channels" },
  { key: "tasks", label: "Tasks" },
  { key: "api-keys", label: "API Keys" },
] as const

type TabKey = (typeof TABS)[number]["key"]

function parseModelRouting(raw: unknown): ModelRoutePolicy | null {
  if (!raw) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? parsed as ModelRoutePolicy : null
    } catch {
      return null
    }
  }
  return typeof raw === "object" ? raw as ModelRoutePolicy : null
}

function candidateKey(candidate: ModelRouteCandidateForm) {
  return `${encodeURIComponent(candidate.provider)}/${encodeURIComponent(candidate.modelId)}`
}

function normalizeRouteCandidates(policy: ModelRoutePolicy | null, primaryProvider: string, primaryModelId: string): ModelRouteCandidateForm[] {
  const seen = new Set<string>()
  const candidates: ModelRouteCandidateForm[] = []
  const primaryKey = candidateKey({ provider: primaryProvider.trim(), modelId: primaryModelId.trim() })

  for (const rawCandidate of policy?.candidates || []) {
    const provider = typeof rawCandidate.provider === "string" ? rawCandidate.provider.trim() : ""
    const rawModelId = rawCandidate.modelId ?? rawCandidate.model_id
    const modelId = typeof rawModelId === "string" ? rawModelId.trim() : ""
    if (!provider || !modelId) continue

    const key = candidateKey({ provider, modelId })
    if (key === primaryKey || seen.has(key)) continue
    seen.add(key)
    candidates.push({ provider, modelId })
  }

  return candidates
}

function validStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return normalized.length > 0 ? normalized : undefined
}

function validCooldownMsByKind(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function buildModelRoutingPayload(fallbackCandidates: ModelRouteCandidateForm[], primaryProvider: string, primaryModelId: string, existingPolicy: ModelRoutePolicy | null): ModelRoutePolicy | null {
  const seen = new Set<string>()
  const primaryKey = candidateKey({ provider: primaryProvider.trim(), modelId: primaryModelId.trim() })
  const candidates: ModelRouteCandidateForm[] = []

  for (const candidate of fallbackCandidates) {
    const normalized = { provider: candidate.provider.trim(), modelId: candidate.modelId.trim() }
    const key = candidateKey(normalized)
    if (!normalized.provider || !normalized.modelId || key === primaryKey || seen.has(key)) continue
    seen.add(key)
    candidates.push(normalized)
  }

  if (candidates.length === 0) return null
  const fallbackOn = validStringArray(existingPolicy?.fallbackOn)
  const noFallbackOn = validStringArray(existingPolicy?.noFallbackOn)
  const cooldownMsByKind = validCooldownMsByKind(existingPolicy?.cooldownMsByKind)
  return {
    enabled: true,
    strategy: "ordered_fallback",
    candidates,
    ...(fallbackOn ? { fallbackOn } : {}),
    ...(noFallbackOn ? { noFallbackOn } : {}),
    ...(cooldownMsByKind ? { cooldownMsByKind } : {}),
  }
}

function firstAvailableFallbackCandidate(providers: Provider[], primaryProvider: string, primaryModelId: string, fallbackCandidates: ModelRouteCandidateForm[]): ModelRouteCandidateForm {
  const used = new Set([
    candidateKey({ provider: primaryProvider, modelId: primaryModelId }),
    ...fallbackCandidates.map(candidateKey),
  ])

  for (const provider of providers) {
    for (const model of provider.models || []) {
      const candidate = { provider: provider.name, modelId: model.model_id }
      if (!used.has(candidateKey(candidate))) return candidate
    }
  }

  return { provider: "", modelId: "" }
}

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
  const [routingEnabled, setRoutingEnabled] = useState(false)
  const [fallbackCandidates, setFallbackCandidates] = useState<ModelRouteCandidateForm[]>([])
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt || "")
  const [isProduction, setIsProduction] = useState(agent.is_production)
  const [idleTimeoutSec, setIdleTimeoutSec] = useState<number>(agent.idle_timeout_sec ?? 300)
  const [selectedCapabilities, setSelectedCapabilities] = useState<Set<string>>(toCapabilitySet(agent.tool_capabilities))
  const [agentType, setAgentType] = useState<AgentTypeKey>(agentTypeOption(agent.agent_type).key)
  const typeDef = agentTypeOption(agentType)

  // ── Data ──
  const [providers, setProviders] = useState<Provider[]>([])
  const [resources, setResources] = useState<AgentResources | null>(null)
  const [loadingResources, setLoadingResources] = useState(true)
  const [allClusters, setAllClusters] = useState<AvailableCluster[]>([])
  const [allHosts, setAllHosts] = useState<AvailableHost[]>([])
  const [allSkills, setAllSkills] = useState<{ id: string; name: string; description: string; status: string; version: number; installed_version?: number | null; labels: string[] | null; is_builtin?: boolean }[]>([])
  const [allMcpServers, setAllMcpServers] = useState<{ id: string; name: string; transport: string; enabled: number }[]>([])
  const [allKnowledgeRepos, setAllKnowledgeRepos] = useState<{ id: string; name: string; description: string | null; active_version: number | null }[]>([])
  const [loadingKnowledge, setLoadingKnowledge] = useState(true)
  const [loadingSkills, setLoadingSkills] = useState(true)
  const [loadingMcp, setLoadingMcp] = useState(true)
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set())
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set())
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())
  const [selectedKnowledgeRepoIds, setSelectedKnowledgeRepoIds] = useState<Set<string>>(new Set())
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(new Set())
  const [selectedDelegateIds, setSelectedDelegateIds] = useState<Set<string>>(new Set())
  const [allAgents, setAllAgents] = useState<DelegatableAgent[]>([])
  const [skillLabelFilter, setSkillLabelFilter] = useState("")
  const [saving, setSaving] = useState(false)

  // Sync form state when agent prop changes
  useEffect(() => {
    setName(agent.name); setDescription(agent.description || "")
    setAgentType(agentTypeOption(agent.agent_type).key)
    setModelProvider(agent.model_provider || ""); setModelId(agent.model_id || "")
    const modelRouting = parseModelRouting(agent.model_routing)
    setRoutingEnabled(modelRouting?.enabled === true)
    setFallbackCandidates(normalizeRouteCandidates(modelRouting, agent.model_provider || "", agent.model_id || ""))
    setSystemPrompt(agent.system_prompt || ""); setIsProduction(agent.is_production)
    setIdleTimeoutSec(agent.idle_timeout_sec ?? 300)
    setSelectedCapabilities(toCapabilitySet(agent.tool_capabilities))
  }, [agent])

  // Load data
  useEffect(() => {
    api<{ data: Provider[] }>("/siclaw/admin/models/providers").then(r => setProviders(Array.isArray(r.data) ? r.data : [])).catch(() => setProviders([]))
    api<{ data: AvailableCluster[] }>("/clusters").then(r => setAllClusters(Array.isArray(r.data) ? r.data : [])).catch(() => setAllClusters([]))
    api<{ data: AvailableHost[] }>("/hosts").then(r => setAllHosts(Array.isArray(r.data) ? r.data : [])).catch(() => setAllHosts([]))
    api<{ data: typeof allSkills }>("/siclaw/skills?page_size=500").then(r => setAllSkills(Array.isArray(r.data) ? r.data : [])).catch(() => setAllSkills([])).finally(() => setLoadingSkills(false))
    api<{ data: typeof allMcpServers }>("/siclaw/mcp").then(r => setAllMcpServers(Array.isArray(r.data) ? r.data : [])).catch(() => setAllMcpServers([])).finally(() => setLoadingMcp(false))
    api<{ data: typeof allKnowledgeRepos }>("/siclaw/admin/knowledge/repos").then(r => setAllKnowledgeRepos(Array.isArray(r.data) ? r.data : [])).catch(() => setAllKnowledgeRepos([])).finally(() => setLoadingKnowledge(false))
    api<{ data: typeof allAgents }>("/agents?page_size=500").then(r => setAllAgents(Array.isArray(r.data) ? r.data : [])).catch(() => setAllAgents([]))
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
      setSelectedKnowledgeRepoIds(new Set(resources.knowledge_repos?.map((k: any) => k.id) || []))
      setSelectedDelegateIds(new Set(resources.delegates?.map(d => d.id) || []))
    }
  }, [resources])

  const selectedProvider = providers.find(p => p.name === modelProvider)
  const availableModels = selectedProvider?.models || []

  const handleSave = async () => {
    if (!name.trim()) return
    let modelRouting: ModelRoutePolicy | null = null
    if (routingEnabled) {
      if (!modelProvider.trim() || !modelId.trim()) {
        toast.error("Select a primary model before enabling fallback")
        return
      }
      modelRouting = buildModelRoutingPayload(fallbackCandidates, modelProvider, modelId, parseModelRouting(agent.model_routing))
      if (!modelRouting) {
        toast.error("Add at least one fallback model")
        return
      }
    }

    setSaving(true)
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: "PUT",
        body: { name: name.trim(), description: description.trim(), model_provider: modelProvider.trim(), model_id: modelId.trim(), model_routing: routingEnabled ? modelRouting : null, system_prompt: systemPrompt.trim(), is_production: isProduction, idle_timeout_sec: Number.isFinite(idleTimeoutSec) ? idleTimeoutSec : 300, tool_capabilities: Array.from(selectedCapabilities), agent_type: agentType },
      })
      await api(`/agents/${agent.id}/resources`, {
        method: "PUT",
        body: { cluster_ids: Array.from(selectedClusterIds), host_ids: Array.from(selectedHostIds), skill_ids: Array.from(selectedSkillIds), mcp_server_ids: Array.from(selectedMcpIds), channel_ids: Array.from(selectedChannelIds), knowledge_repo_ids: Array.from(selectedKnowledgeRepoIds), delegate_agent_ids: Array.from(selectedDelegateIds) },
      })
      onUpdate(updated)
      toast.success("Saved — agent will reload automatically")
    } catch (err: any) {
      toast.error(err.message || "Failed to save")
    } finally { setSaving(false) }
  }

  // Tabs that need the Save button
  const saveTabs: TabKey[] = ["basic", "model", "tools", "skills", "mcp", "knowledge", "resources", "delegates", "channels"]
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
        {activeTab === "basic" && <BasicTab name={name} setName={setName} description={description} setDescription={setDescription} systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt} isProduction={isProduction} setIsProduction={setIsProduction} idleTimeoutSec={idleTimeoutSec} setIdleTimeoutSec={setIdleTimeoutSec} promptLocked={typeDef.lockedPrompt} typeLabel={typeDef.label} />}
        {activeTab === "model" && <ModelTab providers={providers} modelProvider={modelProvider} setModelProvider={setModelProvider} modelId={modelId} setModelId={setModelId} availableModels={availableModels} routingEnabled={routingEnabled} setRoutingEnabled={setRoutingEnabled} fallbackCandidates={fallbackCandidates} setFallbackCandidates={setFallbackCandidates} />}
        {activeTab === "tools" && (
          <div className="px-6 py-6 space-y-4 max-w-2xl">
            {/* Agent type — governs the capability set (and, for built-in types, the persona). */}
            <div>
              <h3 className="text-[13px] font-medium text-foreground">Agent type</h3>
              <p className="text-[12px] text-muted-foreground mt-0.5">The type sets this agent's role. SRE / Coordinator lock the capabilities and the system prompt; Custom lets you choose both.</p>
              <div className="mt-2 space-y-1.5">
                {AGENT_TYPES.map(t => (
                  <label key={t.key} className="flex items-start gap-2 p-2 rounded-md border border-border hover:bg-secondary/30 cursor-pointer">
                    <input type="radio" name="agent-type" className="mt-0.5" checked={agentType === t.key} onChange={() => setAgentType(t.key)} />
                    <span className="flex-1 min-w-0">
                      <span className="text-[12px] font-medium text-foreground">{t.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-medium text-foreground">Tool capabilities</h3>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                {typeDef.capabilities
                  ? "Locked by the agent type — these capabilities are granted automatically."
                  : "Restrict which built-in tools this agent can use. Changes apply live — the running agent reloads on save."}
              </p>
            </div>
            {typeDef.capabilities ? (
              <div className="flex flex-wrap gap-1.5">
                {typeDef.capabilities.map(c => (
                  <span key={c} className="px-2 py-1 rounded-md text-[11px] font-mono bg-secondary text-muted-foreground border border-border">{c}</span>
                ))}
                {typeDef.defaultNoSkills && (
                  <p className="w-full text-[11px] text-muted-foreground/70 mt-1">No skills bound by default; attach only the routing helpers this coordinator needs (Skills tab).</p>
                )}
              </div>
            ) : (
              <CapabilityGroupSelector selected={selectedCapabilities} onChange={setSelectedCapabilities} />
            )}
          </div>
        )}
        {activeTab === "skills" && <SkillsTab allSkills={allSkills} selectedSkillIds={selectedSkillIds} setSelectedSkillIds={setSelectedSkillIds} skillLabelFilter={skillLabelFilter} setSkillLabelFilter={setSkillLabelFilter} isProduction={isProduction} loading={loadingSkills || loadingResources} />}
        {activeTab === "mcp" && <McpTab allMcpServers={allMcpServers} selectedMcpIds={selectedMcpIds} setSelectedMcpIds={setSelectedMcpIds} loading={loadingMcp || loadingResources} />}
        {activeTab === "knowledge" && <KnowledgeTab allRepos={allKnowledgeRepos} selectedIds={selectedKnowledgeRepoIds} setSelectedIds={setSelectedKnowledgeRepoIds} loading={loadingKnowledge || loadingResources} />}
        {activeTab === "resources" && <ResourcesTab allClusters={allClusters} allHosts={allHosts} selectedClusterIds={selectedClusterIds} setSelectedClusterIds={setSelectedClusterIds} selectedHostIds={selectedHostIds} setSelectedHostIds={setSelectedHostIds} loading={loadingResources} isProduction={isProduction} />}
        {activeTab === "delegates" && <DelegatesTab agentId={agent.id} allAgents={allAgents} selectedDelegateIds={selectedDelegateIds} setSelectedDelegateIds={setSelectedDelegateIds} loading={loadingResources} />}
        {activeTab === "channels" && <ChannelsTab agentId={agent.id} selectedChannelIds={selectedChannelIds} setSelectedChannelIds={setSelectedChannelIds} />}
        {activeTab === "tasks" && <AgentTasks agentId={agent.id} />}
        {activeTab === "api-keys" && <AgentApiKeys agentId={agent.id} />}
      </div>
    </div>
  )
}

// ── Tab Components ──────────────────────────────────────

interface DelegatableAgent {
  id: string; name: string; description?: string
  agent_type?: string; model_id?: string; model_provider?: string
  status?: string; is_production?: boolean
}

const TYPE_BADGE: Record<string, { label: string; className: string }> = {
  sre: { label: "SRE", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30" },
  coordinator: { label: "Coordinator", className: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30" },
  custom: { label: "Custom", className: "bg-muted text-muted-foreground border-border" },
}

function DelegatesTab({ agentId, allAgents, selectedDelegateIds, setSelectedDelegateIds, loading }: {
  agentId: string
  allAgents: DelegatableAgent[]
  selectedDelegateIds: Set<string>
  setSelectedDelegateIds: (s: Set<string>) => void
  loading: boolean
}) {
  const [query, setQuery] = useState("")
  const others = allAgents.filter(a => a.id !== agentId)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? others.filter(a => a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q))
    : others
  // Selected first, then by name — the roster reads as "who's on the team" at a glance.
  const sorted = [...filtered].sort((a, b) => {
    const sa = selectedDelegateIds.has(a.id) ? 0 : 1, sb = selectedDelegateIds.has(b.id) ? 0 : 1
    return sa !== sb ? sa - sb : a.name.localeCompare(b.name)
  })
  const toggle = (id: string) => {
    const next = new Set(selectedDelegateIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedDelegateIds(next)
  }
  return (
    <div className="px-6 py-6 space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Delegate roster</h3>
          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed max-w-xl">
            The specialist agents this one may hand a task to. Each delegate runs in its own environment under
            its own capabilities and reports back — this agent keeps oversight. Membership here is the
            authorization: only listed agents can be delegated to.
          </p>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 text-[12px] font-medium">
          {selectedDelegateIds.size} selected
        </span>
      </div>

      {others.length > 6 && (
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search agents…"
          className="w-full h-9 px-3 rounded-lg border border-border bg-background text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      )}

      {loading ? (
        <p className="text-[12px] text-muted-foreground/60">Loading…</p>
      ) : others.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center">
          <p className="text-[13px] text-muted-foreground">No other agents available to delegate to.</p>
          <p className="text-[12px] text-muted-foreground/60 mt-1">Create another agent, then add it here.</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {sorted.map(a => {
            const checked = selectedDelegateIds.has(a.id)
            const type = TYPE_BADGE[a.agent_type ?? "custom"] ?? TYPE_BADGE.custom
            const model = a.model_id || "No model"
            return (
              <button
                type="button"
                key={a.id}
                onClick={() => toggle(a.id)}
                className={`group flex items-center gap-3 w-full text-left rounded-xl border px-4 py-3 transition-all ${
                  checked
                    ? "border-primary/50 bg-primary/[0.06] shadow-sm"
                    : "border-border bg-card hover:border-border hover:bg-secondary/40"
                }`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                  checked ? "bg-primary border-primary text-primary-foreground" : "border-border bg-background group-hover:border-primary/40"
                }`}>
                  {checked && <Check className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] font-semibold text-foreground truncate">{a.name}</span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${type.className}`}>{type.label}</span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${a.is_production ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"}`}>
                      {a.is_production ? "PROD" : "DEV"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                    {a.description || <span className="italic text-muted-foreground/50">No description</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/70">
                    <Cpu className="h-3 w-3" /> {model}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Quick-pick windows for the idle self-destruct timer. Resident = 0 (the pod
// never auto-destroys). Values are seconds; the backend floors any positive
// value below 300 up to 300 (a shorter window churns instances).
const IDLE_TIMEOUT_PRESETS: { label: string; value: number }[] = [
  { label: "∞ Resident", value: 0 },
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 h", value: 3600 },
]

function IdleTimeoutField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-2">
      <label className="text-[13px] font-medium text-foreground">Idle Timeout</label>
      <div className="flex flex-wrap gap-2">
        {IDLE_TIMEOUT_PRESETS.map(p => {
          const active = value === p.value
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => onChange(p.value)}
              className={`h-9 px-3 text-[13px] rounded-md border transition-colors ${active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary/40"}`}
            >
              {p.label}
            </button>
          )
        })}
      </div>
      <div className="relative w-44">
        <input
          type="number"
          min={0}
          value={value}
          onChange={e => onChange(e.target.value === "" ? 0 : Math.max(0, Math.floor(Number(e.target.value))))}
          className="w-full h-10 pl-3 pr-12 text-[15px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground pointer-events-none">sec</span>
      </div>
      <p className="text-[12px] text-muted-foreground/80 leading-relaxed">
        The running instance self-destructs after this long with no active sessions (default 300s, minimum 300 — a smaller positive value is raised to 300, since a shorter window churns instances); choose Resident (0s) to keep it alive. Switching off Resident applies immediately — it restarts the running instance, which may interrupt an in-progress reply; other changes take effect on the agent's next restart.
      </p>
    </div>
  )
}

function BasicTab({ name, setName, description, setDescription, systemPrompt, setSystemPrompt, isProduction, setIsProduction, idleTimeoutSec, setIdleTimeoutSec, promptLocked, typeLabel }: {
  name: string; setName: (v: string) => void; description: string; setDescription: (v: string) => void
  systemPrompt: string; setSystemPrompt: (v: string) => void; isProduction: boolean; setIsProduction: (v: boolean) => void
  idleTimeoutSec: number; setIdleTimeoutSec: (v: number) => void
  promptLocked: boolean; typeLabel: string
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
        {promptLocked ? (
          <p className="text-[12px] text-muted-foreground/70 rounded-md border border-border bg-secondary/30 px-3 py-2">
            Defined by the <span className="font-medium text-foreground">{typeLabel}</span> type — this agent's system prompt is built in and not editable. Switch to a Custom agent to write your own.
          </p>
        ) : (
          <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={6} className="w-full px-3 py-2 text-[13px] font-mono rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring" placeholder="Optional system prompt..." />
        )}
      </div>
      <IdleTimeoutField value={idleTimeoutSec} onChange={setIdleTimeoutSec} />
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

function ModelTab({ providers, modelProvider, setModelProvider, modelId, setModelId, availableModels, routingEnabled, setRoutingEnabled, fallbackCandidates, setFallbackCandidates }: {
  providers: Provider[]; modelProvider: string; setModelProvider: (v: string) => void
  modelId: string; setModelId: (v: string) => void; availableModels: ModelEntry[]
  routingEnabled: boolean; setRoutingEnabled: (v: boolean) => void
  fallbackCandidates: ModelRouteCandidateForm[]; setFallbackCandidates: (v: ModelRouteCandidateForm[]) => void
}) {
  const modelsForProvider = (providerName: string) => providers.find(p => p.name === providerName)?.models || []
  const addFallbackCandidate = () => {
    setFallbackCandidates([...fallbackCandidates, firstAvailableFallbackCandidate(providers, modelProvider, modelId, fallbackCandidates)])
  }
  const updateFallbackCandidate = (index: number, candidate: ModelRouteCandidateForm) => {
    setFallbackCandidates(fallbackCandidates.map((item, itemIndex) => itemIndex === index ? candidate : item))
  }
  const moveFallbackCandidate = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= fallbackCandidates.length) return
    const next = [...fallbackCandidates]
    const [candidate] = next.splice(index, 1)
    next.splice(nextIndex, 0, candidate)
    setFallbackCandidates(next)
  }
  const removeFallbackCandidate = (index: number) => {
    setFallbackCandidates(fallbackCandidates.filter((_, itemIndex) => itemIndex !== index))
  }
  const toggleRouting = () => {
    const nextEnabled = !routingEnabled
    setRoutingEnabled(nextEnabled)
    if (nextEnabled && fallbackCandidates.length === 0) {
      setFallbackCandidates([firstAvailableFallbackCandidate(providers, modelProvider, modelId, fallbackCandidates)])
    }
  }

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
      <div className="border-t border-border pt-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 className="text-[12px] font-medium text-muted-foreground">Fallback Routing</h4>
            <p className="text-[11px] text-muted-foreground/70">Conditions: default · Cooldown: {ROUTE_COOLDOWN_LABEL}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={routingEnabled}
            onClick={toggleRouting}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${routingEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${routingEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        {routingEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-muted-foreground">Fallback order</label>
              <button
                type="button"
                onClick={addFallbackCandidate}
                title="Add fallback model"
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {fallbackCandidates.map((candidate, index) => {
                const candidateModels = modelsForProvider(candidate.provider)
                return (
                  <div key={`${index}-${candidate.provider}-${candidate.modelId}`} className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_112px] gap-2 items-center">
                    <span className="h-8 w-7 inline-flex items-center justify-center rounded-md bg-secondary/60 text-[11px] text-muted-foreground">
                      {index + 1}
                    </span>
                    <select
                      value={candidate.provider}
                      onChange={e => {
                        const provider = e.target.value
                        const modelId = modelsForProvider(provider)[0]?.model_id || ""
                        updateFallbackCandidate(index, { provider, modelId })
                      }}
                      className="w-full h-8 px-2 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">Provider</option>
                      {providers.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                    </select>
                    <select
                      value={candidate.modelId}
                      onChange={e => updateFallbackCandidate(index, { ...candidate, modelId: e.target.value })}
                      disabled={!candidate.provider}
                      className="w-full h-8 px-2 text-[12px] rounded-md border border-border bg-background disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">Model</option>
                      {candidateModels.map(m => <option key={m.id} value={m.model_id}>{m.name || m.model_id}</option>)}
                    </select>
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" onClick={() => moveFallbackCandidate(index, -1)} disabled={index === 0} title="Move up" className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => moveFallbackCandidate(index, 1)} disabled={index === fallbackCandidates.length - 1} title="Move down" className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => removeFallbackCandidate(index)} title="Remove" className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-red-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            {fallbackCandidates.length === 0 && (
              <p className="text-[11px] text-muted-foreground/70">No fallback models selected.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SkillsTab({ allSkills, selectedSkillIds, setSelectedSkillIds, skillLabelFilter, setSkillLabelFilter, isProduction, loading }: {
  allSkills: { id: string; name: string; status: string; version: number; installed_version?: number | null; labels: string[] | null; is_builtin?: boolean }[]
  selectedSkillIds: Set<string>; setSelectedSkillIds: (v: Set<string>) => void
  skillLabelFilter: string; setSkillLabelFilter: (v: string) => void
  isProduction: boolean
  loading: boolean
}) {
  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  // Production agents: only show skills with an approved version
  // Dev agents: show all skills
  const visibleSkills = isProduction
    ? allSkills.filter(s => s.installed_version != null && s.installed_version > 0)
    : allSkills
  const allLabels = Array.from(new Set(visibleSkills.flatMap(s => Array.isArray(s.labels) ? s.labels : []))).sort()
  const filtered = visibleSkills.filter(s => {
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
        <span className="text-[12px] text-muted-foreground font-medium">Bound Skills ({selectedSkillIds.size} / {visibleSkills.length}){isProduction && visibleSkills.length < allSkills.length ? ` · ${allSkills.length - visibleSkills.length} draft-only hidden` : ""}</span>
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
            {isProduction ? (
              <span className="px-1 py-0.5 rounded text-[9px] bg-green-500/20 text-green-400">v{s.installed_version}</span>
            ) : (
              <>
                {s.installed_version != null && s.installed_version > 0 && (
                  <span className="px-1 py-0.5 rounded text-[9px] bg-green-500/20 text-green-400">v{s.installed_version}</span>
                )}
                {s.version !== (s.installed_version ?? 0) && (
                  <span className={`px-1 py-0.5 rounded text-[9px] ${s.status === "pending_review" ? "bg-blue-500/20 text-blue-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                    draft v{s.version}
                  </span>
                )}
              </>
            )}
          </label>
        ))}
        {filtered.length === 0 && <p className="px-2 py-3 text-[11px] text-muted-foreground text-center">{visibleSkills.length === 0 ? (isProduction ? "No approved skills available for production agents" : "No skills available") : "No skills match this label"}</p>}
      </div>
    </div>
  )
}

function McpTab({ allMcpServers, selectedMcpIds, setSelectedMcpIds, loading }: {
  allMcpServers: { id: string; name: string; transport: string; enabled: number }[]
  selectedMcpIds: Set<string>; setSelectedMcpIds: (v: Set<string>) => void
  loading: boolean
}) {
  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
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

function KnowledgeTab({ allRepos, selectedIds, setSelectedIds, loading }: {
  allRepos: { id: string; name: string; description: string | null; active_version: number | null }[]
  selectedIds: Set<string>; setSelectedIds: (v: Set<string>) => void
  loading: boolean
}) {
  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  const allSelected = allRepos.length > 0 && allRepos.every(r => selectedIds.has(r.id))
  const toggleAll = () => {
    if (allSelected) { setSelectedIds(new Set()) }
    else { setSelectedIds(new Set(allRepos.map(r => r.id))) }
  }

  return (
    <div className="px-6 py-6 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground font-medium">Bound Knowledge ({selectedIds.size} / {allRepos.length})</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 h-7 px-2 text-[12px] rounded border border-border bg-background flex items-center text-muted-foreground">
          {allRepos.length} repo{allRepos.length !== 1 ? "s" : ""} available
        </span>
        <button type="button" onClick={toggleAll} className="h-7 px-2 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground whitespace-nowrap">
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div className="max-h-[60vh] overflow-auto border border-border rounded-md">
        {allRepos.map(repo => (
          <label key={repo.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary/30 cursor-pointer text-[12px]">
            <input type="checkbox" checked={selectedIds.has(repo.id)} onChange={e => {
              const next = new Set(selectedIds)
              e.target.checked ? next.add(repo.id) : next.delete(repo.id)
              setSelectedIds(next)
            }} className="rounded" />
            <span className="font-mono flex-1">{repo.name}</span>
            {repo.description && <span className="px-1 py-0.5 rounded text-[9px] bg-secondary text-muted-foreground truncate max-w-[200px]">{repo.description}</span>}
            <span className={`px-1 py-0.5 rounded text-[9px] ${repo.active_version != null ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>
              {repo.active_version != null ? `v${repo.active_version}` : "No version"}
            </span>
          </label>
        ))}
        {allRepos.length === 0 && <p className="px-2 py-3 text-[11px] text-muted-foreground text-center">No knowledge repos available. Create one in Settings → Knowledge.</p>}
      </div>
    </div>
  )
}

function ResourcesTab({ allClusters, allHosts, selectedClusterIds, setSelectedClusterIds, selectedHostIds, setSelectedHostIds, loading, isProduction }: {
  allClusters: AvailableCluster[]; allHosts: AvailableHost[]
  selectedClusterIds: Set<string>; setSelectedClusterIds: (v: Set<string>) => void
  selectedHostIds: Set<string>; setSelectedHostIds: (v: Set<string>) => void
  loading: boolean; isProduction: boolean
}) {
  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  // Cross-env bindings are rejected server-side (credential-list filters by
  // agent.is_production = resource.is_production). Hide mismatched resources
  // so admins can't prepare a binding that will be silently ignored.
  const visibleClusters = allClusters.filter(c => c.is_production === isProduction)
  const visibleHosts = allHosts.filter(h => h.is_production === isProduction)
  const envLabel = isProduction ? "production" : "development"

  return (
    <div className="px-6 py-6 space-y-5">
      {/* Clusters */}
      <div className="space-y-1.5">
        <label className="text-[12px] text-muted-foreground font-medium">Clusters ({selectedClusterIds.size})</label>
        {visibleClusters.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No {envLabel} clusters available. Add matching clusters in Settings.</p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-auto border border-border rounded-md p-2">
            {visibleClusters.map(c => (
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
        {visibleHosts.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No {envLabel} hosts available. Add matching hosts in Settings.</p>
        ) : (
          <div className="space-y-1 max-h-[200px] overflow-auto border border-border rounded-md p-2">
            {visibleHosts.map(h => (
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

interface PersonalBotInfo {
  id: string
  agent_id: string
  name?: string | null
  domain: "feishu" | "lark"
  app_id: string
  access_mode: string
  group_auto_bind: boolean
  status: string
}

function ChannelsTab({ agentId, selectedChannelIds, setSelectedChannelIds }: {
  agentId: string; selectedChannelIds: Set<string>; setSelectedChannelIds: (v: Set<string>) => void
}) {
  const toast = useToast()
  const [bindings, setBindings] = useState<{ id: string; channel_id: string; channel_name: string; channel_type: string; route_key: string; route_type: string; display_name?: string | null; context_mode?: string | null }[]>([])
  const [allChannels, setAllChannels] = useState<{ id: string; name: string; type: string; is_personal_bot?: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [pairingChannel, setPairingChannel] = useState("")
  const [generating, setGenerating] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  // The agent's dedicated Feishu bot (channels row with config.personal_bot).
  // Collapsed to a summary line once active; only admins can edit.
  const [bot, setBot] = useState<PersonalBotInfo | null>(null)
  const [botExpanded, setBotExpanded] = useState(false)
  const [botForm, setBotForm] = useState({ domain: "feishu", app_id: "", app_secret: "", group_auto_bind: true })
  const [savingBot, setSavingBot] = useState(false)

  const applyBot = (b: PersonalBotInfo | null) => {
    setBot(b)
    setBotForm({
      domain: b?.domain ?? "feishu",
      app_id: b?.app_id ?? "",
      app_secret: "",
      group_auto_bind: b ? b.group_auto_bind : true,
    })
    setBotExpanded(!(b && b.status === "active"))
  }

  useEffect(() => {
    Promise.all([
      api<{ data: typeof bindings }>(`/siclaw/agents/${agentId}/channel-bindings`).catch(() => ({ data: [] })),
      // Admin-only endpoint — non-admins just see the advanced section empty.
      api<{ data: typeof allChannels }>("/channels").catch(() => ({ data: [] })),
      api<{ role: string }>("/auth/me").catch(() => ({ role: "" })),
      api<{ data: PersonalBotInfo | null }>(`/siclaw/agents/${agentId}/personal-bot`).catch(() => ({ data: null })),
    ]).then(([b, c, me, pb]) => {
      setBindings(Array.isArray(b.data) ? b.data : [])
      // Dedicated per-agent bots are managed right here, not via the shared list.
      setAllChannels((Array.isArray(c.data) ? c.data : []).filter(ch => !ch.is_personal_bot))
      setIsAdmin(me.role === "admin")
      applyBot(pb.data ?? null)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [agentId])

  const refetchBot = async () => {
    try {
      const pb = await api<{ data: PersonalBotInfo | null }>(`/siclaw/agents/${agentId}/personal-bot`)
      applyBot(pb.data ?? null)
    } catch { /* keep current view */ }
  }

  const handleSaveBot = async () => {
    setSavingBot(true)
    try {
      await api(`/siclaw/agents/${agentId}/personal-bot`, {
        method: "PUT",
        body: {
          domain: botForm.domain,
          app_id: botForm.app_id,
          app_secret: botForm.app_secret,
          group_auto_bind: botForm.group_auto_bind,
        },
      })
      toast.success("Bot saved and enabled")
      await refetchBot()
    } catch (err: any) { toast.error(err.message) } finally { setSavingBot(false) }
  }

  const handleDisableBot = async () => {
    setSavingBot(true)
    try {
      await api(`/siclaw/agents/${agentId}/personal-bot`, { method: "DELETE" })
      toast.success("Bot disabled")
      await refetchBot()
    } catch (err: any) { toast.error(err.message) } finally { setSavingBot(false) }
  }

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

  const handleSetContextMode = async (bindingId: string, mode: "shared" | "per_user") => {
    try {
      await api(`/siclaw/agents/${agentId}/channel-bindings/${bindingId}/context-mode`, {
        method: "PUT", body: { mode },
      })
      setBindings(prev => prev.map(b => (b.id === bindingId ? { ...b, context_mode: mode } : b)))
      toast.success(mode === "shared" ? "Switched to Team (shared) mode" : "Switched to Personal (per-user) mode")
    } catch (err: any) { toast.error(err.message) }
  }

  // Channels authorized for this agent (from selectedChannelIds managed by parent Save)
  const authorizedChannels = allChannels.filter(c => selectedChannelIds.has(c.id))

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  const botActive = bot?.status === "active"

  return (
    <div className="px-6 py-6 space-y-6">
      {/* ── 1. This agent's Feishu bot (dedicated app; admin-managed) ── */}
      <div className="rounded-lg border border-border bg-card">
        <button
          type="button"
          onClick={() => setBotExpanded(v => !v)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-secondary/20"
        >
          <div className="flex min-w-0 items-center gap-2">
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${botExpanded ? "rotate-90" : ""}`} />
            <div className="min-w-0">
              <h4 className="text-[13px] font-medium text-foreground">{bot?.name || "This agent's Feishu bot"}</h4>
              {botExpanded || !bot ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground/70">A dedicated Feishu app — serves direct messages and every group it joins. Open access; admin-configured.</p>
              ) : (
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium">open</span>
                  <span className="font-mono">{bot.app_id}</span>
                </p>
              )}
            </div>
          </div>
          {botActive && (
            <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">Active</span>
          )}
        </button>

        {botExpanded && (
          <div className="space-y-3 border-t border-border px-4 py-4">
            {isAdmin ? (<>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">Region</label>
                  <select value={botForm.domain} onChange={e => setBotForm(p => ({ ...p, domain: e.target.value }))} className="w-full h-8 px-2 text-[13px] rounded-md border border-border bg-background">
                    <option value="feishu">Feishu (China)</option>
                    <option value="lark">Lark (Global)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">App ID</label>
                  <input value={botForm.app_id} onChange={e => setBotForm(p => ({ ...p, app_id: e.target.value }))} placeholder="cli_xxx" className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">App Secret</label>
                  <input type="password" value={botForm.app_secret} onChange={e => setBotForm(p => ({ ...p, app_secret: e.target.value }))} placeholder={bot ? "(unchanged)" : "app_secret"} className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-[12px] cursor-pointer">
                <input type="checkbox" checked={botForm.group_auto_bind} onChange={e => setBotForm(p => ({ ...p, group_auto_bind: e.target.checked }))} className="rounded" />
                <span>Auto-serve groups — just add the bot to a group and it works, no pairing. When off, it serves direct messages only.</span>
              </label>
              <div className="flex items-center gap-2">
                <button onClick={handleSaveBot} disabled={savingBot || !botForm.app_id} className="h-8 px-4 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                  {savingBot ? "..." : botActive ? "Save" : "Save and enable"}
                </button>
                {botActive && (
                  <button onClick={handleDisableBot} disabled={savingBot} className="h-8 px-4 text-[12px] rounded-md border border-border text-muted-foreground hover:text-foreground">
                    Disable
                  </button>
                )}
              </div>
            </>) : (
              <p className="text-[11px] text-muted-foreground/70">
                {bot ? `Bot ${bot.app_id} is ${bot.status}. ` : "No dedicated bot configured. "}
                Configuring the bot requires an admin.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── 2. Active groups ── */}
      <div className="space-y-3">
        <h4 className="text-[12px] font-medium text-muted-foreground">Active groups ({bindings.length})</h4>
        {bindings.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            {botActive
              ? "No groups yet. Add the bot to a group and @-mention it once to auto-connect."
              : "No groups yet. Enable the agent's bot above, or pair via the advanced shared-app flow below."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {bindings.map(b => (
              <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-md border border-border/50">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[12px]">{b.display_name || <span className="font-mono">{b.route_key}</span>}</p>
                    <p className="truncate text-[10px] text-muted-foreground font-mono">{b.channel_name || b.channel_id} · {b.route_type}: {b.route_key}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {b.route_type === "group" && (
                    <select
                      value={b.context_mode === "shared" ? "shared" : "per_user"}
                      onChange={e => handleSetContextMode(b.id, e.target.value as "shared" | "per_user")}
                      title="Context mode: Team shares one conversation; Personal gives each member their own"
                      className="rounded-md border border-border/50 bg-secondary/30 px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-secondary/50 focus:outline-none"
                    >
                      <option value="shared">Team (shared)</option>
                      <option value="per_user">Personal (per-user)</option>
                    </select>
                  )}
                  <button onClick={() => handleUnbind(b.id)} title="Unbind" className="p-1 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 3. Advanced: shared app & manual pairing (legacy flow) ──
          Several agents sharing one org-level app, connected per group via a
          PAIR code. Irrelevant once the agent has its own bot — hidden then. */}
      {!botActive && (
      <details className="group rounded-lg border border-border">
        <summary className="cursor-pointer list-none px-4 py-2.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary/20">
          <span className="select-none">▸ Advanced: shared app & manual pairing</span>
        </summary>
        <div className="space-y-5 border-t border-border px-4 py-4">
      {/* Admin — authorize which shared channels this agent can use */}
      <div className="space-y-3">
        <h4 className="text-[12px] font-medium text-muted-foreground">Authorized Channels (admin)</h4>
        <p className="text-[11px] text-muted-foreground/70">Select which shared channels this agent can use. Users can only pair within authorized channels.</p>
        {allChannels.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No shared channels configured. Admins can add them in Settings → Channels.</p>
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

      {/* Pair a chat group (using authorized channels only) */}
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
        </div>
      </details>
      )}
    </div>
  )
}
