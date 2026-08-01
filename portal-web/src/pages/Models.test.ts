import { describe, expect, it } from "vitest"
import {
  applyProtocolToHinted,
  buildImportPayload,
  describeListedModel,
  importableModels,
  modelApiLabel,
  normalizeApiType,
  toggleSelectAll,
  type FetchSelection,
  type ListedModel,
} from "./Models"

describe("normalizeApiType", () => {
  it("maps legacy stored api_type values to pi's canonical api ids", () => {
    expect(normalizeApiType("anthropic")).toBe("anthropic-messages")
    expect(normalizeApiType("openai")).toBe("openai-completions")
  })

  it("passes canonical values through unchanged", () => {
    expect(normalizeApiType("anthropic-messages")).toBe("anthropic-messages")
    expect(normalizeApiType("openai-completions")).toBe("openai-completions")
  })

  // Deliberately asymmetric with the server's normalizeProviderApi, which
  // defaults "" to openai-completions. Here "" means "inherit"; defaulting it
  // would make the select show OpenAI Compatible for every inheriting model and
  // re-save that as a hard override.
  it("leaves an empty value empty rather than inventing one", () => {
    expect(normalizeApiType("")).toBe("")
  })
})

describe("modelApiLabel", () => {
  it("renders nothing when the model inherits", () => {
    expect(modelApiLabel(null)).toBe("")
    expect(modelApiLabel(undefined)).toBe("")
    expect(modelApiLabel("")).toBe("")
    expect(modelApiLabel("   ")).toBe("")
  })

  it("renders the canonical id for an override, mapping legacy values", () => {
    expect(modelApiLabel("anthropic")).toBe("anthropic-messages")
    expect(modelApiLabel("anthropic-messages")).toBe("anthropic-messages")
  })
})

describe("fetch-models dialog selection", () => {
  const listed = (over: Partial<ListedModel> & { id: string }): ListedModel => ({
    suggested_api_type: "",
    already_exists: false,
    ...over,
  })
  const models: ListedModel[] = [
    listed({ id: "DeepSeek-V4-Pro" }),
    listed({ id: "claude-sonnet-5", suggested_api_type: "anthropic-messages" }),
    listed({ id: "GLM-5.1", already_exists: true }),
  ]
  const sel = (o: Record<string, FetchSelection>) => o

  it("excludes models the provider already has", () => {
    expect(importableModels(models).map((m) => m.id)).toEqual(["DeepSeek-V4-Pro", "claude-sonnet-5"])
  })

  it("builds the payload only from ticked, importable rows", () => {
    const payload = buildImportPayload(models, sel({
      "DeepSeek-V4-Pro": { checked: true, api_type: "" },
      "claude-sonnet-5": { checked: false, api_type: "anthropic-messages" },
      "GLM-5.1": { checked: true, api_type: "" },  // already added — must not slip through
    }))
    expect(payload.map((p) => p.model_id)).toEqual(["DeepSeek-V4-Pro"])
  })

  // The inference is a pre-fill, not a decision: whatever the operator picked in
  // the row's dropdown is what gets imported.
  it("takes the protocol from the selection, not from suggested_api_type", () => {
    const payload = buildImportPayload(models, sel({
      "claude-sonnet-5": { checked: true, api_type: "openai-completions" },
    }))
    expect(payload[0].api_type).toBe("openai-completions")
  })

  // Protocol is required per model; the dialog always seeds a concrete value
  // (the provider's, since the listing can't tell us) and the operator corrects
  // it. An empty selection would be a UI bug, so the payload passes it through
  // rather than inventing a value the server would have to guess at.
  it("passes the row's protocol through verbatim", () => {
    const payload = buildImportPayload(models, sel({
      "DeepSeek-V4-Pro": { checked: true, api_type: "openai-completions" },
    }))
    expect(payload[0].api_type).toBe("openai-completions")
  })

  it("falls back to the model id when the listing carried no display name", () => {
    const payload = buildImportPayload(
      [listed({ id: "bare" }), listed({ id: "named", name: "Named Model" })],
      sel({ bare: { checked: true, api_type: "" }, named: { checked: true, api_type: "" } }),
    )
    expect(payload.map((p) => p.name)).toEqual(["bare", "Named Model"])
  })

  it("select-all never ticks an already-added row and keeps chosen protocols", () => {
    const next = toggleSelectAll(models, sel({
      "claude-sonnet-5": { checked: false, api_type: "anthropic-messages" },
    }), true)
    expect(next["DeepSeek-V4-Pro"].checked).toBe(true)
    expect(next["claude-sonnet-5"]).toEqual({ checked: true, api_type: "anthropic-messages" })
    expect(next["GLM-5.1"].checked).toBe(false)
  })

  it("clear-all unticks everything", () => {
    const next = toggleSelectAll(models, sel({
      "DeepSeek-V4-Pro": { checked: true, api_type: "" },
    }), false)
    expect(Object.values(next).every((v) => !v.checked)).toBe(true)
  })
})

describe("describeListedModel", () => {
  const listed = (over: Partial<ListedModel> & { id: string }): ListedModel => ({
    suggested_api_type: "",
    already_exists: false,
    ...over,
  })

  // The whole point: the operator must be able to tell a real 1M window from
  // the 128K the import falls back to, because a too-low value makes siclaw
  // reject long turns in preflight.
  it("marks fallen-back values as defaults", () => {
    expect(describeListedModel(listed({ id: "m" }))).toBe("128K ctx (default) · 66K out (default)")
  })

  it("shows real values without the default marker", () => {
    expect(describeListedModel(listed({ id: "m", context_window: 1000000, max_tokens: 8192 })))
      .toBe("1000K ctx · 8K out")
  })

  it("mixes real and defaulted fields", () => {
    expect(describeListedModel(listed({ id: "m", context_window: 200000 })))
      .toBe("200K ctx · 66K out (default)")
  })

  it("appends capability flags only when present", () => {
    expect(describeListedModel(listed({ id: "m", context_window: 1000, max_tokens: 1000, vision: true, reasoning: true })))
      .toBe("1K ctx · 1K out · vision · reasoning")
    expect(describeListedModel(listed({ id: "m", context_window: 1000, max_tokens: 1000, vision: false })))
      .toBe("1K ctx · 1K out")
  })
})

describe("applyProtocolToHinted", () => {
  const listed = (over: Partial<ListedModel> & { id: string }): ListedModel => ({
    suggested_api_type: "",
    already_exists: false,
    ...over,
  })
  const models: ListedModel[] = [
    listed({ id: "claude-opus-4-8", protocol_hint: "claude" }),
    listed({ id: "claude-sonnet-5", protocol_hint: "claude" }),
    listed({ id: "DeepSeek-V4-Pro" }),
    listed({ id: "claude-old", protocol_hint: "claude", already_exists: true }),
  ]

  it("sets the protocol on hinted rows only", () => {
    const next = applyProtocolToHinted(models, {}, "anthropic-messages")
    expect(next["claude-opus-4-8"].api_type).toBe("anthropic-messages")
    expect(next["claude-sonnet-5"].api_type).toBe("anthropic-messages")
    expect(next["DeepSeek-V4-Pro"]).toBeUndefined()
  })

  it("skips rows the provider already has", () => {
    expect(applyProtocolToHinted(models, {}, "anthropic-messages")["claude-old"]).toBeUndefined()
  })

  it("preserves each row's checked state", () => {
    const next = applyProtocolToHinted(
      models,
      { "claude-opus-4-8": { checked: true, api_type: "" } },
      "anthropic-messages",
    )
    expect(next["claude-opus-4-8"]).toEqual({ checked: true, api_type: "anthropic-messages" })
    expect(next["claude-sonnet-5"].checked).toBe(false)
  })
})
