import { useState, useEffect } from "react"
import { Loader2, Save } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"

interface Agent {
  id: string
  name: string
  description: string
  group_name: string
  status: string
  model_provider: string
  model_id: string
  brain_type: string
  system_prompt: string
  is_production: boolean
  icon: string
  color: string
  created_at: string
}

interface AgentResources {
  clusters: { id: string; name: string }[]
  hosts: { total: number; sample: { id: string; name: string; ip: string }[] }
  skill_ids: string[]
  mcp_server_ids: string[]
  tools: string[]
  workflows: { id: string; name: string }[]
}

interface ModelEntry {
  id: string
  model_id: string
  name: string
}

interface Provider {
  id: string
  name: string
  models?: ModelEntry[]
}

interface AgentSettingsProps {
  agent: Agent
  onUpdate: (updated: Agent) => void
}

export function AgentSettings({ agent, onUpdate }: AgentSettingsProps) {
  const toast = useToast()

  // Editable fields
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description || "")
  const [groupName, setGroupName] = useState(agent.group_name || "")
  const [modelProvider, setModelProvider] = useState(agent.model_provider || "")
  const [modelId, setModelId] = useState(agent.model_id || "")
  const [brainType, setBrainType] = useState(agent.brain_type || "pi-agent")
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt || "")
  const [isProduction, setIsProduction] = useState(agent.is_production)

  // Providers for dropdowns
  const [providers, setProviders] = useState<Provider[]>([])

  // Resources
  const [resources, setResources] = useState<AgentResources | null>(null)
  const [loadingResources, setLoadingResources] = useState(true)

  const [saving, setSaving] = useState(false)

  // Sync form state when agent prop changes
  useEffect(() => {
    setName(agent.name)
    setDescription(agent.description || "")
    setGroupName(agent.group_name || "")
    setModelProvider(agent.model_provider || "")
    setModelId(agent.model_id || "")
    setBrainType(agent.brain_type || "pi-agent")
    setSystemPrompt(agent.system_prompt || "")
    setIsProduction(agent.is_production)
  }, [agent])

  // Load providers
  useEffect(() => {
    api<{ data: Provider[] }>("/siclaw/admin/models/providers")
      .then((r) => setProviders(Array.isArray(r.data) ? r.data : []))
      .catch(() => setProviders([]))
  }, [])

  // Load resources
  useEffect(() => {
    let cancelled = false
    async function fetchResources() {
      try {
        setLoadingResources(true)
        const data = await api<AgentResources>(`/agents/${agent.id}/resources`)
        if (!cancelled) setResources(data)
      } catch {
        if (!cancelled) setResources(null)
      } finally {
        if (!cancelled) setLoadingResources(false)
      }
    }
    fetchResources()
    return () => { cancelled = true }
  }, [agent.id])

  // Models for selected provider
  const selectedProvider = providers.find((p) => p.name === modelProvider)
  const availableModels = selectedProvider?.models || []

  const handleSave = async () => {
    if (!name.trim()) return
    try {
      setSaving(true)
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: "PUT",
        body: {
          name: name.trim(),
          description: description.trim(),
          group_name: groupName.trim(),
          model_provider: modelProvider.trim(),
          model_id: modelId.trim(),
          brain_type: brainType,
          system_prompt: systemPrompt.trim(),
          is_production: isProduction,
        },
      })
      onUpdate(updated)
      toast.success("Settings saved")
    } catch (err: any) {
      toast.error(err.message || "Failed to save changes")
    } finally {
      setSaving(false)
    }
  }

  const hasBindings =
    resources &&
    ((resources.clusters?.length || 0) > 0 ||
      (resources.hosts?.total || 0) > 0 ||
      (resources.skill_ids?.length || 0) > 0 ||
      (resources.mcp_server_ids?.length || 0) > 0 ||
      (resources.tools?.length || 0) > 0 ||
      (resources.workflows?.length || 0) > 0)

  return (
    <div className="flex-1 overflow-auto">
      {/* Header with save */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border sticky top-0 bg-background z-10">
        <h2 className="text-[14px] font-semibold">Agent Settings</h2>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-primary text-primary-foreground disabled:opacity-50 hover:opacity-90"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save Changes
        </button>
      </div>

      <div className="px-6 py-6 space-y-8">
        {/* Basic Information */}
        <section className="space-y-4">
          <h3 className="text-[14px] font-semibold border-b border-border pb-2">
            Basic Information
          </h3>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[12px] text-muted-foreground">Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-muted-foreground">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-muted-foreground">Group</label>
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <input
                type="checkbox"
                checked={isProduction}
                onChange={(e) => setIsProduction(e.target.checked)}
                className="rounded"
              />
              Production agent
              <span className="text-[11px] text-muted-foreground/70">
                (dev agents see draft skills and only dev clusters)
              </span>
            </label>
          </div>
        </section>

        {/* Model Configuration */}
        <section className="space-y-4">
          <h3 className="text-[14px] font-semibold border-b border-border pb-2">
            Model Configuration
          </h3>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[12px] text-muted-foreground">Model Provider</label>
                <select
                  value={modelProvider}
                  onChange={(e) => { setModelProvider(e.target.value); setModelId("") }}
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">Select Provider</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] text-muted-foreground">Model</label>
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  disabled={!modelProvider}
                  className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">Select Model</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.model_id}>{m.name || m.model_id}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-muted-foreground">Brain Type</label>
              <select
                value={brainType}
                onChange={(e) => setBrainType(e.target.value)}
                className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="pi-agent">pi-agent</option>
                <option value="claude-sdk">claude-sdk</option>
              </select>
            </div>
          </div>
        </section>

        {/* System Prompt */}
        <section className="space-y-4">
          <h3 className="text-[14px] font-semibold border-b border-border pb-2">
            System Prompt
          </h3>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={6}
            className="w-full px-3 py-2 text-[13px] font-mono rounded-md border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Optional system prompt..."
          />
        </section>

        {/* Resource Bindings */}
        <section className="space-y-4">
          <h3 className="text-[14px] font-semibold border-b border-border pb-2">
            Resource Bindings
          </h3>
          {loadingResources ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !hasBindings ? (
            <p className="text-[12px] text-muted-foreground py-2">No resource bindings configured.</p>
          ) : (
            <div className="space-y-3">
              {/* Clusters */}
              {resources!.clusters?.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Bound Clusters</label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.clusters.map((c) => (
                      <span key={c.id} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground">
                        {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Hosts */}
              {(resources!.hosts?.total || 0) > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">
                    Bound Hosts ({resources!.hosts.total})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.hosts.sample.map((h) => (
                      <span key={h.id} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground">
                        {h.name || h.ip}
                      </span>
                    ))}
                    {resources!.hosts.total > resources!.hosts.sample.length && (
                      <span className="inline-block px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground">
                        +{resources!.hosts.total - resources!.hosts.sample.length} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Skills */}
              {resources!.skill_ids?.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Bound Skills</label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.skill_ids.map((sid) => (
                      <span key={sid} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground font-mono">
                        {sid}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* MCP Servers */}
              {resources!.mcp_server_ids?.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Bound MCP Servers</label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.mcp_server_ids.map((mid) => (
                      <span key={mid} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground font-mono">
                        {mid}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Tools */}
              {resources!.tools?.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Bound Tools</label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.tools.map((tool) => (
                      <span key={tool} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Workflows */}
              {resources!.workflows?.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] text-muted-foreground">Bound Workflows</label>
                  <div className="flex flex-wrap gap-1.5">
                    {resources!.workflows.map((w) => (
                      <span key={w.id} className="inline-block px-2 py-0.5 text-[11px] rounded bg-secondary text-secondary-foreground">
                        {w.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

      </div>
    </div>
  )
}
