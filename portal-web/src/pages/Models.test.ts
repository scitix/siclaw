import { describe, expect, it } from "vitest"
import { normalizeApiType } from "./Models"

describe("normalizeApiType", () => {
  it("maps legacy stored api_type values to pi's canonical api ids", () => {
    expect(normalizeApiType("anthropic")).toBe("anthropic-messages")
    expect(normalizeApiType("openai")).toBe("openai-completions")
  })

  it("passes canonical values through unchanged", () => {
    expect(normalizeApiType("anthropic-messages")).toBe("anthropic-messages")
    expect(normalizeApiType("openai-completions")).toBe("openai-completions")
  })
})
