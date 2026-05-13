# Siclaw K8s 故障诊断 Pilot Experiment 报告

> Pilot 实验：在受控集群中注入 6 类典型 Kubernetes 故障，量化评估 Siclaw 诊断能力。

> 用途：作为 IAAI 2027 论文实验流水线的种子（30-fault benchmark 前置验证）。


## 1. Setup

| 项目 | 值 |
|---|---|
| 实验日期 | 2026-05-13 02:33 UTC |
| Siclaw 版本 | git `f45bb21` (branch `aaai-ccfa`) |
| LLM Backend | Kimi-K2.5 via siflow API (moonshotai/Kimi-K2.5, 131k ctx) |
| Portal 端口 | 127.0.0.1:3080 |
| Agent | `yye` (绑定 cluster `cks-test`，30 个内置 skills) |
| Kubernetes Context | `yye@k8s-cks-test` (368 nodes) |
| Experiment Namespace | `experiment` (labelled `siclaw-experiment=true`) |
| 故障数量 | 6 (F1–F6)，覆盖 6 类典型问题 |
| 提问方式 | HTTP SSE → `/api/v1/siclaw/agents/<id>/chat/send`，单 session 单 turn |
| 评分人 | Claude (执行者), 3 维度 0/1 评分 |

## 2. Methodology

### 2.1 实验流水线

```
for fault F1..F6:
  kubectl apply -f F<i>.yaml             # 注入
  sleep 30–50s                           # 等现象稳定
  capture kubectl evidence (get/describe/logs)
  POST /api/v1/.../chat/send             # 用统一问题模板调用 Siclaw
  解析 SSE 流 → 抽取最终回答 + 工具调用列表
  kubectl delete -f F<i>.yaml            # 清理
```

### 2.2 统一提问模板（控制变量）

> *namespace experiment 下的 pod "<POD_NAME>" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。*

提问只更换 pod 名字，不暗示故障类型，确保评测 **诊断能力本身**。

### 2.3 评分维度（每项 0/1，单 Fault 满分 3）

| 维度 | 给 1 分的条件 |
|---|---|
| **Root Cause** | 命中 ground truth 中的核心机制（如 OOMKill / 端口错配 / ConfigMap 缺失等） |
| **Evidence** | 引用了至少一项 kubectl 实际输出（events / status / logs / config）作为佐证 |
| **Fix** | 给出可直接执行的修复方向（命令或 YAML 片段） |

## 3. Per-Fault Results

### F1. OOMKilled — Memory Limit Too Low

- **Category**: Resource Limits
- **Pod**: `pod-f1-oom` in `namespace=experiment`
- **故障摘要**: Deployment 内存上限 32Mi，容器内运行 stress 占用 150MB → 内核 OOM Killer 终止容器，反复 CrashLoopBackOff。

**Inject command**:
```bash
kubectl apply -f F1-oomkilled.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F1-oomkilled.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
State:          Terminated
Reason:       OOMKilled
Exit Code:    137
Last State:     Terminated
Reason:       OOMKilled
Exit Code:    137
Restart Count:  3
Warning  BackOff    8s (x5 over 49s)  kubelet            Back-off restarting failed container stress in pod pod-f1-oom_experiment(8388cb06-d203-4f70-94a5-98fadb18c038)
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f1-oom" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: memory limit 32Mi 低于实际占用 ~150MB，container 被 OOMKill (exit code 137)
- **关键证据词**: `OOMKilled`, `137`, `32Mi`, `limit`
- **Fix**: 增大 limits.memory 到 ≥200Mi 或减少应用内存占用

**Siclaw 实际回答**:

```markdown
## 诊断结果

**根本原因：OOMKilled（内存不足被杀）**

### 证据
| 项目 | 详情 |
|------|------|
| Pod 状态 | `CrashLoopBackOff`，已重启 3 次 |
| 终止原因 | `OOMKilled` |
| 退出码 | 137 (128 + SIGKILL 9) |
| 内存限制 | **Limit: 32Mi** / Request: 16Mi |
| 应用行为 | stress 工具尝试分配 **150M 内存** (`--vm-bytes 150M`) |

**冲突点**：应用申请 150MB，但硬限制只有 32MB → 触发内核 OOM Killer。

### 修复方案

**方案 A：增加内存限制（推荐）**
```yaml
resources:
  limits:
    memory: "200Mi"   # 必须 > 150M
  requests:
    memory: "100Mi"
```

**方案 B：降低 stress 内存需求**
将 `--vm-bytes 150M` 改为 `--vm-bytes 30M`（低于 32Mi 限制）

---

该 pod 带有标签 `siclaw-fault=F1`，属于故障注入测试场景，目的是验证内存限制机制是否正常工作。
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f1-oom -n experiment -o wide`
- `kubectl describe pod pod-f1-oom -n experiment 2>&1`
- `kubectl logs pod-f1-oom -n experiment --previous --tail=50 2>&1`
- `kubectl get pod pod-f1-oom -n experiment -o jsonpath='{\"limits\": {.spec.containers[0].resources.limits}, \"requests\": {.spec.containers[0].resources.requests}}'`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 3  |  Tokens: 18311  |  Tool calls: 4
- **Notes**: Siclaw 三轮内得出完整结论，引用 `--vm-bytes 150M` 与 32Mi 的冲突，给出两套修复方案。

---

### F2. CrashLoopBackOff — Application Exits Immediately

- **Category**: Application Crash
- **Pod**: `pod-f2-crashloop` in `namespace=experiment`
- **故障摘要**: 容器 command 为 `sh -c 'echo bad; exit 1'`，启动即失败。

**Inject command**:
```bash
kubectl apply -f F2-crashloop.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F2-crashloop.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
State:          Waiting
Reason:       CrashLoopBackOff
Last State:     Terminated
Reason:       Error
Exit Code:    1
Restart Count:  2
Warning  BackOff    10s (x4 over 38s)  kubelet            Back-off restarting failed container app in pod pod-f2-crashloop_experiment(d1fbb9ef-ee56-4aa1-a002-091b6ad42766)
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f2-crashloop" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: 容器命令故意 exit 1（伪装为 db connection failed），导致 CrashLoopBackOff
- **关键证据词**: `exit`, `1`, `CrashLoopBackOff`, `exit 1`
- **Fix**: 修改 command 不要 exit 1，或修复实际启动逻辑（这里只是注入的测试故障）

**Siclaw 实际回答**:

```markdown
## 诊断结论

**根本原因：** 应用程序启动脚本故意以 exit code 1 退出，模拟"数据库连接失败"错误。

**证据：**
1. Pod 的 label `siclaw-fault=F2` 表明这是一个故障注入测试
2. 容器命令明确包含：`echo 'fatal: db connection failed at line 42'; exit 1`
3. 容器状态显示 `Exit Code: 1`（应用程序错误），连续重启 3 次
4. 没有 OOMKilled 或权限问题，纯粹是脚本逻辑导致的崩溃

**修复方法：**

修改 Pod 的容器命令，移除测试用的 `exit 1`，例如：

```yaml
command: ["sh", "-c"]
args: ["echo 'starting app'; echo 'fatal: db connection failed at line 42'"]
```

或者修复实际的数据库连接配置，确保应用程序能正常启动。
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f2-crashloop -n experiment -o wide`
- `kubectl describe pod pod-f2-crashloop -n experiment`
- `kubectl logs pod-f2-crashloop -n experiment --previous --tail=50`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 5  |  Tokens: 18119  |  Tool calls: 3
- **Notes**: Siclaw 准确识别这是测试故障注入（注意到 siclaw-fault=F2 label），并区分了脚本错误 vs OOM/权限错误。

---

### F3. ImagePullBackOff — Image Tag Does Not Exist

- **Category**: Image Issue
- **Pod**: `pod-f3-imagepull` in `namespace=experiment`
- **故障摘要**: image=`nginx:doesnotexist-v999`，registry 没有该 tag。

**Inject command**:
```bash
kubectl apply -f F3-imagepull.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F3-imagepull.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
State:          Waiting
Reason:       ErrImagePull
Restart Count:  0
Warning  Failed     21s (x2 over 38s)  kubelet            Failed to pull image "nginx:doesnotexist-v999": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:doesnotexist-v999": failed to resolve reference "docker.io/library/nginx:doesnotexist-v999": docker.io/library/nginx:doesnotexist-v999: not found
Warning  Failed     21s (x2 over 38s)  kubelet            Error: ErrImagePull
Warning  Failed     7s (x2 over 37s)   kubelet            Error: ImagePullBackOff
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f3-imagepull" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: 镜像 tag 不存在导致 ImagePullBackOff / ErrImagePull
- **关键证据词**: `ErrImagePull`, `not found`, `doesnotexist`, `ImagePullBackOff`
- **Fix**: 修正 image tag 到一个存在的版本（如 nginx:latest 或具体版本）

**Siclaw 实际回答**:

```markdown
## 诊断结果

**根本原因：** 镜像不存在  
**类型：** ImageNotFound

---

**证据：**
- Pod 状态显示 `ErrImagePull`
- 容器镜像配置：`nginx:doesnotexist-v999`
- containerd 日志明确报错：  
  `docker.io/library/nginx:doesnotexist-v999: not found`

---

**修复方法：**
修正 `pod-f3-imagepull` 的镜像标签为存在的版本，例如：
```bash
kubectl set image pod/pod-f3-imagepull -n experiment nginx=nginx:latest
```

或修改 Deployment/资源定义中的镜像标签。
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f3-imagepull -n experiment -o wide`
- `kubectl get pod pod-f3-imagepull -n experiment -o jsonpath='{.spec.nodeName}'`
- `kubectl get pod pod-f3-imagepull -n experiment -o jsonpath='{.spec.containers[0].image}'`
- `kubectl get pod pod-f3-imagepull -n experiment -o jsonpath='{.status.containerStatuses[0].state.waiting.message}'`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 5  |  Tokens: 18268  |  Tool calls: 4
- **Notes**: Siclaw 引用 containerd 日志中的具体错误信息 `docker.io/library/nginx:doesnotexist-v999: not found`，给出 kubectl set image 修复命令。

---

### F4. Pending due to Insufficient Resources

- **Category**: Scheduling Failure
- **Pod**: `pod-f4-pending` in `namespace=experiment`
- **故障摘要**: requests.memory=10000Gi, cpu=500，远超集群任何节点可调度容量。

**Inject command**:
```bash
kubectl apply -f F4-pending.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F4-pending.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
Warning  FailedScheduling  40s   default-scheduler  0/368 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 1 node(s) had untolerated taint {scitix.ai/nodecheck: }, 119 node(s) had untolerated taint {kwok.x-k8s.io/node: fake}, 233 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 5 Insufficient cpu, 5 Insufficient memory, 9 node(s) were unschedulable. preemption: 0/368 nodes are available: 363 Preemption is not helpful for scheduling, 5 No preemption victims found for incoming pod.
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f4-pending" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: 资源请求超过任何节点的可用资源，调度器找不到可放置的 node
- **关键证据词**: `Pending`, `Insufficient`, `FailedScheduling`, `10000Gi`, `500`
- **Fix**: 降低 requests 到实际所需（如 cpu=100m memory=128Mi），或为集群增加容量

**Siclaw 实际回答**:

```markdown
## 诊断结论

**根本原因：** Pod 请求了不合理的巨量资源（**500 CPU 核** 和 **10000Gi 内存**），远超集群任何节点的容量。

---

### 证据

1. **资源请求配置**：
   ```yaml
   Requests:
     cpu:     500
     memory:  10000Gi
   ```

2. **调度器事件**：
   ```
   0/368 nodes are available
   5 Insufficient cpu
   5 Insufficient memory
   ```

---

### 修复方案

**选项 A：修正资源请求**（推荐）
```yaml
resources:
  requests:
    cpu: "100m"      # 或根据实际需要调整
    memory: "128Mi"
```

**选项 B：如果确实需要大量资源**
- 扩容集群节点容量
- 或部署到拥有更大实例的节点池

---

**执行命令修复**：
```bash
kubectl patch pod pod-f4-pending -n experiment --type merge -p '{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"100m","memory":"128Mi"}}}]}}'
```
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f4-pending -n experiment --kubeconfig=cks-test -o wide`
- `kubectl describe pod pod-f4-pending -n experiment --kubeconfig=cks-test`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 6  |  Tokens: 17886  |  Tool calls: 2
- **Notes**: Siclaw 引用 scheduler 事件 `0/368 nodes are available` 与 `Insufficient cpu/memory`，给出两个修复方向并示范了 kubectl patch 命令。

---

### F5. Readiness Probe Failing — Wrong Port

- **Category**: Probe Misconfiguration
- **Pod**: `pod-f5-readiness` in `namespace=experiment`
- **故障摘要**: nginx 监听 80，readinessProbe 配 httpGet port=9999 → 永远 connection refused。

**Inject command**:
```bash
kubectl apply -f F5-readiness.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F5-readiness.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
State:          Running
Restart Count:  0
Warning  Unhealthy  5s (x6 over 30s)  kubelet            Readiness probe failed: Get "http://172.16.36.155:9999/healthz": dial tcp 172.16.36.155:9999: connect: connection refused
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f5-readiness" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: readinessProbe 端口配错（9999 vs 实际监听端口 80），探针永远失败
- **关键证据词**: `readiness`, `9999`, `connection refused`, `Running`, `0/1`
- **Fix**: 把 readinessProbe.port 改为 80（或 nginx 真实端口）

**Siclaw 实际回答**:

```markdown
## 诊断结果

**根本原因**：Readiness Probe 端口配置错误

**证据**：
- Pod 状态 `Running` 但 `READY 0/1`
- Readiness Probe 配置为 `http-get http://:9999/healthz`
- 事件日志显示连续失败：`dial tcp 172.16.36.155:9999: connect: connection refused`

**修复方法**：
将 Readiness Probe 的端口从 `9999` 改为 `80`（nginx 默认端口），或修改为正确的健康检查端点：

```yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 80    # 改为 80
```
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f5-readiness -n experiment -o wide --kubeconfig=cks-test`
- `kubectl describe pod pod-f5-readiness -n experiment --kubeconfig=cks-test`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 4  |  Tokens: 19013  |  Tool calls: 2
- **Notes**: Siclaw 区分了 Pod Running 与 Ready 0/1 的差别，定位到端口配错，给出明确 YAML 修复片段。

---

### F6. CreateContainerConfigError — Missing ConfigMap

- **Category**: Configuration Error
- **Pod**: `pod-f6-configmap` in `namespace=experiment`
- **故障摘要**: envFrom configMapRef 指向 `missing-configmap-xyz`，该 ConfigMap 在 namespace 中不存在。

**Inject command**:
```bash
kubectl apply -f F6-configmap.yaml
```

**Fault YAML 关键片段**：见 `/tmp/siclaw-exp/F6-configmap.yaml`。

**注入后实际症状（kubectl describe 关键字段）**：
```
State:          Waiting
Reason:       CreateContainerConfigError
Restart Count:  0
Warning  Failed     1s (x5 over 29s)  kubelet            Error: configmap "missing-configmap-xyz" not found
```

**提问 (统一模板)**：
```
namespace experiment 下的 pod "pod-f6-configmap" 出问题了，请诊断它当前的故障：根本原因是什么、有哪些证据、应该如何修复？请简明回答，不要重复执行命令。
```

**Ground Truth（人工预期答案）**：
- **Root Cause**: Pod 引用了不存在的 ConfigMap 导致 CreateContainerConfigError
- **关键证据词**: `configmap`, `not found`, `CreateContainerConfigError`, `missing-configmap-xyz`
- **Fix**: 创建该 ConfigMap、改成已存在的名字、或将 envFrom 标记为 optional

**Siclaw 实际回答**:

```markdown
## 诊断结果

### 根本原因
Pod 配置引用了一个**不存在的 ConfigMap** `missing-configmap-xyz`，导致容器无法创建。

### 证据
1. **Pod 状态**：`CreateContainerConfigError`（容器配置错误）
2. **Kubelet 事件**：`Error: configmap "missing-configmap-xyz" not found`
3. **Pod 配置**：通过 `envFrom` 引用 ConfigMap，且 `optional: false`（必须存在）

### 修复方法（三选一）

**方案 1：创建缺失的 ConfigMap**（如果确实需要）
```bash
kubectl create configmap missing-configmap-xyz -n experiment \
  --from-literal=APP_CONFIG=your_value
```

**方案 2：修改 Pod 引用正确的 ConfigMap**（如果 ConfigMap 名写错了）
```bash
kubectl edit pod pod-f6-configmap -n experiment
# 将 missing-configmap-xyz 改为实际存在的 ConfigMap 名
```

**方案 3：将 ConfigMap 标记为可选**（如果该配置非必需）
修改 Pod spec，在 `envFrom` 下添加 `optional: true`
```

**Siclaw 实际调用的 kubectl 命令**：
- `kubectl get pod pod-f6-configmap -n experiment -o wide --kubeconfig=cks-test`
- `kubectl describe pod pod-f6-configmap -n experiment --kubeconfig=cks-test`
- `kubectl logs pod-f6-configmap -n experiment --previous --tail=200 --kubeconfig=cks-test 2>&1 || kubectl logs pod-f6-configmap -n experiment --tail=200 --kubeconfig=cks-test`

**评分**: Root=1/1, Evidence=1/1, Fix=1/1 → **3/3**
- Turns: 4  |  Tokens: 17970  |  Tool calls: 3
- **Notes**: Siclaw 给出三套互补的修复方案（创建/改名/optional），覆盖了所有合理路径。

---

## 4. Aggregate Results

| Fault | Category | Root | Evidence | Fix | Total | Turns | Tokens |
|---|---|---|---|---|---|---|---|
| F1 | Resource Limits | 1 | 1 | 1 | **3/3** | 3 | 18311 |
| F2 | Application Crash | 1 | 1 | 1 | **3/3** | 5 | 18119 |
| F3 | Image Issue | 1 | 1 | 1 | **3/3** | 5 | 18268 |
| F4 | Scheduling Failure | 1 | 1 | 1 | **3/3** | 6 | 17886 |
| F5 | Probe Misconfiguration | 1 | 1 | 1 | **3/3** | 4 | 19013 |
| F6 | Configuration Error | 1 | 1 | 1 | **3/3** | 4 | 17970 |
| **TOTAL** |  |  |  |  | **18/18 (100%)** |  |  |

### 关键观察

- **6/6 Fault 全部 3/3 通过**：Siclaw 在本 pilot 的所有故障上准确定位根因、引用 kubectl 证据、给出可执行修复。
- **平均 4.5 turns / ~18k tokens**：每个故障耗费约 1–2 分钟（含 LLM thinking + 工具执行）。
- **工具调用克制**：每个 fault 仅用 2–4 个 kubectl 命令完成诊断，无冗余循环。
- **没有任何 destructive 操作**：所有工具调用都是 read-only（`get` / `describe` / `logs`），与 Siclaw 的 read-only design contract 一致。
- **F2 中 Siclaw 注意到了 `siclaw-fault=F2` label**，正确识别这是测试场景，但也在 fix 中提出了通用修复方向。

## 5. Limitations of This Pilot（论文 Threats to Validity 章节素材）

1. **样本量小**：仅 6 个 fault，论文最终 benchmark 计划 30 个 fault × 6 类别。
2. **无 baseline 对比**：本次只评测 Siclaw。论文需要至少 3 个 baseline（LangChain+GPT-4 / AutoGen / k8sgpt）对照。
3. **单一 LLM 后端**：只测了 Kimi-K2.5。论文应再覆盖至少一个开源/闭源对照（如 GPT-4o, Claude, Qwen）证明优势不来自 LLM 选型。
4. **评分由作者一人完成**：论文需要双盲人工评分 + LLM-as-Judge 交叉验证（GPT-4o + Claude）。
5. **Fault 设计偏简单**：6 个故障都是单点故障；真实生产事件常为级联故障，论文需补充 ≥5 个复合故障。
6. **Pod 状态稳定后才提问**：未评估早期阶段（症状刚出现）的诊断能力，论文应分时间段评测。
7. **无安全评估**：本次只评 Capability，未评 Safety。论文需补 ≥50 条 adversarial prompt 评估 jailbreak / destructive / credential exfil 防御率。

## 6. Next Steps（论文实验扩展路线）

- [ ] **扩展到 30-fault benchmark**：每个类别再补 4 个变种（不同严重度、不同探测方式）。
- [ ] **构造复合故障**：例如 OOM → Service unavailable → 上游 Deployment 探针失败的级联场景。
- [ ] **接 3 个 baseline**：LangChain (GPT-4o + kubectl tool)、AutoGen multi-agent、k8sgpt。
- [ ] **LLM-as-Judge 双裁判**：每条用 GPT-4o + Claude 评分，与人工评分计算 Cohen's kappa 一致性。
- [ ] **Adversarial Safety Benchmark**：50 条 AgentDojo/InjecAgent 改编 + 50 条 K8s 场景自构造。
- [ ] **Real-world Deployment Study**：在 Siflow 内部 3–5 名 SRE 用 4 周，收集 NPS 与 case studies。
- [ ] **Open-source 这两个 benchmark** 作为论文独立 contribution。

## 7. Artifacts（可复现的产物）

| 路径 | 内容 |
|---|---|
| `/tmp/siclaw-exp/F<1..6>-*.yaml` | 6 个故障 manifest（可 kubectl apply 复现） |
| `/tmp/siclaw-exp/F<i>.evidence.txt` | 注入后 kubectl describe/logs 原始输出 |
| `/tmp/siclaw-exp/F<i>.raw.sse` | Siclaw 完整 SSE 流（含所有 thinking / tool 调用） |
| `/tmp/siclaw-exp/F<i>.parsed.json` | 结构化解析结果（final_text / bash_commands / turns / tokens） |
| `/tmp/siclaw-exp/F<i>.question.txt` | 实际发送给 Siclaw 的提问全文 |
| `/tmp/siclaw-exp/ask.sh` | SSE 调用脚本 |
| `/tmp/siclaw-exp/run_one.sh` | 单个 fault 的端到端 runner |
| `/tmp/siclaw-exp/parse_sse.py` | SSE → JSON 解析器 |
| `/home/yye/.claude/plans/replicated-hopping-bonbon.md` | 实验设计计划文档 |

## 8. Conclusion

Siclaw 在 6 个典型 Kubernetes 故障场景中取得 **18/18 (100%) 满分**，平均 4.5 个 turn、约 18k tokens 完成端到端诊断，全程 zero destructive command。本次 Pilot 成功验证了如下三件事：

1. **实验流水线可用**：从 fault 注入到 Siclaw 响应到结构化评分，完整自动化。
2. **Siclaw 的诊断能力在该样本上 ceiling**：6/6 满分意味着需要更复杂的故障（级联、稀有故障类型）才能分出 baseline 的差异。这是好消息——说明扩 benchmark 是有意义的。
3. **可作为 IAAI 论文的初步实验素材**：本报告的方法论、数据格式、Threats to Validity 均可直接迁移到论文 Evaluation 章节。

**建议下一步**：扩展到 30-fault + 接入至少 1 个 baseline (k8sgpt 最容易接，开源现成)，即可形成 IAAI 论文第 6.1 + 6.2 节的核心实验数据。