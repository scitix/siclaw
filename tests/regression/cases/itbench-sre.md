# Siclaw 回归测试 Case 集 — ITBench SRE 场景

> 本文件从 [ITBench](https://github.com/it-bench/itbench-scenarios)（IBM Research, ICML 2025）SRE 场景集提取并适配为 Siclaw 回归测试格式。
>
> **原始场景映射**：scenario-20 → itb-badimage-001，scenario-16 → itb-badenvvar-002，scenario-3 → itb-highcpu-flag-003，scenario-23 → itb-badarch-004。
>
> - **可复现场景**（`reproducible: true`）：用 kubectl 可表达的注入方式，在 `deveval-{runId}` 独立命名空间中运行，与原始 OpenTelemetry Demo 应用无关。
> - **知识问答场景**（`reproducible: false`）：依赖 otel-demo 专属应用栈，无法在通用集群中安全注入，改为提供预录集群状态（`### 集群现状`）供 agent 推理。

---

## Case: itb-badimage-001

```yaml
id: itb-badimage-001
title: 镜像 tag 不存在导致 Pod ImagePullBackOff（ITBench scenario-20）
reproducible: true
faultType: ImagePullBackOff
namespace: deveval-{runId}
podShortName: itb-badimage
tags: [image, pod, itbench, p1]
passThreshold:
  commands: 3
  conclusion: 4
```

### 工单描述

- **green**: Pod `{podName}` 在 namespace `deveval-{runId}` 中一直无法进入 `Running` 状态,`kubectl get pod` 显示 `0/1 Ready`,状态列反复在 `ErrImagePull` / `ImagePullBackOff` 之间切换,请定位故障原因并给出修复建议。
- **yellow**: 商品目录服务（容器名 `product-catalog`）上线后一直起不来,运维反馈镜像好像有点问题,请排查。

### 注入 YAML

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: {podName}
  namespace: deveval-{runId}
  labels:
    deveval/case: itb-badimage-001
    app: product-catalog
spec:
  restartPolicy: Never
  containers:
  - name: product-catalog
    image: ghcr.io/open-telemetry/demo/product-catalog:nonexistent-itbench-abc123
    resources:
      requests:
        memory: "64Mi"
        cpu: "100m"
      limits:
        memory: "128Mi"
        cpu: "200m"
```

### 题解 kubectl

```bash
kubectl get pod {podName} -n deveval-{runId}
kubectl describe pod {podName} -n deveval-{runId}
kubectl get pod {podName} -n deveval-{runId} -o jsonpath='{.spec.containers[0].image}'
kubectl get events -n deveval-{runId} --field-selector involvedObject.name={podName} --sort-by=.lastTimestamp
```

### 期望结论

**根因**: Pod `{podName}` 的容器 `product-catalog` 配置了不存在的镜像 `ghcr.io/open-telemetry/demo/product-catalog:nonexistent-itbench-abc123`。kubelet 在拉取镜像时从仓库收到 `manifest unknown` 或 `not found` 响应,Pod 进入 `ErrImagePull` 状态,经过退避后固定为 `ImagePullBackOff`,容器永远无法启动。`restartPolicy: Never` 使 Pod 不会重启,维持在该错误状态。

**修复建议**:
1. **立即恢复**：修正镜像 tag，将 `nonexistent-itbench-abc123` 替换为仓库中实际存在的版本（如 `v1.11.0`），然后重新创建 Pod；如果是 Deployment，使用 `kubectl rollout undo deployment/<name> -n <ns>` 回滚到上一可用版本；
2. **根本预防**：在 CI/CD 流水线中加入镜像 tag 存在性校验（如 `docker manifest inspect`），镜像不存在时阻断部署，避免带错误 tag 的版本发布到集群。

---

## Case: itb-badenvvar-002

```yaml
id: itb-badenvvar-002
title: Deployment 环境变量配置错误导致服务 CrashLoopBackOff（ITBench scenario-16）
reproducible: false
faultType: BadEnvVar
namespace: otel-demo
podShortName: ignored
tags: [env, deployment, otel-demo, itbench, p1]
passThreshold:
  commands: 0
  conclusion: 4
```

### 工单描述

- **green**: `otel-demo` namespace 中 `shipping` 服务持续 `CrashLoopBackOff`,`RESTARTS` 计数在快速增长,`kubectl logs` 里有 `invalid port` 相关报错,请定位根因并给出修复方案。
- **yellow**: 电商平台运费计算功能异常,SRE 反馈 `shipping` 组件不断重启,业务方反馈下单时无法计算运费,请排查。

### 集群现状

```
$ kubectl get pods -n otel-demo | grep shipping
shipping-6c9f7b4d5-pqrst    0/1     CrashLoopBackOff   7 (2m ago)   15m

$ kubectl logs shipping-6c9f7b4d5-pqrst -n otel-demo
2026-04-16T03:11:22.431Z info  Starting shipping service...
2026-04-16T03:11:22.432Z info  Connecting to quote service at quote:0000
2026-04-16T03:11:22.433Z fatal Error dialing quote service: dial tcp: address 0000: invalid port
goroutine 1 [running]:
main.mustConnectService(...)
        /app/main.go:89 +0x1f8
exit status 2

$ kubectl describe pod shipping-6c9f7b4d5-pqrst -n otel-demo
Name:         shipping-6c9f7b4d5-pqrst
Namespace:    otel-demo
Status:       Running
Node:         node-b/10.0.0.102
Containers:
  shipping:
    Image:    ghcr.io/open-telemetry/demo/shipping:v1.11.0
    Environment:
      QUOTE_ADDR:                          quote:0000
      PORT:                                8080
      SHIPPING_CURRENCY_SERVICE_ADDR:      currency:7777
      OTEL_EXPORTER_OTLP_ENDPOINT:        http://otel-collector:4317
Events:
  Type     Reason     Age                   From               Message
  ----     ------     ----                  ----               -------
  Normal   Pulled     8m (x8 over 15m)     kubelet            Successfully pulled image "ghcr.io/open-telemetry/demo/shipping:v1.11.0"
  Normal   Created    8m (x8 over 15m)     kubelet            Created container shipping
  Normal   Started    8m (x8 over 15m)     kubelet            Started container shipping
  Warning  BackOff    90s (x12 over 13m)   kubelet            Back-off restarting failed container shipping in pod shipping-6c9f7b4d5-pqrst

$ kubectl get deployment shipping -n otel-demo -o jsonpath='{.spec.template.spec.containers[0].env}' | python3 -c "import sys,json; [print(e) for e in json.load(sys.stdin) if e['name']=='QUOTE_ADDR']"
{'name': 'QUOTE_ADDR', 'value': 'quote:0000'}

$ kubectl rollout history deployment/shipping -n otel-demo
deployment.apps/shipping
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

### 题解 kubectl

```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=shipping
kubectl logs shipping-6c9f7b4d5-pqrst -n otel-demo
kubectl describe pod shipping-6c9f7b4d5-pqrst -n otel-demo
kubectl get deployment shipping -n otel-demo -o jsonpath='{.spec.template.spec.containers[0].env}'
kubectl rollout history deployment/shipping -n otel-demo
```

### 期望结论

**根因**: `shipping` Deployment 的容器环境变量 `QUOTE_ADDR` 被错误地设置为 `quote:0000`——端口 `0000` 不是合法的 TCP 端口（合法范围 1–65535）。shipping 服务在启动时立即尝试连接 quote 服务，Go 标准库的 `net.Dial` 在解析地址时检测到端口无效直接返回 `invalid port` 错误，进程以非零 exit code 退出，kubelet 反复重启，进入 `CrashLoopBackOff`。

**修复建议**:
1. **立即恢复**：回滚到上一个正常 revision：`kubectl rollout undo deployment/shipping -n otel-demo`；
2. **定点修复**：直接更新环境变量为正确值：`kubectl set env deployment/shipping -n otel-demo QUOTE_ADDR=quote:8080`；
3. **根本预防**：在部署流水线或 Admission Webhook 中校验 `QUOTE_ADDR` 等关键服务地址格式（`host:port`，端口范围 1–65535），防止错误配置进入集群。

### 评分规则

本 case 要求 agent 精确定位到具体环境变量的错误值，仅描述症状不得分。

**conclusion 维度评分（覆盖默认标准）**:
- **5 分**：agent 指出 `QUOTE_ADDR=quote:0000` 中端口 `0000` 为无效端口，解释合法端口范围，并给出具体修复命令（rollback 或 kubectl set env 均可）
- **4 分**：agent 识别出 `QUOTE_ADDR` 的值 `quote:0000` 存在问题并定位到该环境变量，修复方向正确，但未解释端口无效的原因
- **3 分**：agent 从日志中识别出连接失败 / `invalid port` 错误，但没有追溯到是 `QUOTE_ADDR` 这个具体环境变量配置错误
- **2 分**：agent 只描述了表面症状（CrashLoopBackOff、服务崩溃），未定位到根因
- **1 分**：结论方向错误（如归因到镜像问题、网络策略、权限不足）

commands 维度沿用默认 1-5 评分（passThreshold.commands=0，不影响 PASS/FAIL 判定）。

---

## Case: itb-highcpu-flag-003

```yaml
id: itb-highcpu-flag-003
title: feature flag 开启触发 ad 服务 CPU 打满（ITBench scenario-3）
reproducible: false
faultType: FeatureFlagCPU
namespace: otel-demo
podShortName: ignored
tags: [cpu, configmap, feature-flag, otel-demo, itbench, p1]
passThreshold:
  commands: 0
  conclusion: 4
```

### 工单描述

- **green**: `otel-demo` namespace 中 `ad` 服务 CPU 使用率长时间维持在 95%+ 接近 limit，HPA 目标副本数已超过当前副本，但扩容迟迟未生效，业务侧反馈广告加载超时，请定位根因。
- **yellow**: 今天凌晨发布后广告服务变慢了，监控里 CPU 告警不停，HPA 好像没起作用，帮忙看看。

### 集群现状

```
$ kubectl top pods -n otel-demo --sort-by=cpu | head -10
NAME                              CPU(cores)   MEMORY(bytes)
ad-7c8f9d4b6-aaaaa               960m         145Mi
frontend-6f8b5c9d7-bbbbb         120m          98Mi
cart-7d9c8f4b5-ccccc              85m          64Mi
checkout-5c8f9d4b6-ddddd          72m          88Mi
currency-6b8f5d4c9-eeeee          45m          52Mi

$ kubectl describe pod ad-7c8f9d4b6-aaaaa -n otel-demo | grep -A6 "Resources:"
    Resources:
      Limits:
        cpu:     1000m
        memory:  300Mi
      Requests:
        cpu:     200m
        memory:  180Mi

$ kubectl get hpa -n otel-demo
NAME       REFERENCE             TARGETS     MINPODS   MAXPODS   REPLICAS   AGE
ad         Deployment/ad         96%/80%     1         5         1          180d
frontend   Deployment/frontend   12%/80%     1         3         1          180d

$ kubectl describe hpa ad -n otel-demo
...
Conditions:
  Type            Status  Reason               Message
  ----            ------  ------               -------
  AbleToScale     True    ReadyForNewScale     recommended size matches current size
  ScalingActive   True    ValidMetricFound     the HPA was able to successfully calculate a replica count from cpu resource utilization
  ScalingLimited  True    TooManyReplicas      the desired replica count is more than the maximum replica count
Events:
  Type     Reason             Age    From                       Message
  ----     ------             ----   ----                       -------
  Warning  FailedGetScale     10m    horizontal-pod-autoscaler  failed to get scale for resource Deployment/ad

$ kubectl get cm flagd-config -n otel-demo -o yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flagd-config
  namespace: otel-demo
data:
  feature_flags.json: |
    {
      "flags": {
        "adHighCpu": {
          "state": "ENABLED",
          "defaultVariant": "on",
          "variants": { "on": true, "off": false }
        },
        "loadGeneratorFloodHomepage": {
          "state": "DISABLED",
          "defaultVariant": "off",
          "variants": { "on": true, "off": false }
        },
        "cartServiceFailure": {
          "state": "DISABLED",
          "defaultVariant": "off",
          "variants": { "on": true, "off": false }
        }
      }
    }

$ kubectl get deployment ad -n otel-demo
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
ad     1/1     1            1           180d

$ kubectl rollout history deployment/ad -n otel-demo
deployment.apps/ad
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
3         <none>
```

### 题解 kubectl

```bash
kubectl top pods -n otel-demo --sort-by=cpu
kubectl get hpa -n otel-demo
kubectl describe hpa ad -n otel-demo
kubectl get cm flagd-config -n otel-demo -o yaml
kubectl describe deployment ad -n otel-demo
```

### 期望结论

**根因**: `flagd-config` ConfigMap 中 `adHighCpu` feature flag 被设置为 `ENABLED/on`，触发 ad 服务内置的 CPU 压测逻辑，导致 CPU 持续打到 960m（接近 limit 1000m），触发 CPU throttle。HPA 虽然检测到 CPU 占用率 96% 超过目标 80% 并计算出需要扩容，但由于 `FailedGetScale` 错误（scales 被限制）和 HPA 配置问题，扩容并未实际发生，故障持续存在。

**修复建议**:
1. **立即恢复**：编辑 ConfigMap 关闭 feature flag：`kubectl edit cm flagd-config -n otel-demo`，将 `adHighCpu.state` 改为 `DISABLED`，`defaultVariant` 改为 `off`；
2. **触发生效**：重启 flagd 和 ad Deployment 让配置变更立即生效：`kubectl rollout restart deployment/flagd deployment/ad -n otel-demo`；
3. **HPA 问题排查**：同步检查 `FailedGetScale` 的原因，确认 HPA controller 的 RBAC 权限和 metrics-server 状态是否正常；
4. **流程改进**：通过 GitOps 管理 flagd-config，所有 feature flag 变更走 PR 审批，避免在生产环境手动开启高风险 flag。

---

## Case: itb-badarch-004

```yaml
id: itb-badarch-004
title: checkout 部署了错误 CPU 架构镜像导致 exec format error（ITBench scenario-23）
reproducible: false
faultType: WrongArchImage
namespace: otel-demo
podShortName: ignored
tags: [image, arch, pod, otel-demo, itbench, p1]
passThreshold:
  commands: 0
  conclusion: 4
```

### 工单描述

- **green**: `otel-demo` namespace 中 `checkout` 服务持续 `CrashLoopBackOff`，镜像拉取成功但容器一启动就退出，`kubectl logs` 只有一行 `exec format error`，请定位根因。
- **yellow**: 结账功能完全不可用，容器一直在重启，镜像应该没错，但就是跑不起来，请排查。

### 集群现状

```
$ kubectl get pods -n otel-demo -l app.kubernetes.io/component=checkout
NAME                          READY   STATUS             RESTARTS        AGE
checkout-5d9c8f7b4-vwxyz      0/1     CrashLoopBackOff   12 (90s ago)   20m

$ kubectl logs checkout-5d9c8f7b4-vwxyz -n otel-demo
exec /app/checkout: exec format error

$ kubectl describe pod checkout-5d9c8f7b4-vwxyz -n otel-demo
Name:         checkout-5d9c8f7b4-vwxyz
Namespace:    otel-demo
Node:         node-b/10.0.0.102
Status:       Running
Containers:
  checkout:
    Image:      ghcr.io/open-telemetry/demo/checkout:v1.11.0-arm64
    Image ID:   ghcr.io/open-telemetry/demo/checkout@sha256:9a3f...
    Port:       <none>
    Host Port:  <none>
    State:      Waiting
      Reason:   CrashLoopBackOff
    Last State: Terminated
      Reason:   Error
      Exit Code: 1
Events:
  Type     Reason     Age                  From               Message
  ----     ------     ----                 ----               -------
  Normal   Pulled     19m (x13 over 20m)  kubelet            Successfully pulled image "ghcr.io/open-telemetry/demo/checkout:v1.11.0-arm64" in 1.2s
  Normal   Created    19m (x13 over 20m)  kubelet            Created container checkout
  Warning  Failed     19m (x13 over 20m)  kubelet            Error: failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec user process caused: exec format error
  Warning  BackOff    4m (x55 over 19m)   kubelet            Back-off restarting failed container checkout

$ kubectl get node node-b -o jsonpath='{.status.nodeInfo.architecture}'
amd64

$ kubectl get node node-b -o jsonpath='{.status.nodeInfo.operatingSystem}'
linux

$ kubectl get deployment checkout -n otel-demo -o jsonpath='{.spec.template.spec.containers[0].image}'
ghcr.io/open-telemetry/demo/checkout:v1.11.0-arm64

$ kubectl rollout history deployment/checkout -n otel-demo
deployment.apps/checkout
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

### 题解 kubectl

```bash
kubectl get pods -n otel-demo -l app.kubernetes.io/component=checkout
kubectl logs checkout-5d9c8f7b4-vwxyz -n otel-demo
kubectl describe pod checkout-5d9c8f7b4-vwxyz -n otel-demo
kubectl get deployment checkout -n otel-demo -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl get node node-b -o jsonpath='{.status.nodeInfo.architecture}'
kubectl rollout history deployment/checkout -n otel-demo
```

### 期望结论

**根因（架构不匹配）**: `checkout` Deployment 在近期变更中被更新为 arm64 专属镜像 `ghcr.io/open-telemetry/demo/checkout:v1.11.0-arm64`，但调度到的节点 `node-b` CPU 架构为 `amd64`（x86-64）。Linux 内核无法执行为另一 CPU 指令集编译的 ELF 可执行文件，在容器初始化阶段直接返回 `exec format error`（ENOEXEC）。镜像拉取成功（SHA256 正确）、容器创建成功，但 containerd/runc 在 exec 阶段失败，exit code 1，kubelet 反复重启进入 `CrashLoopBackOff`。

**修复建议**:
1. **立即恢复**：回滚到上一个正常 revision：`kubectl rollout undo deployment/checkout -n otel-demo`；
2. **或直接修复镜像**：`kubectl set image deployment/checkout checkout=ghcr.io/open-telemetry/demo/checkout:v1.11.0 -n otel-demo`（不带架构后缀，使用 multi-arch manifest）；
3. **根本改进**：构建流水线应发布 multi-arch manifest（`docker buildx build --platform linux/amd64,linux/arm64`），而非 `-arm64`/`-amd64` 单架构 tag，让 Kubernetes 运行时自动选择正确架构；节点维护时若需更换架构，应使用 `nodeAffinity` 或 `nodeSelectorTerms` 约束镜像与节点架构的匹配。

### 评分规则

本 case 核心在于识别"镜像 CPU 架构与节点架构不匹配"这一根因，不能只看到 `exec format error` 表象就停止分析。

**conclusion 维度评分（覆盖默认标准）**:
- **5 分**：agent 明确指出镜像 tag 含 `-arm64` 后缀为 arm64 专属镜像，节点 `node-b` 为 amd64，架构不匹配导致 exec format error，并提供正确修复方向（rollback 或改用 multi-arch 镜像）
- **4 分**：agent 识别出 `exec format error` 与架构不匹配相关，指出镜像和节点架构不一致，修复方向正确，但未从镜像 tag 读出具体架构信息
- **3 分**：agent 看到 `exec format error` 并认为是"镜像问题"，但未能解释为何镜像有问题（未识别到架构不匹配）
- **2 分**：agent 只看到 CrashLoopBackOff 表象，未分析 `exec format error` 的含义
- **1 分**：结论方向错误（如归因到权限不足、内存不够、配置文件缺失）
