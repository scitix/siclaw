# Script sandbox validation — 2026-09-12

This record supersedes the earlier prototype and draft acceptance notes. The
current architecture and operator settings are in [script-sandbox.md](script-sandbox.md).
E2B cloud provisioning remains a separate, deferred acceptance gate; the feature
and optional network isolation still default off, and LocalSpawner/headless CLI disable it.

## Code and automated checks

The deployed implementation includes credential/endpoint-bound result delivery,
live Web executor authorization, atomic ten-lane SDK mailboxes, shared target
admission and explicit execution/cleanup outcomes. Runner ownership survives lost
CREATE replies and failed DELETEs; foreground deletion must finish before cleanup
is confirmed. Rejected resource scopes are audited before credential resolution.

- Full backend suite before the final audit-only change: 7,447 passed, two existing skips.
- Final broker/service regression: 150 passed; TypeScript check passed.
- Portal web: 271 passed; both TypeScript projects and backend build passed.
- Real Python runner/SDK processes: 14 passed.
- Seven Helm configuration cases passed, including disabled/local and enabled providers.
- Native amd64 and arm64 CI passed container isolation and ten-container/100-in-flight
  SDK tests. All requests entered before any response was released; an eleventh
  script was rejected. The final image also passed Linux container smoke.
- Companion coordinator race/vet suites and real MySQL concurrent session-claim
  and credential integration tests passed. Removing any of the MCP binding,
  ingress reservation, owner reservation or fairness checks made its tests fail.

The SDK concurrency proof is a native container test. The Kubernetes cluster had
limited worker Pod slots; this report does not claim ten simultaneous K8s runners.
Shared target limits count SDK tool invocations, not all upstream HTTP traffic.

## Fresh-image Web acceptance

The integrated control plane ran real language-model Web sessions. Scripts used
the registered SDK contract; credentials were stored only in trusted services.

| Case | SDK calls | Startup | Script duration | Outcome |
| --- | ---: | ---: | ---: | --- |
| Local files and enforced isolation | 0 | 5,862 ms | 10,916 ms | `/work` and `/tmp` create/read/update/delete; image root read-only; IPv4/IPv6/Unix sockets denied even when the request asked to disable isolation |
| Python batch to ten separate result files | 10 | 6,973 ms | 9,621 ms | Ten identical five-node summaries |
| Shell batch through the fixed CLI | 10 | 1,582 ms | 3,915 ms | Ten successful results |
| Live HTTP MCP through the shared factory | 10 | 1,494 ms | 2,315 ms | Ten successful node-memory queries |
| Parallel node diagnostics | 3 | 1,202 ms | 5,302 ms | Three kernels read; diagnostic resources removed |
| Host SDK after a direct sample | 2 | 1,052 ms | 1,907 ms | Kernel read to a file; remote `rm` denied by the existing host policy |
| Pod SDK after a direct sample | 1 | 1,708 ms | 2,425 ms | Kernel read from a disposable target Pod |
| Facade then backend in one Web session | 0 + 1 | 1,800 / 961 ms | 2,047 / 1,428 ms | Both scripts succeeded; session facade stayed fixed and only backend resource bindings authorized the cluster call |

Durations exclude model generation and are samples, not a latency SLA. Images
were cached, warm pools were disabled and administrator-required network isolation
was enabled. Results were checked against persisted history and Runtime audit.
The runner Pod specs had no injected environment, credentials, service account
token or host filesystem. Local writable volumes were bounded tmpfs volumes.

The Python batch required two attempts: its ten SDK queries succeeded initially,
but a later optional `Path.exists()` probe under `/root` raised `PermissionError`.
The rewritten script handled inaccessible paths and completed. This was a local
probe error, not evidence of credential access or a claim of perfect model success.

The negative cluster case rejected a client-only dry-run create, a server override
and an undeclared cluster, with a successful file-based query as a control. It
exposed one missing audit for early scope rejection; the broker now includes that
path in its audit boundary without changing the shared command policy. On the
final `c8f5fc74` Runtime image, all four integrated calls (three denials, one
success) and both Portal calls had matching audit entries. Both runs confirmed
cleanup. The image passed all seven GitHub checks before this documentation update.

## Standalone Portal and failure paths

A separate Helm release used an independent database/user, a read-only cluster
identity and a deterministic model fixture. This tests the Portal transport and
authorization chain, not natural-language script generation. The fixture captured
the actual model tool definition and verified SDK imports, `input_data()`,
`call_to_file`, `/work` guidance and `max_workers=10` were present.

- Local filesystem/socket boundaries, ten file-based queries and a rejected remote
  write completed in one run (11 SDK calls, 1,793 ms startup, 2,856 ms total).
- A 300,000-character output was capped at 131,072 bytes with `output_truncated=true`.
- Another user's session returned HTTP 404. A reader's own script was denied before
  provider startup, with zero SDK calls.
- Zero Pod quota produced an early rejection (178 ms) and left no runner resources.
- A live binding was removed after a successful callback; the same script's next
  callback was denied and cleanup was confirmed.
- User cancellation and Runtime rollout removed runner Jobs/Pods. Their SSE turns
  ended without a final script result, so cleanup was verified through Kubernetes
  rather than inferred from the client response. A fresh post-rollout run succeeded.

Initial fixture failures were retained: `/root` permission handling, an external
cluster address that was unreachable from the test namespace, and a quota-restore
bug in the acceptance harness. The fixture was corrected to use the internal API
address and trusted cluster CA, and quota restoration replaced the complete hard
limits map. No runtime permission was widened to make these cases pass.

## Remaining scope and release ordering

Deploy the companion authorization/admission API first, then compatible Runtime,
AgentBox and runner images. Use reviewed MCP operations and verified SSH pins.
Merge the feature as a squash so intermediate credential-snapshot states do not
become separate releases. Public cloud E2B remains disabled until provisioning,
external routing, multiple API replicas and VM cleanup are verified in that account.
Local TLS relay/container tests do not replace that cloud acceptance.

Native containers share the host kernel. The supplied tools' command policies and
upstream identities remain trusted; a root SSH account is not an OS-level read-only
account, and node diagnostics create managed infrastructure. This feature does not
prove arbitrary existing diagnostic commands have no side effects.

## Final cleanup

Temporary Agent/host/credential fixtures and disposable target Pods were removed;
the temporary integrated user was suspended and its organization membership revoked.
The standalone release, both disposable namespaces and its separate database/user
were removed. Runner and diagnostic namespaces were empty, with warm pools off.
The integrated test deployment and its pre-existing test Agent/MCP were retained.
