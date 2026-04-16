# Wiki Log

<!-- Format: ## [YYYY-MM-DD] <operation> | <primary page or topic>
     Operations: compile, update, lint, cascade
     Greppable: grep "^## \[" log.md | tail -10
-->

## [2026-04-14] compile | SCHEMA
- Created SCHEMA.md defining wiki conventions, page types, ingest/query/lint workflows
- Establishes directory structure: components/, concepts/, diagnostics/
- Defines `[[wikilink]] @relationship_type` cross-reference syntax
- Replaces RAG-compatible compilation strategy with whole-page LLM Wiki pattern (per Karpathy gist + SamurAIGPT runtime reference)

## [2026-04-14] compile | roce-operator (rewrite)
- Sources: user-provided component reference + roce-operator-ref source code (pkg/ipam/manager.go, ipam.go; cmd/ipam/main.go; internal/controller/nodemeta_controller.go, ipallocation_controller.go) + cluster verification of CRD structure
- Moved to components/ directory
- Rewrote per official LLM Wiki pattern: "When to use" section, [[wikilink]] cross-references, no hardcoded cluster data
- Added "The Allocation Chain" as central diagnostic concept — failure modes mapped to chain breaks
- Verified independence from rdma-doctor at runtime (no CRD reads from rdma-doctor side)
- Cascade pending: pages that should reference roce-operator after they're compiled — rdma-doctor, vce-operator, plus future concept and diagnostic pages

## [2026-04-14] compile | index.md (rewrite)
- Replaced first-pass index with proper navigation entry following SamurAIGPT pattern
- "How to use this wiki" section instructs runtime agent on whole-page reading, no chunk search
- "Diagnostics by Symptom" maps user-reported symptoms to diagnostic pages — primary entry for runtime agent
- Lists Components, Concepts, Diagnostic Patterns sections
- Many [[wikilinks]] currently broken (concepts/ and diagnostics/ pages not yet compiled) — will resolve as compilation continues

## [2026-04-14] compile | rdma-doctor (rewrite)
- Sources: user-provided component reference + rdma-doctor-ref source code (pkg/doctor/{pod,host,node}/diagnostics.go, pkg/kubelet/client.go, pkg/utils/link.go, cmd/rdma-doctor-agent/main.go)
- Moved to components/ directory
- Verified independence from roce-operator: source code grep confirms no IPAllocation/IPPool/Tenant/topology CRD reads. Only kubelet API + node label/annotation metadata.
- Added "Why It Exists Independently of roce-operator" section as diagnostic anchor — clarifies when to use which view
- Added "Three Layers of Checks" + "Cross-Layer Diagnostic Patterns" table — central reasoning structure
- Documented exact pod discovery + netns entry mechanism (kubelet API → containerd init.pid → /proc/PID/ns/net)
- Compiled the alert-to-action mapping inline (was scattered)
- Cascade: roce-operator.md already had [[rdma-doctor]] @related — no update needed. index.md already describes rdma-doctor as "independent of roce-operator" — no update needed.

## [2026-04-14] compile | vbr-cni (rewrite)
- Source: user-provided component reference
- Moved to components/ directory
- Restructured around "The Network Stack vbr Builds" diagram + ADD/DEL/CHECK operations
- Highlighted high-frequency production cause: physical switch trunk not configured for VLAN (separated from CNI plugin issues)
- Added "Identifying Which VLAN a VM Uses" — concrete trace from VM → sandbox → netns → veth → bridge name
- Cascade: vce-operator.md will reference [[vbr-cni]] (handled in vce-operator compile)

## [2026-04-14] compile | vce-operator (rewrite)
- Source: user-provided component reference
- Moved to components/ directory
- Centralized rootfs hostPath vs PVC mode distinction as key diagnostic split (FM-1)
- Added explicit phase lifecycle and conditions table — agent uses conditions to locate failure step
- Cross-references: [[vbr-cni]] for Ethernet, [[roce-operator]] for RDMA, [[scitix-csi-plugins]] for PVC mode rootfs
- Cascade: vbr-cni.md already references [[vce-operator]] — no update needed

## [2026-04-14] compile | scitix-csi-plugins (rewrite)
- Source: user-provided component reference
- Moved to components/ directory
- Listed all 6 storage drivers with mount mechanism table
- GPFS section significantly expanded — multi-step diagnostic with concrete error patterns and root cause summary (most complex driver to diagnose)
- Cascade: vce-operator.md already references [[scitix-csi-plugins]] for PVC mode — no update needed

## [2026-04-14] compile | concepts/roce-modes
- Sources: roce-diag SKILL.md, roce-show-node-mode SKILL.md
- Compiled the four-mode taxonomy as a standalone concept page (was scattered across SKILL.md files)
- "Normal Phenomena That Look Like Failures" table — central to misdiagnosis prevention
- "Endpoint Applicability Quick Reference" table — mode → which test type works
- "Mode-Specific Diagnostic Anchors" — per-mode starting points
- Cascade: roce-operator.md, rdma-doctor.md already reference [[roce-modes]] @depends_on — no update needed

## [2026-04-14] compile | concepts/gid-consistency
- Sources: roce-gid-consistency-check SKILL.md, roce-pod-show-gids SKILL.md
- Centralized the "why SR-IOV is immune" explanation as the primary diagnostic shortcut
- Detection procedure references skill names but doesn't include invocation syntax (per SCHEMA rule)
- Cascade: nccl-timeout.md (compiled later) references this; roce-modes.md mentions this in IPVLAN/MACVLAN section

## [2026-04-14] compile | concepts/tenant-isolation
- Sources: roce-diag SKILL.md tenant flows, roce-operator-ref source code
- Lead with "Single-Tenant vs Multi-Tenant — The First Check" to prevent investigating tenant in single-tenant clusters
- "Cross-Namespace Communication: The Diagnostic Flow" — decision tree for tenant ruling in/out
- Common Misdiagnoses section explicitly addresses three wrong assumptions
- Cascade: roce-operator.md already references this; nccl-timeout.md will reference this

## [2026-04-14] compile | concepts/policy-routing
- Sources: roce-operator-ref/cmd/ipam/main.go (configurePolicyRouting), user reference
- Verified hardcoded mapping (table = 100+N, priority = 10000+N*10, only net1-net8) from source code
- "Important Quirk: IPPool routes[] Are Ignored" — common confusion documented
- Cascade: roce-operator.md, rdma-doctor.md already reference this

## [2026-04-14] compile | concepts/topology-config
- Sources: roce-operator-ref/pkg/types/topology.go, user reference
- "The Three Name Alignments" table — central diagnostic concept (unit name, interface name, leaf name)
- Cascade: roce-operator.md already references [[topology-config]] @depends_on

## [2026-04-14] compile | diagnostics/nccl-timeout
- Synthesized from: roce-operator, rdma-doctor, gid-consistency, tenant-isolation, roce-modes
- This is a true "compiled" page — knowledge does not exist in any single source
- "Differential Diagnosis (in priority order)" — six causes ranked by check cost
- "Quick Triage Decision Tree" — agent navigation aid
- "What NOT to Do" — common antipatterns explicit
- Cascade: index.md, roce-operator.md, rdma-doctor.md, gid-consistency.md all reference this — no update needed

## [2026-04-14] compile | diagnostics/pod-stuck-creating
- Synthesized from: roce-operator, scitix-csi-plugins, vbr-cni, vce-operator
- "First Step: Read the Event" + table mapping event keywords to subsystems — primary triage tool
- Differential by pod type: plain / PVC / RoCE / vbr / VCE
- Cross-cutting patterns A-D: same node, same workload type, single pod, new nodes
- Cascade: index.md already references this

## [2026-04-14] compile | diagnostics/rdma-traffic-failure
- Synthesized from: roce-operator, rdma-doctor, roce-modes, policy-routing
- "The Diagnostic Anchor" — three layers between roce-operator config and physical network
- "The Cross-Layer Anchor Pattern" — host vs pod metric matrix for fault localization
- Six causes documented in cost order
- Cascade: index.md, nccl-timeout.md already reference this

## [2026-04-14] compile | diagnostics/gpu-faults
- Sources: 7 gpu-* SKILL.md files
- Six fault categories table — primary classification
- XID code reference table (user-retryable vs contact-ops)
- ECC severity ladder (with replacement thresholds)
- Decision tree for symptom → category routing
- Cascade: index.md already references this

## [2026-04-14] update | index.md (mark all pages compiled)
- Changed "pending compile" markers to actual updated dates
- All 5 components, 5 concepts, 4 diagnostic patterns now exist
- Wiki structure complete and ready for runtime testing

## [2026-04-14] cleanup | raw layer reorganization
- Moved components/ and concepts/ into raw/ subdirectory (10 pages)
- Archived 4 speculative diagnostics pages to archive/diagnostics-speculative/ with README explaining why
  (nccl-timeout, pod-stuck-creating, rdma-traffic-failure: speculative ordering without empirical backing;
  gpu-faults: duplicates gpu-* SKILL.md content, violates wiki/skill boundary)
- Removed maintainer metadata from raw frontmatter (compiled_from, last_updated) — only title + type remain
- Removed 11 broken wikilinks to archived diagnostic pages from See Also sections and inline references
- Moved SCHEMA.md and log.md into raw/ to make maintainer-only artifacts explicit
- index.md retained as placeholder with top-of-file comment; will be rewritten when compiled layer is produced
- Note: Step 4 content audit from the plan was NOT performed (raw re-classified as frozen high-quality
  source material for the compilation layer; trimming deferred to compile pass)
- Reason: previous round conflated raw layer with compiled layer; correcting structure before producing compiled layer

## [2026-04-14] review | roce-operator + rdma-doctor quality pass (pre-freeze)
- Purpose: last-chance quality check before raw layer is frozen as compilation source material
- Reviewed against three criteria: skill duplication, reference errors, unreasonable content
- Findings:
  1. roce-operator "Single-Tenant vs Multi-Tenant Mode" section duplicated concepts/tenant-isolation.md
  2. roce-operator "Policy Routing" section duplicated concepts/policy-routing.md
  3. rdma-doctor had runbook content (Useful PromQL, Alert-to-Action "First action" column,
     Recommended Diagnostic Order) — retained per "raw is material library" positioning
  4. rdma-doctor end-of-page NPD (node-problem-detector) one-liner was off-topic (different system)
  5. rdma-doctor opening "continuously validates" was inaccurate (agent runs per scrape interval)
- Edits applied:
  - roce-operator Single-Tenant section → 2-sentence summary + pointer to [[tenant-isolation]]
  - roce-operator Policy Routing section → 2-sentence summary + pointer to [[policy-routing]]
  - rdma-doctor: removed NPD one-liner (off-topic)
  - rdma-doctor: "continuously" → "periodically"
- Size delta: roce-operator 13,006 → 12,030 (−976 bytes); rdma-doctor 13,132 → 12,971 (−161 bytes)
- Deferred to user decision when the other three sources (vce-operator, vbr-cni, scitix-csi-plugins)
  arrive: whether to repeat this review pass for those pages against their ref repos

## [2026-04-14] review | vce-operator + vbr-cni + scitix-csi-plugins quality pass (pre-freeze)
- Source repos now available: /Users/sdliu/project/{vce-operator, vbr-cni, scitix-csi-plugins}
- Same three criteria as prior review: skill duplication, internal wiki duplication, source-verified accuracy
- Approach: ran three parallel Explore audits (one per page/repo), then personally re-verified the
  highest-impact findings against source before editing. Two agent findings were false positives and
  were discarded (details below).
- Confirmed and fixed (5 edits total):
  - vce-operator.md: rootfs image path `/data/images/<type>/` → `/data/area-0/images/<type>/`
    (source: cmd/main.go:49 defaultStorageDir="/data"; rootfs.go:27 defaultAreaId="area-0")
  - vce-operator.md: RDMA VM interface naming `net1, net2, ...` → `ib-0, ib-1, ...`
    (source: internal/controller/virtualmachine.go:544 uses fmt.Sprintf("ib-%d", i))
  - vce-operator.md: Inventory algorithm rewritten — was "Best-Fit-Decreasing bin-packing, capped at 10",
    actual is cluster-wide free-resource aggregation divided by per-VM request per dimension, minimum
    across dimensions, no cap (source: internal/controller/inventory.go:121-246)
  - vce-operator.md: Removed false claim "Result capped at 10" (no such cap exists in source)
  - scitix-csi-plugins.md: NFS multi-TCP failover attribution — was "CSI plugin parses and mounts
    first reachable endpoint", corrected to "CSI passes full string to mount -t xstor-nfs; kernel NFS
    client handles failover" (source: pkg/utils/nfs.go:33)
- Agent findings that were false positives (discarded after personal verification):
  - Agent claimed scitix-csi-plugins replicas default is 1 based on repo-root values.yaml. However the
    actual Helm chart values at manifest/deploy/helm/scitix-csi-plugin/values.yaml:3 specifies 2, as do
    all environment overrides. Wiki "2 replicas" kept.
  - Agent claimed rdma-doctor/csi nsenter flags (--mount=/proc/1/ns/mnt) couldn't be confirmed because
    NsenterCmd was defined elsewhere. Located at pkg/utils/util.go:109 — flags match wiki exactly. Kept.
- vbr-cni.md: no changes. Agent verified 18 claims against source; all correct. Three suggested
  clarity edits were "nice-to-have" not factual fixes, so not applied (raw-frozen principle).
- Size delta before SRE-usefulness pass:
  - vce-operator.md: 13,087 → 13,437 (+350, inventory description expanded for accuracy)
  - scitix-csi-plugins.md: 9,446 → 9,569 (+123, NFS section more precise)
  - vbr-cni.md: unchanged

## [2026-04-14] review | SRE-usefulness pass on raw layer
- Criterion: keep only content that helps SRE incident diagnosis; remove content that is clearly
  for other audiences (capacity planning, feature enumeration with no failure-mode hook)
- Scanned all 10 raw pages
- Removed:
  - vce-operator.md "Inventory API" section — the :32199 capacity endpoint is consumed by upstream
    schedulers for "how many VMs can I create", not by SREs diagnosing stuck VCEs. The corrected
    algorithm description belongs in a capacity-planning doc, not a diagnosis wiki.
- Considered but kept:
  - vce-operator.md "Online Resize" — marginal but hooks into RootfsResized condition diagnosis
  - vce-operator.md "Stop / Start" — 2 lines, mild redundancy with phase lifecycle, cost < benefit
  - rdma-doctor.md PromQL / Alert-Action / Recommended Diagnostic Order — already decided in
    prior pass (raw = compilation source material, compile layer decides fate)
- Other pages: no content identified as clearly non-diagnostic
- vce-operator.md size: 13,437 → 12,774 (−663)

## [2026-04-14] compile | produce compiled/ layer from frozen raw
- Produced overlay/knowledge/compiled/ — flat directory, 10 pages + index.md
- Each compiled page derives from the corresponding raw page via these transformations:
  - Removed all `@related` / `@depends_on` typed wikilink tags — not in the official LLM Wiki convention
  - Removed "Diagnostic Commands" sections at end of component pages (vce-operator, vbr-cni,
    scitix-csi-plugins) — kubectl/shell cheat sheets belong to skills, not wiki
  - rdma-doctor: removed "Useful PromQL" section (runbook) and "Recommended Diagnostic Order"
    section (mini-skill); renamed "Alert-to-Action Mapping" → "Alert-to-Condition Mapping" and
    dropped the "First action" column (kept alert→condition, dropped SOP)
  - Converted FM section bash drilldowns to semantic prose (what to check, not how) — agent
    translates into concrete commands using skills and bash
  - Minor: normalized "NOT" to "not" where used for emphasis (wiki tone, not shout)
- Wrote compiled/index.md following the SamurAIGPT pattern: "How to use" + Components table +
  Concepts table. Deliberately omitted "Diagnostics by Symptom" — no empirically-grounded
  diagnostic pages exist; that section is deferred to Phase 2 promotion.
- Verified: all `[[wikilink]]` references in compiled/ resolve to existing compiled .md files.
- Size comparison: raw 86,853 bytes → compiled 80,065 bytes (−7.8%).
- Removed obsolete top-level overlay/knowledge/index.md placeholder — compiled/index.md is now
  the canonical index; deployment mounts compiled/ contents into .siclaw/knowledge/.
- raw/ is frozen. All future knowledge-layer maintenance happens in compiled/; source-of-truth
  changes that would require re-compilation (major component refactor, new component) would
  trigger a raw refresh, but day-to-day wiki updates target compiled/ only.
- Deployment mechanics (NFS PVC, sync pipeline, siclaw_main code changes to replace the
  knowledge_search tool with wiki-based reading) are tracked separately and are not part of
  this commit.

## [2026-04-14] fix | remove vendor/driver-specific assertions from wiki
- Triggered by actual-cluster verification: user's roce-test cluster has `rdma/brcm_sriov_bnxt_*`
  as Kubernetes resource names, but `lspci` + `lsmod` + `/sys/class/infiniband/` show the live
  RDMA hardware is Mellanox ConnectX-7 with mlx5_ib / mlx5_core drivers loaded (bnxt_re not
  loaded). Resource names are plugin-registration strings, not reliable hardware identifiers.
- Problem: earlier wiki copy asserted vendor-specific "normal phenomena" (e.g. "VF GUID=0 is
  normal for Broadcom bnxt") that would actively mislead an agent diagnosing a Mellanox cluster.
- Fixes (raw + compiled, both touched because these are factual errors, not stylistic):
  - roce-modes.md: removed three rows from "Normal Phenomena That Look Like Failures":
    - "VF RDMA device GUID = 0000..." ("Normal for Broadcom bnxt")
    - "ibstat fails 'No such file or directory'" ("Applies to: Broadcom NICs")
    - "ibv_devices shows many devices with node_guid 0" (claim "only PFs have real GUIDs" is
      driver-specific, not universal)
  - rdma-doctor.md "Pod Discovery" step 2: removed the "default targets Broadcom bnxt resources"
    line; replaced with a vendor-neutral description that directs the reader to verify actual
    hardware via lspci / lsmod / /sys/class/infiniband.
- Added SCHEMA.md Content Rule #6: vendor/driver-specific normal/anomaly assertions are banned.
  Wiki describes architecture-level mechanisms; agents determine vendor at diagnosis time and
  combine with vendor-specific references outside the wiki.
- This is the second time the "raw is frozen" principle had to yield to a factual error. The
  principle stands for stylistic and organizational drift; it does not cover verified
  incorrectness.
