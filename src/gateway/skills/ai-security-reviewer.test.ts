import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before the import pulls in getDb at module eval.
vi.mock("../db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../db.js";
import { evaluateScriptsAI } from "./ai-security-reviewer.js";
import type { SecurityFinding } from "./script-evaluator.js";

// ── Helpers ─────────────────────────────────────────────────────────

function mockProviderAndModel(hasProvider = true, hasModel = true) {
  const provider = [{ id: "p1", base_url: "https://api.example.com/v1", api_key: "sk-test", api_type: "openai" }];
  const model = [{ model_id: "gpt-4o-mini" }];
  const query = vi.fn()
    .mockResolvedValueOnce([hasProvider ? provider : [], []])
    .mockResolvedValueOnce([hasModel ? model : [], []]);
  (getDb as any).mockReturnValue({ query });
  return query;
}

/** Stub global fetch with a JSON response wrapper. */
function mockFetchWithContent(content: string, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => "err-body",
  });
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

function staticFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    category: "destructive_command",
    severity: "critical",
    pattern: "rm -rf",
    match: "rm -rf /",
    scriptName: "bad.sh",
    line: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore native fetch in case a test swapped it out.
  // @ts-ignore
  delete (globalThis as any).fetch;
});

// ── Guard: no model provider ───────────────────────────────────────

describe("evaluateScriptsAI — provider discovery", () => {
  it("returns null when no model provider is configured", async () => {
    mockProviderAndModel(false, false);
    const res = await evaluateScriptsAI([{ name: "s.sh", content: "echo hi" }], []);
    expect(res).toBeNull();
  });

  it("returns null when provider exists but no model entry is registered", async () => {
    mockProviderAndModel(true, false);
    const res = await evaluateScriptsAI([{ name: "s.sh", content: "echo hi" }], []);
    expect(res).toBeNull();
  });
});

// ── Happy path: AI response merged with static findings ────────────

describe("evaluateScriptsAI — successful AI review", () => {
  it("parses a clean JSON response and merges findings with static ones", async () => {
    mockProviderAndModel();
    const aiContent = JSON.stringify({
      risk_level: "high",
      findings: [
        {
          category: "data_exfiltration",
          severity: "high",
          description: "curl POST to external host",
          scriptName: "bad.sh",
          line: 10,
        },
      ],
      summary: "Script uploads data.",
    });
    mockFetchWithContent(aiContent);

    const statics = [staticFinding({ severity: "low", line: 1, category: "info_gathering" })];
    const res = await evaluateScriptsAI([{ name: "bad.sh", content: "curl ..." }], statics);

    expect(res).not.toBeNull();
    expect(res!.risk_level).toBe("high"); // AI "high" > static "low"
    // Static finding preserved and AI finding appended
    expect(res!.findings).toHaveLength(2);
    expect(res!.findings.some(f => f.category === "data_exfiltration")).toBe(true);
    expect(res!.summary).toContain("AI:");
    expect(res!.summary).toContain("Script uploads data.");
  });

  it("strips markdown code fences around the JSON response", async () => {
    mockProviderAndModel();
    const content = "```json\n" + JSON.stringify({
      risk_level: "safe",
      findings: [],
      summary: "ok",
    }) + "\n```";
    mockFetchWithContent(content);

    const res = await evaluateScriptsAI([{ name: "s.sh", content: "echo" }], []);
    expect(res).not.toBeNull();
    expect(res!.risk_level).toBe("safe");
  });

  it("picks the higher of static vs AI risk level", async () => {
    mockProviderAndModel();
    mockFetchWithContent(JSON.stringify({
      risk_level: "low",
      findings: [],
      summary: "minor",
    }));
    const statics = [staticFinding({ severity: "critical" })];
    const res = await evaluateScriptsAI([{ name: "x.sh", content: "rm -rf /" }], statics);
    expect(res!.risk_level).toBe("critical"); // static "critical" wins over AI "low"
  });

  it("normalizes invalid AI severity to 'medium'", async () => {
    mockProviderAndModel();
    mockFetchWithContent(JSON.stringify({
      risk_level: "medium",
      findings: [{
        category: "x",
        severity: "REALLY_BAD",
        description: "?",
        scriptName: "s.sh",
        line: 1,
      }],
      summary: "n/a",
    }));
    const res = await evaluateScriptsAI([{ name: "s.sh", content: "echo" }], []);
    expect(res!.findings[0].severity).toBe("medium");
  });

  it("de-duplicates merged findings by category+scriptName+line", async () => {
    mockProviderAndModel();
    // AI returns a finding identical to a static one — should not be duplicated.
    mockFetchWithContent(JSON.stringify({
      risk_level: "high",
      findings: [{
        category: "destructive_command",
        severity: "high",
        description: "same",
        scriptName: "bad.sh",
        line: 3,
      }],
      summary: "dup",
    }));
    const statics = [staticFinding()];
    const res = await evaluateScriptsAI([{ name: "bad.sh", content: "rm" }], statics);
    expect(res!.findings).toHaveLength(1);
  });

  it("defaults missing AI finding fields sensibly", async () => {
    mockProviderAndModel();
    mockFetchWithContent(JSON.stringify({
      risk_level: "medium",
      findings: [{
        severity: "medium",
        description: "no cat",
        // category missing → should fall back to "ai_review"
        // scriptName missing → "unknown"
        // line missing → 0
      }],
      summary: "s",
    }));
    const res = await evaluateScriptsAI([{ name: "x", content: "y" }], []);
    const f = res!.findings[0];
    expect(f.category).toBe("ai_review");
    expect(f.scriptName).toBe("unknown");
    expect(f.line).toBe(0);
  });
});

// ── Failure modes ──────────────────────────────────────────────────

describe("evaluateScriptsAI — failure modes", () => {
  it("returns null when the LLM response is unparseable JSON", async () => {
    mockProviderAndModel();
    mockFetchWithContent("this is not json at all");
    const res = await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    expect(res).toBeNull();
  });

  it("returns null when the AI JSON is missing required fields", async () => {
    mockProviderAndModel();
    // Missing 'summary'
    mockFetchWithContent(JSON.stringify({ risk_level: "low", findings: [] }));
    const res = await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    expect(res).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    mockProviderAndModel();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("econnrefused")) as any;
    const res = await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    expect(res).toBeNull();
  });

  it("returns null when the LLM HTTP response is non-ok", async () => {
    mockProviderAndModel();
    mockFetchWithContent("", false, 500);
    const res = await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    expect(res).toBeNull();
  });

  it("returns null when the DB itself throws", async () => {
    (getDb as any).mockImplementation(() => { throw new Error("db down"); });
    const res = await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    expect(res).toBeNull();
  });
});

// ── Request shape ──────────────────────────────────────────────────

describe("evaluateScriptsAI — HTTP request shape", () => {
  it("posts to {base_url}/chat/completions with Bearer auth and JSON body", async () => {
    mockProviderAndModel();
    const fetchMock = mockFetchWithContent(JSON.stringify({
      risk_level: "safe", findings: [], summary: "",
    }));

    await evaluateScriptsAI([{ name: "s.sh", content: "echo 1" }], []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.temperature).toBe(0);
  });

  it("omits Authorization header when provider has no api_key", async () => {
    const provider = [{ id: "p1", base_url: "http://local", api_key: "", api_type: "openai" }];
    const model = [{ model_id: "m" }];
    const query = vi.fn()
      .mockResolvedValueOnce([provider, []])
      .mockResolvedValueOnce([model, []]);
    (getDb as any).mockReturnValue({ query });

    const fetchMock = mockFetchWithContent(JSON.stringify({
      risk_level: "safe", findings: [], summary: "",
    }));

    await evaluateScriptsAI([{ name: "s", content: "c" }], []);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Authorization"]).toBeUndefined();
  });
});
