import { useEffect, useState } from "react"
import { Plus, Pencil, Trash2, Radio, CheckCircle2, XCircle, Loader2, X } from "lucide-react"
import { useToast } from "../toast"
import {
  useTracingPlatforms,
  type Exporter,
  type ExporterAuth,
  type TracingPlatformType,
} from "../../hooks/useTracingPlatforms"

/**
 * Metrics ▸ Tracing tab — manage the third-party analysis platforms
 * (Langfuse / Phoenix / generic OTLP) the agent-behaviour tracing layer fans
 * out to, plus the three global tracing scalars. Backed by the real API via
 * useTracingPlatforms; changes persist and hot-reload every active AgentBox.
 *
 * Secrets are masked on read — leaving a secret field unchanged (the masked
 * echo) or blank keeps the stored value. The Test button in the form uses the
 * values currently typed, so an existing row must have its real secret
 * re-entered to verify auth (masked echoes will be rejected by the backend).
 */

type PlatformType = TracingPlatformType

const TYPE_META: Record<PlatformType, { label: string; badge: string; chip: string; hint: string }> = {
  langfuse: {
    label: "Langfuse",
    badge: "LF",
    chip: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    hint: "https://<host>/api/public/otel/v1/traces",
  },
  phoenix: {
    label: "Phoenix",
    badge: "PX",
    chip: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    hint: "http://<host>:6006/v1/traces",
  },
  otlp: {
    label: "Generic OTLP",
    badge: "OT",
    chip: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    hint: "http://<host>:4318/v1/traces",
  },
}

/** Local form draft — raw fields including a JSON text buffer for otlp headers. */
interface Draft {
  id: string // "" when adding
  type: PlatformType
  name: string
  url: string
  enabled: boolean
  publicKey: string
  secretKey: string
  apiKey: string
  projectName: string
  headersText: string
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        on ? "bg-blue-500" : "bg-secondary border border-border"
      }`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
    </button>
  )
}

const emptyDraft = (): Draft => ({
  id: "", type: "langfuse", name: "", url: "", enabled: true,
  publicKey: "", secretKey: "", apiKey: "", projectName: "", headersText: "",
})

/** Build a form draft from an existing exporter row (secrets arrive masked). */
function draftFromExporter(e: Exporter): Draft {
  const a = e.auth ?? {}
  return {
    id: e.id,
    type: e.platform_type,
    name: e.name,
    url: e.url,
    enabled: e.enabled,
    publicKey: a.publicKey ?? "",
    secretKey: a.secretKey ?? "",
    apiKey: a.apiKey ?? "",
    projectName: a.projectName ?? "",
    headersText: a.headers ? JSON.stringify(a.headers, null, 2) : "",
  }
}

/**
 * Convert a draft's typed fields into the ExporterAuth wire shape. Returns null
 * (with a toast) if the otlp headers JSON is malformed. Empty/masked secrets are
 * sent verbatim — the backend resolves them back to the stored value.
 */
function authFromDraft(draft: Draft, onError: (m: string) => void): ExporterAuth | null {
  if (draft.type === "langfuse") {
    return { publicKey: draft.publicKey, secretKey: draft.secretKey }
  }
  if (draft.type === "phoenix") {
    return { apiKey: draft.apiKey, projectName: draft.projectName }
  }
  // otlp — parse the headers JSON buffer into a string→string map.
  const text = draft.headersText.trim()
  if (!text) return { headers: {} }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      onError("Headers must be a JSON object")
      return null
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") { onError(`Header "${k}" must be a string`); return null }
      headers[k] = v
    }
    return { headers }
  } catch {
    onError("Invalid headers JSON")
    return null
  }
}

export function TracingPlatforms() {
  const toast = useToast()
  const { exporters, loading, create, update, remove, toggle, test, testById, config, saveConfig } = useTracingPlatforms()

  // Global tracing scalars, mirrored from system_config. serviceName uses a
  // local buffer (saved on blur) so typing doesn't fire a write per keystroke.
  const master = config["tracing.enabled"] === "true"
  const sendContent = config["tracing.sendContent"] === "true"
  const [serviceName, setServiceName] = useState("")
  useEffect(() => { setServiceName(config["tracing.serviceName"] ?? "") }, [config])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, "ok" | "fail">>({})
  const [saving, setSaving] = useState(false)
  const [formTesting, setFormTesting] = useState(false)

  const editing = draft != null && draft.id !== ""

  const openAdd = () => setDraft(emptyDraft())
  const openEdit = (e: Exporter) => setDraft(draftFromExporter(e))
  const close = () => setDraft(null)

  const saveScalar = async (key: string, value: string) => {
    try {
      await saveConfig(key, value)
    } catch {
      toast.error("Failed to save tracing setting")
    }
  }

  const remove_ = async (e: Exporter) => {
    try {
      await remove(e.id)
      toast.success(`${e.name} removed`)
    } catch {
      toast.error("Failed to remove platform")
    }
  }

  const toggleEnabled = async (e: Exporter) => {
    try {
      await toggle(e.id, !e.enabled)
    } catch {
      toast.error("Failed to toggle platform")
    }
  }

  const testRow = async (e: Exporter) => {
    setTesting(e.id)
    try {
      // Use the stored-secret probe (:id/test) — e.auth is masked, so resending
      // it would fail auth for langfuse/phoenix.
      const r = await testById(e.id)
      setResults((m) => ({ ...m, [e.id]: r.ok ? "ok" : "fail" }))
      r.ok ? toast.success(`${e.name}: ${r.message}`) : toast.error(`${e.name}: ${r.message}`)
    } catch {
      setResults((m) => ({ ...m, [e.id]: "fail" }))
      toast.error(`${e.name}: test failed`)
    } finally {
      setTesting(null)
    }
  }

  const testDraft = async () => {
    if (!draft) return
    const auth = authFromDraft(draft, toast.error)
    if (!auth) return
    setFormTesting(true)
    try {
      const r = await test({ platformType: draft.type, url: draft.url, auth })
      r.ok ? toast.success(r.message) : toast.error(r.message)
    } catch {
      toast.error("Test failed")
    } finally {
      setFormTesting(false)
    }
  }

  const saveDraft = async () => {
    if (!draft) return
    if (!draft.name.trim()) { toast.error("Name is required"); return }
    try {
      const u = new URL(draft.url)
      if (u.protocol !== "http:" && u.protocol !== "https:") { toast.error("URL must be http(s)"); return }
    } catch { toast.error("Invalid endpoint URL"); return }

    const auth = authFromDraft(draft, toast.error)
    if (!auth) return

    setSaving(true)
    try {
      if (editing) {
        await update(draft.id, { name: draft.name, url: draft.url, auth, enabled: draft.enabled })
        toast.success("Platform updated")
      } else {
        await create({ name: draft.name, platformType: draft.type, url: draft.url, auth, enabled: draft.enabled })
        toast.success("Platform added")
      }
      close()
    } catch {
      toast.error("Failed to save platform")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="px-6 py-6 space-y-6 max-w-4xl">
      {/* Global tracing settings */}
      <div className="border border-border rounded-lg bg-card p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-semibold">Agent behaviour tracing</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Records agent runs (LLM calls, tools, tokens) and fans out to every enabled platform below.
            </p>
          </div>
          <Toggle on={master} onChange={() => saveScalar("tracing.enabled", master ? "false" : "true")} />
        </div>

        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5 transition-opacity ${master ? "" : "opacity-40 pointer-events-none"}`}>
          <label className="block">
            <span className="text-[11px] text-muted-foreground">service.name</span>
            <input
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              onBlur={() => { if (serviceName !== (config["tracing.serviceName"] ?? "")) saveScalar("tracing.serviceName", serviceName) }}
              placeholder="siclaw-agentbox"
              className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
            />
          </label>
          <div className="flex items-end">
            <div className="flex items-center justify-between w-full rounded-md bg-secondary/40 border border-border px-3 h-9">
              <div>
                <span className="text-[12px]">Send content</span>
                <span className="ml-2 text-[10px] text-muted-foreground">LLM I/O + tool args</span>
              </div>
              <Toggle on={sendContent} onChange={() => saveScalar("tracing.sendContent", sendContent ? "false" : "true")} />
            </div>
          </div>
        </div>
      </div>

      {/* Platforms list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Analysis platforms · {exporters.length}
          </h3>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-blue-500 hover:bg-blue-600 text-white font-medium"
          >
            <Plus className="w-3.5 h-3.5" /> Add platform
          </button>
        </div>

        {loading ? (
          <div className="border border-dashed border-border rounded-lg bg-card p-10 text-center text-[12px] text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading…
          </div>
        ) : exporters.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg bg-card p-10 text-center text-[12px] text-muted-foreground">
            No platforms configured. Add Langfuse, Phoenix or a generic OTLP endpoint to start exporting traces.
          </div>
        ) : (
          <div className="border border-border rounded-lg bg-card divide-y divide-border overflow-hidden">
            {exporters.map((p) => {
              const meta = TYPE_META[p.platform_type]
              const last = results[p.id]
              return (
                <div key={p.id} className="flex items-center gap-4 px-4 py-3">
                  <span className={`inline-flex items-center justify-center w-9 h-9 rounded-md border text-[11px] font-bold ${meta.chip}`}>
                    {meta.badge}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">{p.name}</span>
                      <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-px">{meta.label}</span>
                      {last === "ok" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                      {last === "fail" && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                    </div>
                    <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{p.url}</p>
                  </div>
                  <button
                    onClick={() => testRow(p)}
                    disabled={testing === p.id}
                    title="Test connection"
                    className="flex items-center gap-1 text-[11px] px-2 py-1 border border-border rounded hover:bg-secondary text-muted-foreground disabled:opacity-50"
                  >
                    {testing === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />} Test
                  </button>
                  <Toggle on={p.enabled} onChange={() => toggleEnabled(p)} />
                  <button onClick={() => openEdit(p)} title="Edit" className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => remove_(p)} title="Delete" className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-red-400">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add / Edit form (overlay) */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
          <div className="w-full max-w-lg border border-border rounded-lg bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[14px] font-semibold">{editing ? "Edit platform" : "Add platform"}</h3>
              <button onClick={close} className="p-1 rounded hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>

            {/* type selector — immutable once created */}
            <div className="flex gap-2 mb-4">
              {(Object.keys(TYPE_META) as PlatformType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => { if (!editing) setDraft({ ...draft, type: t }) }}
                  disabled={editing}
                  className={`flex-1 py-2 text-[12px] rounded-md border transition disabled:opacity-50 ${
                    draft.type === t ? "border-blue-500 bg-blue-500/10 text-foreground" : "border-border text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  {TYPE_META[t].label}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="text-[11px] text-muted-foreground">Name</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Langfuse (prod)"
                  className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground focus:outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-muted-foreground">OTLP endpoint URL</span>
                <input
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder={TYPE_META[draft.type].hint}
                  className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                />
              </label>

              {/* type-specific auth */}
              {draft.type === "langfuse" && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-muted-foreground">Public key</span>
                    <input
                      value={draft.publicKey}
                      onChange={(e) => setDraft({ ...draft, publicKey: e.target.value })}
                      placeholder="pk-lf-…"
                      className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-muted-foreground">Secret key</span>
                    <input
                      type="password"
                      value={draft.secretKey}
                      onChange={(e) => setDraft({ ...draft, secretKey: e.target.value })}
                      placeholder={editing ? "(unchanged)" : "sk-lf-…"}
                      className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                    />
                  </label>
                </div>
              )}
              {draft.type === "phoenix" && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-muted-foreground">API key (Bearer)</span>
                    <input
                      type="password"
                      value={draft.apiKey}
                      onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                      placeholder={editing ? "(unchanged)" : "px-…"}
                      className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-muted-foreground">Project name</span>
                    <input
                      value={draft.projectName}
                      onChange={(e) => setDraft({ ...draft, projectName: e.target.value })}
                      placeholder="siclaw"
                      className="mt-1 w-full h-9 px-3 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                    />
                  </label>
                </div>
              )}
              {draft.type === "otlp" && (
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">Headers (JSON)</span>
                  <textarea
                    value={draft.headersText}
                    onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                    placeholder={'{ "Authorization": "Bearer …" }'}
                    rows={3}
                    className="mt-1 w-full px-3 py-2 text-[12px] rounded-md bg-secondary border border-border text-foreground font-mono focus:outline-none focus:border-blue-500"
                  />
                </label>
              )}

              <div className="flex items-center justify-between rounded-md bg-secondary/40 border border-border px-3 h-9">
                <span className="text-[12px]">Enabled</span>
                <Toggle on={draft.enabled} onChange={() => setDraft({ ...draft, enabled: !draft.enabled })} />
              </div>
            </div>

            <div className="flex items-center justify-between mt-5">
              <button
                onClick={testDraft}
                disabled={formTesting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md border border-border hover:bg-secondary text-muted-foreground disabled:opacity-50"
              >
                {formTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />} Test connection
              </button>
              <div className="flex items-center gap-2">
                <button onClick={close} className="px-3 py-1.5 text-[12px] rounded-md border border-border hover:bg-secondary text-muted-foreground">Cancel</button>
                <button
                  onClick={saveDraft}
                  disabled={saving}
                  className="px-4 py-1.5 text-[12px] rounded-md bg-blue-500 hover:bg-blue-600 text-white font-medium disabled:opacity-50"
                >
                  {editing ? "Save changes" : "Add platform"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
