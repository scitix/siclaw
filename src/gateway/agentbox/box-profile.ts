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
   * Container image. undefined → the spawner's default agentbox image
   * (this.config.image / $SICLAW_AGENTBOX_IMAGE).
   */
  image?: string;
  /**
   * Extra runtime-process env names forwarded into the box, ON TOP of the base
   * agentbox allowlist. The box does NOT inherit runtime env; only these pass.
   */
  envForward?: string[];
  /** HOME override (e.g. "/work" when rootfs is read-only and the image HOME isn't writable). */
  home?: string;
  /** Extra writable emptyDir volumes. */
  volumes?: BoxProfileVolume[];
  /** Tool/trust profile: allowed tool names (null = all). Enforced end-to-end in A.3. */
  allowedTools?: string[] | null;
  /** Resource requests/limits override. */
  resources?: { cpu?: string; memory?: string };
}

/** Default profile: a normal agentbox (spawner-config image, no extra env/volumes, all tools). */
export const AGENT_PROFILE: BoxProfile = {
  name: "agent",
};

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
    image: process.env.SICLAW_COMPILE_BOX_IMAGE || "kbc-compile-box:latest",
    envForward: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "KBC_SMOKE"],
    home: "/work",
    volumes: [{ name: "work", mountPath: "/work", sizeLimit: "1Gi" }],
    // null = the box's default compile toolset (posted as allowed_tools on
    // /session; the box falls back to its own DEFAULT_COMPILE_ALLOWED_TOOLS).
    allowedTools: null,
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
    image: process.env.SICLAW_COMPILE_BOX_IMAGE || "kbc-compile-box:latest",
    envForward: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "KBC_SMOKE"],
    home: "/work",
    volumes: [{ name: "work", mountPath: "/work", sizeLimit: "1Gi" }],
    allowedTools: ["Read", "Glob", "Grep"],
  };
}

/** Builtin profile factories. */
const BUILTIN_PROFILES: Record<string, () => BoxProfile> = {
  agent: () => AGENT_PROFILE,
  "kb-compile": kbCompileProfile,
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
