# 敏感数据泄漏防护 — 里程碑

> 基于 [DESIGN.md](./DESIGN.md) 生成

## 步骤总览

| # | 名称 | 描述 | 依赖 | 预估文件数 | 状态 |
|---|------|------|------|-----------|------|
| 1 | 检测与脱敏工具函数 | 新建 kubectl-sanitize.ts，实现 detectSensitiveResource、getOutputFormat、sanitizeJSON | 无 | 1 | ✅ |
| 2 | 工具函数测试 | 新建 kubectl-sanitize.test.ts，覆盖所有检测和脱敏逻辑 | #1 | 1 | ✅ |
| 3 | kubectl tool 防护 | 修改 kubectl.ts，接入脱敏/拦截逻辑 + 修复 config view --raw | #1 | 1 | ✅ |
| 4 | restricted-bash 管道防护 | 修改 restricted-bash.ts，在 validateKubectlInPipeline 中拦截敏感资源 | #1 | 1 | ✅ |
| 5 | 集成测试 | 扩展 kubectl.test.ts 和 restricted-bash.test.ts | #3, #4 | 2 | ✅ |

## 详细步骤

### Step 1: 检测与脱敏工具函数
- **目标**：新建 `src/tools/kubectl-sanitize.ts`，实现三个核心函数
- **涉及文件**：`src/tools/kubectl-sanitize.ts`（新建）
- **验收标准**：
  - `detectSensitiveResource()` 正确识别 secret/secrets、configmap/configmaps/cm、pod/pods/po 及 type/name 组合和逗号分隔形式，跳过 flag 值
  - `getOutputFormat()` 正确解析 `-o json`、`-o=json`、`--output json`、`--output=json`、`-o jsonpath='{...}'` 等所有写法
  - `sanitizeJSON()` 对 Secret 一律脱敏、ConfigMap 按 key/value 模式脱敏、Pod 按 env name 模式脱敏；处理单对象和 List 响应
  - 导出 `SENSITIVE_ENV_NAME_PATTERNS`、`SENSITIVE_KEY_PATTERNS`、`SENSITIVE_VALUE_PATTERNS` 常量
  - TypeScript 编译通过
- **对应设计章节**：DESIGN.md > 模块 1

### Step 2: 工具函数测试
- **目标**：新建 `src/tools/kubectl-sanitize.test.ts`，全面测试 Step 1 的函数
- **涉及文件**：`src/tools/kubectl-sanitize.test.ts`（新建）
- **验收标准**：
  - `detectSensitiveResource` 测试：所有别名、type/name 组合、逗号分隔、flag 穿插、非敏感资源返回 null
  - `getOutputFormat` 测试：所有 flag 写法、前缀匹配 jsonpath/go-template/custom-columns、无 -o 返回 null
  - `sanitizeJSON` 测试：
    - Secret：单对象 + SecretList，所有 data/stringData 值替换为 `**REDACTED**`
    - ConfigMap：匹配 key 脱敏、匹配 value 模式脱敏、保留非敏感条目
    - Pod：匹配 env name 脱敏（DB_PASSWORD）、保留非敏感 env（LOG_LEVEL）、不动 valueFrom、处理 initContainers/ephemeralContainers
    - JSON 解析失败时返回错误信息而非泄漏
  - 所有测试通过
- **对应设计章节**：DESIGN.md > 模块 4（kubectl-sanitize.test.ts 部分）

### Step 3: kubectl tool 防护
- **目标**：修改 `kubectl.ts` 的 `execute()` 接入脱敏/拦截逻辑
- **涉及文件**：`src/tools/kubectl.ts`
- **验收标准**：
  - `config view --raw` 在执行前被拦截（修复遗漏）
  - `get` + 敏感资源 + `-o json` → 执行后 sanitizeJSON 脱敏
  - `get` + 敏感资源 + `-o yaml` → 内部改为 `-o json` 执行 → sanitizeJSON → 返回 JSON + 说明
  - `get` + 敏感资源 + `-o jsonpath/go-template/custom-columns` → 执行前拦截
  - `get` + 敏感资源 + 默认 table / `-o wide` / `-o name` → 放行
  - `describe secret` → 放行
  - `describe configmap/pod` → 拦截
  - catch 路径中的 err.stdout 也经过脱敏
  - TypeScript 编译通过
- **对应设计章节**：DESIGN.md > 模块 2

### Step 4: restricted-bash 管道防护
- **目标**：修改 `validateKubectlInPipeline()` 新增敏感资源检测
- **涉及文件**：`src/tools/restricted-bash.ts`
- **验收标准**：
  - 管道中 kubectl + 敏感资源 + `-o json/yaml/jsonpath/go-template/custom-columns` → 拦截，错误信息提示使用 kubectl tool
  - 管道中 `describe configmap` → 拦截（Pod 不拦截，见 DESIGN.md）
  - 管道中 `describe secret` → 放行
  - 管道中 `kubectl get secret -A`（默认 table）→ 放行
  - 管道中 `kubectl get secret -o name` → 放行
  - 不影响现有非敏感资源命令（如 `kubectl get pods -o yaml | grep xxx`、`kubectl get deploy -o json | jq .`）
  - TypeScript 编译通过
- **对应设计章节**：DESIGN.md > 模块 3

### Step 5: 集成测试
- **目标**：扩展现有测试文件覆盖端到端场景
- **涉及文件**：`src/tools/kubectl.test.ts`、`src/tools/restricted-bash.test.ts`
- **验收标准**：
  - kubectl.test.ts 新增：config view --raw 拦截、get secret -o json 脱敏、get secret 放行、get configmap -o json 脱敏、get pod -o json 脱敏、-o yaml 转 JSON、-o jsonpath 拦截、describe configmap 拦截、describe secret 放行
  - restricted-bash.test.ts 新增：get secret -o json | jq .data 拦截、get secret -A 放行、get configmap -o yaml | grep 拦截、get pod -o json | jq 拦截、describe configmap | grep 拦截
  - 全量测试通过 (`npm test`)
- **对应设计章节**：DESIGN.md > 模块 4
