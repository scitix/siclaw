# Kubernetes Deployment

This directory contains Kubernetes manifests for deploying Siclaw in a multi-tenant configuration.

## Architecture

```
┌─────────────────────┐
│      Gateway        │  (Deployment, 1+ replicas)
│  - User Auth        │
│  - Web2 UI (React)  │
│  - AgentBox Manager │
└──────────┬──────────┘
           │ K8s API
    ┌──────┴──────┐
    ▼             ▼
┌─────────┐ ┌─────────┐
│AgentBox │ │AgentBox │  (Dynamic Pods, per-user)
│ User A  │ │ User B  │
└─────────┘ └─────────┘
```

## Quick Start

### 1. Build Everything

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Build web React frontend
npm run build:web

# Build Docker images
npm run docker:build:gateway
npm run docker:build:agentbox

# Tag and push to your private registry
REGISTRY=your-registry.example.com/siclaw
docker tag siclaw-gateway:latest $REGISTRY/siclaw-gateway:latest
docker tag siclaw-agentbox:latest $REGISTRY/siclaw-agentbox:latest
docker push $REGISTRY/siclaw-gateway:latest
docker push $REGISTRY/siclaw-agentbox:latest
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
kubectl logs -n siclaw -l app=siclaw-gateway

# Port-forward for local testing
kubectl port-forward svc/siclaw-gateway -n siclaw 3000:80

# Open http://localhost:3000
```

## AgentBox Template

The `agentbox-template.yaml` is reference documentation for the pod spec.
The K8sSpawner creates pods programmatically via the K8s API.

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
