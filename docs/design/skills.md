# Skills Architecture

> Canonical model: `docs/design/2026-04-13-skill-governance-design.md` (flat-pool + status-gate + agent-binding). This file summarises the runtime contract and how the agent sees skills. For governance flow, review state machine, and migration rationale, read the governance doc.

## Design Principles

1. **Single flat pool per org.** All skills (builtin, user-created, overlays) live in one `skills` table — no scope hierarchy, no skill-spaces, no per-user fork tree. `is_builtin` and `overlay_of` are flags, not tiers.
2. **Status gates execution eligibility.** `draft → pending_review → installed`. Prod agents see only `is_approved = 1` versions; dev agents see current `skills.specs/scripts`.
3. **Explicit agent binding.** `agent_skills` is the only delivery channel — an agent only receives skills explicitly bound to it. There is no implicit "everything global" bundle.
4. **One execution surface.** AgentBox writes the active bundle into a single flat `.siclaw/skills/resolved/` directory. The agent reads only from there (plus the always-loaded `skills/platform/`); the on-disk `skills/core/` is the fallback when `resolved/` doesn't exist.
5. **Builtins flow through the same pipeline.** Gateway startup scans `skills/core/` and upserts each into the DB with `is_builtin=1`, `status=installed`, `is_approved=1`. After that, builtins are normal DB rows that can be overlaid, re-reviewed, or rolled back.

---

## The Security-Flexibility Trade-off

Siclaw's command whitelist (`ALLOWED_COMMANDS` in `command-sets.ts`) restricts ad-hoc agent commands to a safe read-only set (`kubectl get`, `ip`, `ethtool`, etc.). **Skill scripts are the escape hatch** — the whitelist does not filter inside skill scripts, so a script can use any binary, flag, or pipeline.

This makes skills a **privilege escalation channel**. The trade-off is managed through the status gate:

- **Dev environment**: latest content (draft + installed) is delivered, so authors can iterate freely
- **Prod environment**: only `is_approved = 1` snapshots are delivered — every script in production has been through static pattern scan + AI semantic review + a human reviewer approval

Editing an `installed` skill creates a new version and resets `status = draft` — the next prod fetch will not see the change until it is re-approved.

### Why skills instead of ad-hoc commands?

1. **Flexibility** — bypass the command whitelist for legitimate operational procedures
2. **Reliability** — tested scripts vs trial-and-error command generation
3. **Safety** — the dev/prod split + approval workflow gates production
4. **Reusability** — encode investigation patterns once, reuse across agents
5. **Governance** — review audit trail in `skill_reviews`

---

## Skill Format on Disk

Builtins under `skills/core/` follow this layout:

```
{skillName}/
├── SKILL.md              # YAML frontmatter + Markdown body
└── scripts/
    ├── main.sh
    └── helper.py
```

```yaml
---
name: find-node
description: >-
  Fuzzy-match Kubernetes nodes by keyword.
  Use this instead of listing all nodes to keep context minimal.
---
```

`name` and `description` are surfaced in the agent's system prompt. `meta.json` next to the skill dirs supplies `labels` (`{ "find-node": ["kubernetes", "general"] }`) used for filtering in the UI.

The bundle delivers the same structure (one directory per skill, `SKILL.md` + `scripts/*`) but unpacked into `.siclaw/skills/resolved/` at runtime — there are no scope subdirectories.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `skills` | Skill rows: `id`, `org_id`, `name`, `description`, `labels`, `author_id`, `status`, `version`, `specs`, `scripts`, `created_by`, `is_builtin`, `overlay_of` |
| `skill_versions` | Immutable history: `id`, `skill_id`, `version`, `specs`, `scripts`, `diff`, `commit_message`, `author_id`, `is_approved`, `labels`. UNIQUE `(skill_id, version)` |
| `skill_reviews` | Submit / approve / reject audit: `id`, `skill_id`, `version`, `diff`, `security_assessment`, `submitted_by`, `reviewed_by`, `decision`, `reject_reason` |
| `agent_skills` | Binding junction: `(agent_id, skill_id)` |

Status values: `draft`, `pending_review`, `installed`.

Indexes:
- `idx_skills_org_name (org_id, name)` — **non-unique** (relaxed so a builtin and its overlay can share a name)
- `idx_skills_overlay (overlay_of)`

---

## Status Lifecycle

```
       ┌─────── withdraw ───────┐
       ▼                        │
    [draft] ───submit───▶ [pending_review] ───approve───▶ [installed]
       ▲                        │                              │
       │                      reject                         edit
       │                        │                              │
       └────────────────────────┘                              │
       └───────────────────────────────────────────────────────┘
                                   (edit on installed →
                                    new version, status=draft)
```

| Status | Edit behavior |
|---|---|
| `draft` | In-place update, no version bump |
| `pending_review` | Blocked — must withdraw first |
| `installed` | Creates new `skill_versions` row, resets `status = draft` |

### Review

Submit triggers two-phase analysis stored on `skill_reviews.security_assessment`:

1. **Static pattern scan** (`script-evaluator.ts`): regex rules categorized by risk (`destructive_command`, `privilege_escalation`, `data_exfiltration`, …) with severities (critical / high / medium / low). `rm -rf` → critical, `kubectl delete` → high, `curl -d` → high.
2. **AI semantic review** (`ai-security-reviewer.ts`): LLM receives scripts + Phase 1 findings; returns structured `{ riskLevel, findings[], summary }`. Falls back to static-only when AI is unavailable.

Approve sets `is_approved=1` on the current version and `status=installed`. Reject sets `status=draft` and stores `reject_reason`.

### Rollback

Copies a target version's content into a new version with `status=draft` (must re-review):

```
v1 ✓ approved  "Initial version"
v2 ✓ approved  "Add timeout retry"
v3   draft     "Refactor"          ← broken
v4   draft     "Rollback to v1"    ← content equals v1, fresh version number
```

Rollback is blocked while `status=pending_review` (withdraw first).

---

## Overlays

`overlay_of` lets a user-created skill replace a builtin's content while keeping the same `name`. Bundle queries skip the base skill when an overlay exists for it. Used to customize a builtin without losing the ability to roll back to the original Docker-shipped content (which lives in v1 of the base row).

```
skills/core/find-node       → DB row A (is_builtin=1, status=installed, v1 approved)
User edits "find-node"      → New DB row B (is_builtin=0, overlay_of=A)
Bundle for agents bound to A → returns B's content; A is suppressed
```

---

## Builtin Sync at Startup

Gateway startup runs `syncBuiltinSkills()`:

```
For each directory under skills/core/:
  Parse SKILL.md frontmatter + scripts/* + meta.json labels
  Compute contentHash = SHA-256(specs + sorted scripts)

  Not in DB:
    INSERT with is_builtin=1, status=installed, version=1, is_approved=1
    Create skill_versions(v1, is_approved=1)

  In DB, hash matches:    SKIP
  In DB, user not edited: UPDATE content, version+1, status=installed,
                          create skill_versions(is_approved=1)
                          (image upgrade auto-applies to untouched builtins)
  In DB, user has edited: SKIP (user's edits win; they can rollback to v1
                          to restore the original Docker-shipped version)
```

`skills/platform/` is **never** synced — those skills (skill-authoring, manage-skill) are platform meta-skills, kept on disk, and always loaded by `agent-factory.ts` regardless of bundle state.

---

## Bundle Delivery

### Endpoint

`POST /api/internal/siclaw/skills/bundle` — see `src/portal/adapter.ts`.

Request body:
```json
{ "skill_ids": ["<id>", ...], "is_production": true }
```

Skill IDs come from the `agent_skills` join for the requesting agent.

### Query logic

```sql
-- Production: latest approved version snapshot
SELECT COALESCE(o.id, s.id) AS id, COALESCE(o.name, s.name) AS name,
       COALESCE(o.labels, s.labels) AS labels,
       COALESCE(ov.specs, sv.specs) AS specs,
       COALESCE(ov.scripts, sv.scripts) AS scripts
FROM skills s
LEFT JOIN skills o ON o.overlay_of = s.id              -- overlay wins
LEFT JOIN skill_versions sv ON sv.skill_id = s.id AND sv.is_approved = 1
  AND sv.version = (SELECT MAX(v2.version) FROM skill_versions v2
                    WHERE v2.skill_id = s.id AND v2.is_approved = 1)
LEFT JOIN skill_versions ov ON ov.skill_id = o.id AND ov.is_approved = 1
  AND ov.version = (SELECT MAX(v3.version) FROM skill_versions v3
                    WHERE v3.skill_id = o.id AND v3.is_approved = 1)
WHERE s.id IN (?)

-- Dev: current content (no version filter)
SELECT COALESCE(o.id, s.id), COALESCE(o.name, s.name),
       COALESCE(o.labels, s.labels),
       COALESCE(o.specs, s.specs),
       COALESCE(o.scripts, s.scripts)
FROM skills s
LEFT JOIN skills o ON o.overlay_of = s.id
WHERE s.id IN (?)
```

A prod agent bound to a skill that has never been approved gets an empty row — silently excluded from the bundle until it passes review.

### Response shape

```typescript
{
  version: string,                     // ISO timestamp
  skills: Array<{
    dirName: string,                   // name.replace(/[^a-zA-Z0-9_-]/g, "_")
    scope: "global",                   // legacy field, hardcoded; only used for
                                       // dirName collision priority
    specs: string,                     // SKILL.md content
    scripts: Array<{ name, content }>
  }>
}
```

The `scope` field is a vestige of the old multi-tier model. The bundle always sends `"global"`; AgentBox's `SkillBundlePayload` declares `"builtin" | "global"` only so `skillsHandler.materialize()` can use it as a dirName-collision tie-breaker (global > builtin > other). It carries no scope semantics beyond that.

---

## Materialize → resolved/

`skillsHandler.materialize()` in `src/agentbox/sync-handlers.ts`:

```
Bundle payload → .siclaw/skills/resolved/<dirName>/{SKILL.md, scripts/*}

Rules:
  - Wipe and recreate resolved/ before writing
  - Empty-bundle protection: if incoming.skills is empty AND resolved/
    already has skills, SKIP the wipe (transient Gateway failure guard)
  - Dedup by dirName; priority order global > builtin > other
  - First write wins
```

There is **no per-user segment**. K8s pods are isolated by emptyDir; LocalSpawner shares the cwd, so materialize is unsafe there and is **skipped entirely** by `local-spawner.ts` (only `knowledgeHandler` runs in local mode).

---

## Runtime Modes

| Mode | What the agent sees | Materialize target |
|------|---------------------|--------------------|
| **K8s pod** | bundle skills + `skills/platform/` | `.siclaw/skills/resolved/` (per-pod emptyDir) |
| **LocalSpawner** | `skills/core/` + `skills/platform/` only | not written (handler skipped) |
| **TUI standalone** | `skills/core/` + `skills/platform/` only | not written |
| **TUI + local Portal** | Portal snapshot + `skills/platform/` | `.siclaw/.portal-snapshot/skills/` (ephemeral, cleaned on TUI exit) |

In K8s mode the bundle is the source of truth — `skills/core/` on disk is only a fallback when `resolved/` doesn't yet exist (first boot before the first sync).

In local mode (LocalSpawner or standalone TUI), DB-managed skills are **not delivered** to agents. This is a deliberate limitation of the shared-filesystem multi-user model — see `docs/design/invariants.md` §1.2 and §6.2.

In TUI + local Portal mode, `agent-factory.ts` installs a `skillsOverride` filter on `DefaultResourceLoader` that restricts the visible skill set to paths rooted under either `portalSkillsDir` or `skills/platform/`. Without this filter, the loader would auto-discover user-global skills from `~/.pi/agent/skills/`, which would bypass the Portal-as-SoT contract — see `docs/design/invariants.md` §1.4.

---

## Skill Execution

### Path resolution

`resolveSkillScript(skill, script)` in `src/tools/infra/script-resolver.ts` walks (in order):

1. `.siclaw/skills/resolved/<skill>/scripts/<script>` (materialize output)
2. `.siclaw/skills/<skill>/scripts/<script>` (legacy flat layout)
3. `.siclaw/skills/<global|core>/<skill>/scripts/<script>` (legacy scope subdirs)
4. `skills/core/<skill>/scripts/<script>` (Docker-baked fallback) — unless `.disabled-builtins.json` lists the skill

Path 1 is what current K8s flow produces. Paths 2–3 are kept for legacy on-disk layouts that may exist in older deployments. Path 4 is the TUI / first-boot fallback.

### local_script tool

`src/tools/script-exec/local-script.ts`:

1. Resolve script path (above)
2. Pick interpreter: `.sh` → `bash`, `.py` → `python3`
3. `spawn()` with args array (no shell interpolation)
4. Run as `sandbox` user (OS-level isolation, no credential access)
5. 300 s max timeout, 10 MB max combined output

### restricted-bash skill bypass

`restricted-bash` accepts a command if `isSkillScript()` resolves the target to a path under `skills/` (or `config.paths.skillsDir`). This is the secondary execution path — `local_script` is preferred because it goes straight through the path resolver with no shell intermediary.

---

## Agent Discovery

`agent-factory.ts` assembles `skillsDirs` in this order:

```
1. opts.portalSkillsDir (when TUI + Portal active)         → exclusive
2. .siclaw/skills/resolved/ (when present)                  → bundle output
3. skills/core/ (fallback when neither above exists)        → TUI / first boot
+ skills/platform/ (always appended, never an exclusive)
```

`DefaultResourceLoader` (from pi-coding-agent) scans these dirs for `SKILL.md`, parses frontmatter, and injects each skill's `description` into the agent's system prompt. The agent invokes a skill by calling `local_script(skill, script)`.

---

## File Reference

```
Code
  src/portal/adapter.ts                      Bundle endpoint (POST /api/internal/siclaw/skills/bundle)
  src/portal/migrate.ts                      Schema (skills / skill_versions / skill_reviews)
  src/gateway/skills/builtin-sync.ts         Startup sync of skills/core/ into DB
  src/gateway/skills/script-evaluator.ts     Static pattern scan (Phase 1 review)
  src/gateway/skills/ai-security-reviewer.ts AI semantic analysis (Phase 2 review)
  src/agentbox/sync-handlers.ts              skillsHandler: fetch + materialize
  src/core/agent-factory.ts                  skillsDirs assembly, skillsOverride for TUI+Portal
  src/tools/infra/script-resolver.ts         resolveSkillScript path search
  src/tools/script-exec/local-script.ts      Skill execution tool
  src/lib/portal-skill-materializer.ts       TUI Portal-snapshot materialize (distinct from skillsHandler)

Disk layout
  skills/core/                               Builtin skills (Docker-baked, synced into DB)
  skills/platform/                           Platform meta-skills (always loaded, never in DB)
  .siclaw/skills/resolved/                   Runtime materialize target (K8s)
  .siclaw/.portal-snapshot/skills/           TUI + Portal ephemeral materialize target

Reference
  docs/design/2026-04-13-skill-governance-design.md   Canonical governance design
  docs/design/invariants.md §1.2, §1.3, §2, §6        Bundle / materialize / mode contracts
  docs/design/decisions.md ADR-003                    Bundle delivery decision rationale
```
