/**
 * Broker-free SSH dialing primitives shared by:
 *   - host_exec / host_script  (src/tools/infra/ssh-client.ts) — credentials
 *     materialized to disk by the CredentialBroker, read into Buffers.
 *   - Portal host connection test (src/portal/host-api.ts) — credentials read
 *     straight from the DB as inline strings (no broker in that process).
 *
 * This module knows NOTHING about the broker, the agentbox, or the Portal DB.
 * It takes fully-resolved hops with inline auth material (ssh2 accepts both a
 * privateKey Buffer/string and a password string) and speaks only to ssh2.
 *
 * Multi-hop (ProxyJump): the chain is dialed hop-by-hop. The first hop (the
 * outermost bastion, directly reachable from us) connects over plain TCP; each
 * subsequent hop is reached by asking the previous hop's sshd to open a
 * `direct-tcpip` channel (Client.forwardOut) and running the next SSH handshake
 * over that channel's Duplex stream (ConnectConfig.sock). This is exactly what
 * `ssh -J` does: every hop is end-to-end encrypted and the bastions only relay
 * ciphertext — they never see the downstream session or credentials.
 *
 * TOFU host-key cache is process-scoped (module-level Map) and shared with
 * ssh-client.ts via makeHostVerifier, so a host reached directly and the same
 * host reached as a jump target use one consistent fingerprint record. Reset on
 * process restart. We do NOT persist known_hosts to disk.
 */

import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";

// ── Types ───────────────────────────────────────────────────────────

export type DialHopAuth =
  | { privateKey: Buffer | string; passphrase?: string }
  | { password: string };

export interface DialHop {
  host: string;
  port: number;
  username: string;
  auth: DialHopAuth;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  /** null when the remote process was killed by a signal. */
  exitCode: number | null;
  signal?: string;
  truncated?: boolean;
}

export interface SshRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Script content piped to remote stdin. host_script uses this; host_exec doesn't. */
  stdin?: string;
}

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB, matches spawnAsync

// ── TOFU host-key cache (process-scoped, shared with ssh-client.ts) ──

/** Map<"<host>:<port>", base64 sha256 fingerprint>. Reset on process restart. */
const seenHostKeys = new Map<string, string>();

function fingerprint(keyBuffer: Buffer): string {
  return crypto.createHash("sha256").update(keyBuffer).digest("base64");
}

/**
 * Build a TOFU host-key verifier for a given host:port. First sighting of a
 * host:port is recorded and accepted; later connections must match or are
 * rejected. Shared by ssh-client.ts so single-hop and jump-target connections
 * to the same host:port use one fingerprint record.
 */
export function makeHostVerifier(host: string, port: number): (key: Buffer, cb: (ok: boolean) => void) => void {
  const cacheKey = `${host}:${port}`;
  return (key: Buffer, cb: (ok: boolean) => void) => {
    const fp = fingerprint(key);
    const seen = seenHostKeys.get(cacheKey);
    if (!seen) {
      seenHostKeys.set(cacheKey, fp);
      cb(true);
      return;
    }
    cb(seen === fp);
  };
}

// ── Internal: ssh2 ConnectConfig for one hop ────────────────────────

function buildHopConfig(hop: DialHop, timeoutMs: number, sock?: Duplex): ConnectConfig {
  const config: ConnectConfig = {
    host: hop.host,
    port: hop.port,
    username: hop.username,
    readyTimeout: timeoutMs,
    // host/port are still used for the verifier cache key even when `sock` is
    // set (ssh2 then ignores them for transport but we keep them meaningful).
    hostVerifier: makeHostVerifier(hop.host, hop.port),
  };
  if (sock) config.sock = sock;
  if ("privateKey" in hop.auth) {
    config.privateKey = hop.auth.privateKey;
    if (hop.auth.passphrase) config.passphrase = hop.auth.passphrase;
  } else {
    config.password = hop.auth.password;
  }
  return config;
}

// ── dialSshChain ────────────────────────────────────────────────────

export interface DialedChain {
  /** The connected client for the final (target) hop — ready for exec. */
  client: Client;
  /** Tear down the whole chain (final hop first, then bastions in reverse). */
  teardown: () => void;
}

/**
 * Dial a chain of hops ordered [outermostBastion, …, finalTarget] and resolve
 * with the connected final client plus a teardown that closes the whole chain.
 *
 * A single-element chain is just a direct connection. Any hop's connect error,
 * a forwardOut failure, the connect timeout, or an abort rejects the promise
 * and tears down every client opened so far (exactly once).
 */
export function dialSshChain(hops: DialHop[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<DialedChain> {
  if (hops.length === 0) {
    return Promise.reject(new Error("dialSshChain: empty hop chain"));
  }

  const clients: Client[] = [];
  const closeAll = () => {
    // Close the final hop first, then bastions, so each upstream tunnel is torn
    // down after the channel riding on it is gone.
    for (let i = clients.length - 1; i >= 0; i--) {
      try { clients[i].end(); } catch { /* ignore */ }
    }
  };

  return new Promise<DialedChain>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stopConnectGuards = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      stopConnectGuards();
      closeAll();
      reject(err);
    };
    const succeed = (client: Client) => {
      if (settled) return;
      settled = true;
      stopConnectGuards();
      resolve({ client, teardown: closeAll });
    };
    function onAbort() { fail(new Error("Aborted")); }

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => fail(new Error(`SSH chain connect timeout after ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );

    const connectHop = (index: number, sock?: Duplex) => {
      const hop = hops[index];
      const client = new Client();
      clients.push(client);

      client.on("error", (err) =>
        fail(new Error(`SSH hop ${index} (${hop.host}:${hop.port}) failed: ${err.message}`)));

      client.on("ready", () => {
        if (index === hops.length - 1) {
          succeed(client);
          return;
        }
        const next = hops[index + 1];
        client.forwardOut("127.0.0.1", 0, next.host, next.port, (err, stream) => {
          if (err) {
            fail(new Error(`forwardOut from ${hop.host} to ${next.host}:${next.port} failed: ${err.message}`));
            return;
          }
          connectHop(index + 1, stream as unknown as Duplex);
        });
      });

      let config: ConnectConfig;
      try {
        config = buildHopConfig(hop, opts.timeoutMs, sock);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      try {
        client.connect(config);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    connectHop(0, undefined);
  });
}

// ── runCommand ──────────────────────────────────────────────────────

/**
 * Run a single command on an already-connected client (the final hop of a
 * chain or a plain direct connection). Buffers stdout/stderr (10 MB cap),
 * optionally pipes options.stdin, and enforces timeout + AbortSignal. The
 * caller owns the client lifecycle and must tear it down afterwards.
 */
export function runCommand(client: Client, command: string, options: SshRunOptions): Promise<SshRunResult> {
  return new Promise<SshRunResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    const settleResolve = (r: SshRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    function onAbort() { settleReject(new Error("Aborted")); }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => settleReject(new Error(`SSH timeout after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );

    client.exec(command, (err, stream) => {
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
}
