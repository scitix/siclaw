import { useState, useEffect } from "react"
import { Plus, Trash2, Loader2, Settings, Radio } from "lucide-react"
import { api } from "../api"
import { useToast } from "../components/toast"
import { useConfirm } from "../components/confirm-dialog"

interface Channel {
  id: string; name: string; type: string; config: Record<string, unknown>; status: string; created_at: string
}

const CHANNEL_TYPES = [
  { value: "lark", label: "Lark / Feishu" },
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
]

// Per-type config field definitions
interface ConfigField {
  key: string; label: string; type: "text" | "password" | "select"; placeholder?: string; required?: boolean
  options?: { value: string; label: string }[]
}

const CONFIG_FIELDS: Record<string, ConfigField[]> = {
  lark: [
    { key: "domain", label: "Region", type: "select", required: true, options: [
      { value: "feishu", label: "Feishu (China — open.feishu.cn)" },
      { value: "lark", label: "Lark (Global — open.larksuite.com)" },
    ]},
    { key: "app_id", label: "App ID", type: "text", placeholder: "cli_xxxxxxxxxx", required: true },
    { key: "app_secret", label: "App Secret", type: "password", placeholder: "App secret from console", required: true },
    { key: "verification_token", label: "Verification Token", type: "text", placeholder: "Optional" },
    { key: "encrypt_key", label: "Encrypt Key", type: "text", placeholder: "Optional" },
  ],
  slack: [
    { key: "bot_token", label: "Bot Token", type: "password", placeholder: "xoxb-...", required: true },
    { key: "app_token", label: "App Token", type: "password", placeholder: "xapp-...", required: true },
    { key: "signing_secret", label: "Signing Secret", type: "password", placeholder: "Optional" },
  ],
  discord: [
    { key: "bot_token", label: "Bot Token", type: "password", placeholder: "Discord bot token", required: true },
  ],
  telegram: [
    { key: "bot_token", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF...", required: true },
  ],
}

function ConfigForm({ type, config, onChange }: {
  type: string; config: Record<string, string>; onChange: (config: Record<string, string>) => void
}) {
  const fields = CONFIG_FIELDS[type] || []
  if (fields.length === 0) return <p className="text-[11px] text-muted-foreground">No configuration needed for this type.</p>

  return (
    <div className="space-y-2">
      {fields.map(f => (
        <div key={f.key} className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {f.label} {f.required && <span className="text-red-400">*</span>}
          </label>
          {f.type === "select" ? (
            <select
              value={config[f.key] || f.options?.[0]?.value || ""}
              onChange={e => onChange({ ...config, [f.key]: e.target.value })}
              className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background"
            >
              {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input
              type={f.type}
              value={config[f.key] || ""}
              onChange={e => onChange({ ...config, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background"
            />
          )}
        </div>
      ))}
    </div>
  )
}

export function Channels() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [formName, setFormName] = useState("")
  const [formType, setFormType] = useState("lark")
  const [formConfig, setFormConfig] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editConfig, setEditConfig] = useState<Record<string, string>>({})
  const [editName, setEditName] = useState("")
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const confirmDialog = useConfirm()

  useEffect(() => {
    api<{ data: Channel[] }>("/channels")
      .then(r => setChannels(Array.isArray(r.data) ? r.data : []))
      .catch(() => setChannels([]))
      .finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const ch = await api<Channel>("/channels", {
        method: "POST",
        body: { name: formName, type: formType, config: formConfig },
      })
      setChannels(prev => [...prev, ch])
      setShowCreate(false)
      setFormName(""); setFormConfig({})
      toast.success("Channel created")
    } catch (err: any) { toast.error(err.message) } finally { setCreating(false) }
  }

  const handleDelete = async (ch: Channel) => {
    if (!(await confirmDialog({ title: "Delete Channel", message: `Delete "${ch.name}"?\n\nThis will:\n• Disconnect all paired chat groups using this channel\n• Remove all agent authorizations for this channel\n• Cancel any pending pairing codes\n\nThis action cannot be undone.`, destructive: true, confirmLabel: "Delete" }))) return
    try {
      await api(`/channels/${ch.id}`, { method: "DELETE" })
      setChannels(prev => prev.filter(c => c.id !== ch.id))
      toast.success("Channel deleted")
    } catch (err: any) { toast.error(err.message) }
  }

  const startEdit = async (ch: Channel) => {
    try {
      const full = await api<Channel>(`/channels/${ch.id}`)
      const cfg = (typeof full.config === "string" ? JSON.parse(full.config as unknown as string) : full.config) as Record<string, string>
      setEditingId(ch.id)
      setEditName(ch.name)
      setEditConfig(cfg)
    } catch (err: any) { toast.error(err.message) }
  }

  const handleSaveEdit = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      const updated = await api<Channel>(`/channels/${editingId}`, {
        method: "PUT",
        body: { name: editName, config: editConfig },
      })
      setChannels(prev => prev.map(c => c.id === editingId ? { ...c, name: updated.name || editName } : c))
      setEditingId(null)
      toast.success("Channel updated")
    } catch (err: any) { toast.error(err.message) } finally { setSaving(false) }
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">Channels</h1>
          <p className="text-sm text-muted-foreground">Manage messaging platform connections (Lark, Slack, etc.)</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-3.5 w-3.5" /> Add Channel
        </button>
      </div>

      {showCreate && (
        <div className="mx-6 my-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Channel Name *" value={formName} onChange={e => setFormName(e.target.value)} className="h-8 px-3 text-sm rounded-md border border-border bg-background" />
            <select value={formType} onChange={e => { setFormType(e.target.value); setFormConfig({}) }} className="h-8 px-3 text-sm rounded-md border border-border bg-background">
              {CHANNEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <ConfigForm type={formType} config={formConfig} onChange={setFormConfig} />
          <div className="flex gap-2">
            <button onClick={handleCreate} disabled={creating || !formName} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{creating ? "Creating..." : "Create"}</button>
            <button onClick={() => setShowCreate(false)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Radio className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No channels configured</p>
          </div>
        ) : (
          <div className="px-6 py-4 space-y-2">
            {channels.map(ch => (
              <div key={ch.id}>
                <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 hover:bg-secondary/30">
                  <div className="flex items-center gap-3">
                    <span className={`h-2 w-2 rounded-full ${ch.status === "active" ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                    <div>
                      <p className="text-sm font-medium">{ch.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {CHANNEL_TYPES.find(t => t.value === ch.type)?.label || ch.type} · Created {new Date(ch.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(ch)} title="Settings" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground">
                      <Settings className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(ch)} title="Delete" className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {editingId === ch.id && (
                  <div className="ml-4 mt-2 mb-2 p-4 rounded-lg border border-border bg-card space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full h-8 px-3 text-sm rounded-md border border-border bg-background" />
                    </div>
                    <ConfigForm type={ch.type} config={editConfig} onChange={setEditConfig} />
                    <div className="flex gap-2">
                      <button onClick={handleSaveEdit} disabled={saving} className="h-8 px-4 text-sm rounded-md bg-primary text-primary-foreground disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
                      <button onClick={() => setEditingId(null)} className="h-8 px-4 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground">Cancel</button>
                    </div>
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
