---
title: "AgentBox Security Architecture"
sidebarTitle: "Security"
description: "Defense-in-depth security model for LLM agent command execution in AgentBox containers."
---

# AgentBox Security Architecture

> **Purpose**: Document the multi-layer security model that constrains what an LLM agent
> can do inside an AgentBox container. Every layer is independent — compromising one does
> not disable the others.
>
> **Audience**: Contributors modifying execution tools, Dockerfile, or K8s manifests.

---

## 1. Threat Model

### 1.1 Core Assumption

**The LLM agent is untrusted code.** It generates shell commands that execute in a
container with access to Kubernetes clusters. The security model must assume the agent
will attempt — intentionally or via prompt injection — to:

1. **Read credentials**: kubeconfig, mTLS certificates, API keys, tokens
2. **Exfiltrate data**: Send sensitive information to external endpoints
3. **Escalate privileges**: Gain access beyond read-only K8s operations
4. **Escape the container**: Exploit kernel or runtime vulnerabilities

### 1.2 Trust Boundaries

```
┌─────────────────────────────────────────────────────────┐
│ AgentBox Container                                       │
│                                                          │
│   ┌──────────────────────┐   ┌────────────────────────┐ │
│   │ Main Process          │   │ Child Processes         │ │
│   │ (agentbox user)       │   │ (sandbox user)          │ │
│   │                       │   │                         │ │
│   │ • Node.js runtime     │   │ • kubectl (setgid)      │ │
│   │ • LLM API client      │   │ • grep, jq, sort, ...   │ │
│   │ • Tool validation     │   │ • skill scripts          │ │
│   │ • Reads kubeconfig    │   │ • NO credential access   │ │
│   └──────────────────────┘   └────────────────────────┘ │
│                                                          │
│   Trust boundary: sandbox user cannot read agentbox's    │
│   files (kubeconfig, mTLS certs, .siclaw/config/)        │
└──────────────────────────────────────────────────────────┘
```

### 1.3 What We Protect

| Asset | Location | Risk | Protection |
|-------|----------|------|------------|
| Kubeconfig | `.siclaw/credentials/` | Full cluster access | File permissions + setgid kubectl |
| mTLS certs | `/etc/siclaw/certs/` | Gateway impersonation | File permissions (agentbox:agentbox 0600) |
| API keys | `.siclaw/config/settings.json` | LLM API abuse, cost | File permissions + sensitive path patterns |
| Environment vars | Process memory | Token leakage via /proc | `sanitizeEnv()` strips secrets before child spawn |
| K8s service account | Pod metadata API | Cluster API access | `automountServiceAccountToken: false` |

---

## 2. Defense-in-Depth Overview

Six independent layers, each providing protection even if others are bypassed:

```
Layer 1 — OS User Isolation       sandbox user cannot read credential files
Layer 2 — Command Validation      6-pass whitelist pipeline blocks disallowed binaries
Layer 3 — Container Hardening     drop ALL capabilities, seccomp, readOnlyRootFilesystem
Layer 4 — File I/O Restrictions   assertPathAllowed() scopes agent file tools
Layer 5 — Environment Sanitization  sanitizeEnv() strips API keys/tokens from child env
Layer 6 — kubectl Access Control  read-only subcommands, exec binary whitelist
```

**Design principle**: Each layer is justified independently. Removing one layer must not
create a viable attack path. The OS layer (Layer 1) is the **primary defense** for
credential protection; application layers (2-6) are **secondary defense-in-depth**.

---

## 3. Layer 1: OS-Level User Isolation

### 3.1 Dual-User Model

Two users exist inside the AgentBox container:

| User | UID | Groups | Purpose |
|------|-----|--------|---------|
| `agentbox` | 1000 | `agentbox`, `kubecred` | Main Node.js process. Owns credentials. |
| `sandbox` | 1001 | `sandbox` | All child processes (shell commands). No credential access. |

The main process (Node.js) runs as `agentbox`. When executing shell commands, it uses
`runuser -u sandbox -- bash -c "<command>"` to drop to the `sandbox` user.

### 3.2 setgid kubectl

The `kubectl` binary has the setgid bit set for the `kubecred` group:

```
-rwxr-sr-x 1 root kubecred  kubectl
```

This allows `kubectl` to read kubeconfig files owned by `agentbox:kubecred` with mode
`0640`, while other commands (grep, cut, cat) running as `sandbox` cannot.

**Why setgid and not SUID**: setgid only changes the effective group ID, not the user ID.
The process remains `sandbox` (UID 1001) but temporarily gains `kubecred` group membership.
This is the minimum privilege needed for kubectl to read the kubeconfig.

### 3.3 File Permission Matrix

**Design principle**: OS-level permissions are the source of truth for access control.
Application-level restrictions (`assertPathAllowed`, `writeAllowedDirs`) are a secondary
defense — they prevent the agent from misusing its own file tools, but cannot constrain
shell commands. The `sandbox` user's filesystem permissions must independently enforce
the correct access boundaries.

#### Credentials & secrets (sandbox: no access)

| Path | Owner | Mode | agentbox | sandbox | kubectl (setgid) |
|------|-------|------|----------|---------|-------------------|
| `.siclaw/credentials/*.kubeconfig` | agentbox:kubecred | 0640 | rw | -- | r- (via group) |
| `/etc/siclaw/certs/` | agentbox:agentbox | 0600 | rw | -- | -- |
| `.siclaw/config/settings.json` | agentbox:agentbox | 0600 | rw | -- | -- |
| `.siclaw/data.sqlite` | agentbox:agentbox | 0600 | rw | -- | -- |

#### Skills & application code (sandbox: read-only)

| Path | Owner | Mode | Volume | agentbox | sandbox | Notes |
|------|-------|------|--------|----------|---------|-------|
| `skills/core/` | agentbox:agentbox | 0755/0644 | rootfs (baked) | rwx/rw | r-x/r- | Built-in diagnostic skills. Baked into image. |
| `.siclaw/skills/` | agentbox:agentbox | 0755/0644 | emptyDir | rwx/rw | r-x/r- | Team + personal skills synced from DB via `skillsHandler.materialize()`. |
| `/app/` (application code) | agentbox:agentbox | 0755/0644 | rootfs | rwx/rw | r-x/r- | Node.js dist, package.json, etc. |

**Skills write flow in K8s mode**: `skill.create` → DB → `notifySkillReload` → AgentBox main
process (agentbox user) calls `skillsHandler.materialize()` → writes to emptyDir at
`.siclaw/skills/`. The sandbox user (child processes) only reads from this directory.

Agent needs to **read** skills (SKILL.md, scripts/) to understand and execute them.
Agent must **never write** to skills — that goes through the skill review gate
(WebUI → DB → resource sync → main process materialize).
The `sandbox` user has no write permission on any of these by OS permission alone.

#### User data (sandbox: read-write)

| Path | Owner | Mode | agentbox | sandbox | Notes |
|------|-------|------|----------|---------|-------|
| `.siclaw/user-data/` | agentbox:agentbox | 0777 | rwx | rwx | Memory files, PROFILE.md, investigation notes. |
| `/tmp/` | (any) | 1777 | rw | rw | Temporary files. Sticky bit prevents cross-user deletion. |

The `user-data` directory is the **only** writable area for the sandbox user (besides /tmp).
This matches the application-level `writeAllowedDirs = [userDataDir]` — but enforced at OS level.

**Critical**: No sensitive files should be placed in `/tmp/` or `user-data/`.

### 3.4 Pipeline Compatibility

The dual-user model preserves natural shell pipeline syntax:

```bash
# sandbox runs the entire pipeline; kubectl gains kubecred via setgid
runuser -u sandbox -- bash -c "kubectl get pods -A | grep Error | wc -l"
```

`kubectl` (setgid kubecred) reads the kubeconfig. `grep` and `wc` (plain sandbox) cannot.
The pipe passes stdout data, not file access permissions.

### 3.5 Dockerfile Changes

```dockerfile
FROM node:22-slim

# Create groups and users
RUN groupadd kubecred && \
    groupadd sandbox && \
    useradd -m -s /bin/bash -G kubecred agentbox && \
    useradd -r -s /bin/false -g sandbox sandbox

# Install kubectl with setgid
COPY --from=bitnami/kubectl:latest /opt/bitnami/kubectl/bin/kubectl /usr/local/bin/kubectl
RUN chgrp kubecred /usr/local/bin/kubectl && \
    chmod 2755 /usr/local/bin/kubectl

# Set credential permissions (entrypoint also enforces this)
RUN mkdir -p /home/agentbox/.siclaw/credentials && \
    chown agentbox:kubecred /home/agentbox/.siclaw/credentials && \
    chmod 0750 /home/agentbox/.siclaw/credentials

# Application code & skills: owned by agentbox, world-readable (sandbox can read)
# COPY steps already produce agentbox-owned files when USER is set
COPY --chown=agentbox:agentbox skills/ /app/skills/
RUN chmod -R o+rX /app/ /app/skills/

# User data: sandbox-writable (the only writable area for child processes)
RUN mkdir -p /home/agentbox/.siclaw/user-data && \
    chown agentbox:agentbox /home/agentbox/.siclaw/user-data && \
    chmod 0777 /home/agentbox/.siclaw/user-data

USER agentbox
```

### 3.6 Code Changes

In `src/tools/restricted-bash.ts`, the `exec()` call wraps commands with `runuser`:

```typescript
const finalCommand = `runuser -u sandbox -- bash -c ${shellEscape(command)}`;
```

The `KUBECONFIG` environment variable is still set (kubectl reads it), but the kubeconfig
file itself is only readable by `kubecred` group members.

---

## 4. Layer 2: Application-Level Command Validation

### 4.1 The 6-Pass Validation Pipeline

Every command passes through `validateCommand()` in `src/tools/command-validator.ts`:

```
Pass 1 — Shell Operators      Block: $(), backticks, <(), >(), file redirections, newlines
Pass 2 — Pipeline Extraction   extractPipeline() with pipe-position tracking
Pass 3 — Binary Whitelist      Context-based: local | node | pod | nsenter | ssh
Pass 4 — Pipeline Validators   kubectl subcommand checks
Pass 5 — COMMAND_RULES         Per-command: pipeOnly, noFilePaths, blockedFlags, allowedFlags
Pass 6 — Sensitive Paths       Block commands targeting credential/config file paths
```

### 4.2 Context-Based Whitelisting

Different execution contexts allow different command sets:

| Context | Used By | Scope |
|---------|---------|-------|
| `local` | `restricted-bash.ts` | AgentBox container — text processing + kubectl |
| `node` | `node-exec.ts` | Remote node (via debug pod) — full diagnostics |
| `pod` | `pod-exec.ts` | Target pod — full diagnostics |
| `nsenter` | `pod-nsenter-exec.ts` | Target pod network namespace — full diagnostics |

The `local` context is the most restrictive: only text-processing commands (grep, jq, sort,
etc.), flow control (echo, printf), and kubectl. File-reading commands (cat, ls, find) are
blocked — agents use dedicated file tools instead.

**Source**: `src/tools/command-sets.ts` — `CONTEXT_CATEGORIES`, `COMMAND_CATEGORIES`

### 4.3 COMMAND_RULES Declarative Engine

Per-command restrictions are defined declaratively in `COMMAND_RULES`:

```typescript
interface CommandRule {
  command: string;
  contexts?: string[];      // execution contexts where rule applies
  pipeOnly?: boolean;       // must appear after pipe |
  noFilePaths?: boolean;    // block /, ./, ../, ~ positional args
  blockedFlags?: string[];  // explicitly forbidden flags
  allowedFlags?: string[];  // only these flags allowed
  allowedSubcommands?: { position: number; allowed: string[] };
  positionals?: "allow" | "block" | number;
  requiredFlags?: string[];
  customValidator?: string;
}
```

Example: In the `local` context, `grep` is pipe-only with no file paths and no recursive flags:

```typescript
grep: { command: "grep", contexts: ["local"], pipeOnly: true, noFilePaths: true,
         blockedFlags: ["-r", "-R", "--recursive"] }
```

This prevents `kubectl get pods | grep -rl "" /app/.siclaw` from reading credential files
even though `grep` appears after a pipe.

**Source**: `src/tools/command-sets.ts` — `COMMAND_RULES`

### 4.4 Explicitly Excluded Binaries

| Command | Reason |
|---------|--------|
| `sed` | `-i` in-place write, `-e`/`r`/`w` file ops, `e` command execution |
| `awk`/`gawk` | `system()`, `getline`, pipe-to-shell execution |
| `bc` | `!command` shell escape |
| `nc`/`netcat`/`ncat` | Arbitrary TCP, exfiltration |
| `wget` | File write, recursive crawl |
| `bash`/`sh` (direct) | Unrestricted shell — `restricted-bash` wraps with validation |

### 4.5 Role After OS Isolation

With OS-level user isolation (Layer 1), the application-level command validation becomes a
**secondary defense layer**. It still provides value:

- Blocks commands with dangerous side effects (network exfiltration via `curl -d`)
- Restricts kubectl to read-only subcommands (OS isolation doesn't help here)
- Prevents shell injection via `$()`, backticks, redirections
- Provides audit trail of blocked commands

The `local`-context rules (pipeOnly, noFilePaths, blockedFlags) can be **relaxed** after
OS isolation is deployed, since the sandbox user cannot read credential files regardless.
However, they remain as defense-in-depth.

---

## 5. Layer 3: Container Hardening

### 5.1 K8s SecurityContext

```yaml
spec:
  securityContext:
    runAsNonRoot: false          # Main process needs runuser (requires root or CAP_SETUID)
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: agentbox
    securityContext:
      capabilities:
        drop: ["ALL"]
        add: ["SETUID", "SETGID"]  # Required for runuser -u sandbox
      readOnlyRootFilesystem: true
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: siclaw-data
      mountPath: /home/agentbox/.siclaw
  volumes:
  - name: tmp
    emptyDir:
      sizeLimit: 100Mi
```

### 5.2 Capability Justification

| Capability | Why needed | Risk |
|------------|-----------|------|
| `SETUID` | `runuser -u sandbox` requires switching effective UID | Low — only used to drop privileges, not gain them |
| `SETGID` | `runuser` also switches GID; kubectl setgid requires kernel enforcement | Low — setgid only grants kubecred group |
| All others | Dropped | N/A |

### 5.3 What Is Blocked

With `drop: ALL` + only SETUID/SETGID:

- `CAP_NET_RAW` dropped — no raw sockets, no packet sniffing
- `CAP_SYS_PTRACE` dropped — no debugging/attaching to other processes
- `CAP_SYS_ADMIN` dropped — no mount, no namespace manipulation
- `CAP_SYS_MODULE` dropped — no kernel module loading
- `CAP_DAC_OVERRIDE` dropped — cannot bypass file permission checks
- `CAP_NET_ADMIN` dropped — no network config changes

### 5.4 Additional Hardening

```yaml
# Already in place
automountServiceAccountToken: false   # No K8s API access via service account

# Recommended additions
spec:
  hostNetwork: false
  hostPID: false
  hostIPC: false
```

---

## 6. Layer 4: File I/O Path Restrictions (Application-Level)

Agent file tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) are scoped by
`assertPathAllowed()` in `src/core/agent-factory.ts`:

```
Read allowed:  builtin skills, dynamic skills, userDataDir, reports
Write allowed: userDataDir ONLY
Blocked:       credentials, config, system dirs, anything outside allowed paths
```

**Relationship to OS permissions**: This layer does NOT protect against bash commands —
that is the job of Layer 1 (OS user isolation). `assertPathAllowed` restricts **which
directories the agent's own file tools can see**, providing a curated view of the filesystem.
Even if the sandbox user can `r-x` skills directories, the agent's `write` tool still refuses
to write there because `writeAllowedDirs = [userDataDir]`.

Both layers are needed:
- **OS permissions** (Layer 1): Enforces that `sandbox` cannot write to skills, credentials, app code — regardless of what commands are used
- **assertPathAllowed** (Layer 4): Restricts the agent's file tool **scope** to diagnostic-relevant directories only — prevents the agent from browsing `/etc`, `/proc`, or other irrelevant areas

**Source**: `src/core/agent-factory.ts` — `assertPathAllowed()`

---

## 7. Layer 5: Environment Sanitization

`sanitizeEnv()` in `src/tools/sanitize-env.ts` strips sensitive variables before
spawning child processes:

```
Stripped patterns:
  *_API_KEY, *_SECRET, *_TOKEN, *_PASSWORD, *_CREDENTIAL
  ANTHROPIC_*, OPENAI_*, SICLAW_LLM_*
  SICLAW_GATEWAY_URL (prevents AgentBox → Gateway API calls)
```

**Why this layer persists with OS isolation**: Environment variables live in process memory
(`/proc/self/environ`), not in files. Even if the sandbox user cannot read credential files,
`cat /proc/self/environ` in a child process could leak API keys if they were inherited.
`sanitizeEnv()` prevents this.

**Source**: `src/tools/sanitize-env.ts`

---

## 8. Layer 6: kubectl Access Control

### 8.1 Read-Only Subcommands

```
Allowed: get, describe, logs, top, events, api-resources, api-versions,
         cluster-info, config, version, explain, auth, exec
```

**All write operations permanently blocked**: apply, create, delete, patch, scale, drain,
cordon, edit, replace, label, taint, rollout undo.

### 8.2 kubectl exec Restrictions

When `kubectl exec` is used (e.g., `kubectl exec my-pod -- ip addr`), the exec'd command
passes through the binary allowlist. Only commands in `ALLOWED_COMMANDS` can be exec'd.

### 8.3 kubectl config view --raw Blocked

`kubectl config view --raw` is explicitly blocked — it outputs kubeconfig with embedded
certificates and tokens in plaintext.

**Source**: `src/tools/kubectl.ts` — `SAFE_SUBCOMMANDS`, `validateExecCommand()`

---

## 9. Container Escape Risk Assessment

### 9.1 Attack Surface Analysis

| Vector | Feasibility | Mitigation |
|--------|-------------|------------|
| Kernel exploit (e.g., CVE-2024-1086) | Low — requires specific unpatched kernel | Keep nodes updated; seccomp blocks most exploit syscalls |
| Node.js RCE (prototype pollution) | Medium — if LLM triggers Node.js vulnerability, gains agentbox user | agentbox can read kubeconfig (by design), but K8s RBAC limits cluster access |
| kubectl vulnerability | Low — static Go binary, read-only ops, limited subcommands | Keep kubectl updated |
| `/proc/self/environ` in child | Blocked — `sanitizeEnv()` strips secrets | Layer 5 |
| SUID/SGID binary exploitation | Blocked — `readOnlyRootFilesystem: true`, no SUID binaries in image | Layer 3 |
| Container runtime escape | Very low — standard containerd/runc, non-root child processes | Infrastructure concern, not app-level |
| Network exfiltration | Medium — sandbox can reach network | `curl -d` blocked (Layer 2); Network Policy recommended |
| Mount namespace manipulation | Blocked — `CAP_SYS_ADMIN` dropped | Layer 3 |

### 9.2 Residual Risks

1. **Node.js process compromise**: If the LLM exploits a Node.js vulnerability, it gains
   `agentbox` user privileges (can read kubeconfig). Mitigation: K8s RBAC should scope the
   kubeconfig to read-only cluster access.

2. **Network-level exfiltration**: The sandbox user can make network connections (DNS, HTTP)
   unless restricted by NetworkPolicy. Recommendation: deploy NetworkPolicy to limit egress
   to the K8s API server and required endpoints only.

3. **Shared /tmp**: Both agentbox and sandbox can read/write `/tmp`. Do not store sensitive
   data in `/tmp`. Use `mktemp` with restrictive permissions if temporary files are needed.

### 9.3 Recommended NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agentbox-egress
spec:
  podSelector:
    matchLabels:
      app: agentbox
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: <k8s-api-server-cidr>/32
    ports:
    - port: 6443
      protocol: TCP
  - to:
    - namespaceSelector:
        matchLabels:
          app: siclaw-gateway
    ports:
    - port: 3002
      protocol: TCP
  - to:                          # DNS
    - namespaceSelector: {}
    ports:
    - port: 53
      protocol: UDP
```

---

## 10. Implementation Checklist

### 10.1 Dockerfile

- [ ] Create `kubecred` and `sandbox` groups/users
- [ ] Install kubectl with `chmod 2755` + `chgrp kubecred`
- [ ] Credential dirs: `agentbox:kubecred 0750` (sandbox: no access, kubectl: read via group)
- [ ] Config/cert files: `agentbox:agentbox 0600` (sandbox: no access)
- [ ] Skills dirs: `agentbox:agentbox 0755/0644` (sandbox: read-only)
- [ ] App code: `agentbox:agentbox 0755/0644` (sandbox: read-only)
- [ ] User data dir: `agentbox:agentbox 0777` (sandbox: read-write — the only writable area)
- [ ] Verify no SUID binaries in final image: `find / -perm /4000 -type f`

### 10.2 K8s Manifests

- [ ] Add `capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID"] }`
- [ ] Add `readOnlyRootFilesystem: true` with emptyDir for `/tmp`
- [ ] Add `seccompProfile: { type: RuntimeDefault }`
- [ ] Keep `automountServiceAccountToken: false`
- [ ] Deploy NetworkPolicy for egress restriction

### 10.3 Application Code

- [ ] `restricted-bash.ts`: Wrap commands with `runuser -u sandbox --`
- [ ] Verify `sanitizeEnv()` still strips all sensitive vars (Layer 5 remains)
- [ ] Verify `assertPathAllowed()` still scopes file tools (Layer 4 remains)
- [ ] Entrypoint script: enforce file permissions on startup (defense against volume mount issues)

### 10.4 Validation

File permission verification:
- [ ] Sandbox cannot read credentials: `runuser -u sandbox -- cat .siclaw/credentials/*.kubeconfig` → Permission denied
- [ ] Sandbox cannot read config: `runuser -u sandbox -- cat .siclaw/config/settings.json` → Permission denied
- [ ] Sandbox cannot write skills: `runuser -u sandbox -- touch skills/core/test` → Permission denied
- [ ] Sandbox cannot write app code: `runuser -u sandbox -- touch /app/test` → Permission denied
- [ ] Sandbox **can** read skills: `runuser -u sandbox -- cat skills/core/cluster-events/SKILL.md` → Success
- [ ] Sandbox **can** write user-data: `runuser -u sandbox -- touch .siclaw/user-data/test` → Success

Functional verification:
- [ ] kubectl can read kubeconfig (setgid): `runuser -u sandbox -- kubectl get pods` → Success
- [ ] grep cannot read kubeconfig: `runuser -u sandbox -- grep "" .siclaw/credentials/*.kubeconfig` → Permission denied
- [ ] Pipeline works: `runuser -u sandbox -- bash -c "kubectl get pods | grep Error"` → Success
- [ ] No SUID binaries: `runuser -u sandbox -- find / -perm /4000 -type f` → Empty
- [ ] Run full test suite: `npm test`
