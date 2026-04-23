# Kubernetes Deployment

This directory contains Kubernetes manifests for deploying Siclaw in a multi-tenant configuration.

## Architecture

```
┌──────────────────────┐     ┌─────────────────────┐
│       Portal         │◄───►│      Runtime        │  (Deployments)
│  - User Auth / RBAC  │     │  - AgentBox Manager │
│  - Web UI (React)    │     │  - Channels / Cron  │
│  - DB: MySQL/SQLite  │     │  - Resource Sync    │
└──────────────────────┘     └──────────┬──────────┘
                                        │ K8s API
                                  ┌─────┴─────┐
                                  ▼           ▼
                            ┌─────────┐ ┌─────────┐
                            │AgentBox │ │AgentBox │  (Dynamic pods, per-user)
                            │ User A  │ │ User B  │
                            └─────────┘ └─────────┘
```

## Deployment Options

Siclaw supports two deployment methods:

- **Raw manifests** (this directory) — simple `kubectl apply`, suitable for quick setups
- **Helm chart** (`helm/siclaw/`) — parameterized deployment with overridable values

## Option A: Helm Chart (Recommended)

### Minimal Install

```bash
helm install siclaw helm/siclaw -n siclaw --create-namespace \
  --set image.registry=your-registry.example.com/siclaw \
  --set database.url="mysql://user:pass@host:3306/siclaw"
```

### With Existing Secret

```bash
helm install siclaw helm/siclaw -n siclaw --create-namespace \
  --set image.registry=your-registry.example.com/siclaw \
  --set database.existingSecret.name=my-db-secret
```

### Custom Values File

```bash
helm install siclaw helm/siclaw -n siclaw --create-namespace -f my-values.yaml
```

### Key Values

| Value | Default | Description |
|-------|---------|-------------|
| `image.registry` | `""` | Image registry prefix (e.g. `registry.example.com/myteam`) |
| `image.tag` | `latest` | Image tag for all three images |
| `runtime.replicas` | `1` | Runtime replicas |
| `portal.enabled` | `true` | Enable the Portal (Web UI + DB) |
| `portal.replicas` | `1` | Portal replicas |
| `portal.service.type` | `NodePort` | Service type |
| `portal.service.port` | `3003` | Service port |
| `portal.service.nodePort` | `31003` | NodePort port |
| `database.url` | `""` | MySQL connection URL |
| `database.existingSecret.name` | `""` | Use existing K8s secret for DB URL |

See `helm/siclaw/values.yaml` for the full list.

### Verify

```bash
helm lint helm/siclaw
helm template siclaw helm/siclaw
```

## Option B: Raw Manifests

### 1. Build Everything

```bash
# Install dependencies
npm ci

# Compile TypeScript
npm run build

# Build web React frontend
make build-portal-web

# Build all three Docker images (runtime, portal, agentbox)
# and push them to your registry
REGISTRY=your-registry.example.com/siclaw TAG=latest
make docker REGISTRY=$REGISTRY TAG=$TAG
make push   REGISTRY=$REGISTRY TAG=$TAG
```

### 2. Create Namespace and Secrets

```bash
kubectl create namespace siclaw

# Create secrets
kubectl create secret generic siclaw-secrets \
  --namespace=siclaw \
  --from-literal=jwt-secret=$(openssl rand -hex 32) \
  --from-literal=llm-api-key=YOUR_LLM_API_KEY
```

### 3. Deploy Gateway

```bash
# Replace ${REGISTRY} in the manifest with your registry address, then apply
REGISTRY=your-registry.example.com/siclaw
sed "s|\${REGISTRY}|$REGISTRY|g" gateway-deployment.yaml | kubectl apply -f -
```

### 4. Verify

```bash
# Check pod status
kubectl get pods -n siclaw

# Check logs
kubectl logs -n siclaw -l app=siclaw-runtime
kubectl logs -n siclaw -l app=siclaw-portal

# Port-forward the Portal UI to localhost
kubectl port-forward svc/siclaw-portal -n siclaw 3003:3003

# Open http://localhost:3003
```

## AgentBox Pods

AgentBox pods are created programmatically by the Runtime's K8s spawner — there is no static manifest for them. The authoritative pod spec lives in [`src/gateway/agentbox/k8s-spawner.ts`](../src/gateway/agentbox/k8s-spawner.ts); see [`docs/design/security.md`](../docs/design/security.md) for the security model (capability set, user isolation, setgid kubectl) that constrains the spawn spec. Per-pod DNS comes from the headless Service in [`agentbox-headless-service.yaml`](./agentbox-headless-service.yaml).

## Per-User Kubeconfig

For users who need kubectl access within their AgentBox:

```bash
kubectl create secret generic user-alice-kubeconfig \
  --namespace=siclaw \
  --from-file=config=/path/to/alice-kubeconfig.yaml
```

The secret name follows the pattern `user-${USER_ID}-kubeconfig`.

## Resource Limits

Default resource limits per AgentBox:
- CPU: 100m request, 1000m limit
- Memory: 256Mi request, 1Gi limit
- Temp storage: 500Mi
- Workspace storage: 1Gi

Adjust in `k8s-spawner.ts` as needed.

## Cleanup

AgentBox pods are automatically cleaned up by the Gateway when:
1. User disconnects and idle timeout expires (default: 5 minutes)
2. Gateway shuts down gracefully

For manual cleanup:
```bash
kubectl delete pods -l siclaw.io/app=agentbox -n siclaw
```
