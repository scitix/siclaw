# Siclaw Makefile
#
# Usage:
#   make help                                    — Show all targets
#   make docker push REGISTRY=myregistry.com     — Build & push all images
#   make docker-portal push-portal               — Build & push portal only
#
# Deploy via Helm:
#   helm upgrade --install siclaw ./helm/siclaw -f helm/siclaw/values-local.yaml

# ── Git metadata (auto-detected) ──
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_TAG    := $(shell git describe --tags --abbrev=0 --exact-match 2>/dev/null)
GIT_DIRTY  := $(shell test -n "$$(git status --porcelain)" && echo "-dirty" || echo "")
VERSION    := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

# ── Configurable variables ──
REGISTRY  ?= scitix
NAMESPACE ?= siclaw
TAG       ?= $(if $(GIT_TAG),$(GIT_TAG),$(VERSION)-$(GIT_COMMIT)$(GIT_DIRTY))

# ── Image names ──
RUNTIME_IMAGE  = $(REGISTRY)/siclaw-runtime:$(TAG)
AGENTBOX_IMAGE = $(REGISTRY)/siclaw-agentbox:$(TAG)
PORTAL_IMAGE   = $(REGISTRY)/siclaw-portal:$(TAG)

# ── OCI labels injected into every image ──
DOCKER_LABELS = \
	--label org.opencontainers.image.version=$(VERSION) \
	--label org.opencontainers.image.revision=$(GIT_COMMIT)$(GIT_DIRTY) \
	--label org.opencontainers.image.created=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Self-documenting help (targets annotated with ## are auto-listed) ──
.DEFAULT_GOAL := help

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\n\033[1mUsage:\033[0m\n  make \033[36m<target>\033[0m [REGISTRY=xxx] [TAG=xxx]\n"} /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} /^[a-zA-Z_-]+:.*?##/ {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""

# ==================== Development ====================
##@ Development

tui: ## Run TUI agent (interactive terminal)
	npx tsx src/cli-main.ts

runtime: ## Run Agent Runtime (multi-user, local spawner)
	npx tsx src/gateway-main.ts

portal: ## Run Portal server (standalone web UI + management)
	npx tsx src/portal-main.ts

portal-web: ## Run Portal frontend dev server
	cd portal-web && npm run dev

dev: tui ## Alias for tui

dev-all: ## Run Runtime + Portal together (use in two terminals)
	@echo "Terminal 1: make runtime"
	@echo "Terminal 2: make portal"
	@echo "Terminal 3: make portal-web (optional, for frontend dev)"

# ==================== Build ====================
##@ Build

build: ## Compile TypeScript
	npx tsc --project tsconfig.json

build-portal-web: ## Compile Portal frontend (Vite)
	cd portal-web && npm install && npm run build

# ==================== Docker ====================
##@ Docker

docker: docker-runtime docker-agentbox docker-portal ## Build all Docker images

docker-runtime: ## Build runtime image
	docker build -f Dockerfile.gateway $(DOCKER_LABELS) -t $(RUNTIME_IMAGE) .

docker-agentbox: ## Build agentbox image
	docker build -f Dockerfile.agentbox $(DOCKER_LABELS) -t $(AGENTBOX_IMAGE) .

docker-portal: ## Build portal image
	docker build -f Dockerfile.portal $(DOCKER_LABELS) -t $(PORTAL_IMAGE) .

push: push-runtime push-agentbox push-portal ## Push all images to registry

push-runtime: ## Push runtime image
	docker push $(RUNTIME_IMAGE)

push-agentbox: ## Push agentbox image
	docker push $(AGENTBOX_IMAGE)

push-portal: ## Push portal image
	docker push $(PORTAL_IMAGE)

# ==================== Test ====================
##@ Test

test: typecheck unit ## Type check + unit tests

typecheck: ## Type check (no emit)
	npx tsc --project tsconfig.json --noEmit

unit: ## Run unit tests
	npx vitest run

# ==================== Ops ====================
##@ Ops

info: ## Print build variables
	@echo "VERSION:     $(VERSION)"
	@echo "GIT_COMMIT:  $(GIT_COMMIT)$(GIT_DIRTY)"
	@echo "GIT_TAG:     $(or $(GIT_TAG),(none))"
	@echo "TAG:         $(TAG)"
	@echo "REGISTRY:    $(REGISTRY)"
	@echo "RUNTIME:     $(RUNTIME_IMAGE)"
	@echo "AGENTBOX:    $(AGENTBOX_IMAGE)"
	@echo "PORTAL:      $(PORTAL_IMAGE)"

logs: ## View recent logs (all components)
	@echo "=== Runtime ===" && \
	kubectl -n $(NAMESPACE) logs --tail=50 -l app.kubernetes.io/component=runtime 2>/dev/null; \
	echo "\n=== Portal ===" && \
	kubectl -n $(NAMESPACE) logs --tail=50 -l app.kubernetes.io/component=portal 2>/dev/null; \
	echo "\n=== AgentBox ===" && \
	for pod in $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --no-headers -o name 2>/dev/null); do \
		echo "--- $$pod ---"; \
		kubectl -n $(NAMESPACE) logs --tail=30 $$pod; \
	done

logs-runtime: ## Follow runtime logs
	kubectl -n $(NAMESPACE) logs -f -l app.kubernetes.io/component=runtime

logs-portal: ## Follow portal logs
	kubectl -n $(NAMESPACE) logs -f -l app.kubernetes.io/component=portal

logs-agentbox: ## Follow latest agentbox logs
	kubectl -n $(NAMESPACE) logs -f $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --sort-by=.metadata.creationTimestamp --no-headers -o name | tail -1)

status: ## Show K8s deployment status
	@echo "=== Pods ==="
	@kubectl -n $(NAMESPACE) get pods -o wide
	@echo "\n=== Images ==="
	@kubectl -n $(NAMESPACE) get deployment -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image' 2>/dev/null || true

# ==================== Clean ====================
##@ Clean

clean: ## Remove build artifacts
	rm -rf dist *.tsbuildinfo portal-web/dist

# ── All targets are phony (no file outputs) ──
.PHONY: help tui runtime portal portal-web dev dev-all \
	build build-portal-web \
	docker docker-runtime docker-agentbox docker-portal \
	push push-runtime push-agentbox push-portal \
	test typecheck unit \
	info logs logs-runtime logs-portal logs-agentbox status clean
