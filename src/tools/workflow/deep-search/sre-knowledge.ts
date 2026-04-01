/**
 * Tool usage knowledge for Deep Search Sub-Agent.
 *
 * Domain-agnostic: contains only tool semantics and generic usage mistakes.
 * Domain-specific knowledge (RDMA, networking, etc.) lives in skill SKILL.md files
 * and is loaded by the agent on demand via progressive discovery.
 */

/**
 * Tool semantics — bash vs pod_exec vs node_exec.
 * Injected into Phase 1 and Phase 3 prompts where tools are used.
 */
export function toolSemantics(): string {
  return `## Tool Semantics — MUST follow strictly

### bash tool
- Runs in cluster context (same host as SRE agent)
- Supports pipes (|), && chaining, redirects, shell features
- Can invoke skill scripts: bash skills/{core,extension}/<name>/scripts/<script> [args]
- Allowed commands: kubectl (read-only), grep, sort, jq, yq, head, tail, cut, tr, etc.
- To execute commands INSIDE a pod, use the pod_exec tool (NOT kubectl exec via bash)

### node_exec tool
- Runs on Kubernetes node HOST via privileged debug pod + nsenter
- NO pipes, NO redirects, NO shell features
- Only ~75 whitelisted read-only commands
- Runs on HOST, NOT inside any pod

### read tool
- Read any file, including skills/{core,extension}/*/SKILL.md for detailed usage instructions
- ALWAYS read a skill's SKILL.md before using complex scripts

### Critical Differences
- Pod-specific interfaces/files exist ONLY in the pod's network namespace, NOT on the host
  node_exec: ip link show <pod-interface> → NOT FOUND (wrong tool!)
  pod_exec: ip link show <pod-interface> → CORRECT
- node_exec does NOT support pipes:
  node_exec: lsmod | grep <module> → ERROR (pipe not supported!)
  node_exec: lsmod → OK (filter output in your reasoning, not in the command)
- Shell globs do NOT expand in node_exec:
  node_exec: cat /sys/class/.../*/.../file → ERROR
  Use skill scripts instead, which handle glob expansion internally
- Prefer skill scripts over raw commands — they encode domain knowledge and handle edge cases

### Command Chaining — Maximize Efficiency
PREFER chaining independent commands with && in a single bash call:
  bash: <command-1> && <command-2>
  → 1 tool call instead of 2, both outputs returned together

DO NOT chain when:
- Next command depends on the previous result and requires LLM reasoning to decide
- A single command is sufficient`;
}

/**
 * Common tool usage mistakes the LLM makes — injected into Phase 3.
 * Domain-agnostic: only covers tool misuse, not domain-specific errors.
 */
export function commonMistakes(): string {
  return `## Common Mistakes — AVOID these

1. Using node_exec for pod-level diagnostics:
   WRONG: node_exec: cat /sys/class/net/<iface>/mtu  (pod interfaces don't exist on host)
   RIGHT: pod_exec: cat /sys/class/net/<iface>/mtu

2. Using pipes in node_exec:
   WRONG: node_exec: lsmod | grep <module>
   RIGHT: node_exec: lsmod  (then parse the output yourself)

3. Using shell globs in node_exec:
   WRONG: node_exec: cat /sys/class/.../*/file
   RIGHT: Use a skill script via bash tool (scripts handle glob expansion internally)

4. Hand-crafting commands when a skill script exists:
   Before running raw kubectl/bash commands, check if a relevant skill exists.
   Skill scripts encode domain knowledge, handle edge cases, and produce structured output.

5. NOT reading SKILL.md before invoking a skill:
   Always use the read tool to read skills/{core,extension}/<name>/SKILL.md first.
   It tells you required parameters, edge cases, and output format.`;
}
