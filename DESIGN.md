# 敏感数据泄漏防护 — 方案设计

## 背景与目标

kubectl 的 `get` 和 `describe` 作为只读子命令被列入白名单。但以下命令会将敏感数据直接泄漏到 AI 模型上下文中：

1. **Secret 数据**：`kubectl get secret -o yaml/json` 返回 base64 编码的密码、token、TLS 私钥
2. **ConfigMap 数据**：`kubectl get configmap -o yaml/json` 常被滥用存储凭证（DB 连接串、API key）
3. **Pod 环境变量**：`kubectl get pod -o yaml` / `kubectl describe pod` 暴露 `.spec.containers[].env[].value` 中硬编码的密钥
4. **config view --raw**：仅在 restricted-bash 管道校验器中被拦截，kubectl tool 直接执行路径**遗漏了此检查**

**目标**：防止敏感内容泄漏到 AI 上下文，同时保留对元数据的合法诊断访问（资源是否存在、key 名称、类型、Pod 状态等）。

## 整体方案

三种资源类型需要防护，各自特征不同：

| 资源 | 泄漏字段 | `get -o yaml/json` | `describe` | 默认 table |
|------|---------|---------------------|------------|-----------|
| Secret | `.data`, `.stringData` | CRITICAL 泄漏 | 安全（仅显示字节数） | 安全（名称/类型/计数） |
| ConfigMap | `.data`, `.binaryData` | HIGH 泄漏 | 泄漏（打印完整数据） | 安全（名称/计数） |
| Pod | `.spec.containers[].env[].value` | CRITICAL 泄漏 | 泄漏（显示 env 段） | 安全（仅状态） |

两层防御：
1. **执行后脱敏**（kubectl tool）：执行命令 → JSON 解析 → 替换敏感字段 — 保留诊断价值
2. **执行前拦截**（restricted-bash）：在管道中拦截敏感资源的结构化输出 — 无法在管道中途截获数据

两条执行路径：
- **kubectl tool**（`kubectl.ts`）：直接 `execFile`，无 shell — 可做执行后脱敏
- **restricted-bash tool**（`restricted-bash.ts`）：shell 管道 — 只能做执行前拦截

**统一 JSON 脱敏策略**：不做 YAML 正则脱敏（YAML 缩进语义、多行字符串、flow style 让正则极易误判）。所有脱敏统一走 JSON 路径：
- 用户请求 `-o json` → 正常执行 → JSON 脱敏 → 返回
- 用户请求 `-o yaml` → 内部改为 `-o json` 执行 → JSON 脱敏 → 返回 JSON + 附说明

## 详细设计

### 模块 1：敏感资源检测与脱敏工具函数

- **做什么**：两条执行路径共享的检测函数 + kubectl tool 专用的脱敏函数
- **放在哪**：新文件 `src/tools/kubectl-sanitize.ts`
- **函数定义**：

```typescript
/** 需要输出脱敏的资源类型 */
type SensitiveResourceType = "secret" | "configmap" | "pod";

/**
 * 检测 kubectl 参数是否指向敏感资源类型。
 * 识别：secret, secrets, secret/<name>, configmap, configmaps,
 *       cm, cm/<name>, pod, pods, pod/<name>, po, po/<name>
 * 逗号分隔也处理：pod,secret → 返回第一个命中的类型
 * 跳过 flag 值（-n, -l, --namespace, --selector, --field-selector 等）
 */
function detectSensitiveResource(args: string[]): SensitiveResourceType | null;

/**
 * 解析 -o / --output flag。
 * 处理所有 kubectl flag 写法：
 *   -o json, -o=json, --output json, --output=json
 *   -o jsonpath='{...}', -o=jsonpath='{...}'
 * 返回格式名（如 "json", "yaml", "jsonpath", "go-template", "wide", "name"）
 * 对 jsonpath=..., go-template=..., custom-columns=... 用 startsWith 前缀匹配
 * 默认 table 输出返回 null。
 */
function getOutputFormat(args: string[]): string | null;

/**
 * 脱敏 kubectl JSON 输出中的敏感字段。
 * - Secret：无条件替换 .data, .stringData 所有值
 * - ConfigMap：按 key/value 模式替换 .data, .binaryData 中匹配的条目
 * - Pod：按 env name 模式替换 .spec.containers[].env[].value,
 *         .spec.initContainers[].env[].value,
 *         .spec.ephemeralContainers[].env[].value
 * 同时处理单个对象和 List 响应（遍历 .items[]）。
 * 也处理 catch 路径中的 err.stdout（kubectl 超时时可能已含部分输出）。
 * 返回脱敏后的 JSON 字符串 + 末尾警告注释。
 */
function sanitizeJSON(output: string, resourceType: SensitiveResourceType): string;
```

- **关键决策**：
  - 独立文件避免 `kubectl.ts` 膨胀
  - **不做 YAML 正则脱敏** — 统一走 JSON 路径，消除 `sanitizeYAML()`
  - Pod env 脱敏只针对 `.value`（硬编码值），**不动** `.valueFrom`（仅是引用，对诊断有用）
  - **Pod env 按名称模式脱敏**：仅脱敏 env name 匹配敏感模式的值，模式采用词边界匹配避免误杀
  - **ConfigMap 按 key/value 模式脱敏**：key 名或 value 值匹配凭证模式的条目脱敏，其余保留
  - **Secret 一律脱敏**：无条件替换 `.data`/`.stringData` 的所有值
  - 资源别名：`pod`/`pods`/`po`、`configmap`/`configmaps`/`cm`、`secret`/`secrets`
  - 逗号分隔多资源：`pod,secret` 按逗号分割检查
- **影响范围**：新增 `kubectl-sanitize.ts`，`kubectl.ts` 和 `restricted-bash.ts` 引入

### 模块 2：kubectl Tool 防护（`kubectl.ts`）

- **做什么**：在 `execute()` 中检测敏感资源访问，按输出格式脱敏或拦截
- **怎么做**：
  - 在子命令校验之后（针对 `get` 和 `describe`），调用 `detectSensitiveResource(args)`
  - 按输出格式处理：

| 格式 | 处理方式 |
|------|---------|
| 默认 table / `-o wide` / `-o name` | 放行（这些格式不含敏感数据） |
| `-o json` | 执行 → `sanitizeJSON()` → 返回 |
| `-o yaml` | 内部改为 `-o json` 执行 → `sanitizeJSON()` → 返回 JSON + 说明 |
| `-o jsonpath` / `-o go-template` / `-o custom-columns` | 执行前拦截（无法可靠脱敏模板输出） |

  - `describe` 子命令处理：
    - Secret：**放行**（仅显示字节数，安全）
    - ConfigMap：**拦截**（打印完整 data，人类可读格式正则同样脆弱，引导用 `get -o json`）
    - Pod：**拦截**（打印完整 env 段，引导用 `get -o json`）
  - 修复：在 `execute()` 中添加 `config view --raw` 检查（执行前拦截，L109-129 附近）
  - **catch 路径也脱敏**：`err.stdout` 中可能含部分敏感输出（如 kubectl 超时）
- **关键决策**：对 json 脱敏而非拦截 — 保留诊断价值（key 名称、元数据），仅移除敏感值；YAML 统一转 JSON 处理
- **影响范围**：`kubectl.ts`

### 模块 3：restricted-bash 管道防护（`restricted-bash.ts`）

- **做什么**：在 `validateKubectlInPipeline()` 中拦截管道里对敏感资源的结构化输出
- **怎么做**：
  - 对管道中每个 kubectl 命令调用 `detectSensitiveResource(args)`
  - 检测到敏感资源时（**仅 Secret 和 ConfigMap，Pod 不拦截**）：
    - `-o json/yaml/jsonpath/go-template/custom-columns`：**拦截**，提示使用 kubectl tool（有脱敏能力）
    - `describe configmap`：**拦截**，提示使用 kubectl tool
    - 默认 table / `-o wide` / `-o name`：**放行**（安全）
    - `describe secret`：**放行**（安全）
    - **Pod 在管道中不拦截**：Pod 是最常查询的资源，`kubectl get pods -o json | jq` 是极其常用的模式，拦截会严重影响诊断体验。Pod env 脱敏仅在 kubectl tool 直接执行路径处理
  - `config view --raw` 检查已存在，无需改动
- **关键决策**：管道中只拦截不脱敏 — 无法在管道中途截获数据。错误信息引导 agent 使用 kubectl tool
- **影响范围**：`restricted-bash.ts`

### 模块 4：测试

- `kubectl-sanitize.test.ts`（新建）：
  - `detectSensitiveResource()`：所有别名、带/不带名称、`type/name` 组合形式、逗号分隔 `pod,secret`、flag 穿插
  - `getOutputFormat()`：所有 flag 写法（`-o json`, `-o=json`, `--output json`, `--output=json`, `-o jsonpath='{...}'`）
  - `sanitizeJSON()`：
    - Secret：单个 Secret、SecretList、一律脱敏
    - ConfigMap：按 key/value 模式脱敏、保留非敏感条目
    - Pod：按 env name 模式脱敏、保留 `JAVA_OPTS` 等非敏感 env、处理 init/ephemeral 容器

- `kubectl.test.ts`（扩展）：
  - `config view --raw` 通过 kubectl tool 被拦截
  - `get secret -o json` 返回脱敏输出
  - `get secret`（默认 table）放行
  - `get configmap -o json` 返回按模式脱敏输出
  - `get pod -o json` 返回按模式脱敏 env vars
  - `get secret -o yaml` 内部转 JSON 并脱敏
  - `get secret -o jsonpath` 被拦截
  - `describe configmap` 被拦截
  - `describe secret` 放行

- `restricted-bash.test.ts`（扩展）：
  - `kubectl get secret -o json | jq .data` 被拦截
  - `kubectl get secret -A` 放行（默认 table）
  - `kubectl get configmap -o yaml | grep password` 被拦截
  - `kubectl get pod -o json | jq .spec` 被拦截
  - `kubectl describe configmap name | grep key` 被拦截

## 接口与数据结构

### 敏感模式常量

```typescript
/** Pod env name 匹配这些模式时脱敏对应 value（词边界匹配，避免误杀） */
const SENSITIVE_ENV_NAME_PATTERNS = [
  /password/i,                    // DB_PASSWORD, REDIS_PASSWORD
  /secret/i,                      // CLIENT_SECRET, SECRET_KEY
  /token/i,                       // ACCESS_TOKEN, AUTH_TOKEN
  /credential/i,                  // AWS_CREDENTIAL
  /api[_-]?key/i,                 // API_KEY, APIKEY
  /private[_-]?key/i,             // PRIVATE_KEY
  /[-_]key$/i,                    // SSH_KEY, ENCRYPTION_KEY (但不匹配 KEY_COUNT)
];

/** ConfigMap key 名匹配这些模式时脱敏对应 value */
const SENSITIVE_KEY_PATTERNS = [
  /password/i, /secret/i, /token/i,
  /credential/i, /private/i,
];

/** ConfigMap value 匹配这些模式时脱敏（不论 key 名） */
const SENSITIVE_VALUE_PATTERNS = [
  /:\/\/[^:]+:[^@]+@/,          // connection string: ://user:pass@host
  /^eyJ[A-Za-z0-9_-]{10,}/,     // JWT token
  /-----BEGIN .* KEY-----/,      // PEM private key
  /^(sk-|ghp_|gho_|glpat-)/,    // known API token prefixes
];
```

### JSON 脱敏示例

```json
// Secret 输入 — 一律脱敏
{ "kind": "Secret", "data": { "password": "cGFzc3dvcmQ=" } }
// Secret 输出
{ "kind": "Secret", "data": { "password": "**REDACTED**" } }

// ConfigMap 输入 — 按 key/value 模式脱敏
{ "kind": "ConfigMap", "data": {
  "db.url": "postgresql://user:pass@db/mydb",
  "log.level": "debug"
}}
// ConfigMap 输出 — db.url 匹配 connection string 模式脱敏，log.level 保留
{ "kind": "ConfigMap", "data": {
  "db.url": "**REDACTED**",
  "log.level": "debug"
}}

// Pod 输入 — 按 env name 模式脱敏
{ "kind": "Pod", "spec": { "containers": [{ "env": [
  { "name": "DB_PASSWORD", "value": "secret123" },
  { "name": "LOG_LEVEL", "value": "debug" },
  { "name": "API_KEY", "valueFrom": { "secretKeyRef": { "name": "app-secrets", "key": "apikey" } } }
]}]}}
// Pod 输出 — DB_PASSWORD 匹配脱敏，LOG_LEVEL 保留，valueFrom 不动
{ "kind": "Pod", "spec": { "containers": [{ "env": [
  { "name": "DB_PASSWORD", "value": "**REDACTED**" },
  { "name": "LOG_LEVEL", "value": "debug" },
  { "name": "API_KEY", "valueFrom": { "secretKeyRef": { "name": "app-secrets", "key": "apikey" } } }
]}]}}
```

## 决策记录

| # | 问题 | 决策 | 理由 |
|---|------|------|------|
| 1 | Pod env vars 脱敏粒度 | 按名称模式脱敏（词边界匹配） | Pod 是最常查询的资源，一律脱敏影响诊断；收紧后的模式避免误杀 `KEY_COUNT` 等 |
| 2 | ConfigMap 脱敏粒度 | 按 key/value 模式脱敏 | 绝大多数 ConfigMap 只有普通配置，一律脱敏降低诊断价值 |
| 3 | YAML 输出处理 | 统一转 JSON 脱敏 | YAML 正则脱敏不可靠（缩进语义、多行字符串、flow style），JSON.parse 确定性 100% |
| 4 | describe pod/configmap | 拦截（不脱敏） | describe 人类可读格式正则同样脆弱，引导使用 `get -o json`（有可靠脱敏） |
| 5 | jsonpath/go-template | 一律拦截 | 模板表达式分析复杂且易遗漏，agent 可用 `-o json` 替代 |

## 风险与边界情况

1. **`-o jsonpath=...` 前缀匹配**：`parseArgs` 不拆分 `=`，`getOutputFormat()` 必须用 `startsWith` 前缀匹配处理 `jsonpath=...`、`go-template=...`、`custom-columns=...`。
2. **资源类型别名**：必须处理 `secret`/`secrets`、`configmap`/`configmaps`/`cm`、`pod`/`pods`/`po`，以及 `type/name` 组合形式。
3. **逗号分隔多资源**：`kubectl get pod,secret -o json` — `detectSensitiveResource()` 须按逗号分割检查。
4. **List 响应**：`kubectl get secrets -A -o json` 返回 `{ kind: "SecretList", items: [...] }` — 脱敏必须遍历 `.items[]`。
5. **catch 路径泄漏**：kubectl 超时时 `err.stdout` 可能已含部分敏感数据，脱敏逻辑须覆盖 catch 路径。
6. **已知限制 — 间接资源**：不覆盖 Deployment/StatefulSet/Job 等高级资源的 `.spec.template.spec.containers[].env` 泄漏。这些资源的 pod template 中也可能含硬编码 env，但检测所有 K8s 资源类型不现实，留作后续改进。
7. **已知限制 — `all` 资源类型**：`kubectl get all -o json` 返回混合输出含 Pod，当前不拦截。
8. **性能**：JSON parse/re-serialize 对比 kubectl 执行时间开销极小。

## 预估

- 改动文件：~6（新增：kubectl-sanitize.ts, kubectl-sanitize.test.ts；修改：kubectl.ts, restricted-bash.ts, kubectl.test.ts, restricted-bash.test.ts）
- 改动行数：~450-550
