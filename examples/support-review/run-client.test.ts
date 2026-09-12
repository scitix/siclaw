import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTicketReviewResultServer } from "../../mcp/ticket-review-result/src/server.js";
import { createProductSupportResultServer } from "../../mcp/product-support-result/src/server.js";
import { drafts } from "../../mcp/ticket-review-result/test/fixtures.js";
import { reviewText, runSupport, runTicketReview, type ReviewContext } from "./run-client.js";

const options = () => ({ baseUrl: "https://agent.example", apiKey: "synthetic-key", signal: AbortSignal.timeout(2000) });
const session = { sessionId: "session-review", turnId: "turn-review" };
const encode = (event: string, data: unknown) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const contextFor = (draft = drafts[0]): ReviewContext => ({
  ticket: { id: draft.ticket_id, status: "closed", revision: "completion-1", title: "Synthetic completed ticket" },
  records: draft.evidence.map((e) => ({ ...e, time: "2026-01-01T00:00:00Z", text: "Supplied synthetic handling record.", ...(e.source === "group_message" ? { chat_id: "chat-example" } : {}) })),
  coverage: { complete: draft.evidence.length > 0, missing: draft.evidence.length ? [] : ["handling records unavailable"] },
});

function response(text: string, stride = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += stride));
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function serve(text: string, stride = 7) {
  const fetch = vi.fn().mockResolvedValue(response(text, stride));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("supplied ticket context", () => {
  it("keeps records inside text and permits honest incomplete reviews", () => {
    expect(reviewText(contextFor())).toContain('"revision":"completion-1"');
    const context = contextFor(drafts[5]);
    delete context.ticket.title;
    expect(reviewText(context)).toContain("handling records unavailable");
  });

  it("rejects unfinished, duplicate, unbounded or inconsistent context before sending", () => {
    const context = contextFor();
    for (const candidate of [
      { ...context, ticket: { ...context.ticket, status: "open" } },
      { ...context, records: [...context.records, ...context.records] },
      { ...context, coverage: { complete: false, missing: [] } },
      { ...context, coverage: { complete: true, missing: ["unread"] } },
      { ...context, records: [{ ...context.records[0], text: "x".repeat(270000) }] },
      { ...context, records: [{ ...context.records[0], source: "group_message", chat_id: "" }] },
    ]) expect(() => reviewText(candidate as ReviewContext)).toThrow();
  });
});

describe("strict API result consumer", () => {
  it.each([1, 2, 7, 10000])("accepts CRLF and Unicode across chunks of %i bytes", async (stride) => {
    const draft = { ...drafts[0], type: "Example Δ category" };
    const fetch = serve(": heartbeat\r\n\r\n" + encode("session", session) + encode("chat.event", { type: "text", text: "Complete" }) + encode("result", draft) + encode("done", {}), stride);
    const onChatEvent = vi.fn();
    const value = await runTicketReview({ ...options(), onChatEvent }, contextFor());
    expect(value).toEqual({ ...session, result: draft });
    expect(onChatEvent).toHaveBeenCalledWith({ type: "text", text: "Complete" });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("error");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["stream", "text"]);
    expect(body.text).not.toContain('"expected"');
  });

  it.each([
    [encode("result", drafts[0]) + encode("done", {}), "RUN_RESULT_SEQUENCE"],
    [encode("session", session) + encode("done", {}), "RUN_RESULT_MISSING"],
    [encode("session", session) + encode("result", drafts[0]), "RUN_INTERRUPTED"],
    [encode("session", session) + encode("result", drafts[0]) + encode("result", drafts[0]) + encode("done", {}), "RUN_RESULT_SEQUENCE"],
    [encode("session", session) + encode("result", drafts[0]) + encode("error", { code: "RUN_FAILED", retriable: true }), "RUN_FAILED"],
    [encode("session", session) + encode("result", { ...drafts[0], ticket_id: "another-ticket" }) + encode("done", {}), "REVIEW_TICKET_MISMATCH"],
    [encode("session", session) + encode("result", { ...drafts[0], evidence: [{ source: "attachment", id: "unread" }] }) + encode("done", {}), "REVIEW_EVIDENCE_NOT_SUPPLIED"],
    [encode("session", session) + encode("result", { ...drafts[0], evidence: [] }) + encode("done", {}), "RUN_INVALID_RESULT"],
    [encode("session", session) + "event: result\ndata: not-json\n\n", "RUN_INVALID_JSON"],
  ])("rejects a failed or invalid result: %s", async (wire, code) => {
    serve(wire);
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code });
  });

  it("checks resumed session identity and rejects oversized frames", async () => {
    serve(encode("session", session));
    await expect(runTicketReview({ ...options(), sessionId: "different-session" }, contextFor())).rejects.toMatchObject({ code: "RUN_SESSION_MISMATCH" });
    serve("data: " + "x".repeat(140000), 150000);
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code: "RUN_FRAME_TOO_LARGE" });
  });

  it("refuses a ready draft when the caller declares unavailable material", async () => {
    serve(encode("session", session) + encode("result", drafts[0]) + encode("done", {}));
    await expect(runTicketReview(options(), { ...contextFor(), coverage: { complete: false, missing: ["unread handling page"] } })).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE_COVERAGE", retriable: false });
  });

  it("rejects non-SSE success, classifies HTTP retry, and refuses plaintext remote keys", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code: "RUN_HTTP_200", retriable: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("busy", { status: 429 })));
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ retriable: true });
    await expect(runTicketReview({ ...options(), baseUrl: "http://agent.example" }, contextFor())).rejects.toMatchObject({ code: "INVALID_RUN_URL" });
  });

  it("classifies transport loss and cancellation without accepting partial results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network failure")));
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code: "RUN_TRANSPORT_ERROR", retriable: true });
    await expect(runTicketReview({ ...options(), signal: AbortSignal.abort() }, contextFor())).rejects.toMatchObject({ code: "RUN_ABORTED", retriable: false });
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("socket lost")); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(broken, { headers: { "Content-Type": "text/event-stream" } })));
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code: "RUN_TRANSPORT_ERROR", retriable: true });
  });

  it("rejects invalid UTF-8 without replacing it with fabricated characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "text/event-stream" } })));
    await expect(runTicketReview(options(), contextFor())).rejects.toMatchObject({ code: "RUN_INVALID_UTF8", retriable: false });
  });

  it("consumes actual validated MCP outputs for both roles without mixing contracts", async () => {
    for (const role of ["support", "review"] as const) {
      const server = role === "review" ? createTicketReviewResultServer() : createProductSupportResultServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "support-review-consumer-test", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.listTools();
        const values = role === "review" ? drafts : [{ label: true, info: { ticket_type: "unknown", product: "", summary: "Human help requested", description: "The user cannot clarify and requests human help.", evidence: [], missing_fields: [] } }];
        for (const value of values) {
          const result = await client.callTool({ name: role === "review" ? "submit_ticket_review_result" : "submit_product_support_result", arguments: value }, CallToolResultSchema);
          expect(result.isError).not.toBe(true);
          serve(encode("session", session) + encode("result", result.structuredContent) + encode("done", {}));
          const received = role === "review" ? await runTicketReview(options(), contextFor(value as typeof drafts[0])) : await runSupport(options(), "I need human help");
          expect(received.result).toEqual(result.structuredContent);
        }
        serve(encode("session", session) + encode("result", drafts[0]) + encode("done", {}));
        await expect(runSupport(options(), "I need help")).rejects.toMatchObject({ code: "RUN_INVALID_RESULT" });
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
});
