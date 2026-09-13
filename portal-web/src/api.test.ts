// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { api, apiRaw } from "./api"

afterEach(() => vi.unstubAllGlobals())

it("preserves structured retirement errors and legacy string errors", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null })
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    error: { code: "AGENT_RETIRED", message: "Retired Agent", status: 410, retriable: false },
  }), { status: 410 })))
  for (const call of [() => api("/agents/old"), () => apiRaw("/agents/old", {})]) {
    await expect(call()).rejects.toMatchObject({ message: "Retired Agent", code: "AGENT_RETIRED", status: 410, retriable: false })
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Legacy error" }), { status: 400 })))
  await expect(api("/agents/old")).rejects.toMatchObject({ message: "Legacy error", status: 400 })
})
