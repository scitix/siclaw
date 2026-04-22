# Skill Governance — Flat Pool + Status Gate + Agent Binding

> Replaces the old fork-edit-sync model. Designed for multi-agent architecture.

---

## Why This Redesign

Skill scripts bypass the command whitelist — they execute via `spawn()` directly without
`preExecSecurity` validation (`local-script.ts:145`), and are whitelisted in `restricted-bash`
via `isSkillScript()` (`restricted-bash.ts:289`). A skill script can run any command: `kubectl delete`,
`curl`, `rm -rf`, arbitrary Python — the command whitelist does not apply inside skill scripts.

This makes skills a **privilege escalation channel**. The previous system managed this through
a full approval workflow (fork-edit-sync with submit/contribute/approve). That system was removed
due to complexity (79 commits, 2400+ lines of tests, eventually deleted entirely).

The current codebase has **no security gate**: draft skills are delivered to production agents,
anyone with write access can bind any skill to any agent, and the `is_production` flag is unused
for skill filtering.

This design restores the security gate with a minimal model.

---

## Core Model

```
┌──────────────────────────────────────────────────────┐
│               Skill Pool (per org, flat)              │
│                                                        │
│  draft ──submit──▶ pending_review ──approve──▶ installed│
│                         │ reject                       │
│                         ▼                              │
│                       draft (退回修改)                  │
│                                                        │
│  Builtin skills: synced from Docker image into DB      │
│  on startup, same lifecycle as user-created skills     │
└──────────────────────────────────────────────────────┘

Binding:
  agent_skills — any skill can be bound to any agent (no status check)

Runtime delivery:
  Dev agent  → delivers draft + installed skills
  Prod agent → delivers only installed skills (approved version snapshot)
```

### What was removed (vs old system)

| Old concept | Replaced by |
|---|---|
| personal / global / skillset scope | Single flat pool per org |
| Skill Space (team collaboration) | Not needed — all skills visible to org |
| Fork-edit-sync | Direct edit in pool |
| Submit + Contribute (two review chains) | Single submit → review → approve |
| Per-user enable/disable | Agent binding |
| Content tags (working/published/approved/staging/staging-contribution) | skills table (current) + skill_versions (approved snapshots) |

---

## Entities

### Skill

Content carrier with a status lifecycle.

**Fields** (skills table):

| Column | Type | Description |
|---|---|---|
| id | CHAR(36) PK | UUID |
| org_id | CHAR(36) | Organization |
| name | VARCHAR(255) | Unique per org |
| description | TEXT | |
| labels | JSON | `["kubernetes", "network", "diagnostic"]` for categorization and filtering |
| author_id | CHAR(36) NOT NULL | Creator / current owner |
| status | VARCHAR(20) | `draft` \| `pending_review` \| `installed` |
| version | INT | Monotonically increasing |
| specs | MEDIUMTEXT | SKILL.md content |
| scripts | JSON | `[{ name, content }]` |
| created_by | CHAR(36) | Original creator (immutable) |
| created_at | TIMESTAMP(3) | |
| updated_at | TIMESTAMP(3) | |

Unique constraint: `(org_id, name)`.

### Skill Version

Immutable snapshot for history, diff, and rollback.

**Fields** (skill_versions table):

| Column | Type | Description |
|---|---|---|
| id | CHAR(36) PK | UUID |
| skill_id | CHAR(36) FK | |
| version | INT | Matches skill.version at time of creation |
| specs | MEDIUMTEXT | Full snapshot |
| scripts | JSON | Full snapshot |
| diff | JSON | `{ specs_diff, scripts_diff }` vs previous version |
| commit_message | VARCHAR(500) | |
| author_id | CHAR(36) NOT NULL | Who made this change |
| is_approved | TINYINT(1) | 1 if this version passed review |
| created_at | TIMESTAMP(3) | |

Unique constraint: `(skill_id, version)`.

### Skill Review

Audit record for each submit → approve/reject cycle.

**Fields** (skill_reviews table):

| Column | Type | Description |
|---|---|---|
| id | CHAR(36) PK | UUID |
| skill_id | CHAR(36) FK | |
| version | INT | Skill version at time of submit |
| diff | JSON | `{ specs_diff, scripts_diff }` vs last approved version |
| security_assessment | JSON | `{ risk_level, findings[] }` |
| submitted_by | CHAR(36) | |
| reviewed_by | CHAR(36) | |
| decision | VARCHAR(20) | `approved` \| `rejected` |
| reject_reason | TEXT | |
| submitted_at | TIMESTAMP(3) | |
| reviewed_at | TIMESTAMP(3) | |

### Agent Binding

`agent_skills` junction table (unchanged). No status validation at bind time.

---

## Status Lifecycle

### Transitions

```
          ┌─────── withdraw ───────┐
          ▼                        │
       [draft] ───submit───▶ [pending_review] ───approve───▶ [installed]
          ▲                        │                              │
          │                      reject                         edit
          │                        │                              │
          └────────────────────────┘                              │
          └───────────────────────────────────────────────────────┘
```

### Edit behavior by status

| Current status | Edit action |
|---|---|
| `draft` | In-place update, no version bump |
| `pending_review` | Blocked — must withdraw first |
| `installed` | Creates new version record (with diff), status → `draft` |

### Rollback

Rollback copies content from a target historical version into the skills table as a **new version**:

```
v1 ✓ approved  "初始版本"
v2 ✓ approved  "增加超时重试"
v3   draft     "重构脚本"        ← broken
v4   draft     "Rollback to v1"  ← content equals v1, new version number
```

- Status becomes `draft` regardless of target version's approval state (must re-review)
- Version number is monotonically increasing (no branch/fork)
- Diff is computed against the version being rolled back from (v3), not the target (v1)
- Blocked when status is `pending_review` (must withdraw first)

---

## Review Mechanism

### Submit

When a user submits a skill for review:

1. **Status** changes to `pending_review`
2. **Diff generation**: current content vs last approved version (or full content if no prior approval)
3. **Security assessment** (two-phase):
   - **Phase 1 — Static pattern matching**: regex scan of all scripts for dangerous patterns (`rm -rf`, `kubectl delete`, `curl -d`, privilege escalation, env mutation, etc.), categorized by severity (critical / high / medium / low)
   - **Phase 2 — AI semantic analysis**: LLM receives scripts + Phase 1 findings, returns structured risk assessment `{ riskLevel, findings[], summary }`
4. Diff and assessment stored in `skill_reviews` table

### Approve

- Reviewer (user with `can_review_skills` flag, or admin) approves
- `skill.status` → `installed`
- Current version's `is_approved` set to 1 in `skill_versions`
- Review record updated with `decision: 'approved'`, `reviewed_by`, `reviewed_at`

### Reject

- `skill.status` → `draft`
- Review record updated with `decision: 'rejected'`, `reject_reason`
- Author can edit and re-submit

### Withdraw

- Author pulls back a pending submission
- `skill.status` → `draft`
- Review record can be discarded or kept for audit

### Permissions

| Action | Who |
|---|---|
| Create / edit skill | Any user with write permission |
| Submit / withdraw | Skill author + admin |
| Approve / reject | Users with `can_review_skills` + admin |

---

## Builtin Skills

### Startup Sync

On gateway startup, `syncBuiltinSkills()` scans `skills/core/` and syncs to DB:

```
For each skill directory in skills/core/:
  Parse SKILL.md frontmatter + scripts + meta.json labels
  Compute content hash (SHA-256 of specs + sorted scripts)

  If not in DB:
    INSERT with status='installed', is_approved=1, version=1
    Create skill_versions record (v1, is_approved=1)

  If in DB and user has not edited since last sync
    (i.e. current specs/scripts hash == v1 hash OR == last builtin-sync version hash):
    UPDATE content, version+1, status stays 'installed'
    Create skill_versions record (is_approved=1)
    (Image upgrade — auto-update unmodified builtins)

  If in DB and user HAS edited (current hash differs from last builtin-sync version):
    SKIP — user's edits take precedence
    (User can rollback to v1 to restore original Docker-shipped version)

  If in DB and hash matches:
    SKIP
```

### Auto-bind on Agent Creation

When a new agent is created via `POST /agents`:
- After creating the agent record, auto-insert `agent_skills` rows for all builtin skills
- Admin can later unbind unneeded builtins

### Editing Builtins

Same lifecycle as user skills:
- Edit → status becomes `draft` → needs review → approve → installed
- Rollback to v1 restores the original Docker-shipped version

---

## Bundle Delivery

### Query Logic (handleSkillsBundle)

The bundle endpoint needs to know the requesting agent's `is_production` flag.

**Dev agent** — latest content from skills table:

```sql
SELECT s.id, s.name, s.specs, s.scripts, s.labels
FROM skills s
JOIN agent_skills ask ON ask.skill_id = s.id
WHERE ask.agent_id = ?
```

**Prod agent** — last approved version only:

```sql
SELECT s.id, s.name, sv.specs, sv.scripts, s.labels
FROM skills s
JOIN agent_skills ask ON ask.skill_id = s.id
JOIN skill_versions sv ON sv.skill_id = s.id AND sv.is_approved = 1
WHERE ask.agent_id = ?
  AND sv.version = (
    SELECT MAX(version) FROM skill_versions
    WHERE skill_id = s.id AND is_approved = 1
  )
```

Skills bound to a prod agent but never approved are silently excluded — they won't appear in the bundle until they pass review.

### Determining is_production

The bundle endpoint receives the agent identity via mTLS certificate (`identity.agentId`). It queries the agent's `is_production` flag from the DB (or receives it from the adapter's resource response).

---

## Labels

### Storage

`labels` column on `skills` table, JSON array of strings: `["kubernetes", "network", "diagnostic"]`.

### Builtin Labels

Loaded from `skills/core/meta.json` during startup sync:

```json
{
  "labels": {
    "find-node": ["kubernetes", "general", "diagnostic"],
    "dns-debug": ["kubernetes", "network", "diagnostic"]
  }
}
```

### Usage

- **Skill list page**: filter skills by label
- **Agent binding UI**: filter available skills by label when selecting which to bind
- **API**: `GET /skills?labels=kubernetes,network` returns skills matching any of the specified labels

---

## API Summary

### Skill CRUD

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/siclaw/skills` | List (paginated, search, label filter) |
| POST | `/api/v1/siclaw/skills` | Create (status=draft, version=1) |
| GET | `/api/v1/siclaw/skills/:id` | Get detail |
| PUT | `/api/v1/siclaw/skills/:id` | Edit (draft: in-place; installed: version+1, status→draft) |
| DELETE | `/api/v1/siclaw/skills/:id` | Delete skill + all versions + reviews |

### Version History

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/siclaw/skills/:id/versions` | List all versions |
| GET | `/api/v1/siclaw/skills/:id/versions/:version` | Version detail with diff |
| POST | `/api/v1/siclaw/skills/:id/rollback` | Rollback to specified version |

### Review

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/siclaw/skills/:id/submit` | Submit for review (triggers diff + security assessment) |
| POST | `/api/v1/siclaw/skills/:id/withdraw` | Withdraw submission |
| POST | `/api/v1/siclaw/skills/:id/approve` | Approve (reviewer/admin only) |
| POST | `/api/v1/siclaw/skills/:id/reject` | Reject with reason (reviewer/admin only) |
| GET | `/api/v1/siclaw/skills/:id/review` | Get current review detail |
| GET | `/api/v1/siclaw/reviews/pending` | List all pending reviews (reviewer view) |

### Bundle (internal, modified)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/internal/skills/bundle` | Skill bundle for agent (filters by is_production) |

---

## Migration from Current Schema

### skills table

```sql
-- Remove scope column
ALTER TABLE skills DROP COLUMN scope;

-- Add labels column
ALTER TABLE skills ADD COLUMN labels JSON AFTER description;

-- Change status default
ALTER TABLE skills MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'draft';
```

### skill_versions table

```sql
-- Add diff column
ALTER TABLE skill_versions ADD COLUMN diff JSON AFTER scripts;

-- Add is_approved column
ALTER TABLE skill_versions ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 0 AFTER author_id;

-- Make author_id NOT NULL
ALTER TABLE skill_versions MODIFY COLUMN author_id CHAR(36) NOT NULL;
```

### New table

```sql
CREATE TABLE skill_reviews (
  id CHAR(36) PRIMARY KEY,
  skill_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  diff JSON,
  security_assessment JSON,
  submitted_by CHAR(36) NOT NULL,
  reviewed_by CHAR(36),
  decision VARCHAR(20),
  reject_reason TEXT,
  submitted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at TIMESTAMP(3),
  CONSTRAINT fk_review_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

---

## Security Properties

| Threat | Mitigation |
|---|---|
| Draft skill running in production | Bundle query filters by `is_approved` for prod agents |
| Malicious script in skill | Two-phase security assessment (static + AI) on submit; human reviewer approval required |
| Unauthorized approval | `can_review_skills` permission flag; only reviewer/admin can approve |
| Editing approved skill bypasses review | Edit on installed skill resets status to `draft`; must re-submit and re-approve |
| Builtin skill tampering | Edit triggers same draft→review→approve cycle; rollback to v1 restores original |
| Stale approved version served to prod | Prod bundle reads from `skill_versions` where `is_approved=1`, independent of current skill status |

---

## Cleanup: Code to Remove

| File / pattern | Reason |
|---|---|
| `scope` references in `script-resolver.ts` (skillset branch) | No more scope-based directory layout |
| `scope = 'builtin'` special handling in `internal-api.ts` | Builtins are regular DB skills now |
| `SkillScope` type (`"builtin" \| "global" \| "personal" \| "skillset"`) | Replaced by flat pool |
| Skillset directory traversal in `script-resolver.ts` | No more `skillset/{setId}/{skillName}/` paths |
