# kbc — 知识库编译框架(机制层,域无关)·工作名

> 把任意一棵本地文档树,编译成标准 OKF bundle、可测试、人在环只裁不可约的矛盾。
> **本仓只放"机制",不放"内容"。** 任何库的具体知识(分类法/不变量/敏感规则/覆盖逻辑)
> 都不在这里——它们由 Profile 注入、由宪法装载、或由 Claude Code 按需现造并登记。

## 铁则(设计第一原则)

**不假设用户的库长什么样**——不假设格式(可以是 ppt/表/图/doc/md 混合)、
不假设结构、**也不假设它该用哪套方法论**。我们自己那套(kb-method)是 infra/SRE 口味的
**一个特定实例**,不是普世法,所以它留在 `~/project/kb-method` 当参考宪法,不进本仓。

唯一普适假设:`bundle_root` 指向一棵 OKF markdown 树。

## 脊椎 / 叶子

- **脊椎(本仓发,域无关,always)**:解析任意文件 · 受治理编译/裁决/闸循环 · 通用 lint · Profile/宪法装载器。
- **叶子(per-KB,条件/动态)**:覆盖账本、敏感扫描、领域计算器等——Profile 注册了才点亮;
  没有的工具,Claude Code 按需现造,**造一次即捕获+版本化+登记进 `tools_registry`**(保证可复现)。

## phase 模型:可组合,不是死流水线

phase 之间不互相焊死,**自由组合、按需触发,除编译核心外都可选**。详见 [`design/phases.md`](design/phases.md)。
LLM 调用走 **headless Claude Code**(`tools/llm.py`,复用 Claude Code 鉴权、**无需 API key**;可换 Messages API SDK 后端)。

## 环境

```bash
/usr/bin/python3 -m venv .venv
.venv/bin/pip install pdfplumber python-pptx openpyxl pyyaml   # 解析 + Profile/题集
```

## phase 工具

| phase | 工具 | 干什么 |
|---|---|---|
| **ingest** | `ingest.py` | 异构文件(pdf/pptx/xlsx/图/文本)→ 归一 md + `@prov` 精确出处(回源=重读本地文件)。引擎可插拔,高保真升级件=Docling 后接 |
| **compile**(核心) | `compile_loop.py` + `triage.py` | 归一 md → 抽 OKF 断言 + 跨源检矛盾 → 裁决(自裁/升级成领域 MCQ)→ 账本。状态机见 [`design/compile-loop.md`](design/compile-loop.md) |
| **emit** | `emit.py` | 账本 → 标准 OKF bundle(按主题聚页、frontmatter+type、每条带源、矛盾按裁决落地、写 index.md) |
| **audit** | `kb_audit.py` / `lint_links.py` | 通用链接 lint 脊椎 + Profile 驱动的可选叶子 |
| **eval(发布闸)** | `kb_eval.py` | 题集压测 bundle(蓝队只读 bundle 答题 + 裁判判分 + 阈值过闸)。**可选**,可对任意 bundle 单跑 |

```bash
.venv/bin/python tools/ingest.py --src <文件或目录> --out out/ingested/
.venv/bin/python tools/compile_loop.py --ledger out/ledger.json --ingested out/ingested/ --constitution <宪法文件>
.venv/bin/python tools/emit.py       --ledger out/ledger.json --out out/bundle/        # 账本 → OKF bundle
.venv/bin/python tools/kb_audit.py   --profile examples/profile.siflow.yaml
.venv/bin/python tools/kb_eval.py    --bundle out/bundle/ --questions <题集.yaml>      # 可选发布闸
```

闭环实测:`raw 冲突源 → ingest → compile(检矛盾) → triage(升级领域MCQ) → 人裁 → emit(矛盾按裁决落地的 OKF bundle) → lint(合法) → 发布闸(可消费)`。

`profile.schema.yaml` = Profile 字段说明。`examples/` = 两个真实库的 Profile。宪法/题集/Profile 都是**装载的 per-KB 内容**,不在 `tools/` 代码里(grep 闸守零黑话)。
