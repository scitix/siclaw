# platform/ — L3 适配器原型(平台无关 base 的"托管层"实验)

kbc 是**平台无关的知识库"编译+测试"base**(编译大脑 + 护城河 + 适配器接口)。
`platform/` 放的是把 base **托管化 / 集成进某平台**的**适配器原型**——证明接口、跑通链路,
不是生产代码。第一个真落地(sicore)在**另一个仓的 worktree**里设计(见文末)。

详见 `../design/L3-platform.md`(standalone v1 蓝图)。

## 里面有两块

### 1. forge 适配器(standalone:git forge 当存储底座)
把"一个 git forge(Forgejo)"当 KB 的存储/版本/发布/消费底座的原型。

| 文件 | 作用 |
|---|---|
| `forge/docker-compose.yml` | 本地起一个 Forgejo(headless git 托管) |
| `forge_client.py` | forge REST 的哑封装(issue/文件/分支/PR/tag/tree),域无关、纯 urllib |
| `publish.py` | 发布闸:bundle → commit + release/tag(发布说明=账本编译总结) |
| `consume.py` | 只读消费:取已发布 tag 的 bundle + 带源问答(经 `tools/llm.py`) |
| `repo_sync.py` / `compile_repo.py` | 编侧整环:repo drop/ → 编译 → bundle 回 repo |
| `bridge.py` | 矛盾 ↔ forge issue 翻译(v1 搁置,矛盾改走 chat) |

**已验**:发布 v1 → 只读 token 取版本(写被拒 401)→ 带源问答正确;`compile_repo` 整环(pull→ingest→compile→emit→push)跑通。

### 2. pod/ — 编译 runtime(平台无关:Agent SDK 编译 pod)
把 kbc 编译大脑跑成一个 **Claude Agent SDK** `query()` 任务,可容器化。

| 文件 | 作用 |
|---|---|
| `pod/compile_agent.py` | 入口:Agent SDK 跑 kbc 大脑,读 drop→编→写 bundle |
| `pod/Dockerfile` | py3.11 + `claude-agent-sdk`(自带 claude 二进制)+ 非 root |
| `pod/README.md` | 本地订阅 vs 生产 massapi 鉴权说明 |

**已验**:本地实测 drop → 4 页 OKF bundle(带源、矛盾按宪法版本并列、$0.77、订阅鉴权无需 key)。容器:镜像 builds、非 root 跑;**生产需 `ANTHROPIC_BASE_URL`→massapi**(订阅鉴权不进容器)。

## 与 sicore 落地的关系(重要)

> 这些是 **base 适配器原型**。**第一个真落地 = sicore**,它**复用 sicore 自己的 `siclaw_knowledge` 模块 + Temporal**,**不用 Forgejo**。
> 那套落地设计在 sicore 仓的 worktree:`~/project/sicore-kb-authoring` → `docs/design/kb-authoring-platform.md`。
> forge 这套保留为:① 接口参考 ② 给非 sicore 客户的 standalone 部署选项。
> `pod/` 这套(Agent SDK 编译)**会复用**——它就是 sicore 编译 pod 镜像里要跑的东西。
