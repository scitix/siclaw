/**
 * SRE Knowledge Base for Deep Search Sub-Agent.
 *
 * Skills are now auto-loaded by pi-agent from skills/core/ — no manual catalogs needed.
 * This file provides tool semantics, common mistakes, and domain-specific
 * troubleshooting priorities that complement the auto-loaded skills.
 */

/**
 * Tool semantics — bash vs node_exec vs kubectl exec.
 * Injected into Phase 1 and Phase 3 prompts where tools are used.
 */
export function toolSemantics(): string {
  return `## Tool Semantics — MUST follow strictly

### bash tool
- Runs in cluster context (same host as SRE agent)
- Supports pipes (|), && chaining, redirects, shell features
- Can invoke skill scripts: bash skills/{core,extension}/<name>/scripts/<script> [args]
- Can run kubectl exec to execute commands INSIDE a pod:
  bash: kubectl exec <pod> -n <ns> -- <cmd>
- Allowed commands: kubectl (read-only), grep, sort, jq, yq, head, tail, cut, tr, etc.

### node_exec tool
- Runs on Kubernetes node HOST via privileged debug pod + nsenter
- NO pipes, NO redirects, NO shell features
- Only ~75 whitelisted read-only commands
- Runs on HOST, NOT inside any pod

### read tool
- Read any file, including skills/{core,extension}/*/SKILL.md for detailed usage instructions
- ALWAYS read a skill's SKILL.md before using complex scripts

### Critical Differences
- net1/net2 interfaces exist ONLY in pod network namespace, NOT on host
  node_exec: ip link show net1 → NOT FOUND (wrong tool!)
  bash: kubectl exec <pod> -n <ns> -- ip link show net1 → CORRECT
- node_exec does NOT support pipes:
  node_exec: lsmod | grep mlx → ERROR (pipe not supported!)
  node_exec: lsmod → OK (filter output in your reasoning, not in the command)
- Shell globs do NOT expand in node_exec:
  node_exec: cat /sys/class/infiniband/*/ports/*/counters/port_rcv_errors → ERROR
  Use skill scripts instead, which handle glob expansion internally
- Prefer skill scripts over raw commands — they encode domain knowledge and handle edge cases

### Command Chaining — Maximize Efficiency
Simple chains (2 commands, no parsing needed):
  bash: skills/extension/roce-mtu-compare/scripts/mtu-compare.sh --pod-a X --ns-a Y && skills/extension/roce-pcie-link/scripts/pcie-link.sh --node N
  → 1 tool call instead of 2, both outputs returned together

PREFER chaining when:
- Commands are independent (order doesn't matter, no conditional logic)
- You need to run 2+ skill scripts for the same hypothesis
- Gathering multiple data points to compare (e.g. MTU on both pods)

DO NOT chain when:
- Next command depends on the previous result and requires LLM reasoning to decide
- A single command is sufficient`;
}

/**
 * Common mistakes the LLM makes — injected into Phase 3.
 */
export function commonMistakes(): string {
  return `## Common Mistakes — AVOID these

1. Using node_exec for pod-level diagnostics:
   WRONG: node_exec: cat /sys/class/net/net1/mtu  (net1 doesn't exist on host)
   RIGHT: bash: kubectl exec <pod> -n <ns> -- cat /sys/class/net/net1/mtu

2. Using pipes in node_exec:
   WRONG: node_exec: lsmod | grep mlx5
   RIGHT: node_exec: lsmod  (then parse the output yourself)

3. Using shell globs in node_exec:
   WRONG: node_exec: cat /sys/class/infiniband/*/ports/*/counters/port_rcv_errors
   RIGHT: Use the roce-port-counters skill script via bash tool

4. Hand-crafting commands when a skill script exists:
   WRONG: bash: kubectl exec pod -n ns -- cat /sys/class/infiniband/mlx5_0/ports/1/counters/port_rcv_errors
   RIGHT: bash skills/extension/roce-port-counters/scripts/port-counters.sh --pod pod --ns ns

5. Running node-level perftest in switchdev mode:
   WRONG: roce-perftest-node in switchdev (PF is a switch, not an endpoint)
   RIGHT: roce-perftest-pod (always works regardless of mode)

6. Assuming switchdev mode is an error:
   Switchdev is normal production configuration for SR-IOV + OVS offload.
   Do NOT report it as a misconfiguration.

7. NOT reading SKILL.md before invoking a skill:
   Always use the read tool to read skills/{core,extension}/<name>/SKILL.md first.
   It tells you required parameters, edge cases, and output format.`;
}

/**
 * RDMA bandwidth troubleshooting priority.
 * Injected into Phase 2 for hypothesis ordering.
 */
export function rdmaTroubleshootingPriority(): string {
  return `## RDMA Bandwidth Troubleshooting Priority (most common → least common)
1. roce-show-node-mode → Determine mode (switchdev/legacy) — affects which tools to use
2. roce-mtu-compare → MTU mismatch (most common cause of low bandwidth)
3. roce-pcie-link → PCIe link degradation (Gen4→Gen3, x16→x8)
4. roce-port-counters → Port error/retransmission counters
5. roce-ethtool-errors → NIC hardware errors (CRC, PFC storm)
6. roce-perftest-pod → Actual bandwidth test to confirm the problem

## Switchdev Mode Considerations
- Switchdev is NORMAL production config, NOT an error
- PF acts as switch (not endpoint) — node-level testing does not apply
- SKIP in switchdev: roce-perftest-node, roce-perftest-cross, node-ping-gateway
- USE in switchdev: roce-perftest-pod, pod-ping-gateway, all pod-level skills`;
}
