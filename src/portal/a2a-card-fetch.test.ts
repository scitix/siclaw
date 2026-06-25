import { describe, it, expect, vi } from "vitest";
import { fetchRemoteAgentCard } from "./siclaw-api.js";

function res(status: number, text: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
}

describe("fetchRemoteAgentCard", () => {
  it("fetches /.well-known/agent-card.json and returns the raw JSON text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, '{"name":"Peer","version":"1.0"}'));
    const out = await fetchRemoteAgentCard("https://peer/a2a/agents/x", undefined, fetchImpl as never);
    expect(out).toBe('{"name":"Peer","version":"1.0"}');
    expect(fetchImpl.mock.calls[0][0]).toBe("https://peer/a2a/agents/x/.well-known/agent-card.json");
  });

  it("trims a trailing slash on the base url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, "{}"));
    await fetchRemoteAgentCard("https://peer/a/", undefined, fetchImpl as never);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://peer/a/.well-known/agent-card.json");
  });

  it("sends a bearer header when an api key is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, "{}"));
    await fetchRemoteAgentCard("https://peer/a", "sk-card", fetchImpl as never);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-card");
  });

  it("returns null on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, "not found"));
    expect(await fetchRemoteAgentCard("https://peer/a", undefined, fetchImpl as never)).toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, "<html>nope</html>"));
    expect(await fetchRemoteAgentCard("https://peer/a", undefined, fetchImpl as never)).toBeNull();
  });

  it("returns null when the card exceeds the size cap", async () => {
    const huge = '{"x":"' + "a".repeat(70 * 1024) + '"}';
    const fetchImpl = vi.fn().mockResolvedValue(res(200, huge));
    expect(await fetchRemoteAgentCard("https://peer/a", undefined, fetchImpl as never)).toBeNull();
  });

  it("returns null (never throws) on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await fetchRemoteAgentCard("https://peer/a", undefined, fetchImpl as never)).toBeNull();
  });
});
