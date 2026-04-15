# Siclaw 回归测试 Case 集 — 样例

> 本文件示范回归测试 case 的标准格式。每个 case 之间用 `---` 分隔;每个 case 头部的 YAML 代码块为 frontmatter,正文按固定小节组织。
>
> **核心字段**: `reproducible` 决定 Runner 走"真实注入"还是"Fixture 回放"。`true` 必填 `## 注入 YAML`,禁止 `## Fixtures`;`false` 相反。
>
> **Pod 命名**: Runner 自动生成 `deveval-regress-<podShortName>-<runId>-<yyyymmdd>-<hhmmss>`,case 里用 `{podName}` 占位符引用(注入 YAML、工单描述、题解命令都用它)。`podShortName` 可在 frontmatter 显式指定,否则从 `id` 去掉末尾 `-<数字>` 自动推导。
>
> **隔离要求**: Runner 解析后,仅 `## 工单描述`(+ namespace)会进入被测 agent;`## 注入 YAML` / `## 题解 kubectl` / `## 期望结论` / `faultType` 全部隔离,agent 解题全程看不到。

---

## Case: oom-basic-001

```yaml
id: oom-basic-001
title: Pod 内存超限被 OOMKilled
reproducible: true
faultType: OOMKilled
namespace: deveval-{runId}
podShortName: oom-basic
tags: [pod, memory, p0]
passThreshold:
  commands: 4
  conclusion: 4
```

### 工单描述

- **green**: Pod `{podName}` 在 namespace `deveval-{runId}` 中反复重启,`kubectl get pod` 看到 exit code 137,状态是 `CrashLoopBackOff`,请排查原因。
- **yellow**: 应用 `{podName}`(命名空间 `deveval-{runId}`)每隔几分钟就会崩一次,日志里没有看到明显的异常栈,业务方反馈请求偶发失败,帮忙看看。

### 注入 YAML

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: {podName}
  namespace: deveval-{runId}
  labels:
    deveval/case: oom-basic-001
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do dd if=/dev/zero of=/dev/null bs=100M; done"]
    resources:
      limits:
        memory: "50Mi"
      requests:
        memory: "20Mi"
```

### 题解 kubectl

```bash
kubectl get pod {podName} -n deveval-{runId}
kubectl describe pod {podName} -n deveval-{runId}
kubectl get pod {podName} -n deveval-{runId} -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
kubectl logs {podName} -n deveval-{runId} --previous
```

### 期望结论

**根因**: 容器 `app` 的 `resources.limits.memory` 设置为 `50Mi`,而业务逻辑持续分配大块内存,超过 cgroup 内存上限后被内核 OOM Killer 杀掉,`lastState.terminated.reason` 为 `OOMKilled`,exit code 137(= 128 + SIGKILL)。由于 `restartPolicy: Always`,Pod 被 kubelet 反复重启,进入 `CrashLoopBackOff`。

**修复建议**: 评估业务真实内存占用,将 `resources.limits.memory` 提升到合理值(建议先设 256Mi 观察);若内存需求本身不合理,应优化业务代码。

---

## Case: probe-unreachable-002

```yaml
id: probe-unreachable-002
title: livenessProbe 目标不可达 — 网络连通性/丢包导致容器被反复重启
reproducible: true
faultType: LivenessProbeFailed-Unreachable
namespace: deveval-{runId}
podShortName: probe-unreachable
tags: [pod, probe, network, connectivity, p0]
passThreshold:
  commands: 3
  conclusion: 4
```

### 工单描述

- **green**: Pod `{podName}` 在 namespace `deveval-{runId}` 反复被 kubelet 重启,`kubectl describe` 能看到 `Liveness probe failed: dial tcp 10.255.255.1:80: i/o timeout` 类事件,请定位根因。
- **yellow**: 服务 `{podName}`(ns `deveval-{runId}`)在 `kubectl get pod` 里 RESTARTS 计数一直在涨,业务方反馈不稳定,请排查。

### 注入 YAML

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: {podName}
  namespace: deveval-{runId}
  labels:
    deveval/case: probe-unreachable-002
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do sleep 30; done"]
    livenessProbe:
      tcpSocket:
        host: 10.255.255.1
        port: 80
      initialDelaySeconds: 5
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 2
```

### 题解 kubectl

```bash
kubectl get pod {podName} -n deveval-{runId}
kubectl describe pod {podName} -n deveval-{runId}
kubectl get events -n deveval-{runId} --field-selector involvedObject.name={podName} --sort-by=.lastTimestamp
kubectl get pod {podName} -n deveval-{runId} -o jsonpath='{.spec.containers[0].livenessProbe}'
```

### 期望结论

**根因**: 容器 `app` 的 `livenessProbe.tcpSocket` 指向 `10.255.255.1:80`,该 IP 在集群内不可达(黑洞 / 100% 丢包),kubelet 每 5 秒探测一次,连续 2 次超时后判定容器不健康并重启。由于 `restartPolicy: Always`,Pod 反复进入重启循环,events 中会出现 `Unhealthy: Liveness probe failed: dial tcp 10.255.255.1:80: i/o timeout` 和 `Killing` 事件。

**修复建议**:
1. 核对 `livenessProbe` 的目标地址是否正确——业务探针通常应打到 `127.0.0.1`(容器自身端口),不应打向外部 IP;
2. 如果确实需要探测外部依赖,改用 `readinessProbe`(外部依赖异常时只会摘掉流量,不会杀容器);
3. 确认网络策略 / 路由:目标网段是否被 NetworkPolicy、CNI、或上层路由丢弃。

---

## Case: probe-timeout-003

```yaml
id: probe-timeout-003
title: livenessProbe 执行超时 — 应用响应延迟过大导致探针超时
reproducible: true
faultType: LivenessProbeFailed-Timeout
namespace: deveval-{runId}
podShortName: probe-timeout
tags: [pod, probe, latency, p0]
passThreshold:
  commands: 3
  conclusion: 4
```

### 工单描述

- **green**: Pod `{podName}` 在 namespace `deveval-{runId}` 反复被 kubelet 重启,`kubectl describe` 提示 `Liveness probe failed: command ... timed out`,请排查为什么探针超时。
- **yellow**: 服务 `{podName}`(ns `deveval-{runId}`)运行不稳定,容器反复重启,RESTARTS 不断增长,请定位延迟问题。

### 注入 YAML

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: {podName}
  namespace: deveval-{runId}
  labels:
    deveval/case: probe-timeout-003
spec:
  restartPolicy: Always
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do sleep 30; done"]
    livenessProbe:
      exec:
        command: ["sh", "-c", "sleep 10 && echo ok"]
      initialDelaySeconds: 5
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 2
```

### 题解 kubectl

```bash
kubectl get pod {podName} -n deveval-{runId}
kubectl describe pod {podName} -n deveval-{runId}
kubectl get events -n deveval-{runId} --field-selector involvedObject.name={podName} --sort-by=.lastTimestamp
kubectl get pod {podName} -n deveval-{runId} -o jsonpath='{.spec.containers[0].livenessProbe}'
```

### 期望结论

**根因**: 容器 `app` 的 `livenessProbe.exec` 命令 `sleep 10 && echo ok` 需要至少 10 秒才返回,但 `timeoutSeconds` 只给了 2 秒——每次探针都必然超时。kubelet 连续 `failureThreshold=2` 次判定失败后杀掉容器,`restartPolicy: Always` 导致反复重启。events 中会出现 `Unhealthy: Liveness probe failed: command "..." timed out` 和 `Killing` 事件。

**修复建议**:
1. 优先提高 `timeoutSeconds`(比如从 2 提到 15),给应用足够响应时间;必要时同步拉长 `periodSeconds` 避免堆积;
2. 排查应用自身:响应慢是否因为启动未就绪?如果是冷启动慢,应单独配置 `startupProbe` 保护初始化阶段;
3. 若探针命令本身是 shell 管道,确认每一步都能在 timeout 内完成,避免外部依赖阻塞探针。

---

## Case: node-notready-003

```yaml
id: node-notready-003
title: 节点 NotReady 导致 Pod 长期 Pending
reproducible: false
stubReason: "节点级故障无法在共享测试集群安全模拟,线上排查时故障已由 kubelet 自愈,使用历史 fixture 回放"
faultType: NodeNotReady
namespace: deveval-{runId}
tags: [node, kubelet, scheduling, p1]
passThreshold:
  commands: 3
  conclusion: 4
```

### 工单描述

- **green**: 业务 Pod `billing-worker-7c9d8f-abcde`(namespace `billing-prod`)已经 20 分钟处于 `Pending`,`kubectl describe` 提示 `0/5 nodes are available: 1 node(s) had taint {node.kubernetes.io/unreachable}`,请排查为何调度不下去。
- **yellow**: 结算服务 `billing-worker` 扩容后有一个副本起不来,SRE 反馈集群容量没满,请看看为什么新 Pod 调度失败。

### Fixtures

预录的 kubectl 输出,Runner 启动 AgentBox 时挂载为 fixture 目录,agent 侧的 `kubectl` 被 shim 替代,命中下列命令时回放对应输出,未命中则 case FAIL。

#### `kubectl get pod billing-worker-7c9d8f-abcde -n billing-prod`

```
exit: 0
---
NAME                           READY   STATUS    RESTARTS   AGE
billing-worker-7c9d8f-abcde    0/1     Pending   0          22m
```

#### `kubectl describe pod billing-worker-7c9d8f-abcde -n billing-prod`

```
exit: 0
---
Name:         billing-worker-7c9d8f-abcde
Namespace:    billing-prod
Priority:     0
Node:         <none>
Status:       Pending
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  22m   default-scheduler  0/5 nodes are available: 1 node(s) had taint {node.kubernetes.io/unreachable: }, that the pod didn't tolerate, 4 node(s) didn't match Pod's node affinity/selector.
```

#### `kubectl get nodes`

```
exit: 0
---
NAME      STATUS     ROLES    AGE   VERSION
node-1    Ready      worker   45d   v1.28.2
node-2    Ready      worker   45d   v1.28.2
node-3    NotReady   worker   45d   v1.28.2
node-4    Ready      worker   45d   v1.28.2
node-5    Ready      worker   45d   v1.28.2
```

#### `kubectl describe node node-3`

```
exit: 0
---
Name:               node-3
Roles:              worker
Taints:             node.kubernetes.io/unreachable:NoSchedule
                    node.kubernetes.io/unreachable:NoExecute
Conditions:
  Type                 Status    Reason                       Message
  ----                 ------    ------                       -------
  NetworkUnavailable   False     RouteCreated                 RouteController created a route
  MemoryPressure       Unknown   NodeStatusUnknown            Kubelet stopped posting node status.
  DiskPressure         Unknown   NodeStatusUnknown            Kubelet stopped posting node status.
  PIDPressure          Unknown   NodeStatusUnknown            Kubelet stopped posting node status.
  Ready                Unknown   NodeStatusUnknown            Kubelet stopped posting node status.
Events:
  Type     Reason          Age   From     Message
  ----     ------          ----  ----     -------
  Normal   NodeNotReady    24m   kubelet  Node node-3 status is now: NodeNotReady
```

#### `kubectl get events -n billing-prod --field-selector involvedObject.name=billing-worker-7c9d8f-abcde --sort-by=.lastTimestamp`

```
exit: 0
---
LAST SEEN   TYPE      REASON             OBJECT                                MESSAGE
22m         Warning   FailedScheduling   pod/billing-worker-7c9d8f-abcde      0/5 nodes are available: 1 node(s) had taint {node.kubernetes.io/unreachable: }, that the pod didn't tolerate, 4 node(s) didn't match Pod's node affinity/selector.
```

### 题解 kubectl

```bash
kubectl get pod billing-worker-7c9d8f-abcde -n billing-prod
kubectl describe pod billing-worker-7c9d8f-abcde -n billing-prod
kubectl get nodes
kubectl describe node node-3
```

### 期望结论

**根因**: 集群中 `node-3` 的 kubelet 已停止上报状态(`Kubelet stopped posting node status`),节点被控制面标记为 `NotReady`,并自动打上 `node.kubernetes.io/unreachable:NoSchedule/NoExecute` 污点;同时该业务 Pod 配置了 nodeAffinity/selector,只能调度到符合条件的节点上,其余 4 个 Ready 节点不匹配亲和性,因此 `default-scheduler` 报 `FailedScheduling`,Pod 长时间 Pending。真正的调度失败原因是**匹配节点 node-3 不可用**,而不是集群容量不足。

**修复建议**:
1. 优先排查 `node-3` kubelet 与 API Server 的连通性:检查 kubelet 进程、节点网络、`kubelet.service` 日志;
2. 短期缓解:放宽 Pod 的 nodeAffinity/selector,让它能调度到其他 Ready 节点;
3. 长期改进:对关键业务添加 `tolerations` 或扩展可调度节点池,避免单节点故障阻塞调度。
```

