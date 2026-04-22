/**
 * SSH client wrapper around ssh2 — used by host_exec and host_script.
 *
 * Two responsibilities:
 *   1. acquireSshTarget: ensure the broker has materialized a host's credential
 *      file, then read enough metadata to build an SshTarget for ssh2.connect.
 *   2. sshExec: open one TCP connection per call, run a single command (or pipe
 *      a script via stdin), enforce TOFU host-key check, return stdout/stderr
 *      with timeout + AbortSignal handling.
 *
 * TOFU host-key cache is process-scoped (a module-level Map). Same agentbox pod
 * = consistent fingerprints across calls; pod restart = TOFU resets. We do NOT
 * persist known_hosts to disk — DESIGN decision #4. Stronger validation (an
 * expected_fingerprint column on hosts) is a future option.
 *
 * Memory hygiene: password files are read as Buffer and zeroed after the
 * connect call returns. ssh2's `password` config field is typed `string`, so
 * once we hand it over the password lives as a V8 interned string until GC —
 * this is an accepted residual risk (DESIGN risk #3).
 */

import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import { Client, type ConnectConfig } from "ssh2";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";
import { ensureHostForTool } from "./ensure-kubeconfigs.js";

// ── Types ───────────────────────────────────────────────────────────

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: { type: "key"; privateKeyPath: string }
      | { type: "password"; passwordPath: string };
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  /** null when the remote process was killed by a signal. */
  exitCode: number | null;
  signal?: string;
  truncated?: boolean;
}

export interface SshExecOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Script content piped to remote stdin. host_script uses this; host_exec doesn't. */
  stdin?: string;
}

// ── TOFU host-key cache (process-scoped) ────────────────────────────

/** Map<"<host>:<port>", base64 sha256 fingerprint>. Reset on pod restart. */
const seenHostKeys = new Map<string, string>();

function fingerprint(keyBuffer: Buffer): string {
  return crypto.createHash("sha256").update(keyBuffer).digest("base64");
}

// ── acquireSshTarget ────────────────────────────────────────────────

/**
 * Drive the broker to ensure host credentials are on disk, then assemble an
 * SshTarget. Throws with an actionable message if the host is not bound or
 * its credential file isn't materialized.
 */
export async function acquireSshTarget(
  broker: CredentialBroker | undefined,
  hostName: string,
  purpose: string,
): Promise<SshTarget> {
  if (!broker) {
    throw new Error("Credential broker required for host_exec / host_script");
  }
  await ensureHostForTool(broker, hostName, purpose);

  const info = broker.getHostLocalInfo(hostName);
  if (!info) {
    throw new Error(`Host "${hostName}" not loaded into broker registry after ensureHost`);
  }
  if (!info.filePaths || info.filePaths.length === 0) {
    throw new Error(`Host "${hostName}" has no materialized credential file`);
  }

  const meta = info.meta;
  const wantedSuffix = meta.auth_type === "key" ? ".key" : ".password";
  const credPath = info.filePaths.find((p) => p.endsWith(wantedSuffix));
  if (!credPath) {
    throw new Error(`Host "${hostName}" credential file with suffix ${wantedSuffix} not found`);
  }

  return {
    host: meta.ip,
    port: meta.port,
    username: meta.username,
    auth: meta.auth_type === "key"
      ? { type: "key", privateKeyPath: credPath }
      : { type: "password", passwordPath: credPath },
  };
}

// ── sshExec ─────────────────────────────────────────────────────────

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB, matches spawnAsync

/**
 * Open an SSH connection to `target`, exec `command`, optionally feed
 * `options.stdin` to the remote process. Resolves with stdout/stderr/exitCode.
 *
 * Failure modes (all reject the returned promise):
 *   - connection error: bad host, refused, unreachable
 *   - auth failure: bad key, bad password
 *   - host key mismatch: TOFU cache says the fingerprint changed
 *   - timeout: options.timeoutMs elapsed
 *   - abort: options.signal fired
 *
 * Resource discipline: every code path that resolves/rejects also calls
 * conn.end() and removes its own listeners. A `settled` guard ensures the
 * promise never settles twice (ssh2 emits multiple events on close paths).
 */
export async function sshExec(
  target: SshTarget,
  command: string,
  options: SshExecOptions,
): Promise<SshExecResult> {
  const conn = new Client();
  const config = await buildConnectConfig(target, options.timeoutMs);

  return new Promise<SshExecResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      conn.removeAllListeners();
    };

    const settleResolve = (r: SshExecResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { conn.end(); } catch { /* ignore */ }
      resolve(r);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { conn.end(); } catch { /* ignore */ }
      reject(err);
    };

    const onAbort = () => settleReject(new Error("Aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(
      () => settleReject(new Error(`SSH timeout after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return settleReject(err);

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let totalSize = 0;
        let truncated = false;
        const append = (chunks: Buffer[], chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_OUTPUT) { truncated = true; return; }
          chunks.push(chunk);
        };

        stream.on("close", (code: number | null, signal?: string) => {
          settleResolve({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            exitCode: code,
            ...(signal ? { signal } : {}),
            ...(truncated ? { truncated: true } : {}),
          });
        });
        stream.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
        stream.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

        if (options.stdin !== undefined) {
          stream.stdin.end(options.stdin);
        }
      });
    });

    conn.on("error", (err) => settleReject(err));

    try {
      conn.connect(config);
    } catch (err) {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Internal: assemble ssh2 ConnectConfig with TOFU verifier ───────

async function buildConnectConfig(
  target: SshTarget,
  timeoutMs: number,
): Promise<ConnectConfig> {
  const cacheKey = `${target.host}:${target.port}`;

  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: timeoutMs,
    hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => {
      const fp = fingerprint(key);
      const seen = seenHostKeys.get(cacheKey);
      if (!seen) {
        seenHostKeys.set(cacheKey, fp);
        cb(true);
        return;
      }
      cb(seen === fp);
    },
  };

  if (target.auth.type === "key") {
    config.privateKey = await fsp.readFile(target.auth.privateKeyPath);
  } else {
    const pwBuf = await fsp.readFile(target.auth.passwordPath);
    // ssh2's password is typed string. Once we toString() it lives as a V8
    // interned string until GC — accepted residual risk (DESIGN risk #3).
    // We do zero the file Buffer though.
    config.password = pwBuf.toString("utf8").replace(/\s+$/u, "");
    pwBuf.fill(0);
  }

  return config;
}
