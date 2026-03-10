# 移除 SICLAW_MCP_DIR 与 .siclaw/mcp 依赖

## 背景

当前 AgentBox 的 MCP 配置通过一个独立的中间文件 `.siclaw/mcp/mcp-servers.json` 传递：

```
┌─────────────────────────────────────────────────────────────────────┐
│  当前流程（冗余）                                                    │
│                                                                     │
│  Gateway API ──GET──→ mcpHandler.fetch()                            │
│                          │                                          │
│                          ▼                                          │
│               mcpHandler.materialize()                              │
│                   │   mkdirSync(.siclaw/mcp)                        │
│                   │   writeFileSync(.siclaw/mcp/mcp-servers.json)   │
│                   ▼                                                 │
│               reloadConfig()                                        │
│                   │                                                 │
│                   ▼                                                 │
│               loadConfig()                                          │
│                   │   loadMcpServersConfig()                        │
│                   │     readFileSync(.siclaw/mcp/mcp-servers.json)  │
│                   ▼                                                 │
│               cached.mcpServers  ← 最终使用                         │
└─────────────────────────────────────────────────────────────────────┘
```

`materialize()` 写入文件 → `loadConfig()` 再读回来，是一个**自产自销的绕路**。
MCP 配置完全可以和 providers、paths 等一样，统一存入 `settings.json`。

## 目标

```
┌─────────────────────────────────────────────────────────────┐
│  优化后流程                                                  │
│                                                             │
│  Gateway API ──GET──→ mcpHandler.fetch()                    │
│                          │                                  │
│                          ▼                                  │
│               mcpHandler.materialize()                      │
│                   │   config.mcpServers = merged            │
│                   │   writeConfig(config)  → settings.json  │
│                   ▼                                         │
│               reloadConfig()                                │
│                   │                                         │
│                   ▼                                         │
│               loadConfig()                                  │
│                   │   deepMerge 自然读取 mcpServers 字段     │
│                   ▼                                         │
│               cached.mcpServers  ← 最终使用                  │
└─────────────────────────────────────────────────────────────┘
```

**删除清单：**
- `SICLAW_MCP_DIR` 环境变量（所有引用）
- `.siclaw/mcp/` 目录（运行时不再创建）
- `mcp-servers.json` 中间文件（不再读写）
- `loadMcpServersConfig()` 函数
- K8s template 中对应的 env var 和 volume mount

---

## 开发步骤

### Step 1: 改造 `mcpHandler.materialize()`

**文件**: `src/agentbox/resource-handlers.ts`

**改动**:
1. 删除 `import { loadMcpServersConfig }` (L14)
2. `materialize()` 中删除所有 `.siclaw/mcp` 相关操作：
   - 删除 `loadMcpServersConfig(undefined, { localOnly: true })` 调用 (L44)
   - 删除 `SICLAW_MCP_DIR` 读取与赋值 (L49-50)
   - 删除 `mkdirSync` 创建 `.siclaw/mcp` 目录 (L51)
   - 删除 `writeFileSync` 写 `mcp-servers.json` (L52-56)
3. 替换为：读取当前 `settings.json` 中已有的 `mcpServers` 作为 base，合并 Gateway payload，写回 `settings.json`

**改后代码**:
```typescript
import { loadConfig, reloadConfig, writeConfig } from "../core/config.js";

async materialize(payload: McpPayload): Promise<number> {
  const config = loadConfig();
  const merged: Record<string, unknown> = {};
  // 保留 settings.json 中已有的 mcpServers 作为 base
  if (config.mcpServers) Object.assign(merged, config.mcpServers);
  // Gateway 返回的覆盖
  if (payload?.mcpServers) Object.assign(merged, payload.mcpServers);

  config.mcpServers = merged;
  writeConfig(config);
  return Object.keys(merged).length;
},
```

**验证**: `npm test -- src/agentbox` 通过

---

### Step 2: 删除 `loadMcpServersConfig()` 并清理 `loadConfig()`

**文件 A**: `src/core/mcp-client.ts`
- 删除 `loadMcpServersConfig()` 函数 (L157-182)
- 删除 `tryLoadConfig()` 辅助函数 (L118-155)（仅被 `loadMcpServersConfig` 使用）
- 保留该文件中其他内容（`McpClientManager`、`buildMcpToolName` 等）

**文件 B**: `src/core/config.ts`
- 删除 `import { loadMcpServersConfig }` (L12)
- 删除 `loadConfig()` 中的 MCP 合并逻辑 (L165-171):
  ```typescript
  // 删除 ↓
  if (Object.keys(cached.mcpServers).length === 0) {
    const mcpConfig = loadMcpServersConfig();
    if (mcpConfig?.mcpServers) {
      cached.mcpServers = mcpConfig.mcpServers;
    }
  }
  ```
  `mcpServers` 已经通过 `settings.json` → `deepMerge` 自然加载，无需额外合并。

**验证**: `npx tsc --noEmit` 无类型错误

---

### Step 3: 更新 Gateway 侧 `/api/internal/mcp-servers` 端点

**文件**: `src/gateway/server.ts`
- 删除 `import { loadMcpServersConfig }` (L25)
- `/api/internal/mcp-servers` 端点 (L1245-1261) 中：
  ```typescript
  // 改前
  const localConfig = loadMcpServersConfig(undefined, { localOnly: true });
  const merged = await buildMergedMcpConfig(localConfig, mcpRepo);

  // 改后
  const config = loadConfig();
  const localConfig = Object.keys(config.mcpServers).length > 0
    ? { mcpServers: config.mcpServers }
    : null;
  const merged = await buildMergedMcpConfig(localConfig, mcpRepo);
  ```

**注意**: `buildMergedMcpConfig()` 签名和逻辑不变，只是 local seed 的来源从 `mcp-servers.json` 变为 `settings.json`。

**验证**: `npm test -- src/gateway` 通过

---

### Step 4: 清理测试与注释

**文件 A**: `src/core/mcp-client.test.ts`
- 删除 `loadMcpServersConfig` 的 import (L2)
- 删除 `describe("loadMcpServersConfig", ...)` 测试块 (L120-125)

**文件 B**: `src/agentbox/session.ts`
- 更新注释 (L146):
  ```typescript
  // 改前
  // MCP is initialized per-session inside createSiclawSession via loadMcpServersConfig.
  // 改后
  // MCP is initialized per-session inside createSiclawSession via loadConfig().mcpServers.
  ```

**验证**: `npm test` 全量通过

---

### Step 5: 清理 K8s template 与文档

**文件 A**: `k8s/agentbox-template.yaml`
- 删除 env var (L49-50):
  ```yaml
  - name: SICLAW_MCP_DIR
    value: ".siclaw/mcp"
  ```
- 删除 volume mount (L112-115):
  ```yaml
  - name: skills-pv
    mountPath: /app/.siclaw/mcp
    subPath: mcp
    readOnly: true
  ```

**文件 B**: `docs/arch.md`, `docs/step.md`, `docs/dev-steps.md`
- 更新所有涉及 `SICLAW_MCP_DIR`、`.siclaw/mcp`、`mcp-servers.json` 的描述，反映新的 `settings.json` 统一路径。

**验证**: K8s template 语法正确（缩进对齐）

---

## 风险评估

| 风险点 | 评估 |
|--------|------|
| `loadMcpServersConfig` 被其他模块间接调用 | 已确认仅 4 处直接引用，无反射/动态调用 |
| `writeConfig()` 与 `syncAllResources()` 竞态 | 不存在——`syncAllResources` 是 `await` 串行执行 |
| Gateway 侧本地种子来源变化 | Gateway 也用 `settings.json`，`loadConfig()` 已支持 |
| K8s 存量 pod 的 `.siclaw/mcp` mount | 删除 mount 后新 pod 不挂载，旧 pod 滚动更新时替换 |
