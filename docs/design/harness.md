---
title: "Harness Design Philosophy"
sidebarTitle: "Harness"
description: "How we structure AI-assisted development to prevent knowledge drift, enforce invariants, and maintain code quality at scale."
---

# Harness Design Philosophy

> **Audience**: Human developers (the 3 of us + future contributors).
> This document explains *why* our development framework is designed the way it is,
> and *how* to work within it effectively.
>
> **Not for Claude alone** — this is for the team. Claude reads CLAUDE.md; this doc
> is the reasoning behind what's in CLAUDE.md.

---

## 1. The Problem We're Solving

Siclaw is developed primarily with AI coding assistants (Claude Code). This gives
us velocity — but introduces a class of problems that don't exist in pure-human
development:

### 1.1 Knowledge Drift

Each Claude session starts with a fresh context window. It reads CLAUDE.md and
whatever docs we point it to, but it has **no memory of past sessions' mistakes**.
Without explicit guardrails:

- Session A adds output sanitization to protect secrets
- Session B writes a skill that parses `kubectl get secret -o yaml` output
- Session C modifies the sanitizer, not knowing about Session B's skill
- The skill silently breaks — and nobody notices until production

This is not hypothetical. We experienced exactly this pattern with:
- **Output sanitization vs skill compatibility** — sanitizer changes broke
  skills that depended on raw kubectl output
- **kubectl tool removal** — the dedicated kubectl tool was dead code (never
  registered in agent-factory), deleted during cleanup, but docs still referenced
  it. No session caught the inconsistency because no session read both the docs
  and the registration code.

### 1.2 Context Anxiety

Research by Anthropic ("Harness Design for Long-Running Application Development",
2025) identified a behavioral pattern called **context anxiety**: as an LLM agent
approaches what it *believes* is its context limit, it begins prematurely wrapping
up work — cutting corners, skipping verification steps, declaring victory early.

Mitigation: the **Change Impact Matrix** in CLAUDE.md makes blast radius explicit,
forcing each session to front-load understanding before coding.

### 1.3 Compounding Errors

Without explicit feedback loops, AI sessions repeat the same mistakes:
- Anthropic calls the fix "compounding engineering" — every time Claude does
  something wrong, add a note to CLAUDE.md so it doesn't happen again
- Our Change Impact Matrix is the structured form of this: each row encodes
  a lesson learned about what breaks when you touch a particular area

---

## 2. Our Harness Architecture

The harness is everything around the model that makes it produce correct, safe,
consistent code. It has three layers:

```
┌──────────────────────────────────────────────────────────┐
│ Layer 3: Automated Verification                           │
│ CI (typecheck + vitest), future: hooks, integration tests │
│ Catches: things that slipped through Layers 1-2           │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│ Layer 2: Development Protocol (CLAUDE.md)                 │
│ Pre-flight, Change Impact Matrix, Compaction Rules        │
│ Catches: "I didn't know modifying X would break Y"        │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│ Layer 1: Documentation Parity (docs/design/)              │
│ invariants.md, security.md, tools.md, sanitization.md,    │
│ skills.md, decisions.md                                    │
│ Catches: "I didn't know this constraint existed"           │
└──────────────────────────────────────────────────────────┘
```

### What Each Layer Does

**Layer 1 (Documentation Parity)**: The source of truth for how things work
and why. Every architectural constraint, security model, and design decision
is documented. Code and docs must stay in sync — outdated docs actively mislead.

**Layer 2 (Development Protocol)**: The operational rules for how to use
Layer 1 effectively. CLAUDE.md is auto-loaded by Claude Code at session start.
Its core is the **Change Impact Matrix**: "If you change file X → must read
doc Y → must verify Z → watch out for cross-cutting concern W".

**Layer 3 (Automated Verification)**: The safety net. Currently:
- TypeScript strict mode + `npx tsc --noEmit` (type errors caught at compile)
- `vitest` test suite with heavy coverage on security paths
- DDL parity check (schema-sqlite.ts ↔ migrate-sqlite.ts table sync)
- CI pipeline (typecheck + test on every PR)

---

## 3. Design Principles

These principles guide how we evolve the harness itself:

### 3.1 Advisory vs Mandatory

CLAUDE.md rules are **advisory** — Claude reads them but can choose to skip them
under time pressure or context anxiety. Hooks and CI checks are **mandatory** —
they block the action if the rule is violated.

**Current state**: Most rules are advisory. This is acceptable while the team is
small (3 people) and sessions are supervised. As the project grows, critical rules
should migrate from advisory (CLAUDE.md) to mandatory (hooks/CI).

**Migration priority** (rules that should become mandatory first):
1. ~~DDL parity check~~ — ✅ Done (vitest test in `ddl-parity.test.ts`)
2. `src/core/prompt.ts` edit gate — security-critical, easy to automate
3. Doc-code sync detection — harder to automate, but high drift risk

### 3.2 Concise Over Comprehensive

Anthropic's research shows that **rules get lost in long files**. CLAUDE.md should
be ≤200 lines. Detailed specifications live in `docs/design/` and are loaded on
demand via the Change Impact Matrix.

If you find yourself adding more than 5 lines to CLAUDE.md, consider:
- Is this a rule that applies to ALL sessions? → CLAUDE.md
- Is this domain-specific knowledge? → Relevant `docs/design/*.md`
- Is this a one-time lesson? → Update the Change Impact Matrix row

### 3.3 Encode Assumptions Explicitly

From Anthropic's harness research: *"Every component in a harness encodes an
assumption about what the model can't do on its own."*

When we add a rule to CLAUDE.md or a check to CI, we should document *why* — what
failure mode does this prevent? This lets us remove rules when they become
unnecessary (e.g., if model capabilities improve enough to make a guardrail
redundant).

### 3.4 Separate Generation from Evaluation

AI models are poor critics of their own output. The session that writes code
should not be the sole judge of whether it's correct. Our approach:

- **review-maintainer skill**: Separate Claude session reviews PRs against
  design docs and the Change Impact Matrix
- **Pre-flight protocol**: Forces the developer session to acknowledge constraints
  before coding, not after
- **CI tests**: Automated evaluation independent of the coding session

### 3.5 Cross-Cutting Concerns Are First-Class

The most dangerous bugs come from changes that are correct in isolation but break
something elsewhere. The Change Impact Matrix's "Cross-cutting concerns" column
makes these dependencies explicit.

Current known cross-cutting concerns:
- **Sanitization ↔ Skills**: Changing output sanitization can break skills that
  parse command output; changing skills can expose unsanitized data
- **Command whitelist ↔ Skills**: Adding/removing commands affects what skills
  can use (though skill scripts are exempt from the whitelist)
- **Brain types ↔ Tools**: New tools must work with both pi-agent and claude-sdk
- **Local mode ↔ Resource sync**: Any sync code must respect shared filesystem

---

## 4. Compounding Engineering

When a Claude session breaks something it shouldn't have:
1. Fix the immediate issue
2. Ask: "What did the harness fail to catch?"
3. Update the appropriate layer:
   - Missing knowledge → Update `docs/design/*.md` (Layer 1)
   - Knowledge existed but wasn't consulted → Add row to Change Impact Matrix (Layer 2)
   - Consulted but not enforced → Add CI check or hook (Layer 3)

Every mistake should improve the harness for the next session.

---

## 5. Design Influences

Informed by Anthropic's research on AI agent harness design (2025). Key principle:
the harness should **shrink** with model improvements, not accumulate indefinitely.
The *why* behind each rule (documented in this file) tells us when it's safe to remove.

---

## 6. Quick Reference: Design Doc Inventory

```
docs/design/
├── harness.md        ← This file (harness philosophy, for humans)
├── invariants.md     ← Architecture constraints (deployment modes, bundles, DB, security)
├── security.md       ← 6-layer defense model (OS isolation, command whitelist, containers)
├── sanitization.md   ← 3-layer output sanitization (pre/post strategy, skill exemption)
├── tools.md          ← Tool organization, execution pipelines, context system
├── skills.md         ← Skill lifecycle, approval workflow, execution model
├── guards.md         ← Guard pipeline (input/output/persist/context interceptors)
└── decisions.md      ← ADRs (sql.js, LocalSpawner, whitelist, memory, mTLS, brain types)
```
