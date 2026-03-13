# Siclaw Makefile
#
# Usage:
#   make help                                    — Show all targets
#   make docker push REGISTRY=myregistry.com     — Build & push all images
#   make docker-agentbox push-agentbox           — Build & push agentbox only
#
# Deploy via Helm:
#   helm upgrade --install siclaw ./helm/siclaw -f helm/siclaw/values-local.yaml

# ── Git metadata (auto-detected) ──
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_TAG    := $(shell git describe --tags --abbrev=0 --exact-match 2>/dev/null)
GIT_DIRTY  := $(shell test -n "$$(git status --porcelain)" && echo "-dirty" || echo "")
VERSION    := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

# ── Configurable variables ──
REGISTRY  ?= siclaw
NAMESPACE ?= siclaw
TAG       ?= $(if $(GIT_TAG),$(GIT_TAG),$(VERSION)-$(GIT_COMMIT)$(GIT_DIRTY))

# ── Image names ──
GATEWAY_IMAGE  = $(REGISTRY)/siclaw-gateway:$(TAG)
AGENTBOX_IMAGE = $(REGISTRY)/siclaw-agentbox:$(TAG)

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

gateway: build-web ## Run Gateway server (multi-user, local spawner)
	npx tsx src/gateway-main.ts

dev: tui ## Alias for tui

# ==================== Build ====================
##@ Build

build: build-ts build-web ## Compile TypeScript + Web frontend

build-ts: ## Compile TypeScript
	npx tsc --project tsconfig.json

build-web: ## Compile Web frontend (Vite)
	cd src/gateway/web && npm install && npm run build

# ==================== Docker ====================
##@ Docker

docker: build ## Build all Docker images
	docker build -f Dockerfile.gateway  $(DOCKER_LABELS) -t $(GATEWAY_IMAGE)  .
	docker build -f Dockerfile.agentbox $(DOCKER_LABELS) -t $(AGENTBOX_IMAGE) .

docker-gateway: build ## Build gateway image
	docker build -f Dockerfile.gateway $(DOCKER_LABELS) -t $(GATEWAY_IMAGE) .

docker-agentbox: build-ts ## Build agentbox image
	docker build -f Dockerfile.agentbox $(DOCKER_LABELS) -t $(AGENTBOX_IMAGE) .

push: push-gateway push-agentbox ## Push all images to registry

push-gateway: ## Push gateway image
	docker push $(GATEWAY_IMAGE)

push-agentbox: ## Push agentbox image
	docker push $(AGENTBOX_IMAGE)

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
	@echo "GATEWAY:     $(GATEWAY_IMAGE)"
	@echo "AGENTBOX:    $(AGENTBOX_IMAGE)"

logs: ## View recent logs (all components)
	@echo "=== Gateway ===" && \
	kubectl -n $(NAMESPACE) logs --tail=50 -l app=siclaw-gateway 2>/dev/null; \
	echo "\n=== AgentBox ===" && \
	for pod in $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --no-headers -o name 2>/dev/null); do \
		echo "--- $$pod ---"; \
		kubectl -n $(NAMESPACE) logs --tail=30 $$pod; \
	done

logs-gateway: ## Follow gateway logs
	kubectl -n $(NAMESPACE) logs -f deployment/siclaw-gateway

logs-agentbox: ## Follow latest agentbox logs
	kubectl -n $(NAMESPACE) logs -f $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --sort-by=.metadata.creationTimestamp --no-headers -o name | tail -1)

status: ## Show K8s deployment status
	@echo "=== Pods ==="
	@kubectl -n $(NAMESPACE) get pods -o wide
	@echo "\n=== Images ==="
	@kubectl -n $(NAMESPACE) get deployment siclaw-gateway -o jsonpath='gateway:  {.spec.template.spec.containers[0].image}{"\n"}' 2>/dev/null || true

# ==================== Clean ====================
##@ Clean

clean: ## Remove build artifacts
	rm -rf dist *.tsbuildinfo src/gateway/web/dist

# ── All targets are phony (no file outputs) ──
.PHONY: help tui gateway dev build build-ts build-web \
	docker docker-gateway docker-agentbox \
	push push-gateway push-agentbox \
	test typecheck unit \
	info logs logs-gateway logs-agentbox status clean
