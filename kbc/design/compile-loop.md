# 编译环状态机(阶段③ · 心脏 · 草案 v0)

> 自驱编译:读账本 → 编下一批 → 记三态 → 能自裁的自裁、不可约的攒成领域选择题 →
> **绕过 block 继续编,只剩 block 才停**。状态全在账本+git,任意时刻可中断/恢复。
>
> **机器是机制(框架发,域无关);"什么算可自裁/怎么裁"由装载的宪法说了算(per-KB)。**
> 本文件只定义编排骨架,不内置任何库的具体分类法。

## 一、持久状态 = 账本(resume 与增量都靠它)

```
ledger（json 或 sqlite,随 bundle 进 git）:
  sources : [{anchor_id, src_file, loc, hash, status}]    # 来自 ingest 的 provenance
            # status: pending | compiled | parked
  nodes   : [{node_id, type, from_anchors[], hash}]        # 产出的 OKF 节点 + 反向出处
  findings: [{finding_id, kind, refs[], status, resolution, mcq}]
            # kind: dup | contradiction | gap
            # status: auto_resolved | parked | ruled
            # resolution: 规则名 或 人裁结论(含 "ruled by human @date")
            # mcq: 若 parked,这里存框好的领域选择题(证据内联+预分类选项)
  rounds  : {dry_count, last_progress_at}                  # 收敛守卫
```

- `sources.hash` = 增量的钥匙:raw 文件变了 → hash 变 → 该 anchor 及其下游 nodes 标重检。
- `findings` 去重靠 `kind+refs` 指纹:**同一个矛盾只 park 一次**(否则每轮重复抛,永不收敛)。

## 二、状态与迁移

```
        ┌──────┐  装载 profile/宪法 + ingest 语料 + 账本(无则建空)
        │ INIT │
        └──┬───┘
           ▼
   ┌────────────────┐   有可推进批次? ── 是 ─────────────▶ COMPILE_BATCH
   │     SELECT     │   无,但有 parked ───────────────▶ PARK ─▶ WAIT_HUMAN
   │  (读账本选活)  │   无,且无 parked ─▶ DRY? ─ <K ─▶(回 SELECT)
   └───────▲────────┘                          └─ ≥K ─▶ CONVERGED
           │
  ┌────────┴─────────┐  抽取→结构化成 OKF→去重/织链→检测矛盾
  │  COMPILE_BATCH   │  成功结构化的 → nodes ✅ compiled
  └────────┬─────────┘
           ▼  每个 finding 过一遍
     ┌───────────┐   宪法.classify(finding) ──┐
     │  TRIAGE   │   可自裁 ─▶ AUTO_RESOLVE ─▶ ✅ ─▶ 回 SELECT
     │ (护城河)  │   不可约 ─▶ PARK_ITEM(框成 MCQ,攒批)─▶ 回 SELECT
     │           │   没理解 ─▶ PARK_ITEM(标存疑,攒批)─▶ 回 SELECT
     └───────────┘

  WAIT_HUMAN ── 人裁到达 ──▶ BACKFILL(回填固化)──▶ 回 SELECT
  [raw 更新事件] ─▶ 按 hash 标受影响 nodes 重检 ─▶ 重新进 SELECT
```

**逐状态:**

| 状态 | 做什么 | 出口 |
|---|---|---|
| **INIT** | 装载 profile/宪法/语料/账本 | → SELECT |
| **SELECT** | 从账本挑下一批可推进的活:未编的源 anchor / 被人裁解锁的 parked / 被增量标重检的 node | 见三 |
| **COMPILE_BATCH** | 对该批:抽取断言(带 provenance)→ 按宪法结构化成 OKF 节点 → 与既有去重/织链 → 检测矛盾。成功的写 nodes ✅ | → TRIAGE(逐 finding) |
| **TRIAGE** | 调 `宪法.classify(finding)` 决定走向(**这是护城河的判断点,机器只分派,规则在宪法**) | 三选一↓ |
| **AUTO_RESOLVE** | 套宪法默认裁法(如并列标注/留新/标记),记 resolution+provenance,该项 ✅ | → SELECT |
| **PARK_ITEM** | 把框好的领域 MCQ(证据内联+预分类选项+"我也不确定"逃生口)写进待对齐批,该单元 parked | → SELECT(**继续绕**) |
| **PARK** | 只剩人能裁了:把待对齐批整批抛给人,持久化,挂起 | → WAIT_HUMAN |
| **WAIT_HUMAN** | 挂起(用 fork 的循环运行时的 interrupt/WAITING_FOR_CONFIRMATION),零算力等 | 人裁到达 → BACKFILL |
| **BACKFILL** | 应用人裁:矛盾→compiled(记人裁结论+date),解锁依赖项 | → SELECT(恢复) |
| **CONVERGED** | 无可推进、无 parked、干涸 ≥K 轮 = 编译完成,交阶段⑥发布闸 | 终态(至 raw 更新或新问题再入) |

## 三、两个停止条件(必须分清)

- **PARK(block)**:能编的都编了,**剩下全是只有人能裁的**。→ 抛 MCQ 批,等人。
  这是你说的"block 到底再停"。**注意:不是撞到第一个 block 就停,是把 block 攒着、绕过去继续编,只剩 block 才停。**
- **CONVERGED(干涸)**:没有可推进的,也没有 parked,且连续 K 轮无新进展。→ 真停,交发布闸。
  `dry_count` 防空转(agent 老"觉得还有的理解"导致无限循环)。

## 四、护城河的纪律(TRIAGE 不塌的关键)

1. **默认 park,不默认猜**:只有宪法给出确定性规则时才 AUTO_RESOLVE;否则 PARK_ITEM(存疑不硬编)。
2. **但别淹没人**:宪法的自裁规则吃掉大头(如"口径差异→并列"),只有真领域分叉才 park。
3. **一个矛盾只 park 一次**(按 `kind+refs` 指纹去重),否则永不收敛。
4. **攒批再抛**:PARK_ITEM 只入队,PARK 才整批抛给人——不逐条打断。

## 五、resume / 增量(阶段④的接入点)

- **resume**:每次迁移都持久化账本 + 把 OKF 节点写盘。任意中断后重入 = 重读账本,从 SELECT 续,幂等。状态不在对话里。
- **增量(阶段④)**:外部"raw 更新"事件 = 比对 `sources.hash`,变了的 anchor → 其下游 nodes 标重检 → 注入 SELECT。**只重编受影响的子图 + 邻居 + 在 delta 上重跑矛盾检测,不全量重来。** 别人没 provenance 就只能全量重编 —— 这是护城河的延伸。

## 六、边界(本草案不含)

- COMPILE_BATCH 里"抽取/结构化"的具体智能 = agent 在宪法约束下干的活,本文件只定义它何时被调度、产物如何记账。
- MCQ 的框法质量 = 已单独验证(领域语言+证据内联+预分类选项)。
- 发布闸(阶段⑥)= 下游,CONVERGED 后接。
