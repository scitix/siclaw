<div align="center">

<img src="docs/assets/logo.png" alt="Siclaw Logo" width="400" />

# Siclaw

**AI 驱动的 SRE 副驾驶 — 从自然语言到根因分析**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](README.md) | [中文](README.zh-CN.md)

</div>

---

Siclaw 为每位工程师提供随叫随到的 AI 助手。用自然语言描述问题，智能体自动执行 kubectl、读取日志、追踪网络链路，最终输出根因分析报告 — 支持终端、Web UI 以及飞书 / 钉钉 / Discord 直接对话。

- **自主 K8s 诊断** — 20+ 内置工具，安全优先（默认只读，变更需确认）
- **深度调查** — 4 阶段假设驱动的子智能体引擎，处理复杂故障
- **可插拔 LLM** — 任意 OpenAI 兼容服务（Qwen、DeepSeek、GPT-4o …）+ Anthropic Claude
- **技能系统** — 热加载的诊断 Playbook，智能体运行时自动发现并执行

## 功能特性

| | |
|---|---|
| **终端 TUI** — 本地交互式诊断，支持会话历史和 `--prompt` 单次执行 | **Web UI** — React 前端，集成聊天、技能编辑器、定时任务、凭证保险箱 |
| **IM 频道** — 通过飞书、钉钉或 Discord 直接触发诊断 | **深度调查** — 并行子智能体，自适应预算，结构化 4 阶段工作流 |
| **技能系统** — Core + Team + Personal 三级技能，磁盘或 Web 编辑器热加载 | **MCP 工具服务器** — 通过 [Model Context Protocol](https://modelcontextprotocol.io) 扩展外部工具 |
| **持久记忆** — 每用户记忆存储（Markdown + 向量嵌入），跨会话持久化 | **Webhook 触发** — Prometheus / PagerDuty / 自定义告警触发智能体调查 |

## 架构

```
  Web UI / IM 频道 / Webhook
              │
              ▼
  ┌───────────────────────┐
  │       Gateway          │  控制面：认证、路由、数据库、定时任务
  │    (HTTP + WebSocket)  │
  └──────────┬────────────┘
             │ K8s API 或进程启动
             ▼
  ┌───────────────────────┐
  │      AgentBox          │  执行面：每用户每工作区一个实例
  │  ┌─────────────────┐  │
  │  │  Agent Runtime   │  │  pi-agent 或 claude-sdk
  │  │  ┌───────────┐  │  │
  │  │  │  Tools     │  │  │  kubectl, bash, node_exec, deep_search …
  │  │  │  Skills    │  │  │  core/ + team/ + personal/
  │  │  │  MCP       │  │  │  外部工具服务器
  │  │  │  Memory    │  │  │  向量搜索 + Markdown
  │  │  └───────────┘  │  │
  │  └─────────────────┘  │
  └───────────────────────┘
              │
              ▼
      目标 K8s 集群
     (用户提供 kubeconfig)
```

## 快速开始

Siclaw 支持三种部署模式，按需选择。

### 1. TUI 模式 — 个人本地，最低门槛

直接在终端运行智能体，无需服务端和数据库。

```bash
# 构建
npm ci
npm run build

# 配置 LLM 提供商
mkdir -p .siclaw/config
cp settings.example.json .siclaw/config/settings.json
# 编辑 .siclaw/config/settings.json 填入你的 LLM 提供商信息

# 交互式运行
node siclaw-tui.mjs

# 单次执行
node siclaw-tui.mjs --prompt "为什么 pod nginx-abc 处于 CrashLoopBackOff 状态？"

# 续接上次会话
node siclaw-tui.mjs --continue
```

> **提示：** 任何 OpenAI 兼容接口均可使用 — 将 `baseUrl` 替换为 DeepSeek、Qwen、Kimi 或本地 Ollama 服务器即可。

### 2. 个人服务器 — VM 或笔记本，推荐日常使用

轻量 Web UI，使用 SQLite 存储。无需 MySQL，无需 Docker — 启动服务后在浏览器中完成所有配置。

```bash
npm ci
npm run build
npm run build:web

# 启动服务（SQLite 数据库自动创建）
node siclaw-gateway.mjs --process

# 打开 http://localhost:3000
# 登录：admin / admin（默认凭证）
# 进入 Settings 页面配置 LLM 提供商
```

服务默认使用 SQLite，首次启动自动生成 JWT 密钥。所有配置 — LLM 提供商、模型、凭证 — 均通过 Web UI 的**设置**页面完成。

### 3. Kubernetes — 团队 / 企业

完整多用户部署，隔离 AgentBox Pod、SSO、IM 频道集成。

```bash
# 构建镜像
make build-docker

# 创建命名空间和密钥
kubectl create namespace siclaw
kubectl create secret generic siclaw-secrets \
  --namespace=siclaw \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --from-literal=database-url="mysql://user:pass@host:3306/siclaw" \
  --from-literal=llm-api-key="sk-YOUR-KEY"

# 部署
kubectl apply -f k8s/gateway-deployment.yaml
kubectl apply -f k8s/cron-deployment.yaml
```

详见 [`k8s/README.md`](k8s/README.md) 获取完整部署指南、资源调优和高可用配置。

## 配置

### settings.json（TUI 模式）

最小配置示例 — 放置于 `.siclaw/config/settings.json`：

```json
{
  "providers": {
    "default": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-YOUR-KEY",
      "models": [{ "id": "gpt-4o", "name": "GPT-4o" }]
    }
  }
}
```

<details>
<summary><b>完整 settings.json 参考</b></summary>

```json
{
  "providers": {
    "provider-name": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "your-key",
      "api": "openai-completions",
      "authHeader": true,
      "models": [
        {
          "id": "model-id",
          "name": "Display Name",
          "reasoning": false,
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 2.5, "output": 10.0, "cacheRead": 0.5, "cacheWrite": 3.0 }
        }
      ]
    }
  },
  "default": { "provider": "provider-name", "modelId": "model-id" },
  "embedding": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "your-key",
    "model": "BAAI/bge-m3",
    "dimensions": 1024
  },
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  },
  "debugImage": "busybox:latest",
  "debug": false
}
```

</details>

### 环境变量

**Gateway / 个人服务器：**

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SICLAW_DATABASE_URL` | `mysql://…` 或 `sqlite:路径` | `sqlite:.siclaw/data.sqlite` |
| `SICLAW_JWT_SECRET` | JWT 签名密钥 | 首次启动自动生成 |
| `SICLAW_LLM_API_KEY` | 默认 LLM API Key | 在 Web UI 设置中配置 |
| `SICLAW_ADMIN_PASSWORD` | 初始管理员密码 | `admin` |
| `SICLAW_AGENTBOX_IMAGE` | AgentBox 容器镜像（K8s 模式） | `siclaw-agentbox:latest` |
| `SICLAW_K8S_NAMESPACE` | AgentBox Pod 所在命名空间 | `default` |
| `SICLAW_BASE_URL` | 对外访问 URL | `http://localhost:3000` |

**AgentBox：**

| 变量 | 说明 |
|------|------|
| `SICLAW_LLM_API_KEY` | API Key（从 K8s Secret 注入） |
| `SICLAW_GATEWAY_URL` | Gateway 内部 URL |
| `SICLAW_DEBUG_IMAGE` | 调试 Pod 镜像（`busybox:latest`） |
| `SICLAW_EMBEDDING_BASE_URL` | 嵌入 API（用于记忆索引） |

<details>
<summary><b>SSO / S3 / Cron — 高级变量</b></summary>

| 变量 | 说明 |
|------|------|
| `SICLAW_SSO_ISSUER` | OIDC Issuer URL（启用 SSO） |
| `SICLAW_SSO_CLIENT_ID` | OIDC Client ID |
| `SICLAW_SSO_CLIENT_SECRET` | OIDC Client Secret |
| `SICLAW_SSO_REDIRECT_URI` | OIDC 回调 URI |
| `SICLAW_S3_ENDPOINT` | S3 兼容存储端点 |
| `SICLAW_S3_BUCKET` | S3 存储桶名称 |
| `SICLAW_S3_ACCESS_KEY` | S3 Access Key |
| `SICLAW_S3_SECRET_KEY` | S3 Secret Key |
| `SICLAW_CRON_SERVICE_URL` | 内部 Cron 服务 URL |
| `SICLAW_CRON_API_PORT` | Cron API 监听端口（`3100`） |

SSO、S3 和 Cron 设置也可在 Web UI 的 **设置 > 系统** 页面配置（仅管理员）。

</details>

<details>
<summary><b>IM 频道 — 飞书 / 钉钉 / Discord</b></summary>

### 飞书

在 Web UI 的 **设置 > 频道** 中配置飞书机器人，需要：
- [飞书开放平台](https://open.feishu.cn/) 的 App ID 和 App Secret
- 事件订阅地址：`https://your-domain/api/channels/feishu/event`
- 权限：`im:message`、`im:message.group_at_msg`、`im:resource`

### 钉钉

在 **设置 > 频道** 中配置钉钉机器人，需要：
- 机器人 Webhook URL 和签名密钥
- 回调地址：`https://your-domain/api/channels/dingtalk/event`

### Discord

在 **设置 > 频道** 中配置 Discord 机器人，需要：
- [Discord Developer Portal](https://discord.com/developers/applications) 的 Bot Token
- 权限：`bot`、`messages.read`

</details>

## 项目结构

```
src/
├── cli-main.ts              # TUI 入口
├── gateway-main.ts          # Gateway 入口
├── agentbox-main.ts         # AgentBox 入口
├── cron-main.ts             # Cron Worker 入口
├── core/
│   ├── agent-factory.ts     # 会话工厂（工具 + 大脑 + 技能）
│   ├── prompt.ts            # SRE 系统提示词
│   ├── brains/              # pi-agent 和 claude-sdk 适配器
│   ├── llm-proxy.ts         # Anthropic → OpenAI 翻译代理
│   └── mcp-client.ts        # MCP 服务器管理
├── tools/
│   ├── restricted-bash.ts   # 沙盒化 Shell
│   ├── kubectl.ts           # 只读 kubectl 封装
│   ├── deep-search/         # 并行子智能体调查
│   ├── node-exec.ts         # K8s 节点命令执行
│   └── ...                  # 20+ 工具定义
├── memory/                  # 向量 + 关键词搜索索引
├── gateway/
│   ├── server.ts            # HTTP + WebSocket 服务器
│   ├── auth/                # JWT、SSO、用户管理
│   ├── agentbox/            # K8s Pod Spawner + 进程 Spawner
│   ├── channels/            # 飞书、钉钉、Discord
│   ├── db/                  # Drizzle ORM（MySQL + SQLite）
│   └── web/                 # React 前端（Vite + Tailwind）
├── lib/
│   ├── s3-storage.ts        # S3/OSS 技能版本存储
│   └── s3-backup.ts         # 会话 JSONL 备份
skills/
├── core/                    # 内置技能（10 个）
├── team/                    # 团队共享技能
├── extension/               # 可选扩展技能
└── platform/                # 技能管理工具
k8s/                         # Kubernetes 部署清单
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 22+（纯 ESM） |
| 语言 | TypeScript 5.8 |
| 智能体 | [pi-coding-agent](https://github.com/nicholasgriffintn/pi-coding-agent) / [claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk) |
| 数据库 | MySQL 或 SQLite（[sql.js](https://github.com/sql-js/sql.js)）+ Drizzle ORM |
| 前端 | React + Vite + Tailwind CSS |
| K8s 客户端 | @kubernetes/client-node |
| MCP | @modelcontextprotocol/sdk |
| 实时通信 | WebSocket (ws) |

## 参与贡献

请查阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建、架构概览和 PR 提交指南。

## 开源协议

[Apache License 2.0](LICENSE)
