# L3 平台化 — v1 蓝图(2026-06-25 收敛)

> L3 = 把 kbc 从「一个人本地命令行用」变成「团队托管在线用」的服务。
> L1 规约 / L2 工具 已可本地端到端跑;L3 加多租户 + 托管 + 只读消费。
>
> **承重立场**:不自造"运行时 + 存储 + 评审 UI"三件套。
> 存储/数据面 = 复用一个 **git forge(Forgejo)当 headless git 托管**(只用它 ~10%:git 存储 + 版本 + 鉴权 + 多租户);
> 用户**完全不感知 forge**(它跑内网,我们的 web 在前面)。我们只造:**用户无感知的包装 UI** + **护城河(矛盾→裁决)**。

## 〇、一句话 v1

> **「本地交互编译模式 + 一个发布按钮 + 只读消费」,托管化。** 维护者体验 ≈ 丢文档 + 跟 agent 聊 + 点发布。

## 一、v1 锁定范围 —— 暴露给用户的就 5 件事

1. **丢 raw + 跟 agent 编** —— 维护者丢原始文档、跟编译 agent 对话,agent 按编译纪律(带源 / 矛盾不自裁 / 宁缺毋错)读写知识库。
2. **真矛盾,agent 在对话里问你裁** —— 不走 PR/issue,就在 chat 里问"这条按哪个理解",你一句话裁(=护城河,搬进对话)。
3. **验** —— 看 ①编译总结 ②待裁矛盾 ③试问效果(见 §五)。
4. **发布一版** —— 点发布 = 切一个不可变版本(git tag),自动可回溯。
5. **只读消费** —— 消费者对**已发布的那一版**问答(只读、带源),看不到草稿。

**v1 明确不做(写下来,不是忘了):** 逐次审/PR 流程、并发/多写冲突处理、多人协作/独立审核者/技能空间、批量操作、容器编排/K8s、webhook、计费配额。前提:维护者就一两个、私下对齐。团队大了再加。

## 二、两个区 + 发布闸(替代"逐次审")

- **草稿区**:维护者 + agent 随便改,无门槛。
- **发布区**:不可变版本,**消费者只看这个**。
- **发布闸** = 唯一保留的"门" = 一个郑重的"发布"动作 = 打 tag。它**白送"可回溯"**(每版一个 tag,随时回退)。

> 区分两种"审":**逐次审改**(每个改动等人批准)→ ❌ 砍(协作才需要);**发布闸**(草稿→郑重发布不可变版)→ ✅ 留(否则读者读到半成品)。

## 三、forge 的角色:headless git 托管(用 ~10%)

你的 5 个底层需求,逐个落到 git:读写=文件;**并发+合并 / 行级版本 / 改前可审 = git 的本职**;鉴权/多租户。

- **存储内核必须是 git**(行级 diff / 三方合并 / 历史)——S3 版本 / Nextcloud / DB 出局(blob 级、无行级合并、无审/无回溯语义)。
- **全套 forge vs 裸 git**:裸 git 更小,但鉴权 / 多租户 / 审核写要自己拼;Forgejo 单容器 + sqlite,**白送这些**,资源极轻 → v1 选 Forgejo。
- **只用 git 存储 + tag 版本 + 只读访问 + token 鉴权 / org 多租户;不用它的 issue/PR 界面。**
- 换掉它的条件:若砍掉"多租户 + 鉴权 + 发布区隔离",裸 git 即够,forge 变多余。当前不满足,故留。

## 四、两个面:维护(写) / 消费(只读)—— 同一 git 底座

| | 维护模式(写) | 消费模式(只读) |
|---|---|---|
| 谁 | 库的 owner/维护者(一两个) | 问问题的人 / siclaw 挂载 |
| 看到啥 | 我们的编译 web:聊天编 + 矛盾卡片 + 试问 + 发布 | 只读问答框,挂已发布版 |
| 权限 | forge write | forge read-only |
| 行为契约(**装载**) | `constitution.md` 裁决纪律 | consume 契约(只用库内容/带源/未覆盖诚实/拒变更命令) |
| 隔离 | —— | **物理无写路径**:只读已发布 bundle,连不到草稿/编译 |

> 维护者的"试问"和消费者的"问答"是同一个东西,只是一个连草稿、一个连已发布版。

## 五、审核面 = 编译总结 + 矛盾卡片 + 试问(**不是逐行 diff**)

逐行 diff 是给代码用的;我们的产物是"给人问答的知识",agent 会重写/重组织文字 → 逐行 diff 全是无语义噪音。我们**关注问答效果**,所以审核面是:

1. **编译总结** —— agent 抛:读了哪几篇 → 产出哪些页 → 自动并了哪些矛盾(FYI)→ 留了哪些给你裁 → 哪些"未覆盖"。(来源:账本 findings + resolutions,已有)
2. **待裁矛盾卡片** —— 真冲突:证据内联 + 选项①②③④,点一下裁。(来源:账本 parked,护城河)
3. **试问框** —— 发布前自己问几句,看带源回答对不对 = 按"问答效果"验收。(来源:消费模式 / `kb_eval`,已有)

> 这三样 kbc **现在都有**(总结=读账本、矛盾=parked、试问=消费/闸),UI 只是把它们呈现出来,不用新造引擎。

维护者界面示意(信息架构,非风格):
```
┌─ 知识库 X ───────────── [草稿]●──○ 已发布 v? ─┐
│ banner:草稿中 · 点"发布"才对只读用户可见        │
│ 📋 编译总结:5篇→12页;自动并10处;待裁2处;未覆盖3处 │
│ 🟡 待你确认(2) ▸ 试用额度 90 vs 30 天 [①90][②30][③各有条件][④存疑]│
│ 💬 试问:[ 问题… ] → 带源回答                    │
│ [ 发布这一版 ]                  📜 版本历史(抽屉)│
└──────────────────────────────────────────────────┘
```

## 六、UI 蓝本:轻参考 siclaw skill 生命周期 —— 但**风格不锁**

siclaw 的 skill 已是"草稿→发布版本→可回溯"模型(banner 文案就有"草稿仅测试环境、发布才进生产")。**轻参考它的信息架构/交互模式,不复刻**:

- **拿**:生命周期圆点条(草稿→已验证→已发布)/ 版本时间线抽屉 + 回滚(每版详情=该版"编译总结",非逐行 diff)/ 状态 banner / 矛盾卡片(借其"审批卡内联手风琴"骨架,内容换成证据+选项)/ 卡片·抽屉·对话框架构(少页面)。
- **弃**:逐行 Diff 预览 / 独立审核者 track / 全局贡献 / 技能空间 / 批量。
- **可直接抠的自包含组件**:`SkillLifecycleStatus.tsx`、`components/VersionHistoryDrawer.tsx`、状态 banner。源:`/Users/sdliu/project/siclaw_main/src/gateway/web/src/pages/Skills/`。

> ⚠️ **视觉风格不固化**。只锁信息架构/交互模式;具体风格做前端时再定。
> 风格参考:已有 **8080 消费面 demo**「GPU 选型知识库·证据台」(`~/test-gpu-kb/app/`,uvicorn gpuwiki.server),带源/证据式问答 —— 或另找合适前端 sample。

## 七、自造 vs fork 红线(护城河不外包)

- **fork(底座,别重写)**:Forgejo(git 存储 / tag / 鉴权 / 多租户)。
- **自造(~30%,护城河)**:① 用户无感知的包装 web(聊天编 / 编译总结 / 矛盾卡片 / 试问 / 发布)② 矛盾→自裁/升级裁决环(已验)③ 两个 KB 专属闸指标(bundle 自矛盾 + 源→编译 coverage)。
- 消费问答 / 发布闸:kbc 已有,平台化只是套只读壳 + 接已发布版。

## 八、对已写代码的影响

- `platform/forge_client.py` —— **留**(数据面访问层)。v1 需补:**提交文件** + **打 tag/release**。当前的 issue/PR 方法降为"暂不用"。
- `platform/bridge.py`(矛盾→forge issue)—— **v1 搁置**(矛盾在 chat 里裁,不上 forge issue;若将来要异步/多人审再启用)。
- `worker.py` —— 形态待定(见 §九)。

## 九、运行时(轴 B:远程跑编译 agent)

与"人在哪评审"正交。v1 = 在服务器上跑 headless `claude -p`(`llm.py` 已是这后端,复用订阅鉴权、无需 key;GPU 库消费已验)或保活一个服务器端 agent 会话。容器化(Docker per-job / agentbox)= v2。

## 十、待定 / 承重假设

- **承重假设(已认)**:forge-centric(平台=包装 + headless forge),非 bespoke runtime。
- Gitea vs **Forgejo**(倾向 Forgejo,治理更开放)。
- UI 视觉风格:待选(§六)。
- 运行时形态(§九):v1 headless,v2 容器。

## 十一、平台基础能力矩阵(v1)—— 每条对到实现 + 状态

> 状态:✅验=有实现且真跑过验证 / ✅有=有实现(L2 既有或已写) / 🟡=进行中 / ⏳=明确 v2。

**A. 数据面 / 存储(Forgejo headless git 托管)**
| 能力 | 实现 | 状态 |
|---|---|---|
| git 存储(版本/历史/diff) | `platform/forge/docker-compose.yml`(Forgejo 11) | ✅验 |
| 多租户(org/仓) | Forgejo org/repo | ✅有(单仓 kbc/aliyun-fc) |
| 鉴权(读/写 token) | Forgejo token + `.kbc.token` / `.kbc.ro.token` | ✅验 |
| 只读隔离(消费无写路径) | 只读 token(read:repository) | ✅验(写被拒 401) |

**B. 数据面访问层 `platform/forge_client.py`**
| 能力 | 方法 | 状态 |
|---|---|---|
| 读写仓文件 / 多文件一次提交 | get_file / put_file / commit_files | ✅验 |
| 打 tag/release / 列版本 / 列文件树 | create_release / list_releases / list_tree | ✅验 |
| issue / 分支 / PR | open_issue·get_comments… / create_branch / open_pr | ✅有(v1 搁置) |

**C. 维护侧(编)**
| 能力 | 实现 | 状态 |
|---|---|---|
| 丢 raw(drop 文件 CRUD,自动留痕) | git/forge(commit_files) | ✅有(git 天然 diff) |
| 拉 raw / 推 bundle(repo↔本地) | `platform/repo_sync.py` pull/push_bundle | ✅验(pull)/🟡(push 整环中) |
| 编译(raw→bundle:ingest→compile→emit) | `tools/{ingest,compile_loop,emit}.py` | ✅有(L2) |
| 编侧整环编排(pull→编→push) | `platform/compile_repo.py` | 🟡 后台验证中 |
| 矛盾裁决(护城河) | `tools/triage.py` / v1 在 chat 裁 | ✅有(L2) |
| 编译总结 | ledger findings → 发布说明 | ✅验 |

**D. 发布闸**
| 能力 | 实现 | 状态 |
|---|---|---|
| 发布一版(打 tag,郑重动作) | `platform/publish.py` + create_release | ✅验(v1) |
| 发布说明=编译总结 | publish.summary_from_ledger | ✅验 |
| 可回溯(版本历史/回滚) | git tags / list_releases | ✅验(列版本)/ 🟡回滚 UI(前端) |

**E. 消费侧(只读问答)**
| 能力 | 实现 | 状态 |
|---|---|---|
| 取已发布版(只读) | `platform/consume.py` fetch_published(@tag) | ✅验 |
| 带源问答(consume 契约) | consume.answer + `tools/llm.py` | ✅验(fc=300/fc-2-0=100 各带源) |

**F. 运行时(轴 B)**
| 能力 | 实现 | 状态 |
|---|---|---|
| 远程跑编译/问答 agent(headless,无需 key) | `tools/llm.py`(claude -p) | ✅验 |

**G. 明确 v2 / 未做(写下来不是忘了)**
| 能力 | 归属 |
|---|---|
| webhook 自动触发(drop diff→自动编) | v2(核心 `compile_repo` 不返工,外包一层) |
| 包装前端 UI(维护 web / 消费 web,§六 轻参考、风格待定) | L3 后段 |
| 增量编译(只重编受影响子图,`sources.hash` 已设计) | v2(v1 小库全量重编) |
| 多 worker / 容器编排 / 计费配额 / 多人协作审核 | v2 |

**v1 端到端验收线**:`drop/` 文件 → 编 → 发布 v1 → 只读消费带源答 —— 已逐段验证;`compile_repo` 整环(后台)跑通后,这条线全程自动化(手动触发)即闭合。
