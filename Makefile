# Siclaw Makefile
#
# Local development:
#   make tui             — Run TUI (interactive terminal agent)
#   make gateway         — Run Gateway (multi-user web server)
#
# Build & deploy:
#   make build           — Compile TypeScript + Web frontend
#   make deploy          — Full pipeline: build → docker → push → restart
#   make deploy-gateway  — Build + deploy gateway only
#   make deploy-agentbox — Build + deploy agentbox only
#
# Other:
#   make test            — Type check + unit tests
#   make logs            — View all component logs
#   make status          — Show K8s deployment status
#   make help            — Show all targets

REGISTRY ?= registry-cn-shanghai.siflow.cn/k8s/siclaw
NAMESPACE ?= siclaw
TAG       ?= latest

GATEWAY_IMAGE  = $(REGISTRY)/siclaw-gateway:$(TAG)
AGENTBOX_IMAGE = $(REGISTRY)/siclaw-agentbox:$(TAG)
CRON_IMAGE     = $(REGISTRY)/siclaw-cron:$(TAG)

# ==================== Dev ====================

.PHONY: tui gateway dev

## Run TUI agent (interactive terminal, single user)
tui:
	npx tsx src/cli-main.ts

## Run Gateway server (multi-user, local AgentBox spawner)
gateway: build-web
	npx tsx src/gateway-main.ts

## Alias: make dev = make tui
dev: tui

# ==================== Build ====================

.PHONY: build build-ts build-web

## Compile TypeScript + Web frontend
build: build-ts build-web

## Compile TypeScript only
build-ts:
	npx tsc --project tsconfig.json

## Compile Web frontend (Vite)
build-web:
	cd src/gateway/web && npm install && npm run build

# ==================== Docker ====================

.PHONY: build-docker build-docker-gateway build-docker-agentbox build-docker-cron

## Build all Docker images
build-docker: build
	docker build -f Dockerfile.gateway  -t $(GATEWAY_IMAGE)  .
	docker build -f Dockerfile.agentbox -t $(AGENTBOX_IMAGE) .
	docker build -f Dockerfile.cron     -t $(CRON_IMAGE)     .

## Build gateway image (requires TS + Web)
build-docker-gateway: build
	docker build -f Dockerfile.gateway -t $(GATEWAY_IMAGE) .

## Build agentbox image (requires TS only)
build-docker-agentbox: build-ts
	docker build -f Dockerfile.agentbox -t $(AGENTBOX_IMAGE) .

## Build cron image (requires TS only)
build-docker-cron: build-ts
	docker build -f Dockerfile.cron -t $(CRON_IMAGE) .

# ==================== Push ====================

.PHONY: push push-gateway push-agentbox push-cron

push: push-gateway push-agentbox push-cron
push-gateway:
	docker push $(GATEWAY_IMAGE)
push-agentbox:
	docker push $(AGENTBOX_IMAGE)
push-cron:
	docker push $(CRON_IMAGE)

# ==================== Deploy ====================

.PHONY: deploy deploy-gateway deploy-agentbox deploy-cron restart

## Full pipeline: build → docker → push → restart all
deploy: build-docker push restart

## Deploy gateway only
deploy-gateway: build-docker-gateway push-gateway
	kubectl -n $(NAMESPACE) rollout restart deployment siclaw-gateway
	kubectl -n $(NAMESPACE) rollout status deployment siclaw-gateway --timeout=120s

## Deploy agentbox only (deletes old pods; new ones created on next request)
deploy-agentbox: build-docker-agentbox push-agentbox
	kubectl -n $(NAMESPACE) delete pods -l siclaw.io/app=agentbox --ignore-not-found
	@echo "Old agentbox pods deleted. New pods will be created on next chat.send."

## Deploy cron worker only
deploy-cron: build-docker-cron push-cron
	kubectl -n $(NAMESPACE) rollout restart deployment siclaw-cron
	kubectl -n $(NAMESPACE) rollout status deployment siclaw-cron --timeout=120s

## Restart all components (no rebuild)
restart:
	@echo "--- Restarting gateway ---"
	kubectl -n $(NAMESPACE) rollout restart deployment siclaw-gateway
	@echo "--- Restarting cron ---"
	kubectl -n $(NAMESPACE) rollout restart deployment siclaw-cron
	@echo "--- Cleaning up agentbox pods ---"
	kubectl -n $(NAMESPACE) delete pods -l siclaw.io/app=agentbox --ignore-not-found
	@echo "--- Waiting for rollouts ---"
	kubectl -n $(NAMESPACE) rollout status deployment siclaw-gateway --timeout=120s
	kubectl -n $(NAMESPACE) rollout status deployment siclaw-cron --timeout=120s
	@echo "--- Done ---"

# ==================== Test ====================

.PHONY: test typecheck unit

## Type check + unit tests
test: typecheck unit

## Type check only (no emit)
typecheck:
	npx tsc --project tsconfig.json --noEmit

## Run all unit tests
unit:
	npx vitest run

# ==================== Logs ====================

.PHONY: logs logs-gateway logs-agentbox logs-cron

## View recent logs from all components
logs:
	@echo "=== Gateway ===" && \
	kubectl -n $(NAMESPACE) logs --tail=50 -l app=siclaw-gateway && \
	echo "" && \
	echo "=== Cron ===" && \
	kubectl -n $(NAMESPACE) logs --tail=30 -l app=siclaw-cron && \
	echo "" && \
	echo "=== AgentBox ===" && \
	for pod in $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --no-headers -o name 2>/dev/null); do \
		echo "--- $$pod ---"; \
		kubectl -n $(NAMESPACE) logs --tail=30 $$pod; \
	done

## Follow gateway logs
logs-gateway:
	kubectl -n $(NAMESPACE) logs -f deployment/siclaw-gateway

## Follow latest agentbox logs
logs-agentbox:
	kubectl -n $(NAMESPACE) logs -f $$(kubectl -n $(NAMESPACE) get pods -l siclaw.io/app=agentbox --sort-by=.metadata.creationTimestamp --no-headers -o name | tail -1)

## Follow cron logs
logs-cron:
	kubectl -n $(NAMESPACE) logs -f deployment/siclaw-cron

# ==================== Status ====================

.PHONY: status

## Show K8s deployment status
status:
	@echo "=== Pods ==="
	@kubectl -n $(NAMESPACE) get pods -o wide
	@echo ""
	@echo "=== Gateway Image ==="
	@kubectl -n $(NAMESPACE) get deployment siclaw-gateway -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
	@echo "=== AgentBox Image (from env) ==="
	@kubectl -n $(NAMESPACE) get deployment siclaw-gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AGENTBOX_IMAGE")].value}{"\n"}'
	@echo "=== Cron Image ==="
	@kubectl -n $(NAMESPACE) get deployment siclaw-cron -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}' 2>/dev/null || echo "(not deployed)"

# ==================== Clean ====================

.PHONY: clean clean-pods

## Remove build artifacts (dist/, tsbuildinfo, web build)
clean:
	rm -rf dist *.tsbuildinfo src/gateway/web/dist

## Delete all agentbox pods (K8s)
clean-pods:
	kubectl -n $(NAMESPACE) delete pods -l siclaw.io/app=agentbox --ignore-not-found

# ==================== Help ====================

.PHONY: help

## Show all targets
help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Dev:"
	@echo "  tui              Run TUI agent (interactive terminal)"
	@echo "  gateway          Run Gateway server (multi-user)"
	@echo "  dev              Alias for tui"
	@echo ""
	@echo "Build:"
	@echo "  build            Compile TypeScript + Web frontend"
	@echo "  build-ts         Compile TypeScript only"
	@echo "  build-web        Compile Web frontend only"
	@echo "  build-docker     Build all Docker images"
	@echo ""
	@echo "Deploy (K8s):"
	@echo "  deploy           Full: build + docker + push + restart"
	@echo "  deploy-gateway   Deploy gateway only"
	@echo "  deploy-agentbox  Deploy agentbox only"
	@echo "  deploy-cron      Deploy cron only"
	@echo "  restart          Restart all (no rebuild)"
	@echo ""
	@echo "Test:"
	@echo "  test             Type check + unit tests"
	@echo "  typecheck        Type check only"
	@echo "  unit             Run unit tests"
	@echo ""
	@echo "Ops:"
	@echo "  logs             View recent logs (all)"
	@echo "  logs-gateway     Follow gateway logs"
	@echo "  logs-agentbox    Follow agentbox logs"
	@echo "  logs-cron        Follow cron logs"
	@echo "  status           Show K8s deployment status"
	@echo "  clean            Remove build artifacts"
	@echo "  clean-pods       Delete all agentbox pods (K8s)"
