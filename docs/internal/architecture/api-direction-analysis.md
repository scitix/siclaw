# mTLS架构下的API调用方向分析

## 设计原则

### 1. 数据所有权原则（Data Ownership）
**规则**：谁拥有数据，谁提供API

- **Gateway拥有**：用户数据、配置、定时任务、工作流、历史记录
- **AgentBox拥有**：会话状态、执行上下文、临时工作目录

**推论**：
- ✅ AgentBox应该主动**拉取**Gateway的权威数据（配置、元数据）
- ✅ Gateway应该主动**推送**执行指令给AgentBox（prompt）
- ✅ AgentBox应该主动**上报**执行结果给Gateway（可选）

---

### 2. 职责分离原则（Separation of Concerns）

```
┌─────────────────────────────────────────────────┐
│              Gateway 职责                        │
├─────────────────────────────────────────────────┤
│ - 用户认证与授权                                  │
│ - 数据持久化（会话、消息、配置）                   │
│ - 调度编排（创建/销毁 AgentBox）                  │
│ - 业务逻辑（定时任务、工作流）                     │
│ - 多租户管理                                      │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│             AgentBox 职责                        │
├─────────────────────────────────────────────────┤
│ - AI对话执行（prompt/response）                   │
│ - 工具调用（bash, read, write等）                │
│ - 会话状态管理（上下文、记忆）                     │
│ - 临时文件管理                                    │
│ - 技能加载与执行                                  │
└─────────────────────────────────────────────────┘
```

**推论**：
- ✅ Gateway不应该知道AgentBox的内部实现细节（如session结构）
- ✅ AgentBox不应该承担业务逻辑（如定时任务管理）
- ✅ 边界清晰，降低耦合

---

### 3. 推送 vs 拉取选择原则

| 场景 | 推送（Push） | 拉取（Pull） | 推荐 |
|------|------------|-------------|------|
| **低频大数据** | ❌ 浪费带宽 | ✅ 按需获取 | 拉取 |
| **高频小数据** | ✅ 实时性好 | ❌ 轮询开销大 | 推送 |
| **一次性配置** | ⚠️ 需缓存 | ✅ 启动时加载 | 拉取 |
| **用户触发** | ✅ 实时响应 | ❌ 延迟高 | 推送 |
| **批量查询** | ❌ 冗余传输 | ✅ 精确获取 | 拉取 |

---

## 当前API调用分析

### 类别A：配置与初始化

#### 1. 模型配置（Provider/Model/Embedding）

**当前方向**：
- 启动时：AgentBox → Gateway (`GET /api/internal/settings`)
- 运行时：Gateway → AgentBox (`POST /api/prompt` with `modelConfig`)

**分析**：

| 维度 | 启动拉取 | 每次推送 |
|------|---------|---------|
| **数据量** | ~10KB | ~2KB |
| **频率** | 1次/启动 | 每次prompt |
| **变更频率** | 低（管理员配置） | 中（用户切换模型） |
| **实时性要求** | 低 | 中 |

**结论**：**混合模式** ⭐⭐⭐
```typescript
启动时拉取：GET /api/internal/settings
  → 获取所有providers/models/embedding配置
  → 缓存到本地，减少运行时传输

运行时推送（可选）：POST /api/prompt { modelConfig }
  → 仅在用户使用动态添加的provider时推送
  → 覆盖/补充启动时的配置
```

**架构合理性**：✅ 优秀
- 减少冗余传输
- 支持热更新

**产品合理性**：✅ 优秀
- 用户动态添加Provider后立即可用
- 不需要重启AgentBox

---

#### 2. 技能配置（Skills）

**当前方向**：
- Gateway → AgentBox (通过PVC挂载，文件系统同步)

**可选方向**：
- AgentBox → Gateway (`GET /api/internal/skills?userId=xxx`)

**分析**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| **文件系统挂载** | ✅ 简单，无需API<br>✅ 技能文件可本地调试 | ⚠️ 同步延迟<br>⚠️ 需要额外的sync服务 |
| **API拉取** | ✅ 实时性好<br>✅ 细粒度权限控制 | ⚠️ 需要额外的API<br>⚠️ 技能文件可能很大 |

**结论**：**保持文件系统挂载** ⭐⭐⭐

**架构合理性**：✅ 优秀
- 技能本质上是"代码"，文件系统是自然的分发方式
- 符合K8s的ConfigMap/PVC模式

**产品合理性**：✅ 优秀
- 开发者可以直接修改技能文件并热重载
- 不需要额外的API学习成本

---

### 类别B：运行时元数据查询

#### 3. 定时任务列表（Cron Jobs）

**当前方向**：
- AgentBox → Gateway (`GET /api/internal/cron-list?userId=xxx`)

**可选方向**：
- Gateway → AgentBox (`POST /api/prompt` with `contextData.cronJobs`)

**分析**：

| 方案 | 场景适配 | 数据新鲜度 | 带宽开销 |
|------|---------|-----------|---------|
| **AgentBox拉取** | ✅ 仅在manage-schedule工具需要时 | ✅ 实时 | ✅ 按需 |
| **Gateway推送** | ⚠️ 每次prompt都推送 | ✅ 实时 | ❌ 冗余（大部分prompt不需要） |

**结论**：**AgentBox拉取（mTLS认证）** ⭐⭐⭐

```typescript
// tools/manage-schedule.ts
if (action === "list") {
  const jobs = await gatewayClient.listCronJobs(userId); // mTLS认证
  // 渲染列表
}
```

**架构合理性**：✅ 优秀
- 按需查询，减少冗余传输
- Gateway是定时任务的权威数据源
- mTLS确保只能查询自己的任务

**产品合理性**：✅ 优秀
- 用户执行`/schedule list`时获取最新数据
- 不需要在每次对话时都传递定时任务列表

---

#### 4. 工作空间信息（Workspace Metadata）

**当前方向**：
- Gateway → AgentBox (`POST /api/prompt` with `workspaceId`, `credentialsDir`)

**可选方向**：
- AgentBox → Gateway (`GET /api/internal/workspace?workspaceId=xxx`)

**分析**：

**当前需求**：
- `workspaceId`：用于日志记录和上下文标识
- `credentialsDir`：凭证文件路径
- `allowedTools`：工具白名单（已通过环境变量传递）

**未来可能需求**：
- 工作空间配置（自定义提示词、默认模型等）
- 工作空间成员列表
- 工作空间资源限制

**结论**：**混合模式** ⭐⭐⭐

```typescript
启动时：环境变量传递
  SICLAW_WORKSPACE_ID=xxx
  SICLAW_CREDENTIALS_DIR=/path/to/creds
  SICLAW_ALLOWED_TOOLS='["bash","read"]'

运行时按需查询：
  GET /api/internal/workspace/:id
  → 获取动态配置（自定义提示词等）
```

**架构合理性**：✅ 优秀
- 静态配置（环境变量）+ 动态配置（API查询）
- 减少每次prompt的参数传递

**产品合理性**：✅ 优秀
- 工作空间配置修改后，无需重启AgentBox
- 支持更丰富的工作空间功能

---

#### 5. 用户凭证（Credentials）

**当前方向**：
- Gateway → AgentBox (通过PVC文件系统同步)

**可选方向**：
- AgentBox → Gateway (`GET /api/internal/credentials?userId=xxx&type=github`)

**分析**：

| 方案 | 安全性 | 实时性 | 复杂度 |
|------|--------|--------|--------|
| **文件系统** | ⚠️ 文件权限控制 | ⚠️ 同步延迟 | ✅ 简单 |
| **API查询** | ✅ mTLS + 授权控制 | ✅ 实时 | ⚠️ 需要加密传输 |

**结论**：**保持文件系统（短期），API查询（长期）** ⭐⭐

**短期（当前）**：
- 保持PVC文件系统同步
- 简单、已验证

**长期（建议迁移）**：
```typescript
// AgentBox需要使用GitHub凭证时
const creds = await gatewayClient.getCredential(userId, "github");
// Gateway验证：
//  1. 证书userId匹配
//  2. 返回加密的凭证
//  3. 审计日志记录访问
```

**架构合理性**：⭐⭐⭐ API查询更优
- 细粒度权限控制
- 审计日志完整
- 支持凭证轮换

**产品合理性**：⭐⭐⭐ API查询更优
- 凭证修改后立即生效
- 可以记录凭证使用情况
- 支持临时凭证（过期时间）

---

### 类别C：执行控制与状态同步

#### 6. 会话控制（Session Control）

**当前方向**：
- Gateway → AgentBox
  - `POST /api/prompt` - 发送消息
  - `POST /api/sessions/:id/steer` - 插入引导消息
  - `POST /api/sessions/:id/abort` - 中止执行
  - `POST /api/sessions/:id/close` - 关闭会话

**可选方向**：无需改变

**结论**：**保持Gateway → AgentBox** ⭐⭐⭐

**架构合理性**：✅ 优秀
- Gateway是调度者，AgentBox是执行者
- 符合控制平面（Gateway）vs 数据平面（AgentBox）的划分

**产品合理性**：✅ 优秀
- 用户在Web UI的操作由Gateway发起
- 实时性好（WebSocket → Gateway → AgentBox）

---

#### 7. 事件流（Event Stream）

**当前方向**：
- Gateway → AgentBox (`GET /api/stream/:sessionId` SSE)

**可选方向**：
- AgentBox → Gateway (`POST /api/internal/events` 上报事件)

**分析**：

| 方案 | 实时性 | 可靠性 | 复杂度 |
|------|--------|--------|--------|
| **Gateway拉取（SSE）** | ✅ 实时 | ⚠️ 连接中断丢失 | ✅ 简单 |
| **AgentBox推送** | ✅ 实时 | ✅ 可持久化 | ⚠️ 需要队列/重试 |

**结论**：**保持SSE（当前），考虑混合模式（未来）** ⭐⭐

**当前模式**：
```
AgentBox生成事件 → 内存缓冲 → Gateway SSE订阅 → WebSocket转发给前端
```

**未来可选混合模式**：
```
AgentBox生成事件 → {
  1. 实时：内存缓冲 → Gateway SSE订阅
  2. 持久化：POST /api/internal/events → 数据库 → 断线重连后恢复
}
```

**架构合理性**：⭐⭐ 当前可接受，长期建议混合
- SSE简单，但不支持断线恢复
- 事件推送到Gateway可持久化，支持审计和回放

**产品合理性**：⭐⭐ 当前可接受
- 当前实现已满足需求
- 未来如需支持"断线重连后恢复历史事件"，可改为推送模式

---

#### 8. 执行结果回调（Result Callback）

**当前方向**：无（通过SSE事件流隐式传递）

**可选方向**：
- AgentBox → Gateway (`POST /api/internal/result` 主动上报)

**应用场景**：
- 定时任务执行完成后，上报结果到Gateway数据库
- 工作流节点执行完成后，触发下一步
- 异步任务完成通知

**结论**：**新增AgentBox → Gateway回调（推荐）** ⭐⭐⭐

```typescript
// agentbox: 定时任务执行完成
async function onCronJobComplete(jobId: string, result: string) {
  await gatewayClient.reportCronResult(jobId, {
    status: "success",
    result: result,
    executedAt: new Date(),
  });
}

// gateway: 接收回调并更新数据库
POST /api/internal/cron-result
{
  jobId: "xxx",
  status: "success",
  result: "Task completed successfully",
  executedAt: "2025-01-01T00:00:00Z"
}
```

**架构合理性**：✅ 优秀
- 解耦执行和结果存储
- AgentBox负责执行，Gateway负责持久化
- 支持异步工作流

**产品合理性**：✅ 优秀
- 定时任务执行历史完整记录
- 支持任务失败重试
- 支持工作流编排

---

### 类别D：监控与运维

#### 9. 健康检查（Health Check）

**当前方向**：
- Gateway → AgentBox (`GET /health`)

**可选方向**：
- AgentBox → Gateway (`POST /api/internal/heartbeat` 主动心跳)

**分析**：

| 方案 | 检测延迟 | 实现复杂度 | 网络开销 |
|------|---------|-----------|---------|
| **Gateway轮询** | ⚠️ 轮询间隔 | ✅ 简单 | ⚠️ 持续轮询 |
| **AgentBox心跳** | ✅ 实时 | ⚠️ 需要重试逻辑 | ✅ 按需发送 |

**结论**：**保持Gateway轮询（K8s场景），心跳模式（进程场景）** ⭐⭐

**K8s场景**：
- 依赖K8s的liveness/readiness探针
- Gateway通过K8s API查询Pod状态

**进程场景**：
- 考虑心跳模式减少轮询开销

**架构合理性**：✅ 适配场景
**产品合理性**：✅ 适配场景

---

#### 10. 日志聚合（Log Aggregation）

**当前方向**：
- AgentBox → 标准输出 → K8s日志系统

**可选方向**：
- AgentBox → Gateway (`POST /api/internal/logs` 结构化日志)

**分析**：

**当前模式**：
```
AgentBox console.log → stdout → K8s日志 → 外部日志系统（ELK/Loki）
```

**可选模式**：
```
AgentBox → Gateway日志API → 数据库 → 可查询的结构化日志
```

**结论**：**保持标准输出（推荐）** ⭐⭐⭐

**原因**：
- 标准输出是云原生标准做法
- 日志系统应该是独立的基础设施（ELK/Loki）
- Gateway不应该承担日志聚合的职责

**架构合理性**：✅ 优秀
**产品合理性**：✅ 优秀

---

## API方向调整建议总结

### ✅ 保持现状（已合理）

| API | 方向 | 理由 |
|-----|------|------|
| 会话控制 | Gateway → AgentBox | Gateway是调度者 |
| 事件流（SSE） | Gateway → AgentBox | 实时性好 |
| 健康检查 | Gateway → AgentBox | K8s标准做法 |
| 日志输出 | AgentBox → stdout | 云原生标准 |
| 技能分发 | 文件系统（PVC） | 简单有效 |

---

### ✅ 当前合理，未来可优化

| API | 当前 | 建议 | 优先级 |
|-----|------|------|--------|
| 配置加载 | 启动拉取 | 启动拉取 + 运行时推送 | P1 |
| 凭证管理 | 文件系统 | API查询（mTLS） | P2 |
| 事件流 | SSE | SSE + 事件推送（持久化） | P2 |

---

### ⭐ 建议新增（AgentBox → Gateway）

| API | 方向 | 用途 | 优先级 |
|-----|------|------|--------|
| **定时任务查询** | AgentBox → Gateway | manage-schedule工具 | P0 |
| **执行结果上报** | AgentBox → Gateway | 定时任务/工作流结果 | P1 |
| **工作空间查询** | AgentBox → Gateway | 动态配置 | P2 |
| **凭证查询** | AgentBox → Gateway | 实时凭证获取 | P2 |

---

## 最终架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    mTLS双向认证架构                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Gateway (HTTPS + mTLS)  ←─────────→  AgentBox         │
│                                                         │
│  【Gateway → AgentBox】（控制平面）                      │
│  ✓ POST /api/prompt              发送用户消息           │
│  ✓ POST /api/sessions/:id/steer  插入引导               │
│  ✓ POST /api/sessions/:id/abort  中止执行               │
│  ✓ GET  /api/stream/:id           订阅事件流（SSE）     │
│  ✓ GET  /health                   健康检查              │
│                                                         │
│  【AgentBox → Gateway】（数据获取 + 结果上报）mTLS认证   │
│  ✓ GET  /api/internal/settings         启动配置拉取     │
│  ✓ GET  /api/internal/cron-list        定时任务查询     │
│  ✓ POST /api/internal/cron-result      任务结果上报     │
│  ✓ GET  /api/internal/workspace/:id    工作空间配置     │
│  ✓ GET  /api/internal/credentials      凭证查询（P2）   │
│  ✓ POST /api/internal/events            事件上报（P2）   │
│                                                         │
│  【授权规则】（基于证书身份）                             │
│  • 证书CN（userId）== 请求的userId                       │
│  • 证书OU（workspaceId）限制资源范围                     │
│  • 所有/api/internal/*端点都需要mTLS认证                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 实施优先级

### P0 - 立即实施（mTLS基础）

1. **mTLS基础设施**
   - CertificateManager完善
   - Gateway HTTPS + 证书验证
   - K8s证书Secret管理

2. **定时任务查询** (`GET /api/internal/cron-list`)
   - 解决manage-schedule工具需求
   - 加上mTLS授权检查

---

### P1 - 近期实施（1-2周）

3. **执行结果上报** (`POST /api/internal/cron-result`)
   - 定时任务结果持久化
   - 工作流支持

4. **配置热更新优化**
   - 运行时modelConfig推送
   - 减少冗余传输

---

### P2 - 中期实施（1-2月）

5. **工作空间动态配置** (`GET /api/internal/workspace/:id`)
   - 自定义提示词
   - 工作空间级模型默认

6. **凭证API化** (`GET /api/internal/credentials`)
   - 替代文件系统同步
   - 支持凭证轮换

7. **事件持久化** (`POST /api/internal/events`)
   - 支持断线重连恢复
   - 审计日志

---

## 总结

### 核心观点

1. **✅ 双向通信是合理的**
   - Gateway拥有权威数据 → AgentBox拉取
   - AgentBox执行结果 → 上报给Gateway
   - 符合数据所有权原则

2. **✅ mTLS确保双向通信安全**
   - 每个请求都验证身份
   - 细粒度授权（userId/workspaceId）
   - 防止恶意访问

3. **✅ 按需拉取优于统一推送**
   - 减少冗余传输（定时任务列表只在需要时查询）
   - 数据实时性更好
   - 代码更简洁

4. **✅ 架构符合云原生最佳实践**
   - 控制平面（Gateway）vs 数据平面（AgentBox）
   - 服务网格（Service Mesh）标准模式
   - 可扩展、可维护

---

**你觉得这个API方向设计合理吗？需要我调整哪些部分？** 🚀
