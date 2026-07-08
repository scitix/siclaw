import { useCallback, useEffect, useState } from "react"
import { api } from "../api"
import { useSystemConfig } from "./useMetrics"

/**
 * Tracing analysis platforms — real backend wiring for the Metrics ▸ Tracing tab.
 *
 * Wraps the admin-only exporter CRUD (/siclaw/tracing/exporters) plus the three
 * global tracing scalars stored in system_config (tracing.enabled /
 * tracing.serviceName / tracing.sendContent, reused via useSystemConfig).
 *
 * Auth material is TYPED, never finished headers — the form collects
 * pk/sk (langfuse), apiKey/projectName (phoenix) or raw headers (otlp); the
 * backend assembles the OTLP headers and masks secrets on read. The hook never
 * touches base64 / Bearer assembly. On read, `auth` carries masked secret
 * prefixes; on update, leaving a secret field blank or resending the masked
 * echo keeps the stored value (backend never persists a masked string).
 */

export type TracingPlatformType = "langfuse" | "phoenix" | "otlp"

export interface ExporterAuth {
  // langfuse
  publicKey?: string
  secretKey?: string
  // phoenix
  apiKey?: string
  projectName?: string
  // otlp
  headers?: Record<string, string>
}

/** An exporter row as returned by the API (secrets masked in `auth`). */
export interface Exporter {
  id: string
  name: string
  platform_type: TracingPlatformType
  url: string
  auth: ExporterAuth
  enabled: boolean
  sort_order: number
  created_at?: string
  updated_at?: string
}

export interface ExporterCreate {
  name: string
  platformType: TracingPlatformType
  url: string
  auth: ExporterAuth
  enabled?: boolean
}

export interface ExporterUpdate {
  name?: string
  url?: string
  auth?: ExporterAuth
  enabled?: boolean
}

export interface TestResult {
  ok: boolean
  status: number
  message: string
}

export interface UseTracingPlatforms {
  exporters: Exporter[]
  loading: boolean
  reload: () => void
  create: (input: ExporterCreate) => Promise<void>
  update: (id: string, patch: ExporterUpdate) => Promise<void>
  remove: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  test: (input: { platformType: TracingPlatformType; url: string; auth: ExporterAuth }) => Promise<TestResult>
  // Probe an existing row by id using its STORED (unmasked) auth — for the
  // list-row Test button, where the secret is masked and can't be resent.
  testById: (id: string) => Promise<TestResult>
  // Global tracing scalars (system_config).
  config: Record<string, string>
  configLoading: boolean
  saveConfig: (key: string, value: string) => Promise<void>
}

const EXPORTERS = "/siclaw/tracing/exporters"

export function useTracingPlatforms(): UseTracingPlatforms {
  const [exporters, setExporters] = useState<Exporter[]>([])
  const [loading, setLoading] = useState(true)
  const { config, loading: configLoading, save: saveConfig } = useSystemConfig()

  const reload = useCallback(() => {
    setLoading(true)
    api<{ data: Exporter[] }>(EXPORTERS)
      .then((r) => { setExporters(Array.isArray(r.data) ? r.data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { reload() }, [reload])

  const create = useCallback(async (input: ExporterCreate) => {
    await api(EXPORTERS, { method: "POST", body: input })
    reload()
  }, [reload])

  const update = useCallback(async (id: string, patch: ExporterUpdate) => {
    await api(`${EXPORTERS}/${id}`, { method: "PUT", body: patch })
    reload()
  }, [reload])

  const remove = useCallback(async (id: string) => {
    await api(`${EXPORTERS}/${id}`, { method: "DELETE" })
    reload()
  }, [reload])

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    await api(`${EXPORTERS}/${id}/toggle`, { method: "PUT", body: { enabled } })
    reload()
  }, [reload])

  const test = useCallback(
    async (input: { platformType: TracingPlatformType; url: string; auth: ExporterAuth }): Promise<TestResult> => {
      return api<TestResult>(`${EXPORTERS}/test`, { method: "POST", body: input })
    },
    [],
  )

  const testById = useCallback(
    async (id: string): Promise<TestResult> => {
      return api<TestResult>(`${EXPORTERS}/${id}/test`, { method: "POST" })
    },
    [],
  )

  return { exporters, loading, reload, create, update, remove, toggle, test, testById, config, configLoading, saveConfig }
}
