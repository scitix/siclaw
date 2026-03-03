# AgentBox与Gateway通信架构评估

## 当前架构分析

### 现状

```
┌─────────────┐                    ┌─────────────┐
│   Gateway   │ ──HTTP (单向)──>  │  AgentBox   │
│             │                    │             │
│  创建/管理   │                    │  执行任务    │
│  AgentBox   │                    │             │
└─────────────┘                    └─────────────┘
      │                                    │
      │ 启动时反向依赖                      │
      │ <──── GET /api/internal/settings ─┘
```

### 反向依赖清单

| # | 调用位置 | API端点 | 目的 | 频率 |
|---|---------|---------|------|------|
| 1 | `agentbox-main.ts:31` | `GET /api/internal/settings` | 启动时拉取完整配置 | 启动时一次 |
| 2 | `tools/manage-schedule.ts:101` | `GET /api/internal/cron-list` | 查询用户定时任务列表 | 工具调用时 |

---

## 三种架构方案对比

### 方案A：严格单向（之前的尝试）❌

**理念**：完全消除反向依赖，Gateway主动推送所有数据

**实现**：
- ❌ 移除启动时配置拉取
- ✅ Gateway在首次prompt时推送完整配置
- ❌ 删除 `/api/internal/settings` 端点
- ✅ manage-schedule.list 引导用户去Web UI查看

**优点**：
- ✅ 架构清晰，单向依赖
- ✅ AgentBox可独立启动

**缺点**：
- ❌ 配置推送逻辑分散在多处（rpc-methods, channel-bridge, server）
- ❌ 需要"首次检测"逻辑（复杂、易出错）
- ❌ AgentBox重启但Gateway未感知时，配置可能不会重新推送
- ❌ 工具功能受限（无法查询定时任务）
- ❌ 为了架构纯粹性而牺牲了实用性

**评估**：**不推荐** - 理想主义但不实用

---

### 方案B：mTLS双向认证（推荐）⭐⭐⭐

**理念**：允许合理的双向通信，通过mTLS确保安全

**实现**：
- ✅ 保留启动时配置拉取（加上mTLS认证）
- ✅ 保留 `/api/internal/settings` 端点（加上证书验证）
- ✅ manage-schedule.list 通过mTLS查询Gateway
- ✅ 证书中嵌入身份信息（userId, workspaceId）
- ✅ Gateway验证证书并授权（只能访问自己的资源）

**优点**：
- ✅ **架构简单**：启动拉取配置，逻辑集中
- ✅ **功能完整**：工具可以查询必要的元数据
- ✅ **安全可靠**：mTLS + 细粒度授权，防止恶意访问
- ✅ **实用性强**：支持合理的双向通信
- ✅ **行业标准**：Service Mesh（Istio/Linkerd）都采用mTLS

**缺点**：
- ⚠️ 实施复杂度中等（需要证书管理）
- ⚠️ 需要额外的证书存储和轮换机制

**评估**：**强烈推荐** - 安全、实用、符合行业最佳实践

---

### 方案C：API Key认证（折中）⭐⭐

**理念**：使用API Key而非证书进行身份验证

**实现**：
- ✅ Gateway为每个AgentBox生成唯一API Key
- ✅ AgentBox请求时携带API Key
- ✅ Gateway验证API Key并提取身份信息
- ✅ 基于身份的授权控制

**示例代码**：
```typescript
// Gateway创建AgentBox时生成API Key
const apiKey = crypto.randomUUID();
await db.storeApiKey(apiKey, { userId, workspaceId, boxId });

// AgentBox请求时携带API Key
fetch(`${gatewayUrl}/api/internal/settings`, {
  headers: { "X-AgentBox-API-Key": apiKey }
});

// Gateway验证
const identity = await db.verifyApiKey(req.headers["x-agentbox-api-key"]);
if (!identity || identity.userId !== requestedUserId) {
  return 403;
}
```

**优点**：
- ✅ 实施简单（比mTLS简单很多）
- ✅ 功能完整（支持双向通信）
- ✅ 足够安全（在内网环境下）

**缺点**：
- ⚠️ 安全性低于mTLS（API Key可能泄露）
- ⚠️ 不支持端到端加密（需要依赖TLS）
- ⚠️ 不如mTLS标准化

**评估**：**可接受** - 如果追求快速实施且在可信网络环境

---

## 详细对比

### 安全性对比

| 维度 | 方案A（单向） | 方案B（mTLS） | 方案C（API Key） |
|------|-------------|--------------|----------------|
| **身份验证** | 无需（单向） | ⭐⭐⭐ 双向证书 | ⭐⭐ API Key |
| **传输加密** | TLS（可选） | ⭐⭐⭐ mTLS强制 | ⭐⭐ TLS（可选） |
| **防伪造** | N/A | ⭐⭐⭐ 证书签名 | ⭐ API Key验证 |
| **防重放** | N/A | ⭐⭐⭐ TLS内建 | ⭐ 需自行实现 |
| **密钥泄露影响** | N/A | ⭐⭐⭐ 限于单个实例 | ⭐⭐ 可能影响多个 |
| **撤销机制** | N/A | ⭐⭐⭐ CRL/OCSP | ⭐⭐ 数据库黑名单 |

### 复杂度对比

| 维度 | 方案A（单向） | 方案B（mTLS） | 方案C（API Key） |
|------|-------------|--------------|----------------|
| **实施难度** | ⭐⭐⭐ 高（逻辑复杂） | ⭐⭐ 中（证书管理） | ⭐ 低（简单直接） |
| **代码量** | ~200行（分散多处） | ~500行（集中） | ~100行 |
| **运维复杂度** | ⭐ 低 | ⭐⭐ 中（证书轮换） | ⭐ 低 |
| **调试难度** | ⭐⭐⭐ 高（难定位问题） | ⭐⭐ 中 | ⭐ 低 |

### 功能性对比

| 功能 | 方案A（单向） | 方案B（mTLS） | 方案C（API Key） |
|------|-------------|--------------|----------------|
| **启动配置加载** | ⚠️ 首次prompt推送 | ✅ 启动时拉取 | ✅ 启动时拉取 |
| **运行时元数据查询** | ❌ 不支持 | ✅ 支持 | ✅ 支持 |
| **工具功能完整性** | ❌ 受限 | ✅ 完整 | ✅ 完整 |
| **配置热更新** | ⚠️ 需重启 | ✅ 可主动拉取 | ✅ 可主动拉取 |

---

## 最终推荐

### 🥇 首选：方案B（mTLS）

**适用场景**：
- ✅ 生产环境
- ✅ 多租户SaaS
- ✅ 高安全要求
- ✅ 跨网络边界部署

**核心价值**：
1. **零信任架构**：不依赖网络边界，每个请求都验证
2. **行业标准**：Kubernetes、Istio、Consul都采用mTLS
3. **长期价值**：为未来的多集群、联邦部署打基础

### 🥈 备选：方案C（API Key）

**适用场景**：
- ✅ 内网环境
- ✅ 快速原型验证
- ✅ 单租户私有部署
- ⚠️ 不推荐多租户SaaS

**核心价值**：
1. **快速实施**：半天即可完成
2. **足够安全**：在可信网络环境下
3. **易于理解**：团队容易上手

### ❌ 不推荐：方案A（单向）

**原因**：
- 为了架构纯粹性牺牲了实用性
- 实施复杂度高，收益低
- 不符合实际业务需求

---

## 实施路线图

### 阶段1：快速验证（方案C - 1天）

```typescript
// 1. Gateway生成API Key
const apiKey = crypto.randomUUID();
await agentBoxManager.storeApiKey(boxId, apiKey, { userId, workspaceId });

// 2. AgentBox使用API Key
process.env.SICLAW_API_KEY = apiKey;
fetch(`${gatewayUrl}/api/internal/settings`, {
  headers: { "Authorization": `Bearer ${apiKey}` }
});

// 3. Gateway验证
const identity = await agentBoxManager.verifyApiKey(apiKey);
```

**验证目标**：
- ✅ 双向通信可行性
- ✅ 授权逻辑正确性
- ✅ 性能影响评估

### 阶段2：生产化（方案B - 3天）

1. **Day 1**: 证书基础设施
   - 完善CertificateManager（使用node-forge）
   - 实现证书签发和验证
   - 单元测试

2. **Day 2**: Gateway集成
   - HTTPS server with mTLS
   - 证书验证中间件
   - 授权策略实现

3. **Day 3**: AgentBox集成 + K8s部署
   - GatewayClient实现
   - K8s Secret管理
   - 端到端测试

### 阶段3：运维优化（持续）

- 证书轮换自动化
- 监控和告警
- 审计日志
- 性能优化

---

## 决策建议

### 如果你想...

**快速验证可行性**：
→ 选择方案C（API Key），今天就能完成

**构建生产级系统**：
→ 选择方案B（mTLS），3天内完成，长期受益

**保持架构纯粹**：
→ 不推荐方案A，除非有特殊的合规要求

---

## 总结

**核心观点**：
1. ✅ **允许双向通信是合理的** - 关键是如何安全地实现
2. ✅ **mTLS是最佳实践** - 零信任架构的标准解决方案
3. ✅ **API Key是可行的折中** - 快速验证或内网环境
4. ❌ **强制单向不实用** - 牺牲了功能性和简单性

**下一步行动**：
1. 决定采用方案B（mTLS）还是方案C（API Key）
2. 我立即开始实施选定的方案
3. 保留现有代码（已经是合理的起点）

**你想选择哪个方案？** 🚀
