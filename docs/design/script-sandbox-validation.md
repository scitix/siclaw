# Script sandbox validation — 2026-09-10

## Review against current main

The feature branch is rebased onto Siclaw main `01cad1ba`. The older deployed
acceptance below is retained as historical evidence; it does not certify the
rebased build.

The rebase preserves the complete pre-rebase code tree, including the RPC
contract assertion originally added in a merge commit. The targeted security
and compatibility regression passed after rebasing: 27 files, 588 tests.
Main/AgentBox type checks and the backend build also passed after rebasing.

Review fixes preserve the current handoff routing, harness MCP gate and MCP
artifact recovery. The external control-plane adapter was reviewed separately
for compatibility with the same callback and authorization contract.

The broker rechecks the live caller after asynchronous authorization. Bash
callbacks use the freshly authorized kubeconfig through a private per-call
AgentBox snapshot, so a shared cached credential or concurrent refresh cannot
change the approved target. Neither credentials nor snapshot paths enter the
code runner or model-facing tool arguments.

Verification before the history-only rebase:

- Siclaw after main `01cad1ba`: 353 files, 7,318 passed, 2 existing skips.
- Portal frontend: 30 files, 268 passed; production build passed.
- Main/AgentBox TypeScript checks and backend build passed.
- Python runner: 10 process/protocol tests passed.
- Helm lint and Kubernetes/E2B profile rendering passed.

An mTLS test initially hit a local dual-stack connection failure. It now uses
IPv4 with the original TLS server name and CA checks; its 118-test file and the
full Siclaw suite passed afterwards.

Before this rebase, GitHub PR #584 passed all six CI checks at `309750b1`:
type check, AgentBox build graph, backend tests, Portal tests, native amd64/arm64 container
smoke, local HTTPS E2B relay and amd64 Kind smoke. The latter smoke checks run
inside the two container jobs; they do not provision E2B cloud VMs.

A later CI merge with main's new `chat.getVisualLink` exposed a brittle handler
count assertion (62 actual versus 61 expected). After integrating that main,
the test compares the complete declared RPC name set, including the two existing
session-ordering/lineage entries previously omitted from its partial list. This
retains exact coverage without a manually duplicated count. The updated local
suite, type checks, builds and remote checks passed. The complete-name assertion
is retained as a separate commit when rebasing the former merge history; CI
runs again on the rebased PR head.

External control-plane adapter verification and its remaining test limitations
are documented in that adapter's repository, separately from Siclaw CI.

Fresh Runtime/Portal/AgentBox and external control-plane API images were built
from complete rebased inputs as `sandbox-review-main-20260910`. The Siclaw images were
deployed into the isolated test namespace. The chat Agent selected `run_script`,
but both worker nodes had exhausted their Pod slots: the runner stayed Pending
with `Too many pods`, then timed out at the 90-second startup limit before any
tool call. Its Job/Pod were cleaned up. No unrelated workload or node setting
was changed to obtain capacity. The new external control-plane image has not
yet been deployed. These images predate the final
`01cad1ba` integration and need rebuilding for that final acceptance.

The already deployed AgentBox independently passed a real Linux snapshot smoke:
mode 0640, arbitrary sandbox-user file access denied with EACCES, setgid kubectl
able to read the dummy context, and snapshot cleanup confirmed. Only an inert
test credential was used and no cluster connection was made. This checks the
OS permission path without claiming an SDK/Runtime/Pod end-to-end result.

**Merge gate remains open:** repeat fresh-image acceptance of the Bash credential
snapshot and both control-plane chains when execution capacity is available.
PR/MR remain drafts. Earlier deployed results below do not replace this check.
E2B cloud acceptance is explicitly deferred until an environment is available.

## Earlier deployed acceptance

The following results are from the pre-rebase acceptance images. Test images
were published only to the isolated test namespaces.

## Deployment and identity boundary

Both supported control planes were exercised through their real Web chat APIs:

| Control plane | Tested chain | Identity |
| --- | --- | --- |
| Standalone Portal | Portal → Runtime → AgentBox → Kubernetes Job → broker | Administrator, plus denied ordinary user |
| External control plane | API + MySQL/Redis → Runtime → AgentBox → Kubernetes Job → broker | Ordinary organization reader with explicit Agent/resource group grants |

The deployment used local `kubectl` with an explicitly selected context. The
cluster's friendly name was not independently established. Kubernetes connector
tests used a dedicated read identity for node metadata and fixture-namespace
data; the local deployment administrator's kubeconfig was not delivered to the
Agent or runner. SSH and HTTPS MCP used dedicated fixture services.

Runtime, Portal and AgentBox used `sandbox-ownership-v2-20260910`; the external
control-plane API used `sandbox-ownership-v3-20260910`; the runner used
`sandbox-acceptance-20260910`.
The final ownership fix did not change runner code or its protocol. The tested
configuration forced network isolation, used no warm pool, and required no CNI
NetworkPolicy support. Product defaults remain feature disabled and optional
network isolation disabled.

## Security issue found and corrected

An ordinary reader in the external control plane could submit another user's
existing Web session ID.
Before the fix, the sandbox adopted the persisted owner's authorization. A
harmless marker script reproduced the problem; no destructive command was run.

The fix adds two independent checks:

1. Both Web entry points atomically claim a new session ID before subscribing to
   events or dispatching a message. An existing ID must match the caller and
   Agent and be an undeleted, non-delegated Web session. An insert conflict does
   not alter ownership, title, lineage or message sequence. The actual MySQL
   deployments exercised the no-op conflict update, in addition to SQLite tests.
2. Runtime records the authenticated caller and explicit Web origin for the live
   turn. The broker compares this identity with the control plane's persisted
   owner at admission and on every operation/file chunk. It does not reconstruct
   caller authority from the session database or an LRU registry. Conflicting
   overlapping turns remain blocked until all of them finish.

The original request was replayed against the new Runtime with the old external
control-plane API: the broker returned 403. With the final API, the Web entry
returned 404 before dispatch. Portal returned 404 for the same cross-user pattern. An
Agent API key could not enable sandbox execution by reusing an existing Web
session ID (`Active Web caller required`). The legitimate owner could resume
after these denials, and Portal retained both successful turns in history.

## Final acceptance results

| Coverage | Result |
| --- | --- |
| Portal regression suite | 14/14 passed |
| External control plane ordinary-reader suite | 8/8 passed |
| Portal cross-user session, owner resume and ordinary-user denial | Passed |
| External control plane cross-user session, revoked Agent access, non-Web entry and owner resume | Passed |
| External control plane live cluster group revocation | Next read denied; grant restored |
| External control plane live Agent cluster-binding removal | Next read denied; binding restored |
| External control plane live MCP revocation during file transfer | Next chunk denied; server restored |
| Portal live MCP revocation during file transfer | Next chunk denied; server restored |
| Cancellation | Run cancelled and execution Pod removal confirmed in 696 ms |
| Long-output persistence | Truncated output and structured tool result restored through history API |

The suites covered Python and Shell, fixed Kubernetes reads, the existing
restricted Bash adapter, fixed SSH checks and reviewed MCP operations. Negative
cases covered writes, arbitrary SSH commands, shell/argument injection,
credential/address overrides, undeclared namespaces/nodes, Kubernetes RBAC
denials and unreviewed MCP tools. Isolation checks covered IPv4, IPv6 and Unix
sockets, raw system calls, child processes and Bash `/dev/tcp`. They also covered
timeouts, one-use filesystems, output limits and Kubernetes pagination.

Python `call_to_file` and Shell `siclaw-tool --output` each processed a complete
1,560,109-byte sanitized MCP result: 40,000 rows, value sum 180,000. The upstream
tool executed once; the Agent received the script's summary. Files exceeding
4 MiB were rejected while preserving the old destination and leaving no partial
file. Chunk revocation did not re-execute the source tool.

## Host architectures and local checks

- Siclaw final backend regression: 293 files, 6,372 passed, 2 existing skips.
- Portal frontend regression: 23 files, 229 passed; its code was unchanged by
  the subsequent Web server ownership fix.
- Main and AgentBox TypeScript checks, build and Helm validation passed.
  Final Runtime/Portal image builds also compiled the final source.
- Native Linux amd64 Docker/Kubernetes smoke and local HTTPS E2B-relay smoke
  passed. The relay smoke used fixtures and did not provision an E2B cloud VM.
- The real ARM64 runner image was built from the production Dockerfile in a
  disposable ARM64 Linux VM. Native Python/Shell SDK, 40,000-row Unicode file,
  read-only rootfs, one-use state, raw/child socket denial and optional open
  networking passed. Docker networking remained enabled during seccomp checks.
  All 10 Python process/protocol tests also passed on ARM64. The VM was removed.
- LocalSpawner/TUI disablement, callback authentication, stale/replayed grants,
  scope, concurrency, expiry and file delivery are covered by the automated
  suites. Local mode does not initialize or prewarm a provider even if sandbox
  environment flags request one.

The GitHub workflow has not been remotely triggered. Its relevant native smoke
checks were run directly; a remote CI run is not claimed.

## Real model usability

On the final images, Claude Opus 5 independently selected `run_script` and wrote
the code for all three requests: a five-node CPU/kubelet table, Python large-file
statistics and Shell large-file statistics. Each script completed on its first
attempt in this final rerun. Both file cases returned 40,000 rows and sum 180,000;
the raw dataset was not included in the conversation. The node table also loaded
successfully from saved history in the Portal browser.

The model was accessed through the already authenticated local Claude CLI and a
temporary schema-capture bridge. Local CLI tools/hooks were disabled. The model
received the actual Siclaw tool schema and chose the arguments; Siclaw executed
the calls through its deployed chain. This verifies real model tool usability,
but does not claim direct provider API-key integration. The bridge was stopped
and its temporary model option removed after restoring the fixture model.

The model's Shell script included `ls -l`, which emitted an `Operation not
permitted` warning under the strict syscall profile. File delivery, listing,
Python parsing, `set -e` script completion and the final statistics all succeeded
with exit code 0. The warning is retained in the results; no syscall permission
was added to hide it. Scripts can use the SDK's returned byte count/hash for
file verification.

## Startup observations

With images cached and `warmPoolSize=0`, the final mixed Portal suite had median
startup 1,567.5 ms and median complete-tool duration 1,893 ms (14 runs). The external
control plane's eight-run suite had medians of 1,535 ms and 1,939.5 ms respectively. These are
mixed acceptance samples, not a controlled performance benchmark or an SLA.

The two worker nodes reached their Pod count limits during testing. One external
control-plane startup took 54,510 ms while waiting for a slot. Only this task's idle services
were scaled down to release capacity; unrelated workloads and node settings
were not changed. Prewarming cannot replace available scheduler capacity.

## Remaining validation boundary

Real E2B cloud provisioning, hosted template behavior, public routing and cloud
latency are deferred at the user's request until an E2B environment exists.
Local relay and protocol tests do not substitute for that validation.

Dedicated SSH/MCP fixtures do not establish production helper installation or
third-party tool semantics. SSH still requires the reviewed fixed helper and
restricted key; MCP read-only behavior still requires operator review and
appropriate upstream permissions. Open-network mode permits ordinary external
connections and must not inherit production credentials or ambient identity.
Force network isolation when all infrastructure access must use the broker.
Native Pods share the host kernel and are not equivalent to microVM isolation.

Raw results and secret-bearing deployment inputs remain in the private local
acceptance directory, outside Git. The `ownership-*` reports identify the final
image reruns; earlier failed reproduction logs are retained as evidence of the
fixed issue.

The standalone Portal test deployment and local port-forward were restored.
External control-plane test services were scaled to zero with their database
volume retained.
Temporary pagination Pods were removed, and both execution namespaces were
checked for leftover Jobs/Pods after the runs.
