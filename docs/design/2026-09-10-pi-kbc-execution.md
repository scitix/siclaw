# Pi execution for knowledge compilation

## Ownership

Siclaw maintains one Pi SDK integration in `src/core/pi-execution.ts`. The ordinary
agent factory and the KBC worker both use it. Each caller owns its prompt, tool
registry and application services. The worker does not import the interactive
agent's tools, user configuration discovery or session store.

Python continues to own compilation: source snapshots, Raw provenance, source
slicing, plan and candidate artifacts, contradiction tickets, deterministic lint,
red-blue checks, media verification, artifact acknowledgements and recovery.
The migration changes execution without changing these product contracts.

The compiler has independent capability settings: Claude Agent SDK or Pi, primary
and light models, and existing quality switches. Saving applies directly to new
attempts. It does not create an Agent Type, published release, or approval flow.
Both engines use the same host-owned tools, domain orchestration and metadata
observations. Claude supports Anthropic roles; Pi also supports OpenAI Chat
Completions and Responses. Each role can use its own endpoint and credential.

Historical version 2 Pi snapshots may contain a frozen compiler type identity
and instructions. Recovery continues to decode that payload without looking up
mutable type/release state. New attempts use independent version 1 snapshots.

## Data flow

1. The control plane resolves the owner's primary/light model choices into five explicit
   roles, using the same provider translation as ordinary Siclaw agents.
2. Before materialization, it stores a versioned execution snapshot keyed by
   authoring attempt. The snapshot includes full model descriptors and settings,
   plus credential references. It contains no decrypted credential.
3. Runtime transfers the hydrated configuration in the authenticated session
   request. Existing live sessions are reattached before current policy lookup.
4. Python creates one private Node worker per Pi session. JSONL protocol v1 carries
   session/turn IDs, provider events and tool RPC; credentials arrive on stdin.
5. Python host tools enforce the existing compiler or snapshot path boundary.
   SDK built-in tools, shell execution and implicit extensions are disabled.
6. Artifact ACK remains the durability barrier. Metadata observations use a
   separate bounded queue and cannot delay ACK, replies or terminal events.

## Model and policy contract

The supported APIs are Anthropic Messages, OpenAI Chat Completions and ordinary
OpenAI Responses. Every role declares endpoint, model identity, input capability,
context/output limits, reasoning and authentication policy. Anthropic long
context uses an explicit header from the configured capacity; model IDs do not
contain CLI suffixes. Roles may intentionally use different providers.

Omitted role choices follow the compiler model once during snapshot resolution.
Existing quality/watchdog/batch defaults and explicit overrides are also frozen.
Source budgets are capped to the configured window using the planner's existing
36k fixed-token and three-bytes-per-token estimate, retaining half-window headroom
and reserving output capacity. Models without enough remaining source capacity
are rejected. Planning estimates remain distinct from measured Pi usage.

Configuration writes preserve the selected Claude or Pi engine. Continuation
attempts atomically inherit the original snapshot, including engine, resolved
roles and compiler settings. Catalog edits or deletion cannot change the old
plan; only referenced credentials are resolved again for rotation. The emergency
boot-time PK stop remains an operational override.

## Failure and recovery

KBC owns bounded retries and model-call limits. Pi SDK auto-retry and automatic
compaction are disabled for compiler sessions. Cancellation waits for worker and
host-tool completion before another turn can begin. EOF, abort, budget exhaustion
and provider failure are distinct from completion.

Text reads preserve bounded output while allowing a complete traversal of long
single lines. One `offset`/`limit` range has an explicit `unit` of `lines` or
`bytes`, so providers that populate every optional argument cannot create
conflicting pagination modes. Oversized lines switch to UTF-8 byte pages with
an explicit next offset; the final page reports end of file. Legacy byte
arguments remain readable. The same path guards apply
to line and byte reads. Glob and Grep resolve relative path filters against the
selected search directory rather than the host process directory. Quality survey and question outputs must contain the
requested nonempty result arrays within the existing one-retry budget.

A running box with its original session is reused across Runtime replacement.
A container restart can leave an old-image Pod alive with zero sessions. After
validating the new execution configuration and pinned source revision, Runtime
replaces that empty incompatible box and restores the durable workspace. Unknown health
or active test sessions prevent deletion. Local shared endpoints do not use the
single-run Pod health shortcut.

Recovery restores durable artifacts and checkpoints, including finished batches.
It starts a fresh reasoning conversation. Unsynced filesystem changes retain the
existing bounded loss window; the migration does not claim transcript recovery.

Observations persist role/session/turn identity, model-envelope hashes, usage,
timings, tool activity and classified outcomes. Prompt text, tool payloads,
provider error bodies and credentials stay outside the diagnostic projection.
The queue holds at most 128 records of 64 KiB; bounded RPC retries use stable event
IDs and duplicate inserts are ignored. A dropped record produces an explicit gap.
Readiness observations also include the pinned type/release/harness identity
when supplied. Managed instructions are excluded from that metadata.

## Rollout and rollback

Oversized text and PDF sources select the slice-aware planner even when the
total corpus is below the hierarchical threshold. Text slices prefer complete
lines. A line longer than the source budget uses contiguous, UTF-8-safe byte
ranges; the original Raw remains the citation identity. Legacy line-only plans
remain readable. Coverage validates the entire byte range, and recovery rebuilds
only pending excerpt files from the durable Raw snapshot.

The real-worker Responses fixture covers API-key requests, encrypted reasoning
continuity and host-tool results, including a failed Read returned to the model.
It does not establish compatibility or output quality for an untested gateway.

`python kbc/tools/generate_compiler_corpus.py <output-directory>` creates a
repeatable acceptance corpus: 14 fictional sources totaling 1,415,331 bytes,
including a 1,059,531-byte manual and a 229,685-byte single-line supplement.
At a 192,000-byte source budget it plans nine map batches below the total-corpus
hierarchical threshold. Upload only `raw/`; keep the 22 reference questions in
`expected.json` outside the compilation workspace. Real acceptance must check
source coverage, those answers, unexpected exclusions and checkpoint recovery.

The Pi SDK upgrade is a separate dependency PR. The KBC feature requires the
paired control-plane API/Web change with execution/observation table migrations and the
Siclaw Runtime/AgentBox/KBC images from exact commits.

Deploy the compatible control plane and Runtime before enabling new Pi compilation.
Update Runtime and its configured KBC image together; new sessions require a complete resolved execution payload. Configure and save the selected engine and model roles through knowledge
settings, then start an acceptance run. Preserve running old-image boxes so they
can finish through the unchanged event/artifact protocol.

Validate a real compilation, source citations and media, test-session answers,
durable checkpoint recovery, cancellation, and diagnostic visibility. A successful
ordinary-agent upgrade test alone does not establish KBC acceptance.

Before rollback, preserve or finish active Pi sessions. Restoring an old control
plane/box combination cannot execute a stored Pi snapshot. Database migrations
are additive; do not delete execution or observation records as a rollback step.

Compiler context protection preserves mixed text/image tool results intact. It
fails explicitly if the estimated input exceeds the reserved context budget;
it never silently removes PDF images to satisfy the conversational tool-result
share. A failed owner turn reconciles its scoped edits and clears pending scope
before returning to idle, without starting automatic repair or marking a full
compilation complete.
