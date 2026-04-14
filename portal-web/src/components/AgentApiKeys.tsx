import { useState, useEffect } from "react"
import { Plus, Copy, Trash2, KeyRound, Loader2 } from "lucide-react"
import { api } from "../api"
import { useToast } from "./toast"
import { useConfirm } from "./confirm-dialog"

interface ApiKey {
  id: string
  name: string
  key_plain: string
  key_prefix: string
  created_at: string
  last_used_at?: string
  expires_at?: string
}

interface AgentApiKeysProps {
  agentId: string
}

export function AgentApiKeys({ agentId }: AgentApiKeysProps) {
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newExpiry, setNewExpiry] = useState("")
  const [creating, setCreating] = useState(false)

  // Reveal state (shown after creation)
  const [revealKey, setRevealKey] = useState("")

  useEffect(() => {
    let cancelled = false
    async function fetchKeys() {
      try {
        setLoading(true)
        const res = await api<{ data: ApiKey[] }>(`/siclaw/agents/${agentId}/api-keys`)
        const items = Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as any) : []
        if (!cancelled) setKeys(items)
      } catch (err: any) {
        if (!cancelled) toast.error(err.message || "Failed to load API keys")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchKeys()
    return () => { cancelled = true }
  }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!newName.trim()) return
    try {
      setCreating(true)
      const res = await api<{ key: string }>(`/siclaw/agents/${agentId}/api-keys`, {
        method: "POST",
        body: {
          name: newName.trim(),
          expires_at: newExpiry || undefined,
        },
      })
      // Refresh key list
      const updated = await api<{ data: ApiKey[] }>(`/siclaw/agents/${agentId}/api-keys`)
      const items = Array.isArray(updated.data) ? updated.data : Array.isArray(updated) ? (updated as any) : []
      setKeys(items)
      setNewName("")
      setNewExpiry("")
      setShowCreate(false)
      setRevealKey(res.key)
    } catch (err: any) {
      toast.error(err.message || "Failed to create API key")
    } finally {
      setCreating(false)
    }
  }

  const handleCopyKey = () => {
    navigator.clipboard.writeText(revealKey)
    toast.success("API key copied to clipboard")
  }

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: "Delete API Key",
      message: "This API key will be permanently revoked. Any services using it will lose access.",
      destructive: true,
      confirmLabel: "Delete",
    })
    if (!ok) return
    try {
      await api(`/siclaw/agents/${agentId}/api-keys/${id}`, { method: "DELETE" })
      setKeys((prev) => prev.filter((k) => k.id !== id))
      toast.success("API key deleted")
    } catch (err: any) {
      toast.error(err.message || "Failed to delete API key")
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <span className="text-[13px] font-medium">API Keys</span>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 h-7 px-3 text-[12px] rounded-md bg-primary text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          Create API Key
        </button>
      </div>

      {/* Reveal key banner */}
      {revealKey && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <p className="text-[12px] text-amber-400 font-medium mb-2">
            Copy your API key now. You won't be able to see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[12px] font-mono bg-muted px-3 py-2 rounded border border-border truncate select-all">
              {revealKey}
            </code>
            <button
              onClick={handleCopyKey}
              className="h-8 w-8 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            onClick={() => setRevealKey("")}
            className="mt-2 text-[12px] text-muted-foreground hover:text-foreground underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-border bg-card space-y-3">
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground">Name *</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Production Monitoring"
              className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground">Expiry (optional)</label>
            <input
              type="date"
              value={newExpiry}
              onChange={(e) => setNewExpiry(e.target.value)}
              className="w-full h-8 px-3 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
              className="h-8 px-4 text-[13px] rounded-md bg-primary text-primary-foreground disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewName(""); setNewExpiry("") }}
              className="h-8 px-4 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : keys.length > 0 ? (
          <div className="min-w-[700px]">
            {/* Table header */}
            <div className="sticky top-0 z-10 flex items-center border-b border-border/40 bg-card px-4 py-2.5 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
              <div className="w-[22%] px-2">Name</div>
              <div className="w-[14%] px-2">Key Prefix</div>
              <div className="w-[18%] px-2">Created</div>
              <div className="w-[18%] px-2">Last Used</div>
              <div className="w-[18%] px-2">Expires</div>
              <div className="flex-1 px-2">Actions</div>
            </div>

            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center border-b border-border/20 px-4 py-2.5 transition-colors hover:bg-muted/30"
              >
                <div className="w-[22%] px-2">
                  <span className="text-[13px] text-foreground font-medium truncate block">{key.name}</span>
                </div>
                <div className="w-[14%] px-2 flex items-center gap-1">
                  <code className="text-[12px] text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded truncate" title={key.key_plain}>
                    {key.key_prefix}...
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(key.key_plain); toast.success("Key copied") }}
                    className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground shrink-0"
                    title="Copy full key"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <div className="w-[18%] px-2">
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {new Date(key.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="w-[18%] px-2">
                  <span className="text-[12px] text-muted-foreground tabular-nums">
                    {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "Never"}
                  </span>
                </div>
                <div className="w-[18%] px-2">
                  <span className="text-[12px] text-muted-foreground">
                    {key.expires_at
                      ? new Date(key.expires_at).toLocaleDateString()
                      : "No expiry"}
                  </span>
                </div>
                <div className="flex-1 px-2">
                  <button
                    onClick={() => handleDelete(key.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16">
            <KeyRound className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] font-medium text-muted-foreground">No API keys</p>
            <p className="text-[12px] text-muted-foreground/70 mt-1">Create an API key to access this agent programmatically</p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 mt-4 h-8 px-3 text-[13px] rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            >
              <Plus className="h-3.5 w-3.5" />
              Create API Key
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
