import { afterEach, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { AgentBoxClient } from "./client.js";

let server: http.Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});
async function client(handler: http.RequestListener) {
  server = http.createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return new AgentBoxClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
}
it("permits authenticated invocation transport on local loopback without mTLS", async () => {
  const c = await client((req, res) => {
    expect(req.url).toBe("/api/internal/sandbox-tool");
    expect(req.method).toBe("POST"); req.resume(); res.end(JSON.stringify({ protocol: 1, ok: true, result: { text: "ok" } }));
  });
  await expect(c.sandboxTool({ callback_token: "fixture" }, new AbortController().signal)).resolves.toEqual({ text: "ok" });
});
it("rejects remote cleartext and HTTPS without credentials before connecting", async () => {
  for (const endpoint of ["http://192.0.2.1", "https://example.invalid"]) {
    await expect(new AgentBoxClient(endpoint).sandboxTool({}, new AbortController().signal)).rejects.toThrow();
  }
});
it("bounds tool response memory", async () => {
  const c = await client((_req, res) => res.end(JSON.stringify({ text: "a".repeat(4 * 1024 * 1024) })));
  await expect(c.sandboxTool({}, new AbortController().signal)).rejects.toThrow();
});
it("treats unstructured HTTP errors as unknown execution, not proof of rejection", async () => {
  const c = await client((_req, res) => { res.writeHead(403); res.end("upstream proxy failure"); });
  await expect(c.sandboxTool({}, new AbortController().signal)).rejects.toMatchObject({ execution: "UNKNOWN", retainsCapacity: true });
});
it("preserves confirmed failure and cleanup state from the trusted callback", async () => {
  const c = await client((_req, res) => res.end(JSON.stringify({ protocol: 1, ok: false,
    code: "CLEANUP_PENDING", execution: "FINISHED", cleanup: "pending", result: { text: "completed output" } })));
  await expect(c.sandboxTool({}, new AbortController().signal)).rejects.toMatchObject({ execution: "FINISHED", cleanup: "pending",
    retainsCapacity: true, result: { text: "completed output" } });
});
it("transports complete data above the inline preview limit", async () => {
  const text = "node row\n".repeat(30_000);
  const c = await client((_req, res) => res.end(JSON.stringify({ protocol: 1, ok: true, result: { text } })));
  await expect(c.sandboxTool({}, new AbortController().signal)).resolves.toEqual({ text });
});
it("cancels the HTTP connection while waiting for a tool", async () => {
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const c = await client(req => { req.resume(); started(); });
  const controller = new AbortController();
  const result = c.sandboxTool({}, controller.signal);
  const assertion = expect(result).rejects.toThrow();
  await entered; controller.abort(); await assertion;
});
