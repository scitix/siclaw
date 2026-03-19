# Per-Cluster Debug Image

> Status: Draft
> Branch: `fix/debug_image`

---

## 问题

Debug pod 通过 `runInDebugPod()` 创建，用于在 K8s 节点上执行特权命令（nsenter、网络诊断等）。当前 debug image 是**全局单一配置**（`config.debugImage`，默认 `busybox:1.36`）。

但 AgentBox 会通过不同的 kubeconfig credential 连接**多个集群**，而不同集群可能有：

- 不同的容器镜像仓库（私有仓库、离线环境）
- 不同的镜像拉取策略或准入控制器
- 节点上预缓存的镜像不同

单一全局 `debugImage` 无法满足多集群场景。

---

## 方案

将 `debugImage` 作为**集群级别属性**存储在 Gateway 的 `clusters` 表中。通过现有的 credential manifest metadata 管道传递到 AgentBox，工具创建 debug pod 时从中读取。

### 为什么是集群级别而非 credential 级别？

Debug image 由集群的基础设施决定（镜像仓库、拉取策略），与用户身份无关。连接同一集群的所有用户应使用相同的 debug image。

---

## 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Gateway                                     │
│                                                                     │
│  clusters 表                                                        │
│  ┌──────────┬────────────┬───────────────────────┐                  │
│  │ name     │ apiServer  │ debugImage (新增)      │                  │
│  ├──────────┼────────────┼───────────────────────┤                  │
│  │ prod-a   │ :6443      │ registry.a/debug:v1   │                  │
│  │ prod-b   │ :6443      │ registry.b/busybox:1  │                  │
│  │ dev      │ :6443      │ NULL（使用全局默认）    │                  │
│  └──────────┴────────────┴───────────────────────┘                  │
│                          │                                          │
│              buildCredentialPayload()                               │
│                          │                                          │
│                          ▼                                          │
│  manifest.json entry:                                               │
│  {                                                                  │
│    "name": "prod-a",                                                │
│    "type": "kubeconfig",                                            │
│    "metadata": {                                                    │
│      "clusters": [...],                                             │
│      "contexts": [...],                                             │
│      "debugImage": "registry.a/debug:v1"  ← 新增                   │
│    }                                                                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
                           │
                    credential payload
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        AgentBox                                     │
│                                                                     │
│  工具（如 node_exec）                                                │
│       │                                                             │
│       ├─ resolveRequiredKubeconfig(credDir, name)                   │
│       │       → kubeconfig 路径                                      │
│       │                                                             │
│       ├─ resolveDebugImage(credDir, name)  ← 新增                   │
│       │       → 集群专属 image 或 null                               │
│       │                                                             │
│       ├─ image = params.image ?? resolvedImage ?? config.debugImage  │
│       │                                                             │
│       └─ runInDebugPod(spec, env, opts)                             │
│               │                                                     │
│               └─ DebugPodCache key: "userId:clusterKey:nodeName"    │
│                                       ↑ 新增集群维度                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Image 解析优先级（从高到低）

1. `params.image` — agent 的显式逐次覆盖
2. `metadata.debugImage` — 集群专属 image（来自 manifest）
3. `config.debugImage` — 全局兜底（`busybox:1.36`）

> 注：`SICLAW_DEBUG_IMAGE` 环境变量在 Gateway 侧通过 `/api/internal/settings` 写入 AgentBox 的 `config.debugImage`，与第 3 级等价，不是独立的优先级层。

---

## 改动清单

### 1. DB 层（~3 个文件）

**`src/gateway/db/schema-sqlite.ts`**
- `clusters` 表新增 `debugImage: text("debug_image")` 列

**`src/gateway/db/migrate-sqlite.ts`**
- `clusters` DDL 新增 `debug_image TEXT` 列
- 新增 `ALTER TABLE clusters ADD COLUMN debug_image TEXT` 迁移语句

**`src/gateway/db/repositories/cluster-repo.ts`**
- `list()`、`listByIds()`、`getById()` 的 select 字段加上 `debugImage`
- `save()` 的输入类型和 insert/update 逻辑加上 `debugImage`

### 2. Gateway RPC 层（~1 个文件）

**`src/gateway/rpc-methods.ts`**

- **`cluster.create`**：接收 `debugImage` 参数，传给 `clusterRepo.save()`
- **`cluster.update`**：接收 `debugImage` 参数，传给 `clusterRepo.save()`
- **`cluster.list`**：返回中包含 `debugImage`（仅镜像名，非敏感信息）
- **`buildCredentialPayload()`**：构建 kubeconfig manifest entry 时，读取 `cls.debugImage`，写入 `metadata.debugImage`（仅在非 null 时）

### 3. 前端（~1 个文件）

**`src/gateway/web/src/pages/Environments/components/ClusterDialog.tsx`**

- `Cluster` 接口和 `ClusterFormData` 新增 `debugImage`
- 表单中新增输入框（位于 API Server 下方、Allowed Servers 上方）
- `cluster.create` / `cluster.update` RPC 调用时传递 `debugImage`
- placeholder 提示：如 `"Leave empty to use default (busybox:1.36)"`

**UI 变更示意（仅展示变更区域）：**

```
│                                                 │
│  API Server *                                   │
│  ┌─────────────────────────────────────────┐    │
│  │ https://10.0.1.100:6443                 │    │
│  └─────────────────────────────────────────┘    │
│  ↳ Must include explicit port, e.g. :6443       │
│                                                 │
│  Debug Image                          ← 新增    │
│  ┌─────────────────────────────────────────┐    │
│  │ registry.example.com/debug:v1           │    │
│  └─────────────────────────────────────────┘    │
│  ↳ Leave empty to use default (busybox:1.36)    │
│                                                 │
│  Allowed Servers                                │
│  ┌─────────────────────────────────────────┐    │
│  │ server1, server2, server3               │    │
│  └─────────────────────────────────────────┘    │
│  ↳ Comma-separated list of allowed server...    │
│                                                 │
```

### 4. AgentBox 工具层（~6 个文件）

**`src/tools/kubeconfig-resolver.ts`**
- 扩展内部 `CredentialEntry` 接口，新增可选 `metadata?: { debugImage?: string }` 字段
- 抽取内部 `readManifestEntries()` 函数，复用 manifest.json 解析逻辑（当前 `resolveKubeconfigPath`、`resolveKubeconfigByName`、`resolveRequiredKubeconfig` 各自独立解析）
- 新增 `resolveDebugImage(credentialsDir, kubeconfigName)` 函数，从 manifest entry 的 `metadata.debugImage` 读取，返回 `string | null`

**`src/tools/debug-pod.ts`**
- `DebugPodSpec`：新增可选字段 `clusterKey?: string`
- `DebugPodCache.key()`：从 `${userId}:${nodeName}` 改为 `${userId}:${clusterKey}:${nodeName}`
- 更新所有 `DebugPodCache` 方法签名：在 `userId` 和 `nodeName` 之间新增 `clusterKey` 参数
- `runInDebugPod()`：使用 `spec.clusterKey` 构建 cache key

**`src/tools/node-exec.ts`**、**`src/tools/node-script.ts`**、**`src/tools/pod-nsenter-exec.ts`**、**`src/tools/netns-script.ts`**
- `resolveRequiredKubeconfig()` 之后调用 `resolveDebugImage()` 获取集群专属 image
- Image 解析：`params.image || resolvedDebugImage || loadConfig().debugImage`
- `DebugPodSpec` 中传入 `clusterKey`（credential 名称）

---

## DebugPodCache Key 变更

### 变更前

```
key = "userId:nodeName"
```

不同集群如果存在同名 node，会发生 cache 碰撞——一个集群的 debug pod 被错误复用给另一个集群的 kubectl exec，导致执行失败（kubeconfig 不匹配）。

### 变更后

```
key = "userId:clusterKey:nodeName"
```

其中 `clusterKey` 为 credential 名称（如 `"prod-a"`），确保跨集群的 cache 隔离。

**`runInDebugPod()` 中受影响的调用点：**
- `debugPodCache.getOrCreate(userId, clusterKey, nodeName, ...)`
- `debugPodCache.set(userId, clusterKey, nodeName, ...)`
- `debugPodCache.touch(userId, clusterKey, nodeName, ...)`
- `debugPodCache.remove(userId, clusterKey, nodeName, ...)`

---

## 向后兼容

- `debugImage` 列可为 null——已有集群值为 `NULL`，回退到全局 `config.debugImage`
- `DebugPodSpec` 中的 `clusterKey` 取自 `params.kubeconfig`（credential 名称）；单集群未指定 name 时 fallback 到 `"default"`
- 工具的公开 API（agent 可见参数）不变
- `metadata.debugImage` 可选——AgentBox 在其缺失时优雅降级

---

## TUI 模式

TUI 使用基于文件系统的 credential（`credential-manager.ts`）。`registerKubeconfig()` 可以在 metadata 中接受可选的 `debugImage`，但**不在本次改动范围内**。TUI 用户可以：

1. 使用 `params.image` 逐次覆盖
2. 使用全局 `SICLAW_DEBUG_IMAGE` 环境变量
3. 未来：扩展 `/setup` credential 菜单以支持 debugImage

---

## 测试计划

- [ ] 通过 ClusterDialog 创建两个具有不同 `debugImage` 的集群
- [ ] 验证 `cluster.list` 返回各集群的 `debugImage`
- [ ] 验证 `buildCredentialPayload()` 在 manifest metadata 中包含 `debugImage`
- [ ] 验证 `resolveDebugImage()` 能正确从 manifest 读取
- [ ] 对不同集群执行 `node_exec`——确认 `kubectl run` 使用了正确的 image
- [ ] 验证兜底逻辑：`debugImage=NULL` 的集群使用全局 `config.debugImage`
- [ ] 验证 cache 隔离：不同集群的同名 node 创建各自独立的 debug pod
- [ ] 验证 `params.image` 显式覆盖优先级高于集群 `debugImage`（三级优先级的第一级）
- [ ] `npx tsc --noEmit` 通过
- [ ] `npm test` 通过
