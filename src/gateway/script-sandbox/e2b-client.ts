import { record } from "../../script-sandbox/validation.js";
import type { ScriptSandboxConfig } from "../../script-sandbox/types.js";

type Config = NonNullable<ScriptSandboxConfig["e2b"]>;
export interface E2bInstance { id: string; url: string; accessToken: string }

/** Narrow E2B REST / envd Connect-JSON adapter; no SDK in the runner image.
 * Contract: e2b-dev/E2B e0082d40235dcc57d30df013f610a39e0e89963e,
 * spec/openapi.yml and packages/js-sdk/src/envd/process/process_pb.ts.
 */
export class E2bClient {
  constructor(private readonly config: Config, private readonly http: typeof fetch = fetch) {}

  private async request(url: string, init: RequestInit): Promise<Response> {
    const response = await this.http(url, { ...init, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("E2B request failed"); }
    return response;
  }

  async create(lifetime: number, signal: AbortSignal): Promise<E2bInstance> {
    const response = await this.request(new URL("/sandboxes", this.config.apiUrl).href, {
      method: "POST", headers: { "X-API-Key": this.config.apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      body: JSON.stringify({ templateID: this.config.template, timeout: lifetime, secure: true,
        allow_internet_access: true, network: { allowPublicTraffic: false }, metadata: { purpose: "siclaw-script" } }),
    });
    const value = await readJson(response, 16 * 1024);
    if (!record(value) || typeof value.sandboxID !== "string" || !/^[a-z0-9-]{1,128}$/.test(value.sandboxID)) throw new Error("Invalid E2B sandbox response");
    try {
      if (typeof value.envdAccessToken !== "string" || !value.envdAccessToken || /\s/.test(value.envdAccessToken)) throw new Error("E2B secure envd required");
      const domain = value.domain || this.config.domain;
      if (typeof domain !== "string" || !(domain === this.config.domain || domain.endsWith(`.${this.config.domain}`)) || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("Unexpected E2B domain");
      return { id: value.sandboxID, url: `https://49983-${value.sandboxID}.${domain}`, accessToken: value.envdAccessToken };
    } catch (error) { await this.kill(value.sandboxID).catch(() => {}); throw error; }
  }

  async kill(id: string): Promise<void> {
    const response = await this.http(new URL(`/sandboxes/${encodeURIComponent(id)}`, this.config.apiUrl).href, {
      method: "DELETE", headers: { "X-API-Key": this.config.apiKey }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw new Error("E2B cleanup failed");
  }

  private headers(instance: E2bInstance): Record<string, string> {
    return { "X-Access-Token": instance.accessToken, Authorization: "Basic cm9vdDo=",
      "E2b-Sandbox-Id": instance.id, "E2b-Sandbox-Port": "49983", "Connect-Protocol-Version": "1" };
  }

  async input(instance: E2bInstance, pid: number, frame: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(`${instance.url}/process.Process/SendInput`, {
      method: "POST", headers: { ...this.headers(instance), "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      body: JSON.stringify({ process: { pid }, input: { stdin: Buffer.from(frame).toString("base64") } }),
    });
    await readJson(response, 4096);
  }

  async *start(instance: E2bInstance, isolated: boolean, lifetime: number, signal: AbortSignal): AsyncGenerator<Record<string, any>> {
    const json = Buffer.from(JSON.stringify({ process: { cmd: "/usr/local/bin/python3", args: ["-I", "-B", "-u", "/opt/siclaw/e2b-relay.py", isolated ? "isolated" : "standard", String(lifetime)], cwd: "/work" }, stdin: true }));
    const header = Buffer.alloc(5); header.writeUInt32BE(json.length, 1);
    const response = await this.request(`${instance.url}/process.Process/Start`, {
      method: "POST", headers: { ...this.headers(instance), "Content-Type": "application/connect+json" },
      body: Buffer.concat([header, json]), signal,
    });
    if (!response.headers.get("content-type")?.startsWith("application/connect+json") || !response.body) throw new Error("Invalid E2B command stream");
    const reader = response.body.getReader();
    let buffer = Buffer.alloc(0);
    let ended = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = Buffer.concat([buffer, value]);
        while (buffer.length >= 5) {
          const length = buffer.readUInt32BE(1);
          if (length > 1024 * 1024 || ended) throw new Error("Invalid E2B stream envelope");
          if (buffer.length < length + 5) break;
          const flags = buffer[0];
          const message = JSON.parse(buffer.subarray(5, 5 + length).toString("utf8"));
          buffer = buffer.subarray(5 + length);
          if (flags === 2) {
            if (!record(message) || message.error) throw new Error("E2B command failed");
            ended = true;
          } else if (flags === 0 && record(message) && record(message.event)) yield message.event;
          else throw new Error("Invalid E2B stream frame");
        }
        if (buffer.length > 1024 * 1024 + 5) throw new Error("E2B stream exceeds limit");
      }
      if (!ended || buffer.length) throw new Error("Incomplete E2B command stream");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Empty E2B response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if ((size += value.length) > limit) throw new Error("E2B response exceeds limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
