import { describe, expect, it } from "vitest";
import {
  buildModelListUrl,
  looksLikeClaudeModel,
  parseAnthropicModelList,
  parseOpenAiModelList,
  isValidApiType,
  providerFetchSsrfGuard,
} from "./provider-model-listing.js";

describe("looksLikeClaudeModel", () => {
  it("matches a bare claude-* id, which is how a native Claude endpoint lists them", () => {
    expect(looksLikeClaudeModel("claude-sonnet-5")).toBe(true);
    expect(looksLikeClaudeModel("Claude-Opus-4-8")).toBe(true);
    expect(looksLikeClaudeModel("  claude-haiku-4-5  ")).toBe(true);
  });

  // The anchoring is the whole trick. A namespaced id means an aggregator that
  // re-serves the model over ITS protocol (chat-completions), so matching it
  // would pre-fill an override that 404s every turn. The same gateway lists
  // `Qwen/Qwen3.6-27B` namespaced and its Claude models bare.
  it("does not match a vendor-namespaced id", () => {
    expect(looksLikeClaudeModel("anthropic/claude-3.5-sonnet")).toBe(false);
    expect(looksLikeClaudeModel("anthropic/Claude-Opus-4-8")).toBe(false);
  });

  it("accepts owned_by as a tiebreaker only", () => {
    expect(looksLikeClaudeModel("some-model", "anthropic")).toBe(true);
    expect(looksLikeClaudeModel("some-model", " Anthropic ")).toBe(true);
  });

  // owned_by is spec'd but implementations return constants ("system",
  // "library", an org name) or omit it, so it must never fire alone.
  it("is false for everything else", () => {
    expect(looksLikeClaudeModel("DeepSeek-V4-Pro")).toBe(false);
    expect(looksLikeClaudeModel("zai-org/GLM-5.1", "zai-org")).toBe(false);
    expect(looksLikeClaudeModel("gpt-4o", "system")).toBe(false);
    expect(looksLikeClaudeModel("gpt-4o", undefined)).toBe(false);
    expect(looksLikeClaudeModel("gpt-4o", 42)).toBe(false);
  });
});

describe("parseOpenAiModelList", () => {
  // A BARE claude-* id means a native Claude endpoint, so the row is pre-filled
  // rather than merely flagged. The namespaced form (OpenRouter et al.) is a
  // different case and is left to inherit — see looksLikeClaudeModel.
  it("pre-fills anthropic-messages for bare Claude ids and inherits for the rest", () => {
    expect(parseOpenAiModelList({
      object: "list",
      data: [
        { id: "DeepSeek-V4-Pro", object: "model", owned_by: "deepseek-ai" },
        { id: "claude-sonnet-5", object: "model", owned_by: "system" },
      ],
    })).toEqual([
      { id: "DeepSeek-V4-Pro", suggested_api_type: "" },
      { id: "claude-sonnet-5", suggested_api_type: "anthropic-messages", protocol_hint: "claude" },
    ]);
  });

  it("never pre-fills an override that would break an OpenAI-protocol aggregator", () => {
    // OpenRouter/LiteLLM serve this over chat/completions; an anthropic-messages
    // override here would 404 every turn.
    const [m] = parseOpenAiModelList({ data: [{ id: "anthropic/claude-3.5-sonnet" }] });
    expect(m.suggested_api_type).toBe("");
  });

  // Only data[].id is dependable — everything else degrades rather than throws.
  it("degrades on malformed bodies instead of failing the listing", () => {
    expect(parseOpenAiModelList(undefined)).toEqual([]);
    expect(parseOpenAiModelList({})).toEqual([]);
    expect(parseOpenAiModelList({ data: "nope" })).toEqual([]);
    expect(parseOpenAiModelList({ data: [null, 7, {}, { id: "" }, { id: "  " }] })).toEqual([]);
  });

  it("keeps the good rows when one entry is malformed", () => {
    expect(parseOpenAiModelList({ data: [{ id: "ok" }, null, { nope: 1 }] }))
      .toEqual([{ id: "ok", suggested_api_type: "" }]);
  });
});

describe("parseAnthropicModelList", () => {
  it("maps display_name, limits and capabilities", () => {
    expect(parseAnthropicModelList({
      data: [{
        type: "model",
        id: "claude-opus-4-8",
        display_name: "Claude Opus 4.8",
        max_input_tokens: 1000000,
        max_tokens: 128000,
        capabilities: { image_input: { supported: true }, thinking: { supported: true } },
      }],
    })).toEqual([{
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      suggested_api_type: "",
      context_window: 1000000,
      max_tokens: 128000,
      vision: true,
      reasoning: true,
    }]);
  });

  // max_input_tokens and capabilities postdate the endpoint; older versions and
  // Anthropic-compatible gateways omit them.
  it("leaves optional fields undefined when the endpoint predates them", () => {
    const [m] = parseAnthropicModelList({ data: [{ id: "claude-x" }] });
    expect(m).toEqual({ id: "claude-x", suggested_api_type: "" });
  });

  it("ignores non-numeric or non-positive limits", () => {
    const [m] = parseAnthropicModelList({
      data: [{ id: "claude-x", max_input_tokens: "lots", max_tokens: 0 }],
    });
    expect(m.context_window).toBeUndefined();
    expect(m.max_tokens).toBeUndefined();
  });

  it("degrades on malformed bodies", () => {
    expect(parseAnthropicModelList(null)).toEqual([]);
    expect(parseAnthropicModelList({ data: {} })).toEqual([]);
  });
});

describe("providerFetchSsrfGuard", () => {
  it("allows public and RFC1918 hosts", () => {
    expect(providerFetchSsrfGuard("https://api.scitix.ai/model-api").ok).toBe(true);
    expect(providerFetchSsrfGuard("http://10.0.1.5:8000/v1").ok).toBe(true);
    expect(providerFetchSsrfGuard("http://192.168.1.20:11434/v1").ok).toBe(true);
  });

  // Unlike tracingTestSsrfGuard, loopback is permitted: a local Ollama is a
  // legitimate provider, and the runtime already dials this exact URL.
  it("allows loopback", () => {
    expect(providerFetchSsrfGuard("http://localhost:11434/v1").ok).toBe(true);
    expect(providerFetchSsrfGuard("http://127.0.0.1:8080/v1").ok).toBe(true);
  });

  it("blocks link-local / cloud metadata", () => {
    expect(providerFetchSsrfGuard("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(providerFetchSsrfGuard("http://169.254.1.1/v1").ok).toBe(false);
    expect(providerFetchSsrfGuard("http://[fe80::1]/v1").ok).toBe(false);
  });

  it("blocks non-http protocols and unparseable URLs", () => {
    expect(providerFetchSsrfGuard("file:///etc/passwd").ok).toBe(false);
    expect(providerFetchSsrfGuard("gopher://x/v1").ok).toBe(false);
    expect(providerFetchSsrfGuard("not a url").ok).toBe(false);
  });
});

describe("buildModelListUrl", () => {
  it("appends /models the same way the runtime appends /chat/completions", () => {
    expect(buildModelListUrl("https://api.scitix.ai/model-api")).toBe("https://api.scitix.ai/model-api/models");
    expect(buildModelListUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/models");
  });

  it("tolerates a trailing slash", () => {
    expect(buildModelListUrl("https://api.example.com/v1///")).toBe("https://api.example.com/v1/models");
  });
});

describe("providerFetchSsrfGuard — IPv4-mapped IPv6", () => {
  // `new URL()` normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, which
  // matches neither the dotted-quad nor the fe80 pattern — it has to be
  // unwrapped, or the metadata block the docstring promises is bypassable.
  it("blocks metadata reached through an IPv4-mapped address", () => {
    expect(providerFetchSsrfGuard("http://[::ffff:169.254.169.254]/v1").ok).toBe(false);
    expect(providerFetchSsrfGuard("http://[::ffff:a9fe:a9fe]/v1").ok).toBe(false);
  });

  it("still allows mapped addresses that aren't link-local", () => {
    expect(providerFetchSsrfGuard("http://[::ffff:10.0.0.5]:8000/v1").ok).toBe(true);
    expect(providerFetchSsrfGuard("http://[::ffff:127.0.0.1]:11434/v1").ok).toBe(true);
  });
});


describe("parseOpenAiModelList — vendor extensions", () => {
  // The OpenAI listing spec carries none of these, but real gateways do, and
  // context_window in particular is load-bearing: declared too low, siclaw
  // rejects long turns in preflight before the provider ever sees them.
  it("reads vLLM's max_model_len", () => {
    const [m] = parseOpenAiModelList({ data: [{ id: "qwen", max_model_len: 32768 }] });
    expect(m.context_window).toBe(32768);
  });

  it("reads OpenRouter's context_length, nested max_completion_tokens and modalities", () => {
    const [m] = parseOpenAiModelList({
      data: [{
        id: "anthropic/claude-3.5-sonnet",
        name: "Anthropic: Claude 3.5 Sonnet",
        context_length: 200000,
        top_provider: { max_completion_tokens: 8192 },
        architecture: { input_modalities: ["text", "image"] },
      }],
    });
    expect(m.context_window).toBe(200000);
    expect(m.max_tokens).toBe(8192);
    expect(m.vision).toBe(true);
    expect(m.name).toBe("Anthropic: Claude 3.5 Sonnet");
    // Still inherit, and NOT flagged — an OpenRouter Claude model speaks the
    // OpenAI protocol, so there is nothing here for the operator to correct.
    expect(m.suggested_api_type).toBe("");
    expect(m.protocol_hint).toBeUndefined();
  });

  it("reads the older architecture.modality spelling", () => {
    const [a] = parseOpenAiModelList({ data: [{ id: "m", architecture: { modality: "text+image->text" } }] });
    expect(a.vision).toBe(true);
    const [b] = parseOpenAiModelList({ data: [{ id: "m", architecture: { modality: "text->text" } }] });
    expect(b.vision).toBe(false);
  });

  // Unknown must stay undefined, not false-y guesses: the batch endpoint then
  // applies its documented default and the dialog labels it as such.
  it("leaves everything undefined for a bare spec-compliant entry", () => {
    const [m] = parseOpenAiModelList({ data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }] });
    expect(m.context_window).toBeUndefined();
    expect(m.max_tokens).toBeUndefined();
    expect(m.vision).toBeUndefined();
  });

  it("ignores a name identical to the id", () => {
    const [m] = parseOpenAiModelList({ data: [{ id: "gpt-4o", name: "gpt-4o" }] });
    expect(m.name).toBeUndefined();
  });
});

describe("parseAnthropicModelList — inherit rather than pin", () => {
  // Writing an override equal to the provider's own value looks harmless but
  // pins the row: repoint the provider at a different gateway and every
  // imported model keeps emitting the old protocol while a manually-added
  // sibling follows the provider.
  it("leaves imported rows inheriting the provider protocol", () => {
    const [m] = parseAnthropicModelList({ data: [{ id: "claude-opus-4-8" }] });
    expect(m.suggested_api_type).toBe("");
  });
});

describe("buildModelListUrl — pagination", () => {
  // Anthropic's listing defaults to 20 per page and truncates silently; the
  // newest models sort first, so the tail an operator wants is what goes
  // missing.
  it("requests the maximum page size on the Anthropic branch", () => {
    expect(buildModelListUrl("https://api.anthropic.com/v1", "anthropic-messages"))
      .toBe("https://api.anthropic.com/v1/models?limit=1000");
  });

  it("leaves the OpenAI branch unparameterised", () => {
    expect(buildModelListUrl("https://api.scitix.ai/model-api", "openai-completions"))
      .toBe("https://api.scitix.ai/model-api/models");
    expect(buildModelListUrl("https://api.scitix.ai/model-api")).toBe("https://api.scitix.ai/model-api/models");
  });
});

describe("isValidApiType", () => {
  it("accepts canonical and future pi api ids", () => {
    expect(isValidApiType("openai-completions")).toBe(true);
    expect(isValidApiType("anthropic-messages")).toBe(true);
    // Not an enum on purpose — a newly registered pi api must work without a
    // siclaw release.
    expect(isValidApiType("openai-responses")).toBe(true);
  });

  // A typo otherwise reaches pi's registry verbatim and kills every turn on the
  // model with "No API provider registered for api: …".
  it("rejects typos, wrong case and junk", () => {
    expect(isValidApiType("Anthropic-Messages")).toBe(false);
    expect(isValidApiType("anthropic messages")).toBe(false);
    expect(isValidApiType("-leading-dash")).toBe(false);
    expect(isValidApiType("2fast")).toBe(false);
  });

  it("rejects values that would overflow VARCHAR(50)", () => {
    expect(isValidApiType("a".repeat(50))).toBe(true);
    expect(isValidApiType("a".repeat(51))).toBe(false);
  });
});

describe("providerFetchSsrfGuard — non-dotted IPv4 literals", () => {
  // getaddrinfo's inet_aton accepts decimal/octal/hex forms; all of these reach
  // 169.254.169.254, and a dotted-quad-only regex sees none of them.
  it.each([
    "http://2852039166/v1",
    "http://0251.0376.0251.0376/v1",
    "http://0xA9FEA9FE/v1",
    "http://169.254.43518/v1",
  ])("blocks metadata spelled as %s", (url) => {
    expect(providerFetchSsrfGuard(url).ok).toBe(false);
  });

  it("still allows ordinary hosts that merely start with digits", () => {
    expect(providerFetchSsrfGuard("http://10.0.0.5:8000/v1").ok).toBe(true);
    expect(providerFetchSsrfGuard("https://3.example.com/v1").ok).toBe(true);
  });
});
