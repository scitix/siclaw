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

---

## Case: hpa-quota-deadlock-005

```yaml
id: hpa-quota-deadlock-005
title: HPA 想扩容但被 ResourceQuota 卡死(多源因果)
reproducible: false
stubMode: knowledge-qa
stubReason: "需要预先配置 namespace 级 ResourceQuota + HPA + 高负载,在共享测试集群里组装代价过高,改用知识问答模式"
faultType: HPAQuotaConflict
namespace: payment
podShortName: ignored
tags: [hpa, quota, scaling, multi-cause, p1]
passThreshold:
  commands: 0
  conclusion: 4
```

### 工单描述

- **green**: 服务 `payment-api`(namespace `payment`)流量翻倍后 HPA 没有扩出新副本,`kubectl get hpa` 显示 CURRENT 95% / TARGET 70% / REPLICAS 3,期望 6。监控里看到大量 5xx,请定位为什么 HPA 不生效。
- **yellow**: 大促期间 `payment-api` 顶不住,SRE 反馈"自动扩容好像坏了",请帮忙看看。

### 集群现状

```
$ kubectl get hpa -n payment
NAME           REFERENCE                  TARGETS    MINPODS   MAXPODS   REPLICAS   AGE
payment-api    Deployment/payment-api     95%/70%    3         10        3          47d

$ kubectl describe hpa payment-api -n payment
Name:                                                  payment-api
Namespace:                                             payment
Reference:                                             Deployment/payment-api
Metrics:                                               ( current / target )
  resource cpu on pods (as a percentage of request):   95% (475m) / 70%
Min replicas:                                          3
Max replicas:                                          10
Deployment pods:                                       3 current / 6 desired
Conditions:
  Type            Status  Reason               Message
  ----            ------  ------               -------
  AbleToScale     True    SucceededRescale     the HPA controller was able to update the target scale to 6
  ScalingActive   True    ValidMetricFound     the HPA was able to successfully calculate a replica count
  ScalingLimited  False   DesiredWithinRange   the desired count is within the acceptable range
Events:
  Type     Reason             Age                    From                       Message
  ----     ------             ----                   ----                       -------
  Normal   SuccessfulRescale  3m                     horizontal-pod-autoscaler  New size: 6; reason: cpu resource utilization (percentage of request) above target

$ kubectl get deploy payment-api -n payment
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
payment-api    3/6     6            3           47d

$ kubectl get rs -n payment -l app=payment-api
NAME                       DESIRED   CURRENT   READY   AGE
payment-api-7c8f9d4b6      6         3         3       47d

$ kubectl describe rs payment-api-7c8f9d4b6 -n payment | tail -15
Events:
  Type     Reason            Age                  From                   Message
  ----     ------            ----                 ----                   -------
  Warning  FailedCreate      30s (x12 over 3m)   replicaset-controller  Error creating: pods "payment-api-7c8f9d4b6-xxxxx" is forbidden: exceeded quota: payment-quota, requested: pods=1, used: pods=5, limited: pods=5

$ kubectl get resourcequota -n payment
NAME             AGE   REQUEST                                    LIMIT
payment-quota    180d  pods: 5/5, requests.cpu: 2500m/4000m       limits.cpu: 5000m/8000m

$ kubectl describe resourcequota payment-quota -n payment
Name:            payment-quota
Namespace:       payment
Resource         Used   Hard
--------         ----   ----
limits.cpu       5000m  8000m
limits.memory    10Gi   16Gi
pods             5      5
requests.cpu     2500m  4000m
requests.memory  5Gi    8Gi

$ kubectl get pods -n payment
NAME                            READY   STATUS    RESTARTS   AGE
payment-api-7c8f9d4b6-aaaaa     1/1     Running   0          12d
payment-api-7c8f9d4b6-bbbbb     1/1     Running   0          12d
payment-api-7c8f9d4b6-ccccc     1/1     Running   0          12d
payment-job-runner-1            1/1     Running   0          5h
payment-cron-flush-x9k2t        1/1     Running   0          22h
```

### 题解 kubectl

```bash
kubectl get hpa payment-api -n payment
kubectl describe hpa payment-api -n payment
kubectl get rs -n payment -l app=payment-api
kubectl describe rs <new-rs-name> -n payment
kubectl get resourcequota -n payment
kubectl describe resourcequota payment-quota -n payment
kubectl get pods -n payment
```

### 期望结论

**根因(多源汇聚)**:
1. **HPA 已正确决策扩容**:CPU 利用率 95% 远超目标 70%,HPA 把 Deployment 的 desired replicas 从 3 调到 6(events 里的 `SuccessfulRescale` 证明决策成功);
2. **ReplicaSet 创建新 Pod 被拒**:replicaset-controller 报 `exceeded quota: payment-quota, requested: pods=1, used: pods=5, limited: pods=5`——namespace 的 `payment-quota` 把 pods 总数限制在 5;
3. **Quota 已被其它 Pod 吃满**:除了 3 个 `payment-api` 副本,namespace 里还有 `payment-job-runner` 和 `payment-cron-flush` 各占 1 个 Pod 额度,刚好用满 5/5。

两条因果链交汇于 ResourceQuota:HPA 决策(A) + 其他 Pod 占用配额(B) → ReplicaSet 创建被拒(C) → Deployment 副本数停在 3(D) → 业务 5xx(E)。HPA 本身没有问题,问题在 namespace 的 quota 容量规划。

**修复建议**(按优先级):
1. **立即缓解**:把 `payment-quota.spec.hard.pods` 从 5 提到 12(留出 HPA max 10 + 其他工作负载 2 的余量),同时按比例上调 `requests.cpu` / `requests.memory` / `limits.*`,否则只调 pods 又会被 cpu/memory quota 卡住;
2. **结构调整**:把 batch 类工作负载(job-runner、cron-flush)迁到独立 namespace `payment-batch`,避免与在线服务争抢配额;
3. **告警补齐**:对 `kube_resourcequota{type="used"} / kube_resourcequota{type="hard"} > 0.8` 加 Prometheus 告警,quota 即将耗尽时提前通知,避免 HPA 静默失败。

---

## Case: dns-pdb-cascade-006

```yaml
id: dns-pdb-cascade-006
title: CoreDNS 被 PDB 卡住无法滚动 → 业务大面积超时(链式因果)
reproducible: false
stubMode: knowledge-qa
stubReason: "需要复现 CoreDNS Deployment + PDB + 节点维护多组件串联,共享集群无法安全模拟,改用知识问答模式"
faultType: DNSCascadeFailure
namespace: kube-system
podShortName: ignored
tags: [dns, pdb, cascade, multi-step, p0]
passThreshold:
  commands: 0
  conclusion: 4
```

### 工单描述

- **green**: 多个业务 namespace 反馈"调用外部依赖大量超时",`kubectl logs` 看到 `lookup api.partner.com: i/o timeout`。CoreDNS Pod 一个 Running 一个 CrashLoopBackOff,SRE 怀疑 DNS 出问题,请定位根因。
- **yellow**: 今天上午开始集群里很多服务都很慢,业务方说"接口经常超时",运维已经在重启服务但没用,请排查。

### 集群现状

```
$ kubectl get pods -n kube-system -l k8s-app=kube-dns
NAME                       READY   STATUS             RESTARTS       AGE
coredns-7c8f9d4b6-aaaaa    1/1     Running            0              35d
coredns-7c8f9d4b6-bbbbb    0/1     CrashLoopBackOff   42 (2m ago)    35d

$ kubectl logs coredns-7c8f9d4b6-bbbbb -n kube-system --previous | tail -20
[INFO] plugin/reload: Running configuration SHA512 = 1a2b3c...
[FATAL] plugin/loop: Loop (127.0.0.1:46253 -> :53) detected for zone ".", see https://coredns.io/plugins/loop#troubleshooting. Query: "HINFO 8112946459558236798.6379421158471527516."

$ kubectl get cm coredns -n kube-system -o yaml | grep -A 20 'Corefile:'
Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }

$ kubectl get deploy coredns -n kube-system
NAME       READY   UP-TO-DATE   AVAILABLE   AGE
coredns    1/2     2            1           365d

$ kubectl rollout status deploy/coredns -n kube-system
Waiting for deployment "coredns" rollout to finish: 1 of 2 updated replicas are available...

$ kubectl get pdb -n kube-system
NAME                  MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
coredns-pdb           2               N/A               0                     365d

$ kubectl describe pdb coredns-pdb -n kube-system
Name:           coredns-pdb
Namespace:      kube-system
Min available:  2
Selector:       k8s-app=kube-dns
Status:
    Allowed disruptions:  0
    Current:              1
    Desired:              2
    Total:                2

$ kubectl get nodes
NAME      STATUS                     ROLES    AGE    VERSION
node-a    Ready,SchedulingDisabled   worker   400d   v1.28.4
node-b    Ready                      worker   400d   v1.28.4
node-c    Ready                      worker   400d   v1.28.4

$ kubectl get pod coredns-7c8f9d4b6-bbbbb -n kube-system -o jsonpath='{.spec.nodeName}'
node-a

# 业务侧症状(随便挑一个 namespace)
$ kubectl logs -n payment payment-api-xxx --tail=10
2026-04-15T06:12:03 ERROR resolving api.partner.com: lookup api.partner.com: i/o timeout
2026-04-15T06:12:08 ERROR resolving api.partner.com: lookup api.partner.com: i/o timeout
```

### 题解 kubectl

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs coredns-<crashing-pod> -n kube-system --previous
kubectl get cm coredns -n kube-system -o yaml
kubectl get pdb -n kube-system
kubectl describe pdb coredns-pdb -n kube-system
kubectl get nodes
kubectl get pod <crashing-coredns> -n kube-system -o jsonpath='{.spec.nodeName}'
```

### 期望结论

**根因(链式因果 A→B→C→D→E)**:

A. **节点 `node-a` 处于 SchedulingDisabled**(`kubectl get nodes` 显示 `Ready,SchedulingDisabled`),正在做节点维护(cordon);
B. **CoreDNS 副本之一 `coredns-...-bbbbb` 被调度在 node-a 上,且陷入 CrashLoopBackOff**——日志 `[FATAL] plugin/loop: Loop (127.0.0.1:46253 -> :53) detected` 指向典型问题:Corefile 中 `forward . /etc/resolv.conf`,而该节点的 `/etc/resolv.conf` 把 nameserver 指向了集群本身的 service IP(或 127.0.0.1),CoreDNS 把查询转回自己,形成 DNS 转发回环;
C. **PDB `coredns-pdb` 设置 `minAvailable: 2`**,而当前只有 1 个 CoreDNS Pod 健康(`Allowed disruptions: 0`),Deployment Controller / 节点驱逐 / 滚动更新都被 PDB 拒绝,**坏副本无法被替换**;
D. **DNS 解析能力降到 50%**:集群内只剩一个 CoreDNS endpoint 服务全集群所有查询,kube-proxy 的 service 负载均衡仍把 50% 流量打向已挂掉的 endpoint(直到 readiness/health 摘除生效),期间请求 timeout;
E. **业务侧表现为外部依赖大面积 5xx / timeout**(payment-api 日志里的 `lookup ... i/o timeout`)。

链路:节点 cordon(A) → CoreDNS Pod 配置触发 forward loop(B) → PDB 阻止替换坏 Pod(C) → DNS 容量不足(D) → 业务超时(E)。

**修复建议**(按优先级,先恢复后根治):

1. **立即恢复(P0)**:临时把 PDB 改为 `maxUnavailable: 1`(或暂时删除 PDB),让 CoreDNS Deployment 把坏 Pod 替换掉;同时确认 Deployment `replicas` ≥ 2;
2. **修 Corefile(P1)**:把 `forward . /etc/resolv.conf` 改为显式指向上游 DNS(如 `forward . 8.8.8.8 1.1.1.1` 或公司内部 DNS IP),避免依赖节点 resolv.conf 引发 loop;参考 [coredns.io/plugins/loop#troubleshooting](https://coredns.io/plugins/loop#troubleshooting);
3. **修节点 resolv.conf(P1)**:节点上 `/etc/resolv.conf` 不应该把 cluster DNS service IP 当作 nameserver——这是 kubelet 的 `--resolv-conf` 参数应该指向的"宿主机原始 DNS",检查节点配置;
4. **结构改进(P2)**:CoreDNS Deployment 加 anti-affinity 强制散布到不同节点,避免单节点 cordon 同时影响多副本;PDB 应基于 replicas 的相对值(`maxUnavailable: 1`),而不是绝对值(`minAvailable: 2`),避免缩容时死锁;
5. **告警补齐(P2)**:对 `coredns_cache_misses_total` 暴增 + `coredns up{instance=...} == 0` 加告警,DNS 异常应该 5 分钟内呼叫,而不是等业务方反馈。

### 评分规则

本 case 重点考察 agent 还原 **链式因果 A→B→C→D→E** 的完整度,默认评分太宽松,请按以下严格规则替代默认 conclusion 评分:

**conclusion 维度评分(直接覆盖默认 1-5 分含义)**:
- **5 分**:agent 完整还原 A→B→C→D→E 五段因果链,且至少答对 3 条修复建议中"先解 PDB 救火 → 再修 Corefile 根治"的优先级关系
- **4 分**:还原了 4 段因果链(允许漏掉 D 或 E 任一段),修复建议方向正确但未提优先级
- **3 分**:只识别了 A、B、C 三段中的两段(即 agent 看到了"CoreDNS 崩"+"PDB 卡住"但没回溯到节点 cordon),或修复建议提到了 PDB 但没提 Corefile loop 这个根因
- **2 分**:只看到表面症状 D/E(业务超时、DNS 慢),没有触及任何中间层
- **1 分**:结论方向完全错误(例如归因到业务代码、网络硬件)

**额外强制扣分项**(无论 conclusion 评分多少,触发即从 conclusion 分数上额外扣 1 分):
- agent 把 PDB 当成"次要问题"或"配置优化建议",没有意识到它是"无法替换坏副本"的关键卡点
- agent 提议"重启 CoreDNS Pod"或"扩 CoreDNS 副本数"但没说为什么 PDB 会阻止这些操作

commands 维度沿用默认 1-5 评分,不变。

