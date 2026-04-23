# Security Policy

Siclaw runs LLM-generated shell commands with access to Kubernetes clusters, SSH hosts, and brokered credentials. We take security reports seriously.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report privately through **[GitHub Security Advisories](https://github.com/scitix/siclaw/security/advisories/new)**. We will acknowledge within 48 hours and coordinate a fix before any public disclosure.

## Scope

Security issues we want to hear about include:

- **Credential exposure** — kubeconfig, API keys, SSH keys, or mTLS CA material leaking from the AgentBox container, Gateway process, Portal DB, or logs
- **Sandbox escape** — any path by which an agent can read files, gain capabilities, or run commands outside the intended whitelist (`src/tools/infra/command-sets.ts`, output sanitizer, pipeline validator)
- **Authentication / authorization bypass** — routes in Portal, Runtime, or AgentBox that should require auth (JWT, admin role, API key, mTLS client cert) but don't
- **Prompt-injection-driven privilege escalation** — crafted tool output or skill content that the agent turns into commands bypassing the defense layers
- **Multi-tenant isolation breaks** — one user's session, skills, credentials, or memory leaking to another user (particularly in K8s mode, one AgentBox pod reaching another)
- **Supply chain** — builds that pull unsigned artifacts, Dockerfile primitives that allow privileged escalation, or CI pipelines that could be subverted
- **mTLS weaknesses** — certificate validation gaps, CA handling issues, or client-cert authorization that fails open

Before reporting, please skim [`docs/design/security.md`](docs/design/security.md) — it describes the intended defense-in-depth model (OS-level user isolation, whitelist-only command validation, output sanitization, mTLS scope). A finding that breaks one of those documented invariants is definitely in scope.

## Out of Scope

- The agent choosing an unsafe but allowed command on behalf of the user. The read-only kubectl + whitelist model bounds *capability*, not *judgment*. Unsafe-but-allowed-by-design behaviour is a product decision, not a vulnerability.
- Issues in the user's own kubeconfig, API keys, SSH keys, or LLM provider credentials supplied through the UI.
- Vulnerabilities in third-party dependencies that do not affect Siclaw's configured code paths (please report upstream).
- Denial-of-service via expensive LLM prompts, expensive skills, or deliberately oversized diagnostic runs.
- Social engineering, physical access, or any attack that requires valid admin credentials.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

Older pre-0.1 versions are not maintained.
