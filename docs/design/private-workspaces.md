# Private workspaces and remote persistence

Status: opt-in implementation; production rollout requires the environment checks below.

## Identity and execution

A trusted host resolves `(organization, authenticated user)` to a stable `spaceId`.
Agent IDs, Linux UIDs, pod names and Runtime IDs are not permanent owners. The
Runtime resolves ownership from the authoritative conversation before spawning.
`SICLAW_WORKSPACE_MODE=remote` requires K8s and a host implementing
`workspace.exchange`. Local/Process spawners cannot provide this isolation.

Each private session gets a separate pod, pod-local emptyDir and an mTLS certificate
bound to its agent, organization, space, user and session. Private pods never join
legacy replica pools. Main and child agents execute within that session's pod.
The certificate's JSON ownership attribute uses ASN.1 UTF8String. Previously
issued PrintableString attributes containing JSON are reissued on the next
spawn, since strict X.509 clients reject that invalid encoding.
Changing the Runtime does not change the space's storage backend. New spaces may
use different Runtime defaults. Moving an existing space between buckets requires
an explicit data migration, not a configuration edit.

The container still separates the trusted agentbox UID from the sandbox UID.
Sandbox may read `user-data/files` (directories 2750, files 0640), while only the
trusted agent process writes durable content. Session trees, configuration and
credentials remain private. Ordinary file writes/edits in remote mode are confined
to `files`. File tools reject links and paths writable by another UID, group or
the world. On Linux, trusted owners are root and the actual agent process UID;
changing that UID never disables permission checks, and an unavailable UID refuses
access. `/tmp` is not a remote file-tool root. Sandboxed processing uses scratch
and returns its results through tool output. This prevents a sandbox writer from
swapping parents between trusted path checks and writes. Skills come from the existing trusted configuration/release path;
workspace restore has no skill, configuration, tool-registration or permission
root. A remembered instruction or a script saved as user data grants no permission.
Reviewed skills and MCP services retain their existing trust and permissions;
this change is not a new sandbox for malicious trusted skills or services.

## Persistence protocol

The trusted host holds OSS credentials and a separate metadata database. Neither
credentials nor direct bucket authority are sent to Runtime/AgentBox. The generic
RPC actions are `resolve`, `acquire`, `renew`, `release`, `put`, `get`, `commit`,
`learn` and `memory_search`. The internal HTTP endpoint requires a private client
certificate and overwrites caller-provided routing identity.

Bodies live in versioned objects. References contain space/backend/object IDs,
key, exact version ID, SHA-256 and size. A manifest names file paths and ordered
4 MiB chunks. The maximum checkpoint is 256 MiB and 4,096 objects; oversized data
fails explicitly. SQLite indexes and WALs remain local. Authoritative investigation
and feedback rows are exported as JSON and rebuilt independently from FTS/vectors.
User-created `.db`, `.sqlite` and `.tmp` files remain user data.

The host checks ownership, backend placement generation and writer epoch, uploads
and verifies immutable object versions, then publishes a manifest under a database
transaction locking space before session head. The transaction compares revision,
epoch and holder and records the exact operation receipt. Retrying an ambiguous
commit uses the same operation and content. Unpublished objects are unreachable;
there is no distributed OSS/database transaction.

Lease duration is 120 seconds. The worker uses a conservative 90-second local
validity window, renews every 30 seconds and revalidates before/after tools. Each
renewal has a 10-second transport deadline. Transport failures and classified
temporary service errors leave the existing deadline unchanged, allowing a later
renewal to succeed before it expires. A failed tool validation still refuses that
tool call. Explicit conflict/denial, invalid or unclassified negative replies, and
local expiry permanently fence the executor; a late successful reply cannot revive
it. Authorization lookups that cannot establish permission remain denials. The
host must emit structured RPC errors (`code`, `retriable`, `status`, safe `message`):
conflict 409, denial 403, invalid request 400, temporary service failure 503. Both
Runtime and AgentBox preserve the distinction without forwarding private details.
Checkpoint failures still block subsequent work and durable publication.
Moving a live session may wait for
release or expiry; storage outages never trigger empty-history fallback. A failed
restore can be retried after connectivity or ownership recovers.

The script sandbox broker also revalidates the private lease through the active
per-run AgentBox grant before authorization and after its asynchronous reads.
This covers Runtime-side MCP calls and result chunks as well as native tool
callbacks; the latter check again before and after execution. Revocation prevents
new dispatch, but cannot undo an external request already sent.

## Recovery contract

Pi snapshots preserve the complete entry tree and explicit in-memory active leaf,
including an initial input which the SDK has not yet flushed to JSONL. Restore uses
an exact file and selected branch; it never chooses a transcript by mtime or cwd.
Plan ledger, router state, accepted-turn ledger, child trees, task output, reports
and traces are checkpointed with user files. The restored cwd is local metadata.
Child follow-ups use the live tracked Pi manager or the exact private snapshot,
preserving its selected branch for subsequent checkpoints. Missing, corrupt,
incomplete or oversized child snapshots refuse resume; remote mode never falls
back to a different JSONL. The existing 64 MiB child resume limit still applies.
All remote-mode restore roots, including reports and traces, live below the
pod's writable `user-data` mount; recovery never writes to the read-only image
directory. The manifest's logical paths stay unchanged across this relocation.

The input and an `execution_uncertain` marker are committed before starting a turn.
The marker is removed only after the completed turn's checkpoint commits. A crash
with this marker blocks replay with `PRIVATE_TURN_RECOVERY_REQUIRED`. An authorized
human must inspect the archived input/output and acknowledge the current revision
through the host's recovery API. Recovery archives the marker and never runs it.

A turn still executing in the current process also has a pending marker. Retrying
its accepted turn ID returns the normal duplicate acknowledgement without replay;
a different turn receives the busy response. An accepted-turn ledger entry alone
does not bypass recovery for a restored or idle unfinished turn.

A checkpoint requires managed background work to settle. An unfinished job prevents
a completed checkpoint; shutdown then retains the previous durable snapshot.
Detached notifications cannot launch a new synthetic tool turn in remote mode.
The foreground collector still handles child results within the owning turn.
Unmanaged daemons must not modify workspace files: the scanner is not a filesystem
transaction or a process freezer. Scratch written after the last successful
checkpoint can be lost. External side effects already dispatched cannot be undone
or made exactly-once by a lease. Live stream output is provisional until persistence
succeeds; existing chat telemetry is a separate persistence domain.

## Loading, local state and restarts

OSS is a durable checkpoint store, not a mounted filesystem. The host holds the
storage credentials and metadata authority. Calls follow AgentBox → Runtime
internal API (mTLS) → host workspace service → MySQL/OSS. MySQL records ownership,
backend placement, the current manifest/revision, writer epochs/leases, operation
receipts and memory metadata. Object bodies and exact versions live in OSS. Back
up both the metadata database and encryption key as well as the object store.

| Data | Runtime location | Restore source |
| --- | --- | --- |
| Pi tree, selected leaf, plan/router/turn ledgers and child sessions | `user-data/agent/sessions` plus live Pi managers | Session manifest, including `.pi-session.json` |
| Task output and artifacts | `user-data/agent/tasks` | Session manifest |
| User files, reports, traces and migration archives | `user-data/{files,reports,traces,archive}` | Session manifest |
| Investigation/feedback rows | `user-data/memory` | Exported authoritative JSON; derived SQLite/FTS/vector indexes are rebuilt |
| Learned personal memory | Retrieved through `memory_search/get` | Host-authorized user-space records and referenced OSS bodies |
| Effective Skills, knowledge packages, configuration and credentials | Separate pod-local mounts/caches | Trusted Runtime configuration/release sync; image Built-ins are baked in |
| Temporary command scratch | `/tmp` | No recovery contract |

Each private session has its own local projection and checkpoint head. Two
sessions owned by the same user do not write a shared JSONL or shared file tree.
Memory recall is user-scoped across eligible source sessions; it rechecks source
visibility. A workspace snapshot is never materialized into Skill/configuration
roots. Dynamic Skill directories are made readable to the sandbox (0755, files
0644 or executable 0755); their adjacent private policy files remain 0600.

| Scenario | Read and execution behavior | Persistence boundary |
| --- | --- | --- |
| First turn | Resolve owner and acquire an empty head; clear managed local roots, create a new Pi manager | Commit input/pending marker and accepted-turn ID before execution |
| Warm continuation | Reuse the healthy workspace and live Pi manager; no full OSS download every turn | Commit before execution and after the turn's work has settled |
| Context compaction / branch change | Pi mutates its local tree and active leaf | Next checkpoint captures the complete tree, compaction summary/references and exact selected leaf |
| Skill/model/prompt/MCP reload | Refresh the independent configuration; rebuild an idle brain while retaining its workspace, lease and live Pi manager | An active turn/background work keeps its original brain until a safe boundary |
| After idle release | Reacquire the current authoritative head, discard old projection caches and restore | Full release checkpoints and closes the lease; later turns cannot reuse a closed guard |
| New Pod or another Runtime | Acquire a new writer epoch after the old lease releases/expires; fetch manifest and exact object versions, check hashes, stage files and replace managed roots | Restore exact Pi branches and sidecars before constructing the brain or reading persisted DP mode |
| Container restart in the same Pod | Local emptyDir may survive, but the host head remains authoritative | Restore replaces residual local data, including clearing it when the remote head is empty |
| Graceful shutdown | Stop prompt admission and new tool dispatch; abort/drain foreground/background work | If drained, attempt a final checkpoint then release. If not drained, retain the previous snapshot and let the lease expire |
| SIGKILL / node loss | No final upload can run | Resume the last committed revision; a pending marker requires human recovery and is never automatically replayed |
| Storage failure / fenced writer | Reject new execution/publication; no fallback to guessed JSONL or empty history | Retain the last committed head; staged/unpublished uploads are not a new checkpoint |

Restore/admission, brain creation and release are serialized. Admission pins the
projection even before a brain exists, so idle shutdown and stale-image replacement
cannot mistake an in-progress download for a drained Pod. Checkpoints serialize
capture, upload and commit together; otherwise an older capture could publish after
a newer one. Failed guards are not rebound underneath active tools. Release drains
plan/model-state writers and removes their caches before a later restore.

The container uses `setpriv` to drop initialization privileges and exec the
application as PID 1. This preserves direct SIGTERM delivery and the full Pod
grace period; a `runuser` supervisor would kill its child after two seconds.
The agent UID/groups and account environment are unchanged.

Graceful shutdown has a bounded 20-second work-drain phase and a 55-second process
exit deadline (within the default 60-second Pod grace period). It is best effort:
network failure, grace-period overrides or uncooperative writers can leave the last
checkpoint unchanged. A final interrupted checkpoint retains the pending marker.
The accepted-turn ledger is strict in remote mode: corrupt/unreadable files or
failed writes block execution instead of turning into an empty deduplication set.

## Memory quality and safety

Remote memory is queried as historical evidence through `memory_search/get`.
It is not injected as a PROFILE/system instruction and cannot create skills.
The first implementation extracts exact, explicitly requested user memories and
paired, explicitly successful `host_list`/`cluster_list` observations from the
committed active Pi branch. Assistant prose and arbitrary script results are not
promoted into facts. Source entries, snapshot references, observation time and
expiry accompany every record. The seven-day expiry uses the original event time;
repeated extraction cannot make old evidence fresh again.

The host rechecks user membership, source-session visibility and agent access on
recall. Forgetting disables extraction and advances an independent memory generation,
so an in-flight learner cannot restore the forgotten generation. Object versions remain retained; the host prunes obsolete metadata. Sensitive-pattern exclusion is a conservative filter, not
complete secret detection. Tool success is evidence of an invocation, not proof
that its result is universally true. Current infrastructure facts require new reads.

This is a conservative evidence store with bounded lexical retrieval. It does not
claim Codex-equivalent consolidation, retrieval quality, or zero hallucinations.
Quality claims require an incident replay dataset and measured recall/false-memory
rates. Model reasoning can still misinterpret correct evidence; tool authority is
controlled independently.

## Deployment and PVC retirement

1. Deploy the trusted host's compatible workspace service with a separate metadata
   database/account, versioned OSS buckets, encryption and scoped service credentials.
2. Export and verify legacy data while its old writers are stopped. Keep the original
   storage read-only throughout the migration and comparison period.
3. Set `agentbox.workspace.mode=remote` in this chart. Enable memory separately with
   `SICLAW_MEMORY_ENABLED=true` if desired. Remove old persistence values only after
   migration verification.
4. Exercise user isolation, Runtime handoff, crash recovery, expired leases, OSS
failure, deletion and restore in the actual Linux/MySQL/OSS environment.
5. Retire retained old PVCs only after durable data and recovery have been verified.

The chart and spawner no longer create/mount application-data PVCs. Old enabled
`agentbox.persistence` or `SICLAW_PERSISTENCE_*` settings fail with migration guidance.
The previous PVC had `helm.sh/resource-policy: keep`: removing its template does not
delete deployed volumes. Do not delete a live PVC as part of an application upgrade.
Database storage and unrelated host file-storage volumes are outside this change.
Default `local` mode retains local CLI behavior and ephemeral K8s scratch; it is not
an automatic migration of old persistent sessions.

## Validation scope

The opt-in implementation has been exercised with Pi 0.85.1, a trusted host,
MySQL metadata, a versioned S3-compatible backend, and live model calls. Completed
turns survived a pod deletion/recreation and a Runtime change after stopping the
old executor. The restored Pi tree retained the original input entry and active
leaf, and user-file hashes matched. Two separately authenticated users with their
own private agents recalled only their own saved observations; cross-user session
and file access was denied. Forgetting one user's memory left the other user's
recall intact. Re-enabling learning did not let the old source session republish
forgotten observations.

An additional live turn was interrupted with SIGKILL after its file-write tool
succeeded. The container exited 137. After natural lease expiry, a replacement
refused continuation with `PRIVATE_TURN_RECOVERY_REQUIRED` before any model/tool
execution. Recovery required the owning user and exact revision. A subsequent
read-only model turn retained earlier committed data and did not recreate the
uncommitted write or replay the interrupted input.

A synthetic fixture on a real NFS mount was exported read-only and imported into
MySQL/S3. All 12 package files matched through the owner's file API; another user
was denied. After removing the nine source fixture files and retiring its test
PVC, a new AgentBox with no PVC continued the imported conversation. Its 12 prior
Pi entries and eight unchanged data/archive/child files survived. The child tree,
sidecars and task output in this fixture are synthetic, not a live delegated run.

These checks use synthetic labels. They do not establish incident-level retrieval
quality, external-effect exactly-once semantics, same-agent multi-user coverage,
or a completed cutover of existing user volumes. Local regression also covers
full branches, source integrity, fencing, forgetting and migration rejection paths.

## Legacy export

First use a host-verified ownership catalog and a read-only path/type/size inventory:

```bash
npx tsx scripts/plan-private-workspace-migration.ts catalog.json inventory.json new-plan.json
```

The catalog contains `sourceRoot`, `sessionsDirectory`, `runtimeId`,
`ownershipVerified`, and `sessions` with `sessionId`, `organization`, `principalId`
and optional `parentSessionId`/`activeLeafId`. The host must verify active users and
membership; a nonempty legacy `user_id` is not proof of ownership. The planner
refuses missing owners, cross-owner trees, incomplete parents, cycles and multiple
JSONLs in one session. It never guesses a file by timestamp or attributes shared
files to everyone. The output always has `sourceFrozen: false`; planning cannot
stop old writers. Freeze the complete source tree before enabling export.

The plan lists excluded files and catalog sessions without JSONL separately.
Handoff markers invalidate the old conversational cache: marker-only sessions
require authoritative host history, and a marker beside JSONL refuses migration
of that stale cache. Authentication/configuration, executables, skill drafts and
shared indexes are not private workspace imports. Missing history, unknown owners
and noninteractive workloads require a separate, explicit migration decision.

An operator may set `unknownDisposition: "archive"` and supply the exact
`unownedSessionIds` established by the host inventory. A missing principal is
represented by an empty string only for explicitly selected unowned sessions.
The planner places each affected complete tree in `unknownArchives`, retaining
its original principal and parent identities. It never splits off an unowned
child and silently imports the remainder. Cross-organization trees are refused.

Export these mappings with
`npx tsx scripts/export-unknown-workspace.ts mapping.json --output NEW_DIRECTORY`.
The source must still be frozen. The separate `siclaw-unknown-archive-v1` package
preserves original bytes, including malformed historical JSONL; it contains no
executable Pi snapshot and cannot be passed to the ordinary workspace importer.
The trusted host stores it under a separate `unknown` archive prefix with an
immutable receipt. It must not create an `unknown` user, publish a session head,
make the archive available to workers, or extract memories from it. This is
retention of old unowned data, not support for new anonymous private sessions.

Use `npx tsx scripts/export-private-workspace.ts mapping.json` for a read-only
inventory, then append `--output NEW_DIRECTORY` to write an offline import package.
The trusted host supplies its own importer; the package has no storage credentials.
Example mapping (use independently verified identities and relative source paths):

```json
{
  "organization": "example-org",
  "principalId": "example-user",
  "sessionId": "example-session",
  "runtimeId": "example-runtime",
  "ownershipVerified": true,
  "sourceFrozen": true,
  "sourceRoot": "/mnt/legacy-readonly",
  "piFile": "agents/example/agent/sessions/example-session/history.jsonl",
  "files": [{ "source": "owned/report.txt", "destination": "files/report.txt" }]
}
```

Supply `activeLeafId` when reliably known; omission preserves the full tree but
requires human recovery because JSONL alone cannot recover an in-memory branch
selection. `children` declares complete child session trees with an explicit
`parentSessionId`; an unknown child leaf blocks continuation at the root as well.
Each session can include `sidecars` mapping `source` to `name`: plan/model-route/
turn ledgers and `.tool-results/` are supported. Attributed ordinary files can use
`files`, `reports`, `traces`, `tasks` or `archive` destinations. Original JSONL is
always archived. `memoryDatabase` is optional and may only name independently attributed
personal data. The exporter copies DB/WAL/SHM into scratch before extracting rows.
It archives original JSONL and memory files without rewriting the source. Malformed
lines, dropped entries, symlinks, unstable reads and invalid paths are refused.
Never distribute unowned agent-shared memory to every user: retain it in a separate
operator archive until ownership is established.

Do not assume a new NFS PVC has a new filesystem. Before any write or retirement,
inspect its CSI filesystem/export attributes and mount contents. A tested storage
class returned the same export for distinct PV handles. Use a verified unique
fixture subdirectory, freeze writers, mount it read-only for export, and retain
the shared export when retiring test claim metadata. Never let a test PVC's
reclaim policy delete a shared production export.

## Memory lifecycle controls

The trusted host owns authenticated personal clear/resume controls. Clearing
revokes the memory generation and stops recall and learning. Resuming increments
the generation again and admits only conversations created and initialized after
the host's learning cutoff. Existing conversations and imported history remain
readable but cannot recreate memories. Runtime changes do not reset this policy.
The runtime's automatic-learning switch remains independent.

The host periodically prunes obsolete/expired memory metadata, including registered
unpublished memory uploads once their version is known. Object versions are retained;
workspace operation and storage verification require versioned writes and exact reads,
without object deletion. The user interface confirms memory deletion after the
revocation commits and does not show storage-maintenance details. Unknown upload
versions remain recorded for operator reconciliation. Original conversations and
files are retained, and already injected context is not withdrawn. None of these
controls are model tools or worker RPC actions.
