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

Siclaw is built in four interconnected layers:

```
┌─────────────────────────────────────────────────────┐
│  Persona & Workspace System  (PM roadmap)            │
│  4-layer patch: System → Team → Personal → Workspace │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────┐
│  Knowledge Streams (KR roadmap)                      │
│  Stream A: Team KB (Qdrant)  Stream B: Investigation │
│            external docs         Memory (SQLite)     │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────┐
│  Investigation Engine (IM roadmap)                   │
│  Deep search · Hypothesis validation · Memory loop   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────┐
│  Agent Runtime (current foundation)                  │
│  TUI · Gateway · AgentBox · Skills · Tools · MCP     │
└─────────────────────────────────────────────────────┘
```

---

## Roadmap A — Investigation Memory (IM)

The knowledge feedback loop: every investigation produces structured experience that improves future diagnoses.

### IM Phase 0 — Raw Memory Loop ✅ Complete
- Write investigation notes to markdown memory files
- Vector + FTS hybrid search over memory
- Inject relevant memories into agent context at session start

### IM Phase 1 — Structured Knowledge Extraction ✅ Complete (PR #17)
- Dual-output: raw markdown + structured `investigations` SQLite table
- Schema: `question`, `root_cause_category`, `affected_entities`, `environment_tags`, `causal_chain`, `confidence`, `conclusion`
- Hybrid retrieval: vector similarity + structured field filtering
- Investigation records persist across sessions

### IM Phase 2 — Diagnostic Path Learning 🔄 In Progress
- Extract reusable diagnostic patterns from investigation histories
- Build "playbook index": symptom patterns → hypothesis templates → validated tools
- Feed patterns into Phase 2 (hypothesis generation) of deep investigation engine
- Automatic pattern confidence scoring based on historical outcomes

### IM Phase 3 — Cross-Investigation Correlation ⏳ Planned
- Detect recurring failures across multiple investigations
- Build causal graphs: environment change → failure pattern → root cause
- Surface "this looks like the incident from 2 weeks ago" proactively
- Temporal decay for outdated patterns

### IM Phase 4 — Active Learning ⏳ Planned
- Agent identifies gaps in its own knowledge ("I've seen this symptom but never found the cause")
- Proactively asks questions or suggests follow-up investigations
- Knowledge completeness scoring per failure category

### IM Phase 5 — Team Knowledge Merge ⏳ Planned
- Merge investigation memories across team members (with consent model)
- Conflict resolution for contradictory findings
- Attribution tracking (who discovered what)

---

## Roadmap B — Knowledge Base & Retrieval (KR)

External knowledge ingestion: team docs, runbooks, architecture diagrams → searchable by the agent.

### KR0 — Qdrant + Basic Ingestion 🔄 Next Priority
- Stand up Qdrant vector store (embedded or self-hosted)
- Ingest: team docs (Confluence/Notion/markdown), runbooks, architecture diagrams
- Chunking strategy: heading-aware hierarchical chunking (Anthropic Contextual Retrieval pattern)
- Basic semantic search for agent via `knowledge_search` tool
- Evaluate: Contextual Retrieval vs Late Chunking for technical docs

### KR1 — Source Connectors ⏳ Planned
- Connectors: GitHub (issues, PRs, wikis), Confluence, Notion, local filesystem
- Incremental sync (only re-ingest changed content)
- Source attribution in search results

### KR2 — Knowledge Graph Overlay ⏳ Planned
- Entity extraction: services, nodes, deployments, configs
- Relationship graph: "service A depends on service B via env var X"
- Graph-augmented retrieval: entity → related docs → context
- Storage options: Kuzu (embedded KG) vs SQLite relation tables (T1 open research)

### KR3 — Knowledge Quality & Trust ⏳ Planned
- Content freshness scoring (docs older than 90 days get staleness warning)
- Conflict detection: runbook says X, investigation found Y
- Trust levels: verified (admin-reviewed), contributed (team), auto-ingested

### KR4 — Proactive Knowledge Surfacing ⏳ Planned
- Agent detects "current environment differs from documented architecture"
- Surfaces relevant runbooks before user asks
- "What changed since last deployment" cross-references knowledge base

### KR5 — Multi-Team Knowledge Federation ⏳ Planned
- Team A shares runbooks with Team B (with ACL)
- Federated search across multiple Qdrant collections
- Knowledge licensing and access control model

---

## Roadmap C — Persona & Workspace System (PM)

The "cyber-twin" model: one person, multiple workspaces (personas), each accumulating context independently.

### PM0 — Workspace Foundation ✅ Complete (in Agent Runtime)
- Workspace CRUD via WebUI
- Per-workspace: skills, tools, environments, credentials, allowed models
- `{userId}:{workspaceId}` as fundamental isolation unit

### PM1 — 4-Layer Config Cascade ⏳ Planned
- Full implementation of: System → Team → Personal → Workspace patch model
- JSON Merge Patch vs Strategic Merge Patch evaluation (R3 open research)
- Workspace inherits team config, can override at personal or workspace level
- Mandatory policies at System layer cannot be overridden

### PM2 — Skill Trust Tiers ⏳ Planned
- `restricted` / `standard` / `elevated` skill permission levels
- Elevated skills require explicit workspace grant
- Skill review workflow respects tier (elevated requires senior reviewer)

### PM3 — Persona Memory Isolation ⏳ Planned
- Each workspace has its own memory space (separate investigation history)
- Cross-workspace memory sharing (opt-in, with attribution)
- Memory export/import between workspaces

### PM4 — Team Persona & Shared KB ⏳ Planned
- Team-level persona: shared external KB + individual investigation memories
- Team onboarding: new member inherits team KB baseline
- Contribution model: personal discoveries promoted to team KB after review

---

## Current Sprint Priorities

| Priority | Item | Status | Notes |
|----------|------|--------|-------|
| P1 | KR0: Qdrant stand-up + basic ingestion | 🔄 In Progress | Storage: embedded Qdrant |
| P1 | IM Phase 2: diagnostic path learning | 🔄 In Progress | Depends on IM Phase 1 data accumulation |
| P2 | PM1: 4-layer config cascade | ⏳ Planned | Research R3 first |
| P3 | KR1: Source connectors | ⏳ Planned | After KR0 validated |

---

## Open Research Items

| ID | Question | Blocking |
|----|----------|---------|
| R1 | Contextual Retrieval vs Late Chunking for technical docs | KR0 |
| R3 | Config cascade merge strategy: JSON Merge Patch vs Strategic Merge Patch | PM1 |
| R5 | Agent Memory deep-dive: Mem0 vs Letta vs Zep vs Cognee | IM Phase 3 |
| T1 | Embedded KG storage: Kuzu vs SQLite relation tables | KR2 |

---

## Competitive Landscape (Reference)

| System | What we learned |
|--------|----------------|
| **RCACopilot** (Microsoft) | Handler + embedding vector DB + LLM classification — validated pattern closest to our approach |
| **HolmesGPT** (Robusta) | Multi-datasource integration (Prometheus/Grafana/ES/Datadog) — reference for KR connectors |
| **Dynatrace** | Topology + causal engine — commercial standard for KR2 KG direction |
| **OpenClaw** | Memory architecture (SQLite+FTS5+vector), batch embedding, query expansion — inform IM design |
| **Glean** | Memory + connectors + knowledge graph + governance — enterprise benchmark for PM4 |

---

## Agent Behavior Principles (North Star)

The six characteristics that define the Siclaw agent experience:

1. **Cognitive humility** — Knows what it doesn't know; checks before answering
2. **Knowledge provenance** — Labels `[general knowledge]` vs `[team knowledge]` vs `[current finding]`
3. **Proactive context sensing** — Understands work context, pre-fetches relevant knowledge
4. **Gap detection** — Finds mismatches between documented architecture and live environment
5. **Deep discussion** — Doesn't just give answers; thinks through problems together
6. **Cross-domain association** — Connects knowledge across domains to find non-obvious causes
