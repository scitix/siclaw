# Phase 模型:可组合的能力,不是死流水线

> **原则**:框架由若干 **phase(能力单元)** 组成,每个 phase 有清晰的 `输入 → 输出` 契约。
> phase 之间**不互相焊死**——通过共享物(raw / 归一态 / 账本 / bundle / 出处)传递,可**自由组合、按需触发**。
> **除"编译核心"外,每个 phase 都是可选的。** 流程是"按需拼 phase",不是"跑一条固定的环"。

## phase 清单(各自的契约)

| phase | 工具 | 输入 → 输出 | 触发时机 | 可选? |
|---|---|---|---|---|
| **ingest** | `ingest.py` | raw 文件树 → 归一 md + 出处 | 有异构源时 | 可选(本就是 markdown 就跳过) |
| **compile** | `compile_loop.py` | 归一 md → OKF 断言/bundle + 账本(检矛盾→裁决) | 要建/更新知识 | **核心**(最小不可省) |
| **audit** | `kb_audit.py` | bundle → 链接/孤儿等 lint | 任意时刻想体检 | 可选,可对任意 bundle 单跑 |
| **eval(发布闸)** | `kb_eval.py` | bundle + 题集 → 过闸判定 | 发布前想压测 | **可选**,可对任意 bundle 单跑、不依赖编译 |
| **update(增量)** | `compile_loop.py`(重入) | 变更的 raw → 只重编受影响子图 | raw 改了 | 可选(就是 compile 的重触发) |
| **serve(消费)** | (消费端 / siclaw 挂载) | bundle → 带源回答 | 上线问答 | 可选 |

## 怎么组合(都是合法路径)

- 只想给一个**已有 bundle** 体检:单跑 `audit`,不碰编译。
- 只想**压测**别人给的 bundle 够不够格:单跑 `eval`,不碰编译(发布闸是纯消费侧)。
- 标准建库:`ingest → compile`,想要质量门再 `→ eval`,不想要就停在 compile。
- raw 改了:`ingest(变更文件)→ compile(重入,增量)`,按需再 `eval`。
- 源本就是干净 markdown:跳过 ingest,直接 `compile`。

## 为什么这样切(设计立场)

- **每个 phase 自带契约、能独立跑** → 谁都不绑谁;新 phase 加进来只需声明 `输入→输出`。
- **共享物是接口,不是调用链**:账本(编译状态)、bundle(OKF 产物)、出处(回源)是 phase 间唯一耦合点;
  phase A 不直接 call phase B。
- **可选优先**:发布闸、audit、增量、ingest 都可缺省。最小可用 = 一个 compile。
- **按需触发**:同一个 phase 可被多种事件触发(compile 既是首次建库、也是增量更新、也是反哺重编)。

> 反面教材:把 ingest→compile→audit→eval→serve 写成一个固定顺序、缺一不可、互相 import 的大循环。
> 那会让"我只想 lint 一下"或"我只想压测别人的 bundle"变成做不到的事。**别焊死。**
