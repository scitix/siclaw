---
title: "Skills System"
sidebarTitle: "Skills"
description: "Architecture, lifecycle, approval workflow, and deployment-mode behavior of the skills system."
---

# Skills System

> **Purpose**: Document the full skills architecture — scopes, lifecycle, approval workflow,
> execution model, and how skills behave across deployment modes.
>
> Read this before touching: `src/tools/shell/local-script.ts`, `src/tools/infra/script-resolver.ts`,
> `src/gateway/skills/`, `src/agentbox/resource-handlers.ts`, or `src/core/agent-factory.ts`.

---

## 1. Design Intent

Skills are **packaged diagnostic procedures** — each skill is a directory containing a specification
(`SKILL.md`) and executable scripts (`scripts/`). The agent reads the spec to understand *when* and
*how* to use a skill, then executes its scripts via the `local_script` tool.

### The Security–Flexibility Trade-off

Siclaw's command whitelist (`ALLOWED_COMMANDS` in `command-sets.ts`) restricts the agent to a set of
safe, read-only binaries (e.g. `kubectl get`, `ip`, `ethtool`). This protects production environments
from accidental mutations but limits what the agent can do — many real-world SRE tasks require
commands that go beyond read-only operations (restarting services, modifying configs, running
performance tests, etc.).

**Skill scripts are the escape hatch.** The command whitelist does *not* filter commands inside skill
scripts — a script can use any binary, any flag, any pipeline. This gives users full flexibility to
encode arbitrary operational procedures as skills. The trade-off is managed through the approval
workflow:

- **Dev environment**: users can freely create, edit, and test skills with no restrictions.
  All personal skills (including drafts) are immediately available to the agent.
- **Prod environment**: only reviewer-approved skills are loaded. Before a skill reaches
  production, it goes through static pattern analysis + AI semantic review + human reviewer
  approval. This ensures scripts are safe and intentional before they can run against live
  infrastructure.

In effect, skills should be treated as **read-only at runtime** — they are executed as-is, not
modified on the fly. The editing and iteration happen in dev; production gets immutable, approved
snapshots.

### Why skills instead of ad-hoc commands?

1. **Flexibility** — skill scripts bypass the command whitelist, enabling operations that the
   agent cannot perform through ad-hoc commands alone.
2. **Reliability** — tested scripts avoid the trial-and-error of ad-hoc command generation.
3. **Safety** — the dev/prod split and approval workflow ensure only reviewed scripts run in
   production, even though the scripts themselves are unrestricted.
4. **Reusability** — investigation patterns are encoded once, used by all users.
5. **Governance** — the approval workflow ensures scripts meet the team's quality and security
   bar before they enter the shared pool.

---

## 2. Skill Format

```
{skillName}/
├── SKILL.md              # Specification (YAML frontmatter + Markdown body)
└── scripts/
    ├── main-script.sh    # One or more executable scripts
    └── helper.py
```

### SKILL.md Frontmatter

```yaml
---
name: find-node
description: >-
  Fuzzy-match Kubernetes nodes by keyword.
  Use this instead of listing all nodes to keep context minimal.
---
```

The `name` and `description` fields are parsed by `SkillFileWriter.parseFrontmatter()` and surfaced
in the agent's system prompt for skill discovery.

### Labels (`meta.json`)

Each tier directory (`skills/core/`, `skills/extension/`) may contain a `meta.json`:

```json
{
  "labels": {
    "find-node":      ["kubernetes", "general", "diagnostic"],
    "dns-debug":      ["kubernetes", "network", "diagnostic"]
  }
}
```

Labels are loaded at startup by `src/gateway/skill-labels.ts` and used for filtering in the UI.
Core and extension labels are unified under the `builtin` tier key.

---

## 3. Skill Scopes

| Scope | Source | Mutability | Visibility | Directory | Bundle |
|-------|--------|-----------|------------|-----------|--------|
| **builtin** | Docker image | Immutable at runtime | All users | `skills/core/`, `skills/extension/` | Not in bundle (baked) |
| **global** | Gateway DB | Admin-editable; contributed from personal | All users | `.siclaw/skills/global/` | prod + dev |
| **skillset** | Gateway DB | Skill Space maintainers | Space members | `.siclaw/skills/skillset/{spaceId}/` | **dev only** |
| **personal** | Gateway DB | Author-editable | Author only | `.siclaw/skills/user/{userId}/` | prod + dev |

### Resolution Priority

When multiple scopes contain a skill with the same name, the highest-priority scope wins:

```
personal > skillset > global > builtin
```

Defined in `src/tools/infra/script-resolver.ts` `SKILL_SCOPES`. The directory-to-scope
mapping is: `user/` → personal, `skillset/` → skillset, `extension/` → global (builtin overlay),
`global/` → global, `core/` → builtin.

### Skill Spaces (skillset scope)

A **Skill Space** is a named collaboration group for developing and testing skills before
promoting them to the global pool. Skills inside have `scope="skillset"` and are:

- **Dev-only** — included in dev bundles, excluded from prod bundles
- **Member-controlled** — only Skill Space maintainers can create/edit/delete skills within
- **Promotable** — when approved via `skill.review`, a skillset skill is auto-promoted to a
  global skill (creating or updating `scope="global"` with the same `dirName`)

Skill Spaces are managed via the `skillSpaces` and `skillSpaceMembers` tables, with
`owner` and `maintainer` roles.

### Workspace Skill Composer

The Workspace creation dialog organizes skills into three tabs:

| Tab | Contains | Selection mechanism |
|-----|----------|-------------------|
| **Global** | `builtin` + `global` combined (deduped by `dirName` — global wins) | `globalSkillRefs[]` with `"builtin:name"` or `"global:id"` prefix |
| **Skill Spaces** | `skillset` skills grouped by space | `skillSpaces[]` with per-space `disabledSkillIds` |
| **Personal** | `personal` skills for current user | `personalSkillIds[]` |

### Builtin Sub-Tiers: core vs extension

Both `skills/core/` and `skills/extension/` are **builtin** — they are baked into the Docker image,
read-only at runtime, and treated identically by the agent. The split is organizational:

- **`skills/core/`** — maintained in the base siclaw repository. General-purpose diagnostic skills
  (K8s, networking, Volcano, etc.).
- **`skills/extension/`** — maintained by inner/overlay projects. Domain-specific skills that are
  `COPY`'d into the Docker image via a thin overlay Dockerfile. This separation ensures inner
  projects never conflict with base repo upgrades.

### Disabling Builtins

Users can disable individual builtin skills via `skill.setEnabled(name, false)`.
Disabled skills are stored per-user in `user_disabled_skills` and written to
`.disabled-builtins.json` at bundle sync time. The agent-factory excludes disabled skills
from `additionalSkillPaths`.

---

## 4. Lifecycle & Approval Workflow

### States

```
                     ┌───────────────────────────┐
                     │                           │
  create ──► draft ──┤── submit ──► pending ──┬──┤── approve ──► approved
                     │                        │  │
                     │◄── reject (back to draft)  │
                     │                           │
                     └───────────────────────────┘
```

The `reviewStatus` field tracks this state machine:

| State | Meaning |
|-------|---------|
| `draft` | Author is editing. Working copy only. |
| `pending` | Submitted for review. Staging snapshot created. AI review triggered. |
| `approved` | Reviewer approved. Published copy available. |

### Content Tags

Each skill has up to three content snapshots stored in `skill_contents`:

| Tag | Purpose |
|-----|---------|
| `working` | Author's latest edits. Always exists for personal skills. |
| `staging` | Snapshot at submission time. Reviewer sees this version. |
| `published` | Approved version. Included in prod bundles. |

### Dev vs Prod Environments

| Environment | Personal skills included | Content tag used |
|-------------|------------------------|------------------|
| **dev** | All (including draft) | `working` |
| **prod** | Only approved | `published` |

In dev mode, the agent can access a skill immediately after creation — no approval needed.
In prod mode, only reviewer-approved skills are visible.

### Global Contribution Flow

A personal skill can be contributed to the global pool:

1. **Author submits** with `contributeToGlobal=true` → `contributionStatus="pending"`
2. **AI script review** runs asynchronously (static patterns + LLM analysis)
3. **Reviewer approves** → auto-promotion:
   - Creates (or updates) a global skill with the same `dirName`
   - Copies published content from personal → global
   - Sets `globalSourceSkillId` + `globalPinnedVersion` for audit trail
   - All users' bundles are invalidated and re-synced
4. **Rejection** → reverts to `draft`, `contributionStatus="none"`

Skill Space skills follow a similar flow: when a skillset skill is approved,
it is auto-promoted to `scope="global"` (creating or updating the global skill
with matching `dirName`).

### Script Security Review

When a skill is submitted (`skill.submit`), `triggerScriptReview()` performs two-phase analysis:

**Phase 1 — Static pattern matching** (`DANGER_PATTERNS` in `script-evaluator.ts`):
- Regex rules categorized by risk: `destructive_command`, `privilege_escalation`,
  `data_exfiltration`, `env_mutation`, etc.
- Severity levels: `critical`, `high`, `medium`, `low`
- Examples: `rm -rf` → critical, `kubectl delete` → high, `curl -d` → high

**Phase 2 — AI semantic analysis**:
- Calls LLM with script content + Phase 1 findings as context
- Returns structured risk assessment: `{ riskLevel, findings[], summary }`
- Falls back to static-only if AI is unavailable

Review results are stored in `skill_reviews` table for audit.

---

## 5. Skill Bundle & Sync

### What Goes Into a Bundle

`buildSkillBundle()` in `src/gateway/skills/skill-bundle.ts` packages:

- **Global skills**: all global-scope skills with published content
- **Skillset skills**: Skill Space skills (dev bundles only, with working content tag)
- **Personal skills**: author's own skills (dev=all working, prod=approved published)
- **Disabled builtins list**: names of builtin skills the user has disabled

**Invariant**: The bundle **never** contains core/extension skills. Those are baked into
the Docker image.

When a workspace composer is present, the bundle is filtered to the workspace's selected
global refs, selected personal skills, and enabled Skill Space skills.

### Bundle Version

A SHA256 hash (first 16 chars) computed from all skill content. Used for:
- AgentBox cache validation (skip reload if hash unchanged)
- Browser-side caching

### Sync by Deployment Mode

| Mode | When | Target Directory | Scope |
|------|------|-----------------|-------|
| **K8s** (AgentBox pod startup) | `syncAllResources()` | `.siclaw/skills/{global,skillset,user}/` | global + skillset + personal |
| **K8s** (reload event) | Gateway → AgentBox webhook | Same | Affected scopes |
| **Local** (session spawn) | `local-spawner.syncSkills()` | `.siclaw/skills/user/{userId}/` | bundled global + personal |
| **Local** (reload event) | `reloadResource("skills", userId)` | Same | Affected user |

Local mode syncs to per-user directories to maintain filesystem isolation.
Global skills from the bundle are flattened into the user's directory alongside personal skills;
there is no separate `skills/global/` write in local mode (see `docs/design/invariants.md §1`).

---

## 6. Skill Execution

### local_script Tool

The `local_script` tool (`src/tools/shell/local-script.ts`) is the primary execution path:

1. **Path resolution**: `resolveSkillScript(skill, script)` searches scope directories
   in priority order (personal > skillset > global > builtin)
2. **Interpreter selection**: `.py` → `python3`, `.sh` → `bash`
3. **Execution**: `child_process.spawn()` with args array (no shell interpolation)
4. **Security**: runs as `sandbox` user (OS-level isolation), inherits sanitized environment
5. **Limits**: 300s max timeout, 10 MB max output

### Bash Fallback

The `restricted-bash` tool also allows skill script execution. `isSkillScript()` resolves the
target path and allows scripts rooted under the repo `skills/` tree or the configured dynamic
`skillsDir`, including materialized `skillset` scripts.
This is a secondary path — `local_script` is preferred.

---

## 7. Skill Discovery by Agent

### How the Agent Sees Skills

`agent-factory.ts` passes skill directories to pi-agent's `DefaultResourceLoader` via
`additionalSkillPaths`:

```typescript
const skillsDirs = [dynamicSkillBase, ...skillsetDirs, ...builtinPaths];
// dynamicSkillBase = .siclaw/skills/ (K8s) or .siclaw/skills/user/{userId}/ (local)
// skillsetDirs     = .siclaw/skills/skillset/{spaceId}/ (K8s only)
// builtinPaths     = skills/core/ + skills/extension/ (minus disabled)
```

The loader auto-discovers skills by scanning for `SKILL.md` files, parsing frontmatter,
and injecting descriptions into the system prompt. The agent then knows which skills are
available and can invoke them via `local_script`.

### Deep Search Sub-Agents

Sub-agents in `src/tools/deep-search/sub-agent.ts` load skills separately:

```typescript
const { skills: coreSkills } = loadSkillsFromDir({ dir: "skills/core" });
const { skills: extSkills }  = loadSkillsFromDir({ dir: "skills/extension" });
```

This gives sub-agents access to builtin skills without depending on the bundle.

---

## 8. Forking

Users can fork builtin or global skills to create personal copies:

- **Source**: builtin or global scope only (cannot fork personal skills)
- **Result**: personal skill with `forkedFromId` backlink
- **Content**: copies SKILL.md + scripts from source, with optional overrides
- **Version**: inherits version number from source
- **Labels**: copies labels from source

Forking enables users to customize a builtin diagnostic procedure without modifying the
original. The forked copy can later be contributed back to the global pool via the approval workflow.

---

## 9. Database Schema

| Table | Purpose |
|-------|---------|
| `skills` | Skill metadata: name, scope, status, version, review state, lineage |
| `skill_contents` | File content (specs + scripts) by tag (working/staging/published) |
| `skill_versions` | Version history (audit trail for approved versions) |
| `skill_reviews` | AI + admin review records |
| `skill_votes` | User upvotes/downvotes on global skills |
| `user_disabled_skills` | Per-user builtin skill disabling |
| `workspace_skills` | Workspace-scoped skill assignments (schema exists, not yet enforced) |

---

## 10. Key Files

```
Execution & Resolution
  src/tools/shell/local-script.ts        local_script tool (primary execution path)
  src/tools/infra/script-resolver.ts   Skill path resolution, scope priority
  src/tools/shell/restricted-bash.ts   Bash whitelist (isSkillScript)
  src/tools/workflow/fork-skill.ts     fork_skill tool

Gateway Skills Management
  src/gateway/skills/file-writer.ts   Disk I/O: read, write, scan, snapshot
  src/gateway/skills/skill-bundle.ts  buildSkillBundle() — global + skillset + personal packaging
  src/gateway/skills/script-evaluator.ts  Security review (static + AI)
  src/gateway/skill-labels.ts         Label loading from meta.json
  src/gateway/rpc-methods.ts          RPC: skill.list/get/create/update/delete/submit/review

Agent Integration
  src/core/agent-factory.ts           Skill directory setup, additionalSkillPaths
  src/tools/deep-search/sub-agent.ts  Sub-agent skill loading

Sync & Materialization
  src/agentbox/resource-handlers.ts   skillsHandler.materialize() (K8s)
  src/gateway/agentbox/local-spawner.ts  syncSkills() (local mode)
  src/shared/resource-sync.ts         Resource sync contracts

Filesystem Layout
  skills/core/                        Builtin core skills (Docker-baked)
  skills/extension/                   Builtin extension skills (inner project overlay)
  .siclaw/skills/global/              Global skills (from bundle)
  .siclaw/skills/skillset/{spaceId}/  Skill Space skills (from bundle, dev only)
  .siclaw/skills/user/{userId}/       Personal skills (from bundle)
```
