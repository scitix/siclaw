# Capability container evidence

Kubernetes KB runs emit bounded status-only observations through the optional
`capability.observeContainer` frontend RPC. Deploy a compatible receiver before
the Runtime to retain snapshots after Pod deletion. The emitter starts with
the Runtime; it has no separate activation setting. Older receivers still get
the safe `[capability-container]` Runtime log records when persistence fails.

The observation identifies the run/profile and Pod UID, namespace, node, image
identity and every regular, init and ephemeral container's current/previous exit
status. It excludes environment, arguments, annotations, messages and log content.
The receiver must authorize against the authenticated Runtime and stored run;
Pod labels alone are not authority. Evidence storage must not update execution
state or heartbeat time.

A namespace informer records additions, updates and deletions. Before explicit
cleanup, the last cached snapshot is also recorded without delaying deletion.
One RPC is in flight at a time, with a 3 second transport deadline. Pending and
reconnect backlogs each retain at most 256 observations; acknowledged dedupe
retains at most 1024 keys. A full backlog evicts a previously declined snapshot
before a transport-failed one, then the oldest eligible snapshot. Fresh watch
observations take priority over replay: a replay cannot evict a queued fresh
snapshot. Connection recovery replays failed snapshots after run reconciliation,
with transport failures ahead of explicit declines. Shutdown waits only for the
active request and reports any dropped backlog; it does not drain minutes of
queued diagnostics.

In a shared namespace, an explicit `observed:false` may mean a foreign run or a
legacy run whose ownership is not claimed yet. It is not proof of ownership and
never counts as a stored acknowledgement. Each snapshot gets up to three
explicitly declined reconnect/reconcile replays before its retained replay entry
is dropped with a log. Initial observations, watch relists and transport errors
do not consume that budget. Exhaustion does not blacklist the run: a later
relist or changed snapshot may be sent again. Replays do not repeat the full
snapshot log. This bounds foreign-run replay traffic while allowing temporarily
unclaimed runs to recover; declined snapshots cannot displace transport-failed
evidence in the retained backlog.

These are observations, not a Kubernetes audit journal. A Runtime crash before
acknowledgement can lose its in-memory backlog; retained Runtime logs remain the
second evidence source. A watch that never observed a short-lived Pod cannot
reconstruct its container status afterward.
