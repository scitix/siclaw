/**
 * SSH client for host_exec / host_script.
 *
 * Two responsibilities:
 *   1. acquireSshTarget: drive the CredentialBroker to materialize a host's
 *      credential file(s), then assemble an SshTarget — recursively following
 *      `meta.jump_host` to build a ProxyJump chain (depth capped at 3, with a
 *      cycle guard).
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
import { ensureHostForTool } from "./ensure-kubeconfigs.js";
import {
  dialSshChain,
  runCommand,
  type DialHop,
  type SshRunResult,
  type SshRunOptions,
} from "./ssh-dial.js";

/** Mirrors sicore connector maxJumpDepth — caps a target + up to 3 bastions. */
const MAX_JUMP_DEPTH = 3;

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
 * SshTarget. If the host's metadata names a `jump_host`, recurse to acquire the
 * bastion and attach it as `target.jumpHost` (depth ≤ 3, cycle-guarded). Throws
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

  await ensureHostForTool(broker, hostName, purpose);

  const info = broker.getHostLocalInfo(hostName);
  if (!info) {
    throw new Error(`Host "${hostName}" not loaded into broker registry after ensureHost`);
  }

  const meta = info.meta;
  const filePaths = info.filePaths ?? [];

  let auth: SshTarget["auth"];
  if (meta.auth_type === "managed") {
    // Managed hosts store no key/password of their own — the key is sourced
    // from the bastion at dial time, so they require a jump host and may have
    // zero materialized files (or just a .passphrase for the bastion key).
    if (!meta.jump_host) {
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

  if (meta.jump_host) {
    const nextVisited = new Set(visited);
    nextVisited.add(hostName);
    target.jumpHost = await acquireSshTargetInner(broker, meta.jump_host, purpose, nextVisited, depth + 1);
  }

  return target;
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
  const { client, teardown } = await dialSshChain(hops, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  try {
    return await runCommand(client, command, options);
  } finally {
    teardown();
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
