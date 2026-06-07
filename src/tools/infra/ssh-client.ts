/**
 * SSH client for host_exec / host_script.
 *
 * Two responsibilities:
 *   1. acquireSshTarget: drive the CredentialBroker to materialize a host's
 *      credential file(s), then assemble an SshTarget. When the broker entry
 *      carries a server-pre-resolved `jumpChain`, nest it directly (no
 *      recursion); otherwise fall back to recursively following the legacy
 *      `meta.jump_host` name (depth capped at 3, with a cycle guard).
 *   2. sshExec: resolve the target (+ its jump chain) to inline hops and run a
 *      single command on the final host via ssh-dial's dialSshChain + runCommand.
 *
 * Dialing, multi-hop tunneling (forwardOut + sock), the TOFU host-key cache and
 * output handling all live in ssh-dial.ts (broker-free, shared with the Portal
 * connection test). See that module for the ProxyJump mechanics.
 *
 * Memory hygiene: password / passphrase files are read as Buffers and zeroed
 * after we copy them to strings. ssh2's password/passphrase fields are typed
 * `string`, so once handed over they live as V8 interned strings until GC — an
 * accepted residual risk. Private keys are passed through as Buffers.
 */

import { promises as fsp } from "node:fs";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";
import type { ChainHopMeta } from "../../shared/credential-types.js";
import { ensureHostForTool } from "./ensure-kubeconfigs.js";
import {
  dialSshChain,
  runCommand,
  runCommandStream,
  type DialHop,
  type SshRunResult,
  type SshRunOptions,
  type SshStreamHandle,
} from "./ssh-dial.js";

/** Caps a target + up to 3 bastions. */
const MAX_JUMP_DEPTH = 3;

/**
 * SSH connect/handshake fail-fast deadline (sicore parity: connector default 10s).
 * Deliberately separate from the per-command timeout — an unreachable host fails
 * in ~10s so the caller can fall back (e.g. to node_exec) instead of waiting out
 * the full 30–120s command timeout.
 */
const SSH_CONNECT_TIMEOUT_MS = 10_000;

// ── Types ───────────────────────────────────────────────────────────

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth:
    | { type: "key"; privateKeyPath: string; passphrasePath?: string }
    | { type: "password"; passwordPath: string }
    // "managed": no stored credential; the key is discovered on jumpHost at
    // dial time. Requires jumpHost to be set.
    | { type: "managed"; passphrasePath?: string };
  /** Next hop toward this target (the bastion), when reached via ProxyJump. */
  jumpHost?: SshTarget;
}

// Re-exported so host_exec / host_script keep importing these from here.
export type SshExecResult = SshRunResult;
export type SshExecOptions = SshRunOptions;

// ── acquireSshTarget (recursive over the jump chain) ────────────────

/**
 * Drive the broker to ensure host credentials are on disk, then assemble an
 * SshTarget. If the broker entry carries a pre-resolved `jumpChain`, attach it
 * as the `target.jumpHost` nest directly; else, if the metadata names a legacy
 * `jump_host`, recurse to acquire the bastion (depth ≤ 3, cycle-guarded). Throws
 * with an actionable message if a host is not bound or not materialized.
 */
export async function acquireSshTarget(
  broker: CredentialBroker | undefined,
  hostName: string,
  purpose: string,
): Promise<SshTarget> {
  if (!broker) {
    throw new Error("Credential broker required for host_exec / host_script");
  }
  return acquireSshTargetInner(broker, hostName, purpose, new Set<string>(), 0);
}

async function acquireSshTargetInner(
  broker: CredentialBroker,
  hostName: string,
  purpose: string,
  visited: Set<string>,
  depth: number,
): Promise<SshTarget> {
  if (visited.has(hostName)) {
    throw new Error(`Host "${hostName}" forms a jump-host cycle: ${[...visited, hostName].join(" → ")}`);
  }
  if (depth > MAX_JUMP_DEPTH) {
    throw new Error(`Jump-host chain for "${hostName}" exceeds max depth ${MAX_JUMP_DEPTH}`);
  }

  // ensureHost resolves the handle (a host name OR an id) to its registry entry
  // and returns it directly. Don't re-look-up by the original handle — the
  // registry is keyed by credential.name, so a host-id handle would miss here
  // even though ensureHost succeeded (its id→name fallback lives inside ensureHost).
  const info = await ensureHostForTool(broker, hostName, purpose);
  if (!info) {
    throw new Error(`Host "${hostName}" not loaded into broker registry after ensureHost`);
  }

  const meta = info.meta;
  const filePaths = info.filePaths ?? [];
  // New protocol: the server may pre-resolve the whole bastion chain. When
  // present we consume it directly (no per-hop credential.get recursion);
  // otherwise we fall back to recursing on meta.jump_host (legacy).
  const chain = info.jumpChain;

  let auth: SshTarget["auth"];
  if (meta.auth_type === "managed") {
    // Managed hosts store no key/password of their own — the key is sourced
    // from the bastion at dial time, so they require a jump (via jump_chain or
    // the legacy jump_host) and may have zero materialized files (or just a
    // .passphrase for the bastion key).
    if (!(chain && chain.length > 0) && !meta.jump_host) {
      throw new Error(`Managed host "${hostName}" requires a jump host`);
    }
    const passphrasePath = filePaths.find((p) => p.endsWith(".passphrase"));
    auth = { type: "managed", ...(passphrasePath ? { passphrasePath } : {}) };
  } else {
    if (filePaths.length === 0) {
      throw new Error(`Host "${hostName}" has no materialized credential file`);
    }
    const wantedSuffix = meta.auth_type === "key" ? ".key" : ".password";
    const credPath = filePaths.find((p) => p.endsWith(wantedSuffix));
    if (!credPath) {
      throw new Error(`Host "${hostName}" credential file with suffix ${wantedSuffix} not found`);
    }
    if (meta.auth_type === "key") {
      const passphrasePath = filePaths.find((p) => p.endsWith(".passphrase"));
      auth = { type: "key", privateKeyPath: credPath, ...(passphrasePath ? { passphrasePath } : {}) };
    } else {
      auth = { type: "password", passwordPath: credPath };
    }
  }

  const target: SshTarget = { host: meta.ip, port: meta.port, username: meta.username, auth };

  if (chain && chain.length > 0) {
    // Server pre-resolved the chain [outermost … nearest]. Nest it onto the
    // target: target.jumpHost = nearest bastion, whose .jumpHost chains outward
    // to the outermost (directly-reachable) bastion. No recursion, no per-hop
    // credential.get. See docs/design/ssh-jump-host.md §6.1.
    let jh: SshTarget | undefined;
    for (const hop of chain) {
      const t = chainHopToTarget(hop, hostName);
      t.jumpHost = jh;
      jh = t;
    }
    target.jumpHost = jh;
  } else if (meta.jump_host) {
    // Legacy fallback: recurse by bastion NAME (depth- and cycle-guarded).
    const nextVisited = new Set(visited);
    nextVisited.add(hostName);
    target.jumpHost = await acquireSshTargetInner(broker, meta.jump_host, purpose, nextVisited, depth + 1);
  }

  return target;
}

/**
 * Build an SshTarget for one materialized jump_chain hop. A bastion is always
 * explicit (key/password) — never managed (jump-chain invariant ③) — and reads
 * its OWN materialized files by suffix (kept isolated from the target's files).
 */
function chainHopToTarget(
  hop: { meta: ChainHopMeta; filePaths: string[] },
  targetName: string,
): SshTarget {
  const fps = hop.filePaths ?? [];
  let auth: SshTarget["auth"];
  if (hop.meta.auth_type === "key") {
    const privateKeyPath = fps.find((p) => p.endsWith(".key"));
    if (!privateKeyPath) {
      throw new Error(`Jump hop ${hop.meta.ip} for "${targetName}" has no materialized key file`);
    }
    const passphrasePath = fps.find((p) => p.endsWith(".passphrase"));
    auth = { type: "key", privateKeyPath, ...(passphrasePath ? { passphrasePath } : {}) };
  } else {
    const passwordPath = fps.find((p) => p.endsWith(".password"));
    if (!passwordPath) {
      throw new Error(`Jump hop ${hop.meta.ip} for "${targetName}" has no materialized password file`);
    }
    auth = { type: "password", passwordPath };
  }
  return { host: hop.meta.ip, port: hop.meta.port, username: hop.meta.username, auth };
}

// ── sshExec ─────────────────────────────────────────────────────────

/**
 * Resolve `target` (+ its jump chain) to inline hops, dial the chain, exec
 * `command` on the final host, and tear the chain down. Single-hop targets are
 * just a one-element chain. All failure modes (connect/auth error, host-key
 * mismatch, forwardOut failure, timeout, abort) reject the returned promise.
 */
export async function sshExec(
  target: SshTarget,
  command: string,
  options: SshExecOptions,
): Promise<SshExecResult> {
  const hops = await targetToHops(target);
  // Connect with the short fail-fast deadline; the command itself then runs under
  // the caller's (longer) options.timeoutMs via runCommand below.
  const { client, teardown } = await dialSshChain(hops, {
    timeoutMs: SSH_CONNECT_TIMEOUT_MS,
    signal: options.signal,
  });
  try {
    return await runCommand(client, command, options);
  } finally {
    teardown();
  }
}

// ── sshExecStream (background) ──────────────────────────────────────

/**
 * Streaming counterpart to {@link sshExec} for background jobs: dials the chain,
 * starts `command` on the final host, and returns live stdout/stderr streams plus
 * a `done` promise — WITHOUT buffering. The chain is torn down automatically when
 * the command finishes or is aborted (so the caller never leaks a connection).
 * The command itself should be `timeout`-wrapped by the calling tool so a dropped
 * channel cannot orphan the remote process.
 */
export async function sshExecStream(
  target: SshTarget,
  command: string,
  options: { signal?: AbortSignal; stdin?: string } = {},
): Promise<SshStreamHandle> {
  const hops = await targetToHops(target);
  const { client, teardown } = await dialSshChain(hops, {
    timeoutMs: SSH_CONNECT_TIMEOUT_MS,
    signal: options.signal,
  });
  try {
    const handle = await runCommandStream(client, command, options);
    // Tear the chain down once the remote command closes (or is aborted, which
    // closes the channel → resolves done). finally so a rejected done still cleans up.
    void handle.done.finally(() => { try { teardown(); } catch { /* already gone */ } });
    return handle;
  } catch (err) {
    teardown();
    throw err;
  }
}

// ── Internal: SshTarget chain → inline DialHop[] ────────────────────

/**
 * Flatten an SshTarget (+ jumpHost chain) into the order dialSshChain expects:
 * [outermost bastion, …, final target]. Reads each hop's materialized
 * credential file(s) into inline material.
 */
async function targetToHops(target: SshTarget): Promise<DialHop[]> {
  // Walk target → jumpHost producing [target, bastion, …], then reverse so the
  // directly-reachable outermost bastion is dialed first.
  const targetFirst: SshTarget[] = [];
  for (let t: SshTarget | undefined = target, d = 0; t; t = t.jumpHost, d++) {
    if (d > MAX_JUMP_DEPTH) {
      throw new Error(`Jump-host chain exceeds max depth ${MAX_JUMP_DEPTH}`);
    }
    targetFirst.push(t);
  }
  const ordered = targetFirst.reverse();
  return Promise.all(ordered.map((t) => hopFromTarget(t)));
}

async function hopFromTarget(t: SshTarget): Promise<DialHop> {
  if (t.auth.type === "managed") {
    let passphrase: string | undefined;
    if (t.auth.passphrasePath) {
      const buf = await fsp.readFile(t.auth.passphrasePath);
      passphrase = buf.toString("utf8").replace(/\s+$/u, "");
      buf.fill(0);
    }
    // No key/password read here — ssh-dial sources the key from the bastion.
    return { host: t.host, port: t.port, username: t.username, auth: { managed: true, ...(passphrase ? { passphrase } : {}) } };
  }
  if (t.auth.type === "key") {
    const privateKey = await fsp.readFile(t.auth.privateKeyPath);
    let passphrase: string | undefined;
    if (t.auth.passphrasePath) {
      const buf = await fsp.readFile(t.auth.passphrasePath);
      passphrase = buf.toString("utf8").replace(/\s+$/u, "");
      buf.fill(0);
    }
    return {
      host: t.host,
      port: t.port,
      username: t.username,
      auth: { privateKey, ...(passphrase ? { passphrase } : {}) },
    };
  }
  const pwBuf = await fsp.readFile(t.auth.passwordPath);
  const password = pwBuf.toString("utf8").replace(/\s+$/u, "");
  pwBuf.fill(0);
  return { host: t.host, port: t.port, username: t.username, auth: { password } };
}
