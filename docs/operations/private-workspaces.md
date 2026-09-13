# Operating private workspace storage

Remote workspaces contain sensitive recovery data. Enable them only with a trusted
host that controls the metadata database, object-store credentials and storage
policies. See [the persistence protocol](../design/private-workspaces.md) for the
execution and migration contract.

## Recovery snapshots contain unredacted data

Chat telemetry applies configured redaction to supported output fields. Workspace
checkpoints serve a different purpose: `captureWorkspaceFiles` preserves file bytes,
and Pi snapshots preserve the session entry tree. Neither checkpoint capture nor
upload adds content redaction. They may contain original user input, tool output,
files, pending-turn records and secrets that reached those sources.

For example, if a tool returns a secret, a chat record may display `[REDACTED]`
while the recovery snapshot retains the original value. A redacted chat record is
not evidence that all retained copies were sanitized. Memory extraction filters
also do not sanitize the underlying session checkpoint. Deleting learned memory
does not delete these source records or object versions.

Treat workspace objects, their backups, local projections and authorized file
downloads as sensitive original data. Do not copy them into logs, support tickets
or general-purpose analysis buckets without a separate review and sanitization
step. Keep original secret material out of tool output where possible.

## Access and encryption requirements

The host's API enforces user ownership and authorization. Direct object-store
access bypasses that application boundary: a service credential may cover the
retained data of many users. Use a dedicated private bucket or tightly scoped
prefix, block public access, restrict network access and audit version reads and
policy changes. Runtime and AgentBox must not receive storage credentials or gain
access to the host's credential Secrets through namespace RBAC.

Require and independently verify bucket-side encryption at rest, including the
KMS key policy when using KMS. The workspace transport sends unchanged bodies over
HTTPS; it does not implement application-side encryption, set an encryption mode
on PUT, or validate bucket encryption/lifecycle policy. A successful version-storage
probe proves exact-version write/read integrity only. SHA-256 is an integrity
check, not encryption, and user isolation is not per-user cryptographic isolation.

Distinguish the keys involved:

- A host key that encrypts saved AK/SK protects credential configuration. It does
  not encrypt checkpoint bodies. Theft of that key together with the encrypted
  credential database can expose the corresponding storage credentials.
- A stolen credential with version-read access can expose retained original data
  within its permitted scope, subject to object-reference availability, network
  controls and any independent KMS authorization. Bucket encryption that permits
  that same principal to decrypt is not a barrier to these authorized reads.
- Storage encryption keys or KMS decrypt authority must be protected separately.
  Assess compromise together with object access and backups; a key alone is not
  equivalent to possession of every object.

When a secret has entered a checkpoint, rotate or revoke the original secret and
assess every retained copy. If storage authority is compromised, revoke it and
scope the incident to all history it could read, not just the current user or
recent chat. Rotating access credentials does not sanitize existing versions or
recall data already copied. Protect backups of metadata, credential encryption
keys and objects; avoid giving one broadly accessible backup account all three.

## Retention and lifecycle rules

The application removes eligible metadata only. It does not delete object
versions, so there is no application-enforced retention deadline. Actual durability
still depends on the provider, bucket policy and backups; this is not a promise
that an external store will retain data forever.

For the `private-spaces-v1/` data prefix, do not enable age-based expiration of
current objects or noncurrent versions. Check bucket-wide rules as well as prefix
and tag rules. A current manifest can reference an old exact version; object age,
memory TTL or loss of a metadata row does not establish that it is safe to delete.
Deleting a referenced version makes restoration fail. Transitions requiring an
asynchronous archive restore also need a separate recovery design before use.

Monitor retained bytes and object counts. A future deletion/retention scheme must
account for manifests, session trees, memory sources, archives, backups and uploads
whose acknowledgement was lost. The current collector does not establish that
reachability set. Do not grant version-deletion permission merely to run it.

## Placement and release checks

An AgentBox crash can leave its event connection silent without closing TCP.
Runtime cancels pending event reads when Stop is requested and rejects a read
after 60 seconds without data or a heartbeat. This ends the client stream; it
does not acknowledge an uncertain execution or release the crashed writer's
lease. A replacement writer can still wait up to 120 seconds for that lease.
Review and acknowledge the exact committed revision before clearing an
`execution_uncertain` marker. Recovery archives the marker and never replays
the interrupted input automatically.

Existing spaces keep their assigned backend when changing Runtime or its default
storage setting. Cross-bucket migration is not implemented. `placementEpoch` has
no production update entry point; future migration must advance it transactionally
and separately copy, verify and rewrite all required object references. Editing
database placement fields is not a supported migration procedure.

Before rollout, record independently verified bucket versioning, effective IAM,
encryption/KMS and lifecycle settings, backup access, and restoration results for
the exact deployed revision. Keep this evidence with the deployment record;
application health checks and synthetic version probes cannot establish it.
