// Synthetic observability MCP for planning replays. No live infrastructure or model mocks.
// Run with node scripts/smoke/planning-fixture.mjs; expose only to the test agents.
import http from "node:http";
import { pathToFileURL } from "node:url";

const string = { type: "string" };
const number = { type: "number" };
const tool = (name, description, properties, required = Object.keys(properties)) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const fixtureTools = [
  tool("service_status", "Return the current status of one named demo service.", { service: string }),
  tool("source_catalog", "Find observability sources available for one demo service.", { service: string }),
  tool("request_search", "Find slow requests in a bounded lookback window. Requires the request source id.", {
    source_id: string, service: string, lookback_minutes: { type: "integer", minimum: 1, maximum: 120 },
  }),
  tool("trace_get", "Read timestamped spans and completeness for a trace id returned by request_search.", { trace_id: string }),
  tool("timeline_verify", "Check a proposed elapsed-time attribution against the source trace. This read-only check may fail; inspect its result.", {
    trace_id: string, critical_path_ms: number, retry_wait_ms: number,
  }),
];

const services = new Set(["checkout-demo", "checkout-empty", "checkout-gap", "checkout-unavailable"]);
const spans = [
  { id: "root", parent: null, name: "request", start_ms: 0, end_ms: 1200 },
  { id: "route", parent: "root", name: "routing", start_ms: 0, end_ms: 100 },
  { id: "inventory", parent: "root", name: "inventory", start_ms: 100, end_ms: 300 },
  { id: "fraud", parent: "root", name: "fraud-check", start_ms: 100, end_ms: 500 },
  { id: "pay", parent: "root", name: "payment", start_ms: 500, end_ms: 1100 },
  { id: "pay-1", parent: "pay", name: "payment-attempt-1", start_ms: 500, end_ms: 560, outcome: "retryable" },
  { id: "pay-2", parent: "pay", name: "payment-attempt-2", start_ms: 760, end_ms: 820, outcome: "retryable" },
  { id: "pay-3", parent: "pay", name: "payment-attempt-3", start_ms: 1020, end_ms: 1100, outcome: "ok" },
  { id: "response", parent: "root", name: "response", start_ms: 1100, end_ms: 1200 },
];
const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ ...ok({ error }), isError: true });

export function callFixture(name, args) {
  if (["service_status", "source_catalog", "request_search"].includes(name) && !services.has(args.service)) {
    return fail("Unknown service");
  }
  if (name === "service_status") return ok({ service: args.service, status: "healthy", replicas: 3 });
  if (name === "source_catalog") return ok({
    service: args.service, request_source_id: "demo-requests-v1", time_basis: "lookback_minutes",
    available_tools: ["request_search", "trace_get", "timeline_verify"],
  });
  if (name === "request_search") {
    if (args.source_id !== "demo-requests-v1") return fail("Unknown request source id");
    if (!Number.isInteger(args.lookback_minutes) || args.lookback_minutes < 1 || args.lookback_minutes > 120) {
      return fail("Lookback must be an integer between 1 and 120 minutes");
    }
    if (args.service === "checkout-unavailable") return fail("Request index unavailable; query timed out. No rows were retrieved.");
    const age = args.service === "checkout-empty" ? 45 : 10;
    return ok({ service: args.service, lookback_minutes: args.lookback_minutes,
      requests: args.lookback_minutes < age ? [] : [{
        request_id: `req-${args.service}`, trace_id: `trace-${args.service}`,
        age_minutes: age, duration_ms: 1200, status: 200,
      }],
    });
  }
  const service = String(args.trace_id ?? "").replace(/^trace-/, "");
  if (!services.has(service) || service === "checkout-unavailable") return fail("Trace not found");
  if (name === "trace_get") return ok({
    trace_id: args.trace_id, duration_ms: 1200, complete: service !== "checkout-gap",
    spans: service === "checkout-gap" ? spans.filter((s) => !s.id.startsWith("pay")) : spans,
    dependencies: ["routing precedes inventory and fraud-check", "payment waits for both inventory and fraud-check", "response waits for payment"],
    ...(service === "checkout-gap"
      ? { missing: "payment subtree is absent; the 500–1100 ms interval cannot be attributed from this trace" }
      : { retry_events: [{ offset_ms: 560, backoff_ms: 200 }, { offset_ms: 820, backoff_ms: 200 }] }),
  });
  if (name === "timeline_verify") {
    if (service === "checkout-gap") return fail("Cannot verify full attribution: payment subtree is missing");
    if (args.critical_path_ms !== 1200 || args.retry_wait_ms !== 400) {
      return fail("Attribution mismatch. Recheck overlap, parent/child spans, and retry backoff against trace_get.");
    }
    return ok({ verified: true, critical_path_ms: 1200, retry_wait_ms: 400, source: args.trace_id });
  }
  return fail("Unknown tool");
}

export const skillFixture = {
  name: "demo-request-latency",
  description: "Investigate slow requests and build a trace timeline for checkout demo services using the observability MCP.",
  specs: `---
name: demo-request-latency
description: Investigate slow requests and build a trace timeline for checkout demo services using the observability MCP.
---

# Demo request latency

Use source_catalog to find the request source, then request_search within the
user's time window. Expand only when the user permitted a fallback and its trigger
is met. Use a returned trace id with trace_get. Start/end offsets are relative to
request start, in milliseconds. Parent/child spans and concurrent branches overlap;
derive the critical path from dependencies, do not sum all span durations.
For a complete trace, check the derived elapsed time and retry waiting using
timeline_verify before describing the attribution as verified. If data is absent
or a query fails, report the evidence gap. Do not fabricate requests or timing.
Include request/trace ids, timeline, attribution, and limitations in the result.
`,
};

export const planningCases = [
  { id: "direct", prompt: "查一下 checkout-demo 当前是否健康，简短回答即可。" },
  { id: "discovery", prompt: "分析 checkout-demo 最近30分钟的一条慢请求，画出时间线并核对耗时归因。我不知道这里的数据源和排查流程，请自行查明。不要修改服务。" },
  { id: "known", prompt: "已知请求源 demo-requests-v1，checkout-demo 最近30分钟有慢请求。使用 request_search 返回的 trace_id 调 trace_get，按依赖与重叠关系归因，用 timeline_verify 核验后给出时间线。数据源和流程已确认，无需重新查目录；不要修改服务。" },
  { id: "fallback", prompt: "分析 checkout-empty 最近30分钟一条慢请求并核验时间线。仅当30分钟内没有可用样本时，允许扩大到最近2小时；禁止查更早的数据。不要修改服务。" },
  { id: "bounded", prompt: "分析 checkout-empty 最近15分钟一条慢请求并核验时间线。只允许这15分钟，不要扩大范围；没有样本就如实说明。不要修改服务。" },
  { id: "incomplete", prompt: "分析 checkout-gap 最近30分钟一条慢请求，给出时间线与耗时归因，核验后说明哪些结论有证据。不要修改服务。" },
  { id: "query_error", prompt: "分析 checkout-unavailable 最近30分钟一条慢请求并核验时间线。不要扩大窗口，不要修改服务。" },
  { id: "proposal", prompt: "为 checkout-demo 最近30分钟慢请求排查写一个可直接执行的方案，现在不要查询实时请求或执行排查。可以阅读操作指南。写清关键步骤、时间窗口约束、分支条件和如何验收。" },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  http.createServer(async (req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(405).end(); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) { res.writeHead(413).end(); return; }
      }
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "planning-fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: fixtureTools }
          : message.method === "tools/call" ? callFixture(message.params.name, message.params.arguments ?? {})
            : message.method === "ping" ? {} : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: message.id, result }));
    } catch {
      res.writeHead(400).end("Invalid request");
    }
  }).listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log("Planning fixture ready"));
}
