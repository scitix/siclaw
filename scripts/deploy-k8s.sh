#!/usr/bin/env bash
# ==============================================================================
# Siclaw Kubernetes 一键部署脚本
# ==============================================================================
#
# 用途：把 portal / runtime / agentbox 三个镜像部署到当前 kubectl context 指向的
#       集群，注入 portal 自己的 MySQL（chart 自带 demo MySQL）+ trace-store 用
#       的外部 MySQL（siclaw-trace-db），最后自动启动 port-forward 让你的 Mac
#       浏览器能直接打开前端。
#
# 前置条件：
#   1. helm（v3.x）/ kubectl / openssl 已安装，kubectl context 指向目标集群
#   2. 已有镜像清单文件（默认 scripts/images.txt，与本脚本同目录；与 cwd 无关，
#      可以在仓库任意路径下调用）。格式：每行一个镜像 ref，三个镜像必须共享同一
#      个 registry 和 tag。空行和 # 开头的行被忽略。例：
#
#         # 这是注释，会被忽略
#         registry-cn-shanghai.siflow.cn/k8s/siclaw-portal:yye-feat-xxx-6330af8
#         registry-cn-shanghai.siflow.cn/k8s/siclaw-runtime:yye-feat-xxx-6330af8
#         registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:yye-feat-xxx-6330af8
#
#      地域随便选（北京 / 上海 / 马来 / 美东 / …），脚本不写死。
#   3. 集群里已有 trace-store MySQL Service（默认 default/siclaw-trace-db:3306）
#
# 使用示例：
#   # 最简单：scripts/images.txt 已存在（与本脚本同目录）
#   ./scripts/deploy-k8s.sh
#
#   # 指定别的镜像清单（任意路径）
#   ./scripts/deploy-k8s.sh -f scripts/images-shanghai.txt
#   ./scripts/deploy-k8s.sh -f /tmp/images-malaysia.txt
#
#   # 部到自定义 namespace（默认 siclaw）
#   NAMESPACE=siclaw-test ./scripts/deploy-k8s.sh -f images.txt
#
#   # trace-db 不在 default namespace 时
#   TRACE_DB_NS=trace-system ./scripts/deploy-k8s.sh -f images.txt
#
#   # 强制重新生成 secret（已有用户登录会失效，慎用）
#   FORCE_RESEED=1 ./scripts/deploy-k8s.sh -f images.txt
#
#   # 跳过自动 port-forward（如要走 NodePort / Ingress 时用）
#   SKIP_PORTFORWARD=1 ./scripts/deploy-k8s.sh -f images.txt
#
# 关于"重新部署新镜像"：
#   - 镜像 tag 变了：helm upgrade 自动滚更新，正常生效
#   - 镜像 tag 没变（latest 之类的可变 tag，或者强制重推同名 tag）：脚本设置
#     imagePullPolicy=Always 并主动 rollout restart，确保新镜像被重新拉取
#   - 旧的 agentbox pod 会被脚本删除（agentbox 是按需拉起的，删除后下次发消息
#     才会用新镜像创建）
#
# 安全说明：
#   - 生成的 secret 存在 ~/.siclaw-deploy-secrets.env（mode 600）
#   - 脚本本身不含任何密码，可以提交到仓库
#   - images.txt 也不含密码，可以放心提交（建议每个 region 一份）
# ==============================================================================

set -euo pipefail

# ── 解析命令行参数 ──────────────────────────────────────────────────────────
# 默认镜像清单与本脚本同目录（scripts/images.txt），与 cwd 无关。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_FILE="${SCRIPT_DIR}/images.txt"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--file) IMAGES_FILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^# =====/p' "$0" | sed 's/^# \?//' | head -n 50
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── 默认配置（可被环境变量覆盖）─────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-siclaw}"
RELEASE_NAME="${RELEASE_NAME:-siclaw}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.siclaw-deploy-secrets.env}"
PORTFORWARD_PORT="${PORTFORWARD_PORT:-3003}"
PORTFORWARD_PID_FILE="${PORTFORWARD_PID_FILE:-/tmp/siclaw-portforward.pid}"

# trace-store MySQL（集群内访问，DNS 形式）
TRACE_DB_NS="${TRACE_DB_NS:-default}"
TRACE_DB_SVC="${TRACE_DB_SVC:-siclaw-trace-db}"
TRACE_DB_PORT="${TRACE_DB_PORT:-3306}"
TRACE_DB_USER="${TRACE_DB_USER:-root}"
TRACE_DB_PASS="${TRACE_DB_PASS:-siclawsiclawsiclaw}"
TRACE_DB_NAME="${TRACE_DB_NAME:-siclaw_traces}"
TRACE_MYSQL_URL="mysql://${TRACE_DB_USER}:${TRACE_DB_PASS}@${TRACE_DB_SVC}.${TRACE_DB_NS}.svc.cluster.local:${TRACE_DB_PORT}/${TRACE_DB_NAME}"

# Chart 路径（脚本可以从仓库任意位置调用，SCRIPT_DIR 上面已经设置）
CHART_DIR="${SCRIPT_DIR}/../helm/siclaw"

# ── 工具检查 ────────────────────────────────────────────────────────────────
command -v helm >/dev/null    || { echo "ERROR: helm not found in PATH"; exit 1; }
command -v kubectl >/dev/null || { echo "ERROR: kubectl not found in PATH"; exit 1; }
command -v openssl >/dev/null || { echo "ERROR: openssl not found in PATH"; exit 1; }
[[ -d "$CHART_DIR" ]]         || { echo "ERROR: chart dir not found: $CHART_DIR"; exit 1; }
[[ -f "$IMAGES_FILE" ]]       || { echo "ERROR: images file not found: $IMAGES_FILE"; exit 1; }

# ── 解析镜像清单 ────────────────────────────────────────────────────────────
# 每行一个 image ref，跳过空行和 # 开头注释。三个镜像必须共享同一 registry+tag。
declare -A SEEN_COMPONENTS=()
IMAGE_REGISTRY=""
IMAGE_TAG=""

while IFS= read -r line; do
  line="${line%%#*}"                            # 去掉行内注释
  line="$(echo "$line" | xargs)"                # trim
  [[ -z "$line" ]] && continue

  # 期望格式：<host>/<path>/siclaw-<component>:<tag>
  if [[ "$line" =~ ^(.+)/(siclaw-(portal|runtime|agentbox)):(.+)$ ]]; then
    reg="${BASH_REMATCH[1]}"
    component="${BASH_REMATCH[3]}"
    tag="${BASH_REMATCH[4]}"
  else
    echo "ERROR: malformed line in $IMAGES_FILE:"
    echo "  $line"
    echo "Expected: <registry>/siclaw-{portal|runtime|agentbox}:<tag>"
    exit 1
  fi

  if [[ -z "$IMAGE_REGISTRY" ]]; then
    IMAGE_REGISTRY="$reg"
    IMAGE_TAG="$tag"
  else
    [[ "$reg" == "$IMAGE_REGISTRY" ]] || { echo "ERROR: registry mismatch — $reg vs $IMAGE_REGISTRY"; exit 1; }
    [[ "$tag" == "$IMAGE_TAG" ]]      || { echo "ERROR: tag mismatch — $tag vs $IMAGE_TAG"; exit 1; }
  fi
  SEEN_COMPONENTS[$component]=1
done < "$IMAGES_FILE"

for c in portal runtime agentbox; do
  [[ -n "${SEEN_COMPONENTS[$c]:-}" ]] || { echo "ERROR: missing siclaw-$c in $IMAGES_FILE"; exit 1; }
done

# ── 打印部署上下文 ──────────────────────────────────────────────────────────
echo "============================================================"
echo "Images file : $IMAGES_FILE"
echo "Registry    : $IMAGE_REGISTRY"
echo "Tag         : $IMAGE_TAG"
echo "Namespace   : $NAMESPACE"
echo "Release     : $RELEASE_NAME"
echo "Trace MySQL : ${TRACE_DB_SVC}.${TRACE_DB_NS}.svc:${TRACE_DB_PORT}/${TRACE_DB_NAME}"
echo "kubectl ctx : $(kubectl config current-context)"
echo "============================================================"

# ── 加载或生成 secret ───────────────────────────────────────────────────────
if [[ "${FORCE_RESEED:-0}" == "1" ]] || [[ ! -f "$SECRETS_FILE" ]]; then
  if [[ -f "$SECRETS_FILE" ]]; then
    cp "$SECRETS_FILE" "${SECRETS_FILE}.bak-$(date +%s)"
    echo "Backed up old secrets to ${SECRETS_FILE}.bak-*"
  fi
  echo "Generating new secrets → $SECRETS_FILE"
  cat > "$SECRETS_FILE" <<EOF
JWT=$(openssl rand -hex 32)
RT=$(openssl rand -hex 32)
PT=$(openssl rand -hex 32)
DB_PASS=$(openssl rand -hex 16)
EOF
  chmod 600 "$SECRETS_FILE"
else
  echo "Reusing secrets from $SECRETS_FILE"
fi
# shellcheck disable=SC1090
source "$SECRETS_FILE"

# ── 确保 namespace 存在 ─────────────────────────────────────────────────────
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl create namespace "$NAMESPACE"

# ── helm upgrade --install ─────────────────────────────────────────────────
# imagePullPolicy=Always 是关键：即使 tag 没变也强制重新拉镜像。
helm upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
  -n "$NAMESPACE" \
  -f "${CHART_DIR}/values-standalone.yaml" \
  --set image.registry="$IMAGE_REGISTRY" \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Always \
  --set mysql.enabled=true \
  --set mysql.password="$DB_PASS" \
  --set database.url="mysql://siclaw:$DB_PASS@siclaw-mysql:3306/siclaw" \
  --set runtime.jwtSecret="$JWT"     --set portal.jwtSecret="$JWT" \
  --set runtime.runtimeSecret="$RT"  --set portal.runtimeSecret="$RT" \
  --set runtime.portalSecret="$PT"   --set portal.portalSecret="$PT" \
  --set runtime.env.SICLAW_TRACE_MYSQL_ENABLED=1 \
  --set runtime.env.SICLAW_TRACE_SQLITE_ENABLED=0 \
  --set runtime.env.SICLAW_TRACE_MYSQL_URL="$TRACE_MYSQL_URL"

# ── 保证镜像被重新拉取 ──────────────────────────────────────────────────────
# 即使 helm 计算出的 spec 没变（tag 相同的情况），rollout restart 也会让 K8s
# 用 imagePullPolicy=Always 重新拉镜像，从而加载最新构建。
echo "Forcing pod restart to ensure latest images are pulled..."
kubectl rollout restart -n "$NAMESPACE" deploy/siclaw-portal  >/dev/null
kubectl rollout restart -n "$NAMESPACE" deploy/siclaw-runtime >/dev/null

# 旧的 agentbox pod 是按需拉起的、状态可能是 Completed。直接删掉，下次发消息
# 时 Runtime 会用新镜像 spawn 一个新的。
kubectl delete pod -n "$NAMESPACE" \
  -l 'siclaw.dev/app=agentbox' --ignore-not-found >/dev/null 2>&1 || true

# ── 等 mysql 起来 + 绕过 migrate.ts 的外键创建顺序 bug ──────────────────────
# Portal 的 migrate.ts 里 agent_skills 在 skills 之前 CREATE，MySQL 严格模式
# 第一次跑会失败（SQLite 默认放行所以本地 OK）。在 demo MySQL 上 SET GLOBAL
# FOREIGN_KEY_CHECKS=0 让它跑过；后续部署 IF NOT EXISTS 已生效，FK 关不关都行。
echo "Waiting for siclaw-mysql to become ready..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/component=mysql \
  -n "$NAMESPACE" --timeout=180s || true

echo "Disabling MySQL FOREIGN_KEY_CHECKS (works around migrate.ts ordering bug)..."
kubectl exec -n "$NAMESPACE" deploy/siclaw-mysql -- \
  mysql -uroot -p"$DB_PASS" -e "SET GLOBAL FOREIGN_KEY_CHECKS=0;" 2>/dev/null \
  || echo "  (skipped — mysql not accepting connections yet, portal will retry)"

# 再 restart 一次 portal 让它在 FK 关掉后重跑 migration
kubectl rollout restart -n "$NAMESPACE" deploy/siclaw-portal >/dev/null

# ── 等 portal / runtime rollout 完成 ────────────────────────────────────────
echo "Waiting for portal / runtime rollouts to complete..."
kubectl rollout status -n "$NAMESPACE" deploy/siclaw-portal  --timeout=180s || true
kubectl rollout status -n "$NAMESPACE" deploy/siclaw-runtime --timeout=180s || true

# ── 自动启动 port-forward（让 Mac 浏览器能直接访问）─────────────────────────
if [[ "${SKIP_PORTFORWARD:-0}" != "1" ]]; then
  # 杀掉旧的 port-forward（如果还活着）
  if [[ -f "$PORTFORWARD_PID_FILE" ]]; then
    OLD_PID="$(cat "$PORTFORWARD_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      echo "Killed old port-forward (pid $OLD_PID)"
    fi
    rm -f "$PORTFORWARD_PID_FILE"
  fi

  # 等到 svc 的 endpoints 里只剩活的 pod，避免 port-forward 抓到 Terminating 的旧实例
  echo "Waiting for portal endpoints to stabilize..."
  for i in $(seq 1 30); do
    bad="$(kubectl get pods -n "$NAMESPACE" \
            -l app.kubernetes.io/component=portal \
            --no-headers 2>/dev/null | awk '$3!="Running"' | wc -l)"
    [[ "$bad" == "0" ]] && break
    sleep 2
  done

  echo "Starting port-forward (svc/siclaw-portal:3003 → 0.0.0.0:${PORTFORWARD_PORT})..."
  nohup kubectl port-forward -n "$NAMESPACE" --address 0.0.0.0 \
    svc/siclaw-portal "${PORTFORWARD_PORT}:3003" \
    > /tmp/siclaw-portforward.log 2>&1 &
  echo $! > "$PORTFORWARD_PID_FILE"

  # 验证 port-forward 真的通了；不通则提示用户但不让脚本退出非零
  for i in $(seq 1 10); do
    sleep 1
    if curl -fsSI -m 1 "http://localhost:${PORTFORWARD_PORT}" >/dev/null 2>&1; then
      break
    fi
  done

  # 抓一下开发机的 IP（多网卡时取第一个非回环）
  DEV_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$DEV_IP" ]] && DEV_IP="<DEV-MACHINE-IP>"
fi

# ── 收尾输出 ────────────────────────────────────────────────────────────────
echo
echo "============================================================"
echo "Deploy complete."
kubectl get pods -n "$NAMESPACE"
echo "============================================================"

if [[ "${SKIP_PORTFORWARD:-0}" != "1" ]]; then
  cat <<EOF

✅ Portal is live. From your Mac:

  1) If your Mac is on the same internal network as $DEV_IP, just open:
       http://${DEV_IP}:${PORTFORWARD_PORT}

  2) Otherwise, start an SSH tunnel from your Mac:
       ssh -L ${PORTFORWARD_PORT}:localhost:${PORTFORWARD_PORT} yye@${DEV_IP}
     then open:
       http://localhost:${PORTFORWARD_PORT}

First-time login? Register the admin account first (run on this dev box):
  curl -X POST http://localhost:${PORTFORWARD_PORT}/api/v1/auth/register \\
    -H 'Content-Type: application/json' \\
    -d '{"username":"admin","password":"admin"}'

Verify trace MySQL is wired (after sending one chat message):
  kubectl run -n $NAMESPACE mysql-query --rm -it --restart=Never --image=mysql:8.0 -- \\
    mysql -h${TRACE_DB_SVC}.${TRACE_DB_NS}.svc.cluster.local -u${TRACE_DB_USER} -p${TRACE_DB_PASS} ${TRACE_DB_NAME} \\
    -e 'SELECT id, session_id, LEFT(user_message, 60), created_at FROM agent_traces ORDER BY id DESC LIMIT 5;'

Stop port-forward:
  kill \$(cat $PORTFORWARD_PID_FILE)
EOF
fi
