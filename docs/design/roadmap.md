---
title: "Roadmap"
sidebarTitle: "Roadmap"
description: "Investigation Memory, Knowledge Base, and Persona roadmaps with current status."
---

# Siclaw Roadmap

> **Last updated**: 2026-03-06
> **Product vision**: Siclaw is every SRE's cyber-twin — an AI colleague that accumulates experience,
> learns proactively, understands work context, and engages in deep technical discussion.
>
> **Core differentiator**: The knowledge feedback loop — not more agents, but deeper SRE expertise accumulation.

---

## Architecture Layers

Siclaw is built in five interconnected layers. **Depth** (IM/KR) and **breadth** (OB/CS) must grow together — a knowledgeable agent with short arms cannot do real SRE work.

```
┌──────────────────────────────────────────────────────────────────┐
│  Persona & Workspace System  (PM roadmap)                         │
│  Config cascade · Skill trust tiers                               │
│  System → Team → Personal → Workspace (mandatory → optional)      │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────────┐
│  Knowledge Streams  (IM + KR roadmaps)                            │
│  Stream A: Team KB (Qdrant, external docs)                        │
│  Stream B: Investigation Memory (SQLite, learned patterns)        │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────────┐
│  Observability Integration  (OB roadmap)                          │
│  Metrics · Logs · Events — the agent's sensory layer              │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────────┐
│  Agent Runtime  (current foundation)                              │
│  TUI · Gateway · AgentBox · Skills · MCP · Brain types            │
│  Command surface (CS roadmap) · Credential model · DB layer       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Roadmap A — Investigation Memory (IM)

The knowledge feedback loop: every investigation produces structured experience that improves future diagnoses.

### IM Phase 0 — Raw Memory Loop ✅ Complete
- Write investigation notes to markdown memory files
- Vector + FTS hybrid search over memory
- Inject relevant memories into agent context at session start

### IM Phase 1 — Structured Knowledge Extraction ✅ Complete
- Dual-output: raw markdown + structured `investigations` SQLite table
- Schema: `question`, `root_cause_category`, `affected_entities`, `environment_tags`, `causal_chain`, `confidence`, `conclusion`
- Hybrid retrieval: vector similarity + structured field filtering
- Investigation records persist across sessions

### IM Phase 2 — Diagnostic Path Learning 🔄 In Progress
- Extract reusable diagnostic patterns from investigation histories
- Build "playbook index": symptom patterns → hypothesis templates → validated tools
- Feed patterns into Phase 2 (hypothesis generation) of deep investigation engine
- Automatic pattern confidence scoring based on historical outcomes

---

## Roadmap B — Knowledge Base & Retrieval (KR)

External knowledge ingestion: team docs, runbooks, architecture diagrams → searchable by the agent.

### KR0 — Qdrant + Basic Ingestion 🔄 In Progress
- Stand up Qdrant vector store (embedded first, self-hosted for production)
- Ingest: team docs (Confluence/Notion/markdown), runbooks, architecture diagrams
- Chunking strategy: heading-aware hierarchical chunking (Anthropic Contextual Retrieval pattern)
- Basic semantic search for agent via `knowledge_search` tool
- Evaluate: Contextual Retrieval vs Late Chunking for technical docs (R1)

### KR1 — Source Connectors ⏳ Planned
- Connectors: GitHub (issues, PRs, wikis), Confluence, Notion, local filesystem
- Incremental sync (only re-ingest changed content)
- Source attribution in search results

---

## Roadmap C — Observability Integration (OB)

**Currently the largest capability gap.** Real SRE diagnosis without metrics and logs is like diagnosing a patient without vital signs. This is the agent's sensory layer — without it, knowledge accumulation has no raw data to reason from.

Reference: HolmesGPT integrates Prometheus/Grafana/ES/Datadog — that is the minimum viable observability surface.

### OB0 — Metrics Query (Prometheus/Thanos) ⏳ Next Priority
- `metrics_query` tool: PromQL execution against configured Prometheus/Thanos endpoint
- Range queries: "show me CPU usage for this pod over the last 2 hours"
- Instant queries: current value lookups for health checks
- Result formatting: table output for LLM consumption without token explosion (R2)
- Endpoint auth uses existing `api_token` credential type — no new credential infrastructure needed
- Workspace-level endpoint configuration (each workspace points to its own Prometheus)

### OB1 — Log Query (Loki / Elasticsearch / Datadog Logs) ⏳ Planned
- `log_query` tool: unified interface over multiple log backends
- Backend adapters: Loki (LogQL), Elasticsearch (Lucene/KQL), Datadog
- Time-range + label/field filtering
- Endpoint auth via existing `api_token` / `api_basic_auth` credential types
- Backend abstraction: single tool with backend param vs separate tools per backend (T2)

### OB2 — Event Correlation ⏳ Planned
- Correlate K8s events + metrics spikes + log error bursts on a shared timeline
- `correlate_events` tool: given a time window, surface co-occurring anomalies across OB sources
- Feed correlated event sets into IM causal pattern building
- "At 14:32 the deployment rolled out, at 14:34 error rate spiked, at 14:35 OOMKill started"

---

## Roadmap D — Persona & Workspace System (PM)

The "cyber-twin" model: one person, multiple workspaces (personas), each with its own config and skills. Config flows downward; lower layers override higher layers except for mandatory System policies.

```
System (mandatory baselines, security, compliance)
  └─ Team (conventions, shared tools, approved skills)
       └─ Personal (individual preferences, personal skills)
            └─ Workspace (context-specific overrides — highest priority)
```

### PM0 — Workspace Foundation ✅ Complete
- Workspace CRUD via WebUI
- Per-workspace: skills, tools, environments, credentials, allowed models
- `{userId}:{workspaceId}` as fundamental isolation unit
- Schema: `workspaces`, `workspaceSkills`, `workspaceTools`, `workspaceEnvironments`, `workspaceCredentials`

### PM1 — 4-Layer Config Cascade ⏳ Planned
- Full merge semantics: System → Team → Personal → Workspace (R3: JSON Merge Patch vs Strategic Merge Patch)
- Mandatory policies at System layer: cannot be overridden by any lower layer, enforced at agent startup
- Team layer: shared tool configs, approved skill lists, default models
- Workspace layer: context-specific tool endpoints (which Prometheus, which kubeconfig)
- Config validation at each layer boundary (reject invalid overrides at write time, not runtime)

### PM2 — Skill Trust Tiers ⏳ Planned
- Three tiers: `restricted` (read-only, no exec) / `standard` (normal tools) / `elevated` (write ops, external calls)
- Elevated skills require explicit workspace grant + senior reviewer approval
- System layer defines maximum allowed tier per workspace type
- Runtime enforcement: agent refuses to load elevated skills without workspace grant in config

---

## Roadmap E — Command & Environment Surface (CS)

The agent's reach: what it can run, and where it can connect. Two dimensions that must grow together.

**Security invariant**: whitelist-only model (ADR-004) must not be weakened. Every addition requires use case justification + flag restrictions + test coverage.

**Credential infrastructure note**: the credential model already supports `ssh_key`, `ssh_password`, `kubeconfig`, `api_token`, `api_basic_auth` — all stored, materialized, and discoverable via the `credential_list` tool. CS work is about the execution layer (tools + whitelist), not re-doing credential storage.

### CS0 — K8s Ecosystem Tools ⏳ Next Priority
- `helm`: read-only subcommands (`get`, `list`, `status`, `history`, `show`) — no `install`/`upgrade`/`delete`
- `istioctl`: `analyze`, `proxy-status`, `proxy-config` — no config mutations
- `argocd`: `app get`, `app list`, `app history`, `app diff` — no sync/rollback
- Add per-tool flag allowlists following the existing `command-sets.ts` declarative pattern

### CS1 — Network & TLS Diagnostic Tools ⏳ Planned
- `curl`: expand allowed flags — add `--resolve`, `--connect-to` for service endpoint testing
- `openssl s_client`: TLS handshake and certificate inspection (read-only)
- `dig` / `nslookup`: DNS resolution diagnostics

### CS2 — SSH & Remote Host Access ⏳ Planned
- `ssh_exec` tool: executes commands on remote hosts using workspace `ssh_key` / `ssh_password` credentials; target must be in environment `allowedServers` list
- `ssh` added to command whitelist with strict flag restrictions (no tunneling, no agent forwarding)
- Host diagnostic skills: memory/CPU/NUMA topology, disk I/O, process state, kernel logs
- InfiniBand diagnostic skills: link state, routing, congestion — commands already whitelisted (`ibaddr`, `iblinkinfo`, `ibswitches`, `ibroute`), only skill wrappers missing
- Switch/network device access: separate evaluation needed (SNMP read-only or vendor REST API via `api_token`)

---

## Agent Behavior Engineering Map

The six agent behavior principles must map to concrete engineering work, not remain as aspirations.

| Principle | Engineering Feature | Roadmap Item | Status |
|-----------|--------------------|-----------|----|
| **Cognitive humility** | `knowledge_search` called before answering; KB miss triggers explicit "I don't know" | KR0 | ⏳ |
| **Knowledge provenance** | Tool responses tagged: `[team-kb]` / `[investigation-memory]` / `[live-cluster]` / `[general]` | KR0 + IM2 | ⏳ |
| **Proactive context sensing** | Workspace context (namespace, recent alerts) injected at session start; triggers OB + KB pre-fetch | OB0 + PM1 | ⏳ |
| **Gap detection** | Compare KB-documented architecture vs. live cluster state; flag discrepancies | KR1 + OB2 | ⏳ |
| **Deep discussion** | Multi-turn hypothesis refinement; agent presents competing hypotheses and asks before concluding | IM2 | 🔄 |
| **Cross-domain association** | Connect a service's runbook, alert history, recent deployments, and investigation records | KR1 + IM2 | ⏳ |

---

## Current Sprint Priorities

| Priority | Item | Roadmap | Status | Notes |
|----------|------|---------|--------|-------|
| P1 | OB0: Prometheus metrics query tool | OB | ⏳ Planned | Largest capability gap; unblocks real SRE diagnosis |
| P1 | KR0: Qdrant stand-up + basic ingestion | KR | 🔄 In Progress | Embedded Qdrant first |
| P1 | IM Phase 2: diagnostic path learning | IM | 🔄 In Progress | Needs IM Phase 1 data accumulation |
| P2 | CS0: Helm + Istioctl + ArgoCD read-only | CS | ⏳ Planned | Expands command surface for real SRE workflows |
| P2 | PM1: 4-layer config cascade | PM | ⏳ Planned | Research R3 first |
| P3 | OB1: Log query (Loki/ES) | OB | ⏳ Planned | After OB0 pattern validated |
| P3 | KR1: Source connectors | KR | ⏳ Planned | After KR0 validated |
| P3 | CS2: SSH & remote host access | CS | ⏳ Planned | Credential layer ready; needs ssh_exec tool + skills |

---

## Open Research Items

| ID | Question | Blocking |
|----|----------|---------|
| R1 | Contextual Retrieval vs Late Chunking for technical docs | KR0 |
| R2 | OB tool output format: summarize metrics/logs for LLM without token explosion | OB0 |
| R3 | Config cascade merge strategy: JSON Merge Patch vs Strategic Merge Patch | PM1 |
| T2 | OB backend abstraction: single tool with backend param vs separate tools per backend | OB1 |

---

## Competitive Landscape (Reference)

| System | What we learned |
|--------|----------------|
| **RCACopilot** (Microsoft) | Handler + embedding vector DB + LLM classification — validated pattern closest to our approach |
| **HolmesGPT** (Robusta) | Multi-datasource OB integration (Prometheus/Grafana/ES/Datadog) — direct reference for OB roadmap |
| **Dynatrace** | Topology + causal engine — commercial standard for future KG direction |
| **OpenClaw** | Memory architecture (SQLite+FTS5+vector), batch embedding, query expansion — inform IM design |
| **OpenOcta** | Tool Profile mechanism, Exec Security tiers — inform CS and future workspace agent design |
| **Glean** | Memory + connectors + knowledge graph + governance — enterprise benchmark for long-term PM direction |

---

## Agent Behavior Principles (North Star)

The six characteristics that define the Siclaw agent experience. See "Agent Behavior Engineering Map" above for how each maps to concrete roadmap items.

1. **Cognitive humility** — Knows what it doesn't know; checks before answering
2. **Knowledge provenance** — Labels `[general knowledge]` vs `[team knowledge]` vs `[current finding]`
3. **Proactive context sensing** — Understands work context, pre-fetches relevant knowledge
4. **Gap detection** — Finds mismatches between documented architecture and live environment
5. **Deep discussion** — Doesn't just give answers; thinks through problems together
6. **Cross-domain association** — Connects knowledge across domains to find non-obvious causes
