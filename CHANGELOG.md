# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

#### Prometheus Observability Layer

Integrated Prometheus metrics via a decoupled event bus architecture. Business code emits diagnostic events; a single prom-client subscriber maps them to 11 Prometheus metrics covering token usage, cost, latency, tool calls, sessions, and health.

**New Components:**
- `diagnostic-events.ts` — zero-dependency event bus (`emitDiagnostic()` / `onDiagnostic()`)
- `metrics.ts` — prom-client subscriber, the only file that depends on prom-client
- Dedicated metrics HTTP server on port 9090 for AgentBox (K8s mode only, bypasses mTLS)

**Helm Chart:**
- ServiceMonitor for Gateway, PodMonitor for AgentBox (cross-namespace discovery)
- Grafana dashboard auto-import via ConfigMap with `grafana_dashboard: "1"` label
- PrometheusRule with preset alerts (opt-in)

**Breaking Changes:**
- AgentBox container port name changed from `http` to `https` in K8s manifests and `k8s-spawner.ts`. If you have external configurations (NetworkPolicies, custom Services, Istio VirtualServices) that reference the AgentBox port by name `http`, update them to `https`.
- New container port `metrics` (9090) added to AgentBox pods.

**Dependencies:**
- Added `prom-client` for Prometheus metrics

---

#### mTLS Authentication for Gateway-AgentBox Communication

Implemented mutual TLS (mTLS) authentication to secure internal APIs between Gateway and AgentBox instances. This provides certificate-based authentication and authorization for all internal endpoints.

**Security Features:**
- Gateway acts as Certificate Authority (CA)
- Each AgentBox receives unique client certificate with embedded identity (userId, workspaceId, boxId)
- Certificate-based authorization for protected endpoints
- 30-day certificate validity with automatic renewal on AgentBox restart

**New Components:**
- `CertificateManager` class for CA operations and certificate issuance/verification
- `createMtlsMiddleware()` for HTTP request authentication
- `GatewayClient` class for AgentBox to make authenticated requests to Gateway
- Automatic certificate provisioning in K8s spawner (via Kubernetes Secrets)

**New API Endpoints:**
- `GET /api/internal/cron-list?userId={userId}` - List cron jobs for a user (with authorization check)

**Modified Components:**
- `K8sSpawner`: Issues client certificates and mounts them as Secrets in AgentBox Pods
- `agentbox-main.ts`: Uses `GatewayClient` instead of plain fetch for settings sync
- `manage_schedule` tool: Uses `GatewayClient` for listing cron jobs with mTLS authentication

**Documentation:**
- [mTLS Setup Guide](docs/deployment/mtls-setup.md) - Comprehensive deployment guide
- [mTLS API Reference](docs/development/mtls-api-reference.md) - Developer reference
- [mTLS Security Design](docs/architecture/mtls-security.md) - Architecture documentation
- [AgentBox-Gateway Communication](docs/architecture/agentbox-gateway-communication.md) - Communication patterns
- [API Direction Analysis](docs/architecture/api-direction-analysis.md) - Bidirectional API design rationale

**Dependencies:**
- Added `node-forge` for X.509 certificate generation and verification

**Migration Notes:**
- Existing deployments continue to work (backward compatible)
- New AgentBox Pods automatically receive certificates
- Gateway URL must use `https://` scheme for mTLS to activate
- Certificate files mounted at `/etc/siclaw/certs` in AgentBox Pods

**Breaking Changes:**
- None (mTLS is additive and backward compatible)

**Performance:**
- TLS handshake overhead: ~50-100ms per connection (amortized with keep-alive)
- Certificate verification: ~1-5ms per request

**Testing:**
- All code compiles successfully with TypeScript strict mode
- Manual testing required for certificate generation and verification
- See [Testing section](docs/deployment/mtls-setup.md#testing-mtls) for integration tests

---

## [0.1.0] - Previous Releases

(Add previous release notes here as they are created)

---

## Release Process

1. Update this CHANGELOG.md with all changes under [Unreleased]
2. Change [Unreleased] to version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Create git tag: `git tag -a vX.Y.Z -m "Release X.Y.Z"`
4. Push tag: `git push origin vX.Y.Z`
5. Build and publish release artifacts

## Version Format

This project uses [Semantic Versioning](https://semver.org/):
- MAJOR version for incompatible API changes
- MINOR version for new functionality (backward compatible)
- PATCH version for bug fixes (backward compatible)
