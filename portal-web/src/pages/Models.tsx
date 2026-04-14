import { useState, useEffect } from "react"
import { Plus, Trash2, Loader2, ChevronDown, ChevronRight, Settings } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface ModelEntry {
  id: string
  provider_id: string
  model_id: string
  name: string
  reasoning: boolean
  context_window: number
  max_tokens: number
  is_default: boolean
}

export interface Provider {
  id: string
  name: string
  base_url: string
  api_key?: string
  api_type: string
  models?: ModelEntry[]
}

export function Models() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const toast = useToast()
  const confirmDialog = useConfirm()

  // Create provider
  const [showCreateProvider, setShowCreateProvider] = useState(false)
  const [providerForm, setProviderForm] = useState({ name: "", base_url: "", api_key: "", api_type: "openai-completions" })
  const [creating, setCreating] = useState(false)

  // Edit provider
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: "", base_url: "", api_key: "", api_type: "openai-completions" })
  const [saving, setSaving] = useState(false)

  // Add model
  const [showAddModel, setShowAddModel] = useState<string | null>(null)
  const [modelForm, setModelForm] = useState({ model_id: "", name: "", context_window: "128000", max_tokens: "65536", reasoning: false, is_default: false })
  const [addingModel, setAddingModel] = useState(false)

  // Edit model
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [editModelForm, setEditModelForm] = useState({ model_id: "", name: "", context_window: "", max_tokens: "", reasoning: false, is_default: false })
  const [savingModel, setSavingModel] = useState(false)

  const fetchProviders = async () => {
    try {
      const res = await api<{ data: Provider[] }>("/siclaw/admin/models/providers")
      setProviders(Array.isArray(res.data) ? res.data : [])
    } catch {
      setProviders([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchProviders() }, [])

  const handleCreateProvider = async () => {
    setCreating(true)
    try {
      await api("/siclaw/admin/models/providers", { method: "POST", body: providerForm })
      setShowCreateProvider(false)
      setProviderForm({ name: "", base_url: "", api_key: "", api_type: "openai-completions" })
      await fetchProviders()
      toast.success("Provider created")
    } catch (err: any) { toast.error(err.message) } finally { setCreating(false) }
  }

  const startEdit = (provider: Provider) => {
    setEditingId(provider.id)
    setEditForm({
      name: provider.name,
      base_url: provider.base_url,
      api_key: provider.api_key || "",
      api_type: provider.api_type,
    })
    setExpandedId(provider.id)
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      await api(`/siclaw/admin/models/providers/${editingId}`, { method: "PUT", body: editForm })
      setEditingId(null)
      await fetchProviders()
      toast.success("Provider updated")
    } catch (err: any) { toast.error(err.message) } finally { setSaving(false) }
  }

  const handleDeleteProvider = async (id: string) => {
    if (!(await confirmDialog({ title: "Delete Provider", message: "Delete this provider and all its models? This cannot be undone.", destructive: true, confirmLabel: "Delete" }))) return
    try {
      await api(`/siclaw/admin/models/providers/${id}`, { method: "DELETE" })
      setProviders((prev) => prev.filter((p) => p.id !== id))
      if (editingId === id) setEditingId(null)
    } catch (err: any) { toast.error(err.message) }
  }

  const handleAddModel = async (providerId: string) => {
    setAddingModel(true)
    try {
      await api(`/siclaw/admin/models/providers/${providerId}/models`, {
        method: "POST",
        body: { ...modelForm, context_window: parseInt(modelForm.context_window), max_tokens: parseInt(modelForm.max_tokens) },
      })
      setShowAddModel(null)
      setModelForm({ model_id: "", name: "", context_window: "128000", max_tokens: "65536", reasoning: false, is_default: false })
      await fetchProviders()
      toast.success("Model added")
    } catch (err: any) { toast.error(err.message) } finally { setAddingModel(false) }
  }

  const handleDeleteModel = async (providerId: string, modelId: string) => {
    await api(`/siclaw/admin/models/providers/${providerId}/models/${modelId}`, { method: "DELETE" })
    await fetchProviders()
  }

  const startEditModel = (model: ModelEntry) => {
    setEditingModelId(model.id)
    setEditModelForm({
      model_id: model.model_id,
      name: model.name || "",
      context_window: String(model.context_window),
      max_tokens: String(model.max_tokens),
      reasoning: !!model.reasoning,
      is_default: !!model.is_default,
    })
  }

  const handleSaveModel = async (providerId: string) => {
    if (!editingModelId) return
    setSavingModel(true)
    try {
      await api(`/siclaw/admin/models/providers/${providerId}/models/${editingModelId}`, {
        method: "PUT",
        body: {
          model_id: editModelForm.model_id,
          name: editModelForm.name,
          context_window: parseInt(editModelForm.context_window),
          max_tokens: parseInt(editModelForm.max_tokens),
          reasoning: editModelForm.reasoning,
          is_default: editModelForm.is_default,
        },
      })
      setEditingModelId(null)
      await fetchProviders()
      toast.success("Model updated")
    } catch (err: any) { toast.error(err.message) } finally { setSavingModel(false) }
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Model Providers</h1>
          <p className="text-sm text-muted-foreground">Configure LLM providers and models for your agents</p>
        </div>
        <button onClick={() => setShowCreateProvider(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add Provider
        </button>
      </div>

      {/* Create provider form */}
      {showCreateProvider && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <p className="text-sm font-medium">New Provider</p>
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Provider Name *" value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <select value={providerForm.api_type} onChange={(e) => setProviderForm({ ...providerForm, api_type: e.target.value })} className="h-8 px-3 text-sm rounded-md border border-border bg-background">
              <option value="openai-completions">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <input placeholder="Base URL * (e.g. https://api.openai.com/v1)" value={providerForm.base_url} onChange={(e) => setProviderForm({ ...providerForm, base_url: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
          <input type="password" placeholder="API Key" value={providerForm.api_key} onChange={(e) => setProviderForm({ ...providerForm, api_key: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          <div className="flex gap-2">
            <button onClick={handleCreateProvider} disabled={creating || !providerForm.name || !providerForm.base_url} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "..." : "Create"}</button>
            <button onClick={() => setShowCreateProvider(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground">Cancel</button>
          </div>
        </div>
      )}

      {/* Provider list */}
      <div className="flex-1 overflow-auto">
        {providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Settings className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No model providers configured</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Add a provider to enable AI conversations</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-3">
            {providers.map((provider) => (
              <div key={provider.id} className="rounded-lg border border-border/50">
                {/* Provider header */}
                <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-secondary/30" onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}>
                  <div className="flex items-center gap-2">
                    {expandedId === provider.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    <div>
                      <p className="text-sm font-medium">{provider.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{provider.base_url} · {provider.api_type}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{provider.models?.length || 0} models</span>
                    <button onClick={(e) => { e.stopPropagation(); startEdit(provider) }} title="Edit provider" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><Settings className="h-3.5 w-3.5" /></button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteProvider(provider.id) }} title="Delete provider" className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {/* Expanded content */}
                {expandedId === provider.id && (
                  <div className="border-t border-border/50 p-3 bg-secondary/10">
                    {/* Edit form */}
                    {editingId === provider.id && (
                      <div className="p-3 mb-3 rounded-md border border-border bg-card space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Edit Provider</p>
                        <div className="grid grid-cols-2 gap-2">
                          <input placeholder="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                          <select value={editForm.api_type} onChange={(e) => setEditForm({ ...editForm, api_type: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background">
                            <option value="openai-completions">OpenAI Compatible</option>
                            <option value="anthropic">Anthropic</option>
                          </select>
                        </div>
                        <input placeholder="Base URL" value={editForm.base_url} onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
                        <input type="password" placeholder="API Key (leave empty to keep current)" value={editForm.api_key} onChange={(e) => setEditForm({ ...editForm, api_key: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" />
                        <div className="flex gap-2">
                          <button onClick={handleSaveEdit} disabled={saving || !editForm.name || !editForm.base_url} className="h-7 px-3 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "..." : "Save"}</button>
                          <button onClick={() => setEditingId(null)} className="h-7 px-3 text-xs rounded-md border border-border text-muted-foreground">Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Models list */}
                    {provider.models && provider.models.length > 0 && (
                      <div className="space-y-1.5 mb-3">
                        {provider.models.map((model) => (
                          <div key={model.id}>
                            <div className="flex items-center justify-between px-3 py-2 rounded-md bg-card border border-border/30">
                              <div>
                                <p className="text-sm font-mono">{model.model_id}</p>
                                <p className="text-xs text-muted-foreground">
                                  {model.name || model.model_id}{model.reasoning ? " · reasoning" : ""} · {(model.context_window / 1000).toFixed(0)}K
                                  {model.is_default && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-primary/20 text-primary">default</span>}
                                </p>
                              </div>
                              <div className="flex items-center gap-1">
                                <button onClick={() => startEditModel(model)} title="Edit model" className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><Settings className="h-3.5 w-3.5" /></button>
                                <button onClick={() => handleDeleteModel(provider.id, model.id)} title="Delete model" className="p-1 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                              </div>
                            </div>
                            {editingModelId === model.id && (
                              <div className="ml-4 mt-1.5 mb-1.5 p-3 rounded-md border border-border bg-card space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <input placeholder="Model ID *" value={editModelForm.model_id} onChange={(e) => setEditModelForm({ ...editModelForm, model_id: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
                                  <input placeholder="Display Name" value={editModelForm.name} onChange={(e) => setEditModelForm({ ...editModelForm, name: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                                  <input placeholder="Context Window" value={editModelForm.context_window} onChange={(e) => setEditModelForm({ ...editModelForm, context_window: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                                  <input placeholder="Max Tokens" value={editModelForm.max_tokens} onChange={(e) => setEditModelForm({ ...editModelForm, max_tokens: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                                </div>
                                <div className="flex items-center gap-4">
                                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={editModelForm.reasoning} onChange={(e) => setEditModelForm({ ...editModelForm, reasoning: e.target.checked })} /> Reasoning</label>
                                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={editModelForm.is_default} onChange={(e) => setEditModelForm({ ...editModelForm, is_default: e.target.checked })} /> Default</label>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => handleSaveModel(provider.id)} disabled={savingModel || !editModelForm.model_id} className="h-7 px-3 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50">{savingModel ? "..." : "Save"}</button>
                                  <button onClick={() => setEditingModelId(null)} className="h-7 px-3 text-xs rounded-md border border-border text-muted-foreground">Cancel</button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add model form */}
                    {showAddModel === provider.id ? (
                      <div className="p-3 rounded-md border border-border bg-card space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <input placeholder="Model ID *" value={modelForm.model_id} onChange={(e) => setModelForm({ ...modelForm, model_id: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
                          <input placeholder="Display Name" value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                          <input placeholder="Context Window" value={modelForm.context_window} onChange={(e) => setModelForm({ ...modelForm, context_window: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                          <input placeholder="Max Tokens" value={modelForm.max_tokens} onChange={(e) => setModelForm({ ...modelForm, max_tokens: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                        </div>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={modelForm.reasoning} onChange={(e) => setModelForm({ ...modelForm, reasoning: e.target.checked })} /> Reasoning</label>
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={modelForm.is_default} onChange={(e) => setModelForm({ ...modelForm, is_default: e.target.checked })} /> Default</label>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => handleAddModel(provider.id)} disabled={addingModel || !modelForm.model_id} className="h-7 px-3 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50">{addingModel ? "..." : "Add"}</button>
                          <button onClick={() => setShowAddModel(null)} className="h-7 px-3 text-xs rounded-md border border-border text-muted-foreground">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setShowAddModel(provider.id)} className="flex items-center gap-1 h-7 px-3 text-xs rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30">
                        <Plus className="h-3 w-3" /> Add Model
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
