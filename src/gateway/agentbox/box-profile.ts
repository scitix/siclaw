/**
 * BoxProfile — declarative descriptor for the shape + tool/trust envelope of a
 * spawned box. This is the Layer-1 generalization that REPLACES the per-capability
 * `if (isCompile)` special-casing in k8s-spawner.ts: adding a capability becomes
 * "register a profile", not "fork the spawner".
 *
 * ⚠️ A.1 — the type + registry (data + lookup) only. Wiring it into K8sSpawner
 * (replacing the isCompile branches) is A.2; the kb-test profile + allowedTools
 * enforcement are A.4/A.3.
 */

/** An extra writable volume a profile needs (rootfs is read-only). */
export interface BoxProfileVolume {
  /** Volume + mount name (unique within the pod). */
  name: string;
  /** Absolute mount path inside the container. */
  mountPath: string;
  /** emptyDir size limit, e.g. "1Gi". */
  sizeLimit?: string;
}

export interface BoxProfile {
  /** Profile name; also the box reuse-key discriminator (A.5) and a pod label. */
  name: string;
  /**
   * Pod-name prefix for boxes of this profile (default "agentbox"). The compile
   * profiles override it to "kbc-box" so an operator scanning `kubectl get pods`
   * during a production incident can tell a KB compile box from a chat agentbox
   * by name alone, not just by label/image filtering. All resources derived from
   * the pod name (cert Secret, hostname) follow this prefix automatically.
   */
  podNamePrefix?: string;
  /**
   * Container image. undefined → the spawner's default agentbox image
   * (this.config.image / $SICLAW_AGENTBOX_IMAGE).
   */
  image?: string;
  /**
   * Profile-declared Runtime env names. The box never inherits arbitrary
   * Runtime env: normal AgentBoxes also have a small built-in allowlist, while
   * lean profiles receive only the names declared here.
   */
  envForward?: string[];
  /** HOME override (e.g. "/work" when rootfs is read-only and the image HOME isn't writable). */
  home?: string;
  /** Extra writable emptyDir volumes. */
  volumes?: BoxProfileVolume[];
  /**
   * Inner Linux sandbox required by this image. `bubblewrap` needs to create
   * user/PID/network namespaces and private mounts; Kubernetes' runtime-default
   * seccomp/AppArmor profiles deny those operations before the inner sandbox
   * can apply its narrower filesystem and network policy.
   *
   * This is deliberately profile-scoped. A normal AgentBox must retain the
   * outer runtime-default policy, and read-only KB test boxes do not launch a
   * native shell at all.
   */
  nestedSandbox?: "bubblewrap";
  /** Tool/trust profile: allowed tool names (null = all). Enforced end-to-end in A.3. */
  allowedTools?: string[] | null;
  /**
   * Resource override. `cpu`/`memory` set BOTH request and limit (guaranteed
   * shape); `cpuRequest`/`memoryRequest` set only the request, leaving the
   * limit at its default (or `cpu`/`memory`) — the burstable shape a compile
   * box needs: schedule honestly near real usage, keep headroom to the limit.
   * A request override ABOVE the effective limit must also set the limit, or
   * K8s rejects the pod (request > limit).
   */
  resources?: { cpu?: string; memory?: string; cpuRequest?: string; memoryRequest?: string };
}

/** Default profile: a normal agentbox (spawner-config image, no extra env/volumes, all tools). */
export const AGENT_PROFILE: BoxProfile = {
  name: "agent",
};

/**
 * Whether this Runtime can host KB compile/test boxes — i.e. it was given an
 * explicit compile-box image (helm `agentbox.compileBoxEnabled` ⇒ the
 * SICLAW_COMPILE_BOX_IMAGE env). This is the single source of truth the Runtime
 * advertises to its consumer on connect so the consumer can route compile runs
 * here WITHOUT any consumer-side config. The bare `siclaw-kbc-box:latest`
 * fallback in the profiles above is deliberately NOT treated as capable: an
 * unset env means KB stays dark (fail-closed), so we must not claim capability.
 */
export function isCompileCapable(): boolean {
  return !!process.env.SICLAW_COMPILE_BOX_IMAGE?.trim();
}

/**
 * kb-compile — a KB compile box. Reproduces the pre-refactor compile special-case
 * DECLARATIVELY: dedicated image, Anthropic-compatible LLM env (the lean box does
 * not phone home for settings), a writable /work with HOME pointed at it.
 *
 * Built lazily so the image env var is read at spawn time, not module load.
 */
function kbCompileProfile(): BoxProfile {
  return {
    name: "kb-compile",
    podNamePrefix: "kbc-box",
    image: process.env.SICLAW_COMPILE_BOX_IMAGE || "siclaw-kbc-box:latest",
    // LLM credentials arrive in /session after fail-closed input materialization:
    // consumer block first, Runtime Helm fallback only when that block is absent.
    // Never duplicate a Runtime secret into the pod spec; only the non-secret
    // endpoint and ops KBC_* kill switches remain as rolling-version fallbacks.
    envForward: ["ANTHROPIC_BASE_URL", "KBC_*"],
    home: "/work",
    volumes: [{ name: "work", mountPath: "/work", sizeLimit: "4Gi" }], // installer allows 2GB unpacked raw + candidate output — 1Gi evicted large-corpus pods
    // A compile box realistically runs 1-2Gi (Claude Code + candidate tree +
    // snapshots); the 256Mi default request let the scheduler bin-pack ~10 hot
    // compiles onto a node they then burst to 4Gi each on (audit finding:
    // oversubscription → OOMKills). Request near real usage; limit stays 4Gi.
    resources: { memoryRequest: "1Gi" },
    // null = the box's default compile toolset (posted as allowed_tools on
    // /session; the box falls back to its own DEFAULT_COMPILE_ALLOWED_TOOLS).
    allowedTools: null,
  };
}

/**
 * kb-compile-codex — the same authoring capability and image as kb-compile,
 * with the outer exception Codex needs to install its *narrower* Bubblewrap
 * sandbox. Keeping this as a distinct profile means Claude authoring boxes
 * retain Kubernetes' RuntimeDefault seccomp/AppArmor policy.
 */
function kbCompileCodexProfile(): BoxProfile {
  return {
    ...kbCompileProfile(),
    name: "kb-compile-codex",
    nestedSandbox: "bubblewrap",
  };
}

/**
 * kb-test — a read-only, zero-infra KB consumer box (start-a-test-session). Same kbc image +
 * writable /work (Claude Code's ~/.claude) as kb-compile, but a RESTRICTED tool
 * envelope: Read/Glob/Grep only — no Write/Edit/Bash and no compile MCP tools, so
 * it can measure the wiki without mutating it or touching infra. The trust
 * difference is expressed purely as allowedTools; the box shape is identical.
 * This is the second profile that proves the abstraction is capability-general.
 */
function kbTestProfile(): BoxProfile {
  return {
    name: "kb-test",
    image: process.env.SICLAW_COMPILE_BOX_IMAGE || "siclaw-kbc-box:latest",
    envForward: ["ANTHROPIC_BASE_URL", "KBC_*"],
    home: "/work",
    // Same cap as kb-compile — the profiles' documented invariant is "identical
    // box shape, trust differs only in allowedTools" (a sizeLimit is a ceiling,
    // not an allocation, so this costs nothing for small snapshots).
    volumes: [{ name: "work", mountPath: "/work", sizeLimit: "4Gi" }],
    allowedTools: ["Read", "Glob", "Grep"],
  };
}

/** Builtin profile factories. */
const BUILTIN_PROFILES: Record<string, () => BoxProfile> = {
  agent: () => AGENT_PROFILE,
  "kb-compile": kbCompileProfile,
  "kb-compile-codex": kbCompileCodexProfile,
  "kb-test": kbTestProfile,
};

/**
 * Resolve a BoxProfile by name. Env-derived fields (e.g. the compile image) are
 * read at call time.
 *
 * FAIL-CLOSED: an unknown non-empty name THROWS rather than silently falling back
 * to the all-tools `agent` profile — a misspelled "kb-test" must not quietly
 * become a full-privilege box (that would be a trust-envelope escalation). An
 * absent name is the explicit normal path → the default agent profile.
 */
export function getBoxProfile(name: string | undefined): BoxProfile {
  if (!name || name === "agent") return AGENT_PROFILE;
  const factory = BUILTIN_PROFILES[name];
  if (!factory) throw new Error(`unknown BoxProfile: ${name}`);
  return factory();
}
