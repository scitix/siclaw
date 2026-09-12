import { SCRIPT_STARTUP_MS, TOOL_CALLBACK_MS, NODE_CALLBACK_MS } from "./budgets.js";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ScriptFrameParser, encodeScriptFrame } from "./protocol.js";
import { record, resolveScriptLimits, validateScriptRequest } from "./validation.js";
import { ScriptTrafficBusyError } from "./traffic.js";
import { SandboxToolError } from "./errors.js";
import { sanitizeSandboxResult } from "./sanitize.js";
import { postExecSecurity } from "../tools/infra/security-pipeline.js";
import { redactSensitiveContent } from "../tools/infra/kubectl-sanitize.js";
import { ScriptResultTransfer, ScriptResultLimitError, SCRIPT_INLINE_RESULT_BYTES, SCRIPT_RUN_FILE_BYTES, SCRIPT_RESULT_CHUNK_BYTES } from "./result-transfer.js";
import { ScriptSandboxError, type ScriptChannel, type ScriptPrincipal, type ScriptRequest, type ScriptResult, type ScriptSandboxConfig, type ScriptSandboxProvider, type ScriptToolCall } from "./types.js";

export interface ScriptBroker {
  authorize(principal: ScriptPrincipal, signal: AbortSignal): Promise<void>;
  call(principal: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<unknown>;
  /** Required for file delivery; reauthorizes the original operation's resource. */
  authorizeResult?(principal: ScriptPrincipal, scope: ScriptRequest, call: ScriptToolCall, signal: AbortSignal): Promise<void>;
}

/** Runtime owns channels and authorization. The runner is untrusted, including its RPC. */
export class ScriptSandboxService {
  private active = new Set<AbortController>();
  private stopped = false;
  private completions = new Set<Promise<void>>();
  constructor(private readonly config: ScriptSandboxConfig, private readonly provider: ScriptSandboxProvider, private readonly broker: ScriptBroker) {}

  async run(raw: unknown, principal: ScriptPrincipal, signal?: AbortSignal): Promise<ScriptResult> {
    if (!this.config.enabled || this.stopped) throw new ScriptSandboxError("Script sandbox is disabled", 503);
    const request = validateScriptRequest(raw);
    const startFrame = encodeScriptFrame({ type: "start", language: request.language, code: request.code, input: request.input ?? null });
    if (this.active.size >= this.config.maxConcurrentRuns) throw new ScriptSandboxError("Script sandbox is busy; retry later", 429);
    const controller = new AbortController();
    this.active.add(controller);
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    this.completions.add(completion);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const started = Date.now();
    const limits = resolveScriptLimits(request, this.config);
    const result: ScriptResult = { run_id: randomUUID(), status: "failed", exit_code: null, stdout: "", stderr: "", output_truncated: false,
      network_isolation: limits.isolated, tool_calls: 0, duration_ms: 0, startup_ms: 0, warm: false };
    principal = { ...principal, runId: result.run_id };
    let channel: ScriptChannel | undefined;
    let timedOut = false;
    let timer = setTimeout(() => { timedOut = true; controller.abort(new Error("startup timeout")); }, SCRIPT_STARTUP_MS);
    try {
      await this.broker.authorize(principal, controller.signal);
      controller.signal.throwIfAborted();
      const startup = Date.now();
      channel = await this.provider.start(result.run_id, limits.isolated, limits.timeout, controller.signal);
      result.startup_ms = Date.now() - startup;
      result.warm = channel.warm === true;
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      principal.deadlineMs = Date.now() + limits.timeout * 1000;
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeout * 1000);
      await this.execute(channel, startFrame, principal, request, result, limits.timeout, controller.signal);
      result.status = result.exit_code === 0 ? "completed" : "failed";
    } catch (error) {
      result.status = timedOut ? "timed_out" : controller.signal.aborted ? "cancelled" : "failed";
      // Connector and Kubernetes exceptions can contain credentials; do not relay them.
      if (error instanceof SandboxToolError) result.cleanup = error.cleanup;
      result.error = error instanceof SandboxToolError ? error.message : "Script execution denied, interrupted or unavailable";
      if (!channel && !controller.signal.aborted && error instanceof ScriptSandboxError) throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      result.cleanup = channel ? "pending" : result.cleanup ?? "not_required";
      if (channel) {
        try { await channel.close(); result.cleanup = "confirmed"; }
        catch { console.warn("[script-sandbox] Instance cleanup failed"); }
      }
      this.completions.delete(completion);
      complete();
      this.active.delete(controller);
      signal?.removeEventListener("abort", abort);
      result.duration_ms = Date.now() - started;
      const { callbackToken: _token, ...audit } = principal;
      console.info(JSON.stringify({ event: "script_run", ...audit, runId: result.run_id, instanceId: channel?.instanceId,
        codeHash: createHash("sha256").update(request.code).digest("hex"), status: result.status, isolated: limits.isolated,
        toolCalls: result.tool_calls, durationMs: result.duration_ms, startupMs: result.startup_ms, warm: result.warm }));
    }
    // Code can print supplied input, transformed tool results or literal secrets.
    // Apply the shared document security pipeline before history/model exposure.
    postExecSecurity(result.stdout, { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: false }, {
      outputMode: "data", stderr: result.stderr, onOutputData: safe => {
        result.stdout = safe.text; result.stderr = safe.stderr;
        result.notices = safe.notices;
      },
    });
    if (result.cleanup === "pending") (result.notices ??= []).push("Instance cleanup is unconfirmed; do not automatically retry this run.");
    let remaining = this.config.maxOutputBytes;
    for (const name of ["stdout", "stderr"] as const) {
      const bytes = Buffer.from(result[name]);
      let end = Math.min(bytes.length, remaining);
      while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      result[name] = bytes.subarray(0, end).toString("utf8");
      result.output_truncated ||= end < bytes.length;
      remaining -= end;
    }
    return result;
  }

  private execute(channel: ScriptChannel, start: string, principal: ScriptPrincipal, scope: ScriptRequest, result: ScriptResult, timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const parser = new ScriptFrameParser();
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let bytes = 0;
      let received = 0;
      let pending = 0;
      let settled = false;
      const ids = new Set<string>();
      const transfers = new ScriptResultTransfer();
      const maxRequests = 3 * this.config.maxToolCalls + Math.ceil(SCRIPT_RUN_FILE_BYTES / SCRIPT_RESULT_CHUNK_BYTES);
      let requests = 0;
      const appendOutput = (name: "stdout" | "stderr", text: string) => {
        const buffer = Buffer.from(text, "utf8");
        let end = Math.min(buffer.length, Math.max(0, this.config.maxOutputBytes - bytes));
        // Cap the returned UTF-8 text, including replacement characters for
        // invalid input. Never cut inside a codepoint at the output boundary.
        while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
        bytes += end;
        result[name] += buffer.subarray(0, end).toString("utf8");
        result.output_truncated ||= end < buffer.length;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        transfers.close();
        signal.removeEventListener("abort", abort);
        channel.stdout.off("data", data);
        channel.stderr.off("data", discard);
        channel.stdin.off("error", fail);
        appendOutput("stdout", decoders.stdout.end()); appendOutput("stderr", decoders.stderr.end());
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("cancelled"));
      const fail = () => finish(new Error("Runner transport failed"));
      const discard = () => {}; // Raw stderr belongs to the supervisor, not script output.
      const tool = async (raw: unknown) => {
        if (settled || signal.aborted) throw new Error("Inactive script run");
        if (pending >= 10 || ++requests > maxRequests) throw new Error("Protocol budget exceeded");
        if (!record(raw) || Object.keys(raw).some(k => !["id", "tool", "arguments", "delivery"].includes(k)) || typeof raw.id !== "string" || raw.id.length > 64 || ids.has(raw.id) || typeof raw.tool !== "string" || !/^[a-z][a-z0-9_.]{0,63}$/.test(raw.tool) || !record(raw.arguments) ||
          (raw.delivery !== undefined && raw.delivery !== "file")) throw new Error("Invalid tool request");
        const isTransfer = raw.tool === "result.read" || raw.tool === "result.discard";
        if (!isTransfer && ++result.tool_calls > this.config.maxToolCalls) throw new Error("Tool budget exceeded");
        ids.add(raw.id); pending++;
        let response: unknown;
        try {
          const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(raw.tool === "node_exec" ? NODE_CALLBACK_MS : TOOL_CALLBACK_MS)]);
          let value: unknown;
          if (isTransfer) {
            if (raw.delivery !== undefined) throw new Error("Invalid transfer delivery");
            value = raw.tool === "result.read" ? await transfers.read(raw.arguments, boundedSignal) : transfers.discard(raw.arguments);
          } else {
            const call = structuredClone(raw) as unknown as ScriptToolCall;
            if (call.delivery && !this.broker.authorizeResult) throw new Error("File delivery unavailable");
            if (call.delivery) transfers.assertAvailable();
            value = await this.broker.call(principal, scope, call, boundedSignal);
            await this.broker.authorizeResult?.(principal, scope, call, boundedSignal);
            if (call.delivery === "file") value = transfers.open(value, s => this.broker.authorizeResult!(principal, scope, call, s));
          }
          boundedSignal.throwIfAborted();
          response = { id: raw.id, result: value };
          if (Buffer.byteLength(JSON.stringify(response)) > SCRIPT_INLINE_RESULT_BYTES) throw new ScriptResultLimitError();
        } catch (error) {
          const failure = error instanceof SandboxToolError ? error : new SandboxToolError(
            error instanceof ScriptResultLimitError ? "RESULT_TOO_LARGE" : "UNAUTHORIZED",
            error instanceof ScriptResultLimitError ? "FINISHED" : "NOT_DISPATCHED");
          response = { id: raw.id, ...sanitizeSandboxResult(failure.wire()) as object };
        }
        pending--;
        if (settled || signal.aborted) throw new Error("Inactive script run");
        return response;
      };
      const data = (chunk: Buffer) => {
        if (settled) return;
        try {
          received += chunk.length;
          if (received > 16 * this.config.maxOutputBytes + this.config.maxToolCalls * 256 * 1024) throw new Error("Protocol budget exceeded");
          for (const frame of parser.push(chunk)) {
            if (settled) throw new Error("Frame after exit");
            if (frame.type === "stdout" || frame.type === "stderr") {
              if (typeof frame.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error("Invalid output");
              const decoded = Buffer.from(frame.data, "base64");
              appendOutput(frame.type, decoders[frame.type].write(decoded));
            } else if (frame.type === "tool") {
              void tool(frame.call).then(response => channel.stdin.write(encodeScriptFrame({ type: "tool_result", response }))).catch(fail);
            } else if (frame.type === "exit" && Number.isSafeInteger(frame.code) && !pending) {
              result.exit_code = frame.code as number;
              parser.finish();
              finish();
            } else throw new Error("Unexpected runner frame");
          }
        } catch { fail(); }
      };
      channel.stdout.on("data", data);
      channel.stderr.on("data", discard);
      channel.stdin.on("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      void channel.done.then(fail, fail);
      if (signal.aborted) abort();
      else void (async () => {
        await channel.bindTools?.({ principal, timeoutSeconds, signal, call: async raw => {
          try { return await tool(raw); } catch (error) { fail(); throw error; }
        } });
        if (!settled && !signal.aborted) channel.stdin.write(start);
      })().catch(fail);
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.completions]);
    await this.provider.shutdown?.();
  }
}
