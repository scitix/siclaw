import { useState, useEffect, useRef } from "react"
import { Plus, Trash2, Loader2, ChevronDown, ChevronRight, Settings, Download, X } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface ModelEntry {
  id: string
  provider_id: string
  model_id: string
  name: string
  reasoning: boolean
  vision: boolean
  context_window: number
  max_tokens: number
  /**
   * Per-model protocol override. Optional AND nullable: the row arrives via
   * `SELECT *` and is NULL for every model predating this column, which is what
   * "inherit the provider's api_type" is stored as.
   */
  api_type?: string | null
  is_default: boolean
}

/** A model advertised by the provider's own /models endpoint (import dialog). */
export interface ListedModel {
  id: string
  name?: string
  /** Server-inferred protocol; "" = inherit the provider. Operator can change it. */
  suggested_api_type: string
  /** Row looks like a Claude model on an OpenAI-protocol provider — flagged, not decided. */
  protocol_hint?: "claude"
  context_window?: number
  max_tokens?: number
  vision?: boolean
  reasoning?: boolean
  already_exists: boolean
}

export interface Provider {
  id: string
  name: string
  base_url: string
  api_key?: string
  api_type: string
  models?: ModelEntry[]
}

// Legacy api_type values stored before the options became pi's canonical api
// ids ("anthropic" is a pi provider slug, not an api). Mirrors the server-side
// normalizeProviderApi (src/core/model-compat.ts), which keeps old rows working
// at read time; this map only affects what the edit form shows and re-saves.
const LEGACY_API_TYPES: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
}

export function normalizeApiType(apiType: string): string {
  return LEGACY_API_TYPES[apiType] ?? apiType
}

/**
 * Label for a model's protocol override in the summary line — empty string when
 * the model inherits, so the common row renders unchanged and only the
 * exception draws the eye.
 *
 * Note this deliberately does NOT default to "openai-completions" the way the
 * server's normalizeProviderApi does: on the frontend an absent value means
 * "inherit", and picking the fallback is the server's job.
 */
export function modelApiLabel(apiType: string | null | undefined): string {
  const raw = (apiType ?? "").trim()
  return raw ? normalizeApiType(raw) : ""
}

/** Defaults the batch endpoint applies when the listing carried no value. */
const IMPORT_DEFAULT_CONTEXT_WINDOW = 128000
const IMPORT_DEFAULT_MAX_TOKENS = 65536

/**
 * What a listed model will actually be imported as. The OpenAI listing spec
 * carries none of these fields, so most rows fall back — and `context_window`
 * is load-bearing (too low and turns get rejected in preflight, siclaw-side),
 * so the dialog says plainly which numbers are real and which are guesses.
 */
export function describeListedModel(m: ListedModel): string {
  const ctx = m.context_window
    ? `${Math.round(m.context_window / 1000)}K ctx`
    : `${Math.round(IMPORT_DEFAULT_CONTEXT_WINDOW / 1000)}K ctx (default)`
  const out = m.max_tokens
    ? `${Math.round(m.max_tokens / 1000)}K out`
    : `${Math.round(IMPORT_DEFAULT_MAX_TOKENS / 1000)}K out (default)`
  const parts = [ctx, out]
  if (m.vision) parts.push("vision")
  if (m.reasoning) parts.push("reasoning")
  return parts.join(" · ")
}

/** Per-row state in the import dialog: ticked, plus the (editable) protocol. */
export interface FetchSelection { checked: boolean; api_type: string }

/**
 * Rows the operator may actually import — models the provider already has are
 * shown for context but can never be selected.
 */
export function importableModels(models: ListedModel[]): ListedModel[] {
  return models.filter((m) => !m.already_exists)
}

/**
 * Body for the batch-import request. Takes the protocol from the row's current
 * selection, NOT from `suggested_api_type`: the inference is only a pre-fill,
 * and an operator correction must win.
 */
export function buildImportPayload(
  models: ListedModel[],
  selection: Record<string, FetchSelection>,
) {
  return importableModels(models)
    .filter((m) => selection[m.id]?.checked)
    .map((m) => ({
      model_id: m.id,
      name: m.name || m.id,
      api_type: selection[m.id]?.api_type || "",
      context_window: m.context_window,
      max_tokens: m.max_tokens,
      vision: m.vision,
      reasoning: m.reasoning,
    }))
}

/**
 * Apply one protocol to every hinted row at once. A gateway serving its whole
 * Claude family over the Claude protocol otherwise means repeating the same
 * dropdown edit N times — and the listing cannot infer it (no field in the
 * OpenAI /models spec carries protocol), so the operator has to say it once.
 */
export function applyProtocolToHinted(
  models: ListedModel[],
  selection: Record<string, FetchSelection>,
  apiType: string,
): Record<string, FetchSelection> {
  const next = { ...selection }
  for (const m of models) {
    if (m.already_exists || m.protocol_hint !== "claude") continue
    next[m.id] = { checked: next[m.id]?.checked ?? false, api_type: apiType }
  }
  return next
}

/**
 * Select-all / clear-all. Already-added rows stay unticked either way, and each
 * row keeps whatever protocol the operator had chosen.
 */
export function toggleSelectAll(
  models: ListedModel[],
  selection: Record<string, FetchSelection>,
  selectAll: boolean,
): Record<string, FetchSelection> {
  return Object.fromEntries(models.map((m) => [
    m.id,
    { checked: selectAll && !m.already_exists, api_type: selection[m.id]?.api_type ?? "" },
  ]))
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
  const [modelForm, setModelForm] = useState({ model_id: "", name: "", context_window: "128000", max_tokens: "65536", api_type: "", reasoning: false, vision: false, is_default: false })
  const [addingModel, setAddingModel] = useState(false)

  // Fetch models from the provider's own /models endpoint
  const [fetchDialogProvider, setFetchDialogProvider] = useState<Provider | null>(null)
  const [fetchLoading, setFetchLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetchedModels, setFetchedModels] = useState<ListedModel[]>([])
  // Per-row selection state, keyed by model id. Holds the (editable) protocol
  // alongside the checkbox so the operator can correct a bad inference before
  // importing.
  const [fetchSelection, setFetchSelection] = useState<Record<string, { checked: boolean; api_type: string }>>({})
  const [importing, setImporting] = useState(false)
  // Monotonic token identifying the newest listing request; see openFetchDialog.
  const fetchRequestRef = useRef(0)

  // Edit model
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [editModelForm, setEditModelForm] = useState({ model_id: "", name: "", context_window: "", max_tokens: "", api_type: "", reasoning: false, vision: false, is_default: false })
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
      // Rows created before the api_type options became pi's canonical api ids
      // carry legacy values; map them so the select shows (and re-saves) the
      // canonical id instead of silently snapping to the first option.
      api_type: normalizeApiType(provider.api_type),
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
      setModelForm({ model_id: "", name: "", context_window: "128000", max_tokens: "65536", api_type: "", reasoning: false, vision: false, is_default: false })
      await fetchProviders()
      toast.success("Model added")
    } catch (err: any) { toast.error(err.message) } finally { setAddingModel(false) }
  }

  const openFetchDialog = async (provider: Provider) => {
    // Every response is checked against this token before it touches state. A
    // listing can take the endpoint's full 15s timeout, and the operator is free
    // to close the dialog and open another provider's meanwhile — without the
    // guard the slow response repopulates the dialog under the NEW provider's
    // header, and Import then writes the stale provider's models into it.
    const requestId = ++fetchRequestRef.current
    const isStale = () => fetchRequestRef.current !== requestId

    setFetchDialogProvider(provider)
    setFetchLoading(true)
    setFetchError(null)
    setFetchedModels([])
    setFetchSelection({})
    try {
      // The endpoint answers 200 with ok:false for a reachable-but-unhappy
      // provider (bad key, non-JSON body, Azure-style incompatible path), so
      // the failure text lands in the dialog rather than as a thrown error.
      const res = await api<{ ok: boolean; message?: string; models?: ListedModel[] }>(
        `/siclaw/admin/models/providers/${provider.id}/fetch-models`,
        { method: "POST", body: {} },
      )
      if (isStale()) return
      if (!res.ok) { setFetchError(res.message || "Could not list models") ; return }
      const models = res.models || []
      setFetchedModels(models)
      setFetchSelection(Object.fromEntries(
        models.map((m) => [m.id, { checked: false, api_type: m.suggested_api_type || "" }]),
      ))
      if (models.length === 0) setFetchError("Provider returned no models")
    } catch (err: any) {
      if (isStale()) return
      setFetchError(err.message)
    } finally {
      if (!isStale()) setFetchLoading(false)
    }
  }

  const closeFetchDialog = () => {
    // Invalidate any in-flight listing so it can't land on the next dialog.
    fetchRequestRef.current++
    setFetchDialogProvider(null)
    setFetchLoading(false)
  }

  const importable = importableModels(fetchedModels)
  const selectedIds = importable.filter((m) => fetchSelection[m.id]?.checked).map((m) => m.id)

  const handleImportModels = async () => {
    if (!fetchDialogProvider || selectedIds.length === 0) return
    setImporting(true)
    try {
      const payload = buildImportPayload(fetchedModels, fetchSelection)
      const res = await api<{ imported: number; skipped: number }>(
        `/siclaw/admin/models/providers/${fetchDialogProvider.id}/models/batch`,
        { method: "POST", body: { models: payload } },
      )
      closeFetchDialog()
      await fetchProviders()
      toast.success(`Imported ${res.imported} model${res.imported === 1 ? "" : "s"}${res.skipped ? `, skipped ${res.skipped}` : ""}`)
    } catch (err: any) { toast.error(err.message) } finally { setImporting(false) }
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
      api_type: model.api_type ? normalizeApiType(model.api_type) : "",
      reasoning: !!model.reasoning,
      vision: !!model.vision,
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
          api_type: editModelForm.api_type,
          reasoning: editModelForm.reasoning,
          vision: editModelForm.vision,
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
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-4">
          <p className="text-sm font-medium">New Provider</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Provider Name</label>
              <input autoComplete="off" placeholder="e.g. openai" value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Default API Type <span className="font-normal text-muted-foreground">— individual models can override this</span></label>
              <select value={providerForm.api_type} onChange={(e) => setProviderForm({ ...providerForm, api_type: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background">
                <option value="openai-completions">OpenAI Compatible</option>
                <option value="anthropic-messages">Anthropic</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Base URL</label>
            <input autoComplete="off" placeholder="e.g. https://api.openai.com/v1" value={providerForm.base_url} onChange={(e) => setProviderForm({ ...providerForm, base_url: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background font-mono" />
            <p className="text-xs text-muted-foreground mt-1">The API endpoint URL. Must support OpenAI-compatible or Anthropic chat completions.</p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">API Key</label>
            <input type="password" autoComplete="new-password" placeholder="Bearer token for authentication" value={providerForm.api_key} onChange={(e) => setProviderForm({ ...providerForm, api_key: e.target.value })} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
          </div>
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
                          <input autoComplete="off" placeholder="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background" />
                          <select value={editForm.api_type} onChange={(e) => setEditForm({ ...editForm, api_type: e.target.value })} className="h-7 px-2 text-xs rounded-md border border-border bg-background">
                            <option value="openai-completions">OpenAI Compatible</option>
                            <option value="anthropic-messages">Anthropic</option>
                          </select>
                        </div>
                        <input autoComplete="off" placeholder="Base URL" value={editForm.base_url} onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" />
                        <input type="password" autoComplete="new-password" placeholder="API Key (leave empty to keep current)" value={editForm.api_key} onChange={(e) => setEditForm({ ...editForm, api_key: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" />
                        <div className="flex gap-2">
                          <button onClick={handleSaveEdit} disabled={saving || !editForm.name || !editForm.base_url} className="h-7 px-3 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "..." : "Save"}</button>
                          <button onClick={() => setEditingId(null)} className="h-7 px-3 text-xs rounded-md border border-border text-muted-foreground">Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Always visible — opening the Add Model form must not hide
                        the other way to add models. */}
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Models</span>
                      <button onClick={() => openFetchDialog(provider)} title={`List the models ${provider.base_url}/models advertises`} className="flex items-center gap-1 h-7 px-2.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary">
                        <Download className="h-3 w-3" /> Fetch from provider
                      </button>
                    </div>

                    {/* Models list */}
                    {provider.models && provider.models.length > 0 && (
                      <div className="space-y-1.5 mb-3">
                        {provider.models.map((model) => (
                          <div key={model.id}>
                            <div className="flex items-center justify-between px-3 py-2 rounded-md bg-card border border-border/30">
                              <div>
                                <p className="text-sm font-mono">{model.model_id}</p>
                                <p className="text-xs text-muted-foreground">
                                  {model.name || model.model_id}{model.reasoning ? " · reasoning" : ""}{model.vision ? " · vision" : ""} · {(model.context_window / 1000).toFixed(0)}K
                                  {!!modelApiLabel(model.api_type) && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-500 font-mono">{modelApiLabel(model.api_type)}</span>}
                                  {!!model.is_default && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-primary/20 text-primary">default</span>}
                                </p>
                              </div>
                              <div className="flex items-center gap-1">
                                <button onClick={() => startEditModel(model)} title="Edit model" className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"><Settings className="h-3.5 w-3.5" /></button>
                                <button onClick={() => handleDeleteModel(provider.id, model.id)} title="Delete model" className="p-1 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                              </div>
                            </div>
                            {editingModelId === model.id && (
                              <div className="ml-4 mt-1.5 mb-1.5 p-3 rounded-md border border-primary/40 bg-card space-y-2">
                                <p className="text-[11px] font-medium text-muted-foreground">Editing <span className="font-mono text-foreground">{model.model_id}</span></p>
                                <div className="grid grid-cols-2 gap-2">
                                  <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Model ID</label><input value={editModelForm.model_id} onChange={(e) => setEditModelForm({ ...editModelForm, model_id: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" /></div>
                                  <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Display Name</label><input value={editModelForm.name} onChange={(e) => setEditModelForm({ ...editModelForm, name: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                                  <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Context Window</label><input value={editModelForm.context_window} onChange={(e) => setEditModelForm({ ...editModelForm, context_window: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                                  <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Max Output Tokens</label><input value={editModelForm.max_tokens} onChange={(e) => setEditModelForm({ ...editModelForm, max_tokens: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                                  <div className="col-span-2"><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">API Type <span className="font-normal opacity-70">— overrides the provider protocol for this model only</span></label><select value={editModelForm.api_type} onChange={(e) => setEditModelForm({ ...editModelForm, api_type: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background"><option value="">Inherit from provider</option><option value="openai-completions">OpenAI Compatible</option><option value="anthropic-messages">Anthropic</option></select></div>
                                </div>
                                <div className="flex items-center gap-5">
                                  <div className="flex items-center gap-2">
                                    <button type="button" role="switch" aria-checked={editModelForm.reasoning} onClick={() => setEditModelForm({ ...editModelForm, reasoning: !editModelForm.reasoning })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${editModelForm.reasoning ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${editModelForm.reasoning ? "translate-x-3" : "translate-x-0"}`} /></button>
                                    <span className="text-xs text-muted-foreground">Reasoning model</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button type="button" role="switch" aria-checked={editModelForm.vision} onClick={() => setEditModelForm({ ...editModelForm, vision: !editModelForm.vision })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${editModelForm.vision ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${editModelForm.vision ? "translate-x-3" : "translate-x-0"}`} /></button>
                                    <span className="text-xs text-muted-foreground">Vision model</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button type="button" role="switch" aria-checked={editModelForm.is_default} onClick={() => setEditModelForm({ ...editModelForm, is_default: !editModelForm.is_default })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${editModelForm.is_default ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${editModelForm.is_default ? "translate-x-3" : "translate-x-0"}`} /></button>
                                    <span className="text-xs text-muted-foreground">Default model</span>
                                  </div>
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
                      <div className="p-3 rounded-md border border-dashed border-border bg-card space-y-2">
                        <p className="text-[11px] font-medium text-muted-foreground">New model</p>
                        <div className="grid grid-cols-2 gap-2">
                          <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Model ID</label><input placeholder="e.g. gpt-4o" value={modelForm.model_id} onChange={(e) => setModelForm({ ...modelForm, model_id: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background font-mono" /></div>
                          <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Display Name</label><input placeholder="e.g. GPT-4o" value={modelForm.name} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                          <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Context Window</label><input value={modelForm.context_window} onChange={(e) => setModelForm({ ...modelForm, context_window: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                          <div><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">Max Output Tokens</label><input value={modelForm.max_tokens} onChange={(e) => setModelForm({ ...modelForm, max_tokens: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background" /></div>
                          <div className="col-span-2"><label className="block text-[11px] font-medium text-muted-foreground mb-0.5">API Type <span className="font-normal opacity-70">— overrides the provider protocol for this model only</span></label><select value={modelForm.api_type} onChange={(e) => setModelForm({ ...modelForm, api_type: e.target.value })} className="w-full h-7 px-2 text-xs rounded-md border border-border bg-background"><option value="">Inherit from provider</option><option value="openai-completions">OpenAI Compatible</option><option value="anthropic-messages">Anthropic</option></select></div>
                        </div>
                        <div className="flex items-center gap-5">
                          <div className="flex items-center gap-2">
                            <button type="button" role="switch" aria-checked={modelForm.reasoning} onClick={() => setModelForm({ ...modelForm, reasoning: !modelForm.reasoning })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${modelForm.reasoning ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${modelForm.reasoning ? "translate-x-3" : "translate-x-0"}`} /></button>
                            <span className="text-xs text-muted-foreground">Reasoning model</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" role="switch" aria-checked={modelForm.vision} onClick={() => setModelForm({ ...modelForm, vision: !modelForm.vision })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${modelForm.vision ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${modelForm.vision ? "translate-x-3" : "translate-x-0"}`} /></button>
                            <span className="text-xs text-muted-foreground">Vision model</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" role="switch" aria-checked={modelForm.is_default} onClick={() => setModelForm({ ...modelForm, is_default: !modelForm.is_default })} className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${modelForm.is_default ? "bg-primary" : "bg-muted"}`}><span className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${modelForm.is_default ? "translate-x-3" : "translate-x-0"}`} /></button>
                            <span className="text-xs text-muted-foreground">Default model</span>
                          </div>
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

      {/* Fetch-models dialog */}
      {fetchDialogProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !importing && closeFetchDialog()}>
          <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between px-4 py-3 border-b border-border">
              <div>
                <h2 className="text-sm font-semibold">Fetch models — {fetchDialogProvider.name}</h2>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{fetchDialogProvider.base_url}/models</p>
              </div>
              <button onClick={closeFetchDialog} disabled={importing} className="p-1 rounded-md hover:bg-secondary text-muted-foreground disabled:opacity-50"><X className="h-4 w-4" /></button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3">
              {fetchLoading ? (
                <div className="flex items-center justify-center py-10 gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Listing models…
                </div>
              ) : fetchError ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-red-400">{fetchError}</p>
                  <p className="text-xs text-muted-foreground mt-2">The provider may not expose a /models endpoint. You can still add models manually.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {fetchedModels.map((m) => {
                    const sel = fetchSelection[m.id]
                    return (
                      <label key={m.id} className={`flex items-center gap-3 px-2 py-1.5 rounded-md ${m.already_exists ? "opacity-40" : "hover:bg-secondary/40 cursor-pointer"}`}>
                        <input
                          type="checkbox"
                          disabled={m.already_exists}
                          checked={!!sel?.checked}
                          onChange={(e) => setFetchSelection({ ...fetchSelection, [m.id]: { ...sel, checked: e.target.checked, api_type: sel?.api_type ?? "" } })}
                          className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-mono truncate">{m.id}</span>
                          <span className="block text-[10px] text-muted-foreground">{describeListedModel(m)}</span>
                          {m.protocol_hint === "claude" && !m.already_exists && (
                            <span className="block text-[10px] text-amber-500/90">Claude-named — pick Anthropic if this gateway serves it over the Claude protocol</span>
                          )}
                        </span>
                        {m.already_exists ? (
                          <span className="text-[10px] text-muted-foreground shrink-0">already added</span>
                        ) : (
                          <select
                            value={sel?.api_type ?? ""}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setFetchSelection({ ...fetchSelection, [m.id]: { checked: sel?.checked ?? false, api_type: e.target.value } })}
                            className="h-6 px-1.5 text-[11px] rounded border border-border bg-background shrink-0"
                          >
                            <option value="">Inherit</option>
                            <option value="openai-completions">OpenAI Compatible</option>
                            <option value="anthropic-messages">Anthropic</option>
                          </select>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <div className="flex items-center gap-3">
              {fetchedModels.some((m) => m.protocol_hint === "claude" && !m.already_exists) && (
                <button
                  onClick={() => setFetchSelection(applyProtocolToHinted(fetchedModels, fetchSelection, "anthropic-messages"))}
                  className="text-xs text-amber-600 hover:text-amber-500"
                  title="Set every Claude-named row to the Anthropic protocol"
                >
                  Set all Claude rows → Anthropic
                </button>
              )}
              <button
                onClick={() => {
                  const allSelected = selectedIds.length === importable.length && importable.length > 0
                  setFetchSelection(toggleSelectAll(fetchedModels, fetchSelection, !allSelected))
                }}
                disabled={importable.length === 0}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                {selectedIds.length === importable.length && importable.length > 0 ? "Clear selection" : "Select all"}
              </button>
              </div>
              <div className="flex gap-2">
                <button onClick={closeFetchDialog} disabled={importing} className="h-7 px-3 text-xs rounded-md border border-border text-muted-foreground disabled:opacity-50">Cancel</button>
                <button onClick={handleImportModels} disabled={importing || selectedIds.length === 0} className="h-7 px-3 text-xs rounded-md bg-primary text-primary-foreground disabled:opacity-50">
                  {importing ? "Importing…" : `Import ${selectedIds.length} model${selectedIds.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
