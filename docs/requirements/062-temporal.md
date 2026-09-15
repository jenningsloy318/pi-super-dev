# Temporal — Durable Execution 及其对我们 harness 的启示

Status: reference / external research (2026-09-15) — 在线研究 + 源码核实；非 super-dev spec，是 058/059 之外的旁证输入
 researched for: pi-super-dev 的 resume / checkpoint / convergence 机制（对照学习，非采用）
Sources: 见文末「来源」；关键事实均带出处，未核实的标注为 [未证实]

---

## 0. 一句话

Temporal 干的事叫 **Durable Execution（持久化执行）**：你的代码就算跑到一半服务器被拔了电源，重启后它能**精确地从上次中断的那一行继续往下跑**。变量、状态、执行上下文全部自动保持。你写代码不需要写几十个 try-catch 和死循环轮询，只要当它永远不会宕机一样写正常逻辑（「code the happy path, Temporal handles the errors」）。

难怪连 Cursor、Lovable 这类重度依赖长时多步骤 Agent 的产品，底层都搭在 Temporal 上（Cursor 已自己证实，见 §7；Lovable 有员工公开分享但未核实细节，见 §7 注）。

**为什么这值得 super-dev 认真读**：Temporal 解决的问题域和我们的 resume-cache + checkpoint-rollback + convergence loop **是同一个问题域**——「一个跑几小时、会失败、要能接着跑完的多步骤流程」。我们的 v0.4.3 事故（resume cache 被 phase commit 吞掉、rollback 静默截断）**正是 Temporal 的架构在结构上不可能犯的错**。下面逐条拆解，最后给出我们能偷的具体 pattern。

---

## 1. 公司与产品事实

| 项 | 事实 | 出处 |
|---|---|---|
| 公司 | Temporal Technologies，2019 年创立 | temporal.io/about |
| 创始人 | Maxim Fateev、Samar Abbas；二人在 **Uber** 内建了开源项目 **Cadence**（Temporal 的前身），Fateev 亦历经 AWS / Microsoft | temporal.io/blog/building-resilient-workflows… |
| 许可 | 开源 MIT；商业化产品为 Temporal Cloud | 同上 |
| 融资 | Series E $550M，估值 $12.55B | temporal.io/blog/temporal-raises-usd550m-series-e…（2026） |
| 必要依赖 | Server 运行**必须**有外部持久化库（Cassandra/Postgres/MySQL 等）——持久性完全依赖数据库写 | docs.temporal.io/temporal-service/persistence |

**关键设计起点**：Cadence→Temporal 的演化，核心是把「流程的状态」从应用进程里彻底外置成一个**独立持久化的 Event History**。这一条是理解后面所有 pattern 的根。

---

## 2. 核心心智模型：Workflow vs Activity

Temporal 的世界被一条纪律劈成两半：

- **Workflow（工作流）= 编排逻辑**。必须**确定性（deterministic）**。它不直接做 I/O、不调 LLM、不读时钟、不生成随机数。它只做一件事：**发 Command、等 Awaitable**。
- **Activity（活动）= 副作用**。一切非确定性（LLM 调用、工具调用、外部 API、DB、文件、网络）**必须**放在 Activity 里。Activity 天生**可重试**、结果被持久化进 history。

为什么这么劈？因为**重放（replay）**。

```
首次执行:  代码跑 → 生成 Command → Server 存成 Event
重放恢复:  代码再跑 → 生成 Command → SDK 与 Event History 比对
           匹配 → 用存储结果，继续
           不匹配 → NondeterminismError（立即、大声、流程卡住直到修代码）
```

Command ↔ Event 的对应是严格双射的（`ScheduleActivityTask`→`ActivityTaskScheduled`、`StartTimer`→`TimerStarted`、…）。

**非确定性的来源**（官方 determinism 文档明确列出）：时间（`Date.now()`）、随机（`Math.random()`/uuid）、外部状态（文件/环境变量/DB/HTTP）、非确定性迭代顺序（某些语言的 map/dict/set）、线程竞态。官方的处方是：**把这些统统搬进 Activity**，或用 SDK 提供的确定性变体。

**各 SDK 的保护级别不同**（值得我们知道「保护是分层的」）：Python 沙箱在运行时拦截并 abort；TypeScript 用隔离 V8 沙箱自动替换成确定性变体；Java/Go **没有沙箱**，只靠开发者约定 + `workflowcheck` 静态分析 + 重放时才暴露 `NonDeterministicException`。

> **→ 对我们的映射**：`src/nodes.ts` 的 node algebra（task/sequence/branch/choose/parallel/loop/retry/gate/map/wait/tryCatch）就是我们的 **Workflow 定义**；`delegation-backend.ts` / `agent-runtime.ts` 的 agent 派发就是我们的 **Activity**。这个劈分我们**已经做对了**——引擎逻辑（deterministicPhaseCommit、convergence governor）是确定性的，LLM 调用都在 delegation 里。但有一处我们**违反**了：reviewer 的 verdict 是自由散文、被 regex 解析后**直接驱动控制流**（`src/review-findings.ts` 自述「Reviewer severity is free-form LLM text (no schema enum)」）。在 Temporal 眼里这是「一个非确定性 Activity 的结果，没存成类型化 Event 就被 Workflow 消费了」——这正是 059 spec 的 `evidenceLoci` 和 R4 缝在补的东西。**Temporal 的模型是这个设计的正当性证明。**

---

## 3. 架构：把状态外置成不可变事件流

Temporal Server 内部四个独立可伸缩的服务 + 一个持久化层：

1. **Frontend**：gRPC 网关、限流、路由、鉴权。
2. **History**（有状态核心）：管理 workflow 的 **Mutable State**、把事件**追加**到 durable workflow history、基于 **shard** 管理定时器与队列。
3. **Matching**：托管 Task Queue，把 workflow task / activity task 派发给 worker。
4. **Worker Service**：跑平台自身的内部 workflow。
5. **Persistence**：唯一必需的外部依赖；存 history、mutable state、队列、visibility。

**这就是 v0.4.3 事故的结构性解药**。Temporal 里，Event History 是**独立持久化存储里的一条不可变追加日志**，**永远不会出现在 workflow 所写的内容树里**。所以在 Temporal 里，「rollback 把 history 截断了」这件事**在结构上不可能发生**——history 的生命周期根本不挂在应用内容树上。

我们的等价物对照：

| Temporal | super-dev |
|---|---|
| Event History（外部库，不可变追加） | `.resume-cache.jsonl` + `.convergence-ledger.jsonl`（在 spec 目录里） |
| Workflow 定义 | `src/nodes.ts` node algebra |
| Workflow 执行 | `runPipelineTask`（pipeline.ts） |
| Activity 结果 Event | resume row（key = `${id}@${scope}#${occurrence}`） |
| Worker / Shard | 单机 pi 会话 + run lock |
| 重放 | resume 回放已收敛 stage |

**我们与 Temporal 的结构性差异**：我们的「history」和「内容」**住在同一棵树里**（spec 目录）。v0.4.3 的 `neverGitTracked` untrack 是**让现实符合假设**的修补，但根因——「状态与内容共址」——没变。Temporal 的架构提示：**真正的 class-level fix 是把状态层移出内容树**（例如 `.super-dev-state/` 平行目录或独立的 sqlite）。这不是现在要做的，但是值得记的架构方向。

---

## 4. 失败处理：声明式重试，且**Workflow 默认不重试**

这是最直接可偷的一块。

**Activity 默认重试**，声明式，参数：

```
InitialInterval    = 1s
BackoffCoefficient = 2.0      （指数退避）
MaximumInterval    = 100 × InitialInterval
MaximumAttempts    = ∞（但被 timeout 兜底）
NonRetryableErrors = []
```

**Workflow 默认不重试**，官方明确给了理由（值得逐字读）：

> 「Retrying an entire Workflow Execution is not recommended due to the deterministic nature of Workflow replay. Since Workflows replay the same sequence of events to reach the same state, retrying the whole Workflow would **repeat the same logic without resolving the underlying issue** … can lead to unnecessary resource consumption and higher costs. Instead, retry failed Activities within the Workflow.」

以及：

> 「In most use cases, a Workflow failure would indicate an **issue with the design or deployment** of your application; for example, a permanent failure that may require different input data.」

**→ 这是对我们 convergence loop 设计的直接验证。** 我们的三层结构恰好就是 Temporal 的处方：

| Temporal 语义 | super-dev 现状 |
|---|---|
| Activity 级自动重试（指数退避） | `SUPER_DEV_TRANSIENT_RETRY_MS` 阶梯 2000/4000/8000/16000（workflow.ts） |
| NonRetryableError（permanent failure，立即暴露） | `fault-classification.ts` 的 **P5 agent-environment non-retryable** |
| Workflow 级**不**重试，而是 escalation / 人工 | convergence loop → judge → REPLAN / route-back |
| Schedule-to-Close timeout 兜底重试预算 | `SUPER_DEV_MAX_PHASE_WALL_MS` / run wall fuse（wall-fuse.ts） |

**三个我们还没有、但值得偷的 Temporal 语义**：

1. **Per-error next-retry-delay**：Activity 可以抛 `ApplicationFailure` 并**自带下一次重试延迟**，覆盖策略默认值。→ 我们的 reviewer 撞上 provider 限流时，只能走固定阶梯；若能让 agent 报「60s 后重试我」，就能避开无用重试（这正是 2026-09-13 antigravity 限流场景的痛点）。

2. **「MaximumAttempts 不推荐用于限制重试，推荐用 timeout 限总时长」**：官方明确建议**用墙钟预算而非次数**来兜底。→ 我们的 `SUPER_DEV_MAX_RUN_WALL_MS`（16h）+ per-phase wall 是对的方向；但我们同时还用了 `SUPER_DEV_MAX_PHASE_ATTEMPTS=4` 次数帽。Tempor 的经验说：**墙钟是主，次数是辅**。我们的 v0.4.2 demand-set laws（需求集单调缩减）+ v0.3.99 plateau governor 已经把次数帽变成了「进度分类」而非朴素重试，与此一致。

3. **Event History 的降噪语义**：`ActivityTaskStarted` 事件**在 Activity 彻底结束（或重试耗尽）之前不写进 history**——「to avoid filling the Event History with noise」。→ 我们的 `.resume-cache.jsonl` 记的是**完成的调用**；但 `audit.jsonl` / `usage-calls.jsonl` 记**每一次**尝试。前者是控制流（history），后者是可观测性（visibility）——**这两者不该混**。我们 v0.4.3 刚把状态文件 untrack，但 `audit.jsonl` 等仍是「history 里的噪声」。

---

## 5. 版本化：Build ID 与 Patching（对 REPLAN 的启示）

Temporal 有两套机制处理「代码变了但有一批流程正在飞」：

- **Worker Versioning（推荐）**：给 worker 打 **Build ID**，server 按版本路由 task，**保证在飞执行始终跑在启动它的代码版本上**。
- **Patching API `patched()`**（非版本化代码的内联分支，类似 feature flag）：在 history 里打 **marker**。语义精妙且有两处「反直觉」：
  - **非重放时** `patched()` 一律返回 `true` 并写 marker（所以官方建议**把最新代码放在 if-patched 块的顶部**，否则新执行会跑进旧分支）。
  - **重放时**若 history 里该点**没有** marker → 返回 `false`，**且之后永远返回 `false`**（即使重放结束跑新代码）。
  - 官方原话：**「the Workflow does not always run the newest code」**——这是**设计**，不是 bug：如果未来新代码依赖更早的 patch，它就该用旧代码。

**→ 映射到我们的 REPLAN（这是最值钱的一条对应）**：

| Temporal Patching | super-dev REPLAN |
|---|---|
| 部署新 workflow 代码时有一批执行正在飞 | REPLAN 发生时有一批 stage 已收敛 |
| Build ID 保证在飞执行跑旧代码 | **我们没有**——version skew 事故（在内存的 0.64 owner 派发磁盘上的 0.65 children，杀死全部 child，2026-09-04/05 观察到 3 次）**正是缺 Build ID 的直接后果** |
| `patched()` marker：细粒度、per-patch | REPLAN 的 resume-row 丢弃（replan.ts 的 stage→call-id-prefix drop）：**粗粒度**，owner + downstreamOf(owner) 整片丢弃 |
| 「does not always run the newest code」是设计 | 我们的 S-E（superseding orphaned ledger anchors，v0.3.97 058）和 059 的 `@owned/@inherited` 标签是同类意图，但靠 LLM 声明 |

**可偷的 pattern**：
- **marker 语义**（「重放时此点无 marker ⇒ 一路 false 到底」）是**确定性版本路由**的核心。我们的 resume row key `${id}@${scope}#${occurrence}` 已经近乎是 marker，但缺「**重放时校验 marker 存在性**」这一步——即：**resume 回放某 stage 时，应先校验它依赖的上游 anchor（scenario id / pinId / amendment family）在当前 artifacts 里仍存在，否则立即 fail-loud，而不是让 writer 跑出一个引用已消失 ID 的产物**。
- 这**正是 spec-26 REPLAN 的 trace-gate 死循环的 live specimen**（2026-09-13 22:24 观察）：重写后的 BDD 把 SCENARIO-014/030/002/044 重编号为 SCENARIO-050..089，spec writer 的重放引用了不存在的旧 ID，trace gate 4 轮全挂、每轮 ~13 分钟。**Temporal 会在第一次不匹配时抛 NondeterminismError，耗时 0。** → 这是我们最高性价比的可偷 pattern（见 §8 L3）。

---

## 6. 交互原语：Signal / Query / Update（对边界纪律的启示）

一个运行中的 workflow **只能**通过这三种方式被外部触及：

- **Query**：**只读、同步、必须立即返回**；**不能做异步 I/O，不能改状态**。
- **Signal**：**异步**，触发状态迁移，**不能返回值**。
- **Update**：**同步 request-response**，**会改状态**并返回结果。

另有 **Memo**（启动时给的元数据）：官方**警告**「Memos shouldn't store data that is critical to the execution」——缺类型安全、最终一致、**「Excessive reliance on Memos hides mutable state from the Workflow Execution History」**（Cloud 上限 40KB）。

**→ 映射**：
- Query ≈ 我们的状态查看（`omisis_status` / run 状态读取）。**Tempor 的纪律「Query 不能改状态」值得我们明确写进自己的契约**——我们的 status 读取走只读 reviewer，已经吻合。
- Signal ≈ `intercom`（异步、不阻塞）。
- Update ≈ judge escalation / REPLAN request（同步、改状态、有返回）。
- **Memo 的警告直接命中我们**：`audit.jsonl`、`run-metrics.jsonl`、sigma-bands 是可观测性，**绝不能驱动控制流**。我们已有这条意识的实例（sigma-bands 只做 outlier 标注，不做 gate），但 `usage-calls.jsonl`→预算检查是**用 Memo 当 history** 的边缘情形。

---

## 7. 谁在用：Cursor 的工程自述（含硬数字）

来源：Cursor 官方博客《What we've learned building cloud agents》（2026）。这是本 doc 里**证据最强**的一节。

- **演化路径**：最初是 **work-stealing 架构**（worker 抢 agent、循环跑到完），「把本地能跑的直接搬到服务器，很脆弱——cloud agent 早期 beta 可靠性只有**一个 9**」。后来发现自己在**重重复发明 Temporal 已有的 durable execution 原语**（重试、跨机调度、跨节点持久），于是**迁移到 Temporal**。
- **规模**：迁移后「跨过**两个 9**」；今天 Temporal 每天为 Cursor 处理 **>5000 万 actions / >700 万 unique workflows**；Cursor 内部 **>40% 的 PR 来自 cloud agent**（且在增长）。
- **能活什么**：inference provider 抖动、pod hibernate/resume、**跨天甚至跨周**的运行。
- **四条已验证的架构教训**（每条都对我们有用）：
  1. **「The development environment is the product」**——云 agent 输出质量的最大因子是有**完整开发环境**；缺了不报错，只是**输出质量微妙下降**，容易被误诊为「模型不行」。→ **我们的对照**：pi-omisis 的 python/venv/pytest 环境若不完整，implementer 的失败看起来像「agent 不行」。
  2. **从「eternal」workflow 拆成多个较短的、完成单任务就退出的 workflow**——「makes version upgrades easier」。→ **这正是我们的「partial → resumed pass」设计**（v0.3.95 之后用户改走 resume 而非 fresh run），以及 058 的 D-D checkpoint rollback。**Cursor 用了同样的方向并给出了理由：版本升级。**
  3. **agent loop / machine state / conversation state 解耦**——loop 住在 Temporal 里而非 VM 里，所以 pod 生命周期可独立管理（可换 pod 类型、只读 VM、预热 VM）；conversation 层用**append-only 存储 + 流式**，且**重试会 rewind 流**（「if a step fails after streaming partial output and then retried, the client can detect this, rewind its stream」）。→ **重试-rewind 语义我们缺**：一个 stage 失败重试时，我们渲染的报告没有 rewind 语义（rendered *.md 是幂等重渲染，近似但不等价）。
  4. **「Knowing how to get out of the way」**——早期不信任 agent，harness 每步 double-check、强制 commit、push；模型变强后**把逻辑从 harness 移进 agent 可控的 tools**（multi-repo 从硬编码变成「给 repo layout + branch/PR tools，让 agent 决定」；CI Autofix 从「harness 抓日志写进 VM」变成「给 GitHub CLI + 大输出写文件让它自己搜」）。**「The harness isn't going away so much as what it contains is changing.」**→ 这是对我们 **059 的 DEC-8「Writers declare; reviewers confirm」** 和「prompt-only 是 advisory（P4）」的独立佐证：**确定性该留在引擎，判断该还给 agent。**
- **下一步**：**self-healing environments**——让 agent 能**报告**「secret 缺失 / 网络被挡 / 环境阻止前进」并**自愈**（autoinstall）。→ **对照**：我们的 `appendEnvironmentFault`（v0.4.3 刚注册进 neverGitTracked）是「报告」的一半，「自愈」还没有。

**Lovable**：有员工（Jonathan Grahl）公开分享「how we use Temporal and Durable Execution at Lovable」，但**细节未经我们核实**，故标为 [未证实-细节]。原文档「Cursor、Lovable 底层全搭在 Temporal 上」——**Cursor 证实**，**Lovable 证至「在用」级别**。

**Vercel AI SDK 集成**（官方 blog + `@temporalio/ai-sdk`）：plugin **自动把每个 LLM 调用包成一个 Activity**（`temporalProvider.languageModel()` 替换 `openai()`，两行改动），工具调用显式声明为 Activity；卖点是「**No repeated API calls, no wasted tokens, no lost progress**」。→ **这正是我们 delegation 已在做的事**，但他们的关键是「**LLM 调用的结果被存成 history 里的 Event**」；我们的 verdict 散文没存成结构化 Event（又是 §2 的那个缺口）。

---

## 8. 对 super-dev 的可偷 pattern（按性价比排序）

### L1 — 「History 绝不活在内容树里」（class-level，架构方向）
Temporal 的 Event History 在独立持久化层。我们的 v0.4.3 用 `neverGitTracked` + common-dir `info/exclude` 让**假设成真**，但状态仍与内容共址于 spec 目录。**方向**：状态层外置（`.super-dev-state/` 或 sqlite），使「rollback 截断 history」在结构上不可能。**现在不做，但作为 058/059 之外的第三条架构轴记下。**

### L2 — Activity 结果必须类型化并落 history，才能驱动控制流
Temporal 的 Command↔Event 双射让重放**可校验**。我们的 reviewer verdict 是散文 + regex。**已在做**：059 的 `evidenceLoci` + R4 缝。**Cursor 的佐证**：conversation 层是 append-only 且**重试会 rewind**——结构化事件让「重试 vs 新结果」可区分。

### L3 — 重放确定性校验（把 13 分钟死循环变成 0 秒 fail-loud）★最高性价比
**偷 Temporal 的 `NondeterminismError` 语义**：resume 回放一个 stage 前，**先机械校验它引用的上游 anchor（scenario id / pinId / amendment family / protected-file pin）在当前 artifacts 里仍然存在**；不存在 → 立即 fail-loud（REPLAN 或 route-back），**不要**让 writer 跑出引用幽灵 ID 的产物。
- **真实代价（已测量）**：spec-26 REPLAN round 1 的 trace-gate 死循环，4 轮 × ~13 分钟 ≈ **52 分钟纯浪费**，全部因为 SCENARIO ID 被重编号后重放引用了旧 ID。
- 这是 058 的 S-E（ledger anchor superseding）和 059 的 `@owned/@inherited` 的**机械执行层**：LLM 声明是 advice，anchor 存在性校验是 mechanics（P4）。

### L4 — Per-error next-retry-delay
让失败 agent 报「多久后重试我」，覆盖固定阶梯（`SUPER_DEV_TRANSIENT_RETRY_MS`）。直接命中 provider 限流场景（2026-09-13 antigravity）。

### L5 — 墙钟为主、次数为辅（官方明确建议）
保留 run wall fuse 为主兜底；把 `MAX_PHASE_ATTEMPTS` 继续朝「进度分类」而非「朴素重试」演化（v0.4.2 demand-set laws / v0.3.99 plateau 已在此路径上）。

### L6 — Heartbeat（长 Activity 的生命线）
Temporal 的长 Activity **必须心跳**并配 `Heartbeat Timeout`，否则 worker 视其已死。**我们的对照缺口（已观察）**：phase 跑 1.5–2h，一个 **34 分钟零编辑**的 attempt 只被 completion guard 兜住（observation 166f8fe17c7b）。**手到擒来**：`tool-usage.jsonl` / `usage-calls.jsonl` 已是心跳数据，只需一个 **heartbeat timeout** 判据（N 分钟无工具调用/无编辑 → 升级），就能把「静默卡死」转成 fail-loud。

### L7 — Build-ID 意识的版本路由
我们已有 version-skew 检查（session 起手的 on-disk vs in-memory 版本核对）。Tempor 的 Build ID 是同一问题的服务端解。**现状足够**（单机 + 启动时核对），但** REPLAN 应记录一个 `specRevision`**，让 resume 时能机械校验「这个 row 是在哪个 spec 版本下收敛的」——这是 L3 的前置数据。

### L8 — Query 不改状态 / Memo 不当 history
把「只读查看绝不变更状态」写成我们的显式契约；`audit.jsonl`/sigma-bands 严格限于可观测性，不进控制流。

---

## 9. 什么**不**适用（别过度照搬）

- **可伸缩性机制不需要**：shard、task queue、多 worker、sticky execution、Continue-As-New 的「百万级 workflow」语义——我们是单机单会话，`parallel`/`map` 的并发问题（BUG-5 的 state[as] 竞态）是另一类问题。
- **Activity 幂等性的强要求不同**：Temporal 的同一 task **可能被投递两次**（at-least-once），所以 activity 必须幂等；我们的 delegation 是**每调用一次、memoize by key**，幂等性要求弱得多（但 `writerTask` 的「main call 与 render-retry 共享 id 导致 occurrence 自增」是有意为之的近似）。
- **「Workflow 默认不重试」不能照字面搬**：我们的 convergence loop **就是**某种 workflow 级重试。Tempor 的真实教训不是「别重试」，而是「**朴素的整流程重试不解决问题，要把重试变成有进展的迭代**」——这正是我们的 demand-set 单调律和 plateau governor 在做的事。**这一条我们其实比 Temporal 的默认更细。**
- **我们没有沙箱**：TypeScript SDK 的 V8 隔离沙箱对我们不可得（我们的「workflow」是 TS 控制流，沙箱化成本远超收益）；我们的等价物是**机械校验 + fail-loud**（P4），即 L3。

---

## 10. 一页纸结论

Temporal 把「长流程可靠性」拆成三件事，每件我们都已有一个对应物，但**深度不同**：

| Temporal 的三件事 | 我们对应物 | 成熟度差距 |
|---|---|---|
| **状态外置**为不可变事件流（独立持久化） | resume-cache（在内容树内，v0.4.3 刚 untrack） | 结构性差距 → L1 |
| **重放可校验**（Command↔Event 双射，不匹配立即报错） | resume 回放，**无等价校验** | 最大差距 → L3 ★ |
| **失败分层**：Activity 声明式重试 / Workflow 不朴素重试 / 墙钟兜底 / non-retryable | transient ladder / P5 / wall fuse / convergence governor | **最接近**，补 L4/L6 即可 |

**如果只偷一条：L3（重放确定性校验）**。它是唯一能把一个已实测的 52 分钟死循环直接归零的改动，且完全落在我们的 fail-loud 原则（P4）和已有的 058/059 声明层之上——**不需要新基础设施，只需要在 resume 回放前加一个 anchor 存在性的机械检查**。

---

## 来源

**官方文档（已抓取核实）**
- Determinism in Temporal Workflows — github.com/temporalio/skill-temporal-developer `references/core/determinism.md`
- What is a Temporal Retry Policy? — docs.temporal.io/encyclopedia/retry-policies
- Workflow Execution overview（Replay / Commands / Status / Memo / Workflow cache）— docs.temporal.io/workflow-execution
- Patching（`patched()` marker 语义）— docs.temporal.io/patching
- Temporal Architecture（四服务 + persistence）— docs.temporal.io/encyclopedia/architecture/temporal-architecture
- Persistence Store（外部库必需）— docs.temporal.io/temporal-service/persistence

**公司 / 案例**
- About Temporal（2019 创立、MIT）— temporal.io/about
- How Temporal Transformed Workflow Orchestration（Fateev/Abbas、Uber Cadence 血缘）— temporal.io/blog/building-resilient-workflows-from-azure-to-cadence-to-temporal
- Temporal Raises $550M Series E at $12.55B Valuation — temporal.io/blog/temporal-raises-usd550m-series-e-at-usd12-55b-valuation-ai
- **What we've learned building cloud agents（Cursor 官方，含 50M actions/7M workflows/40% PR 数字与四条架构教训）** — cursor.com/blog/cloud-agent-lessons ★
- Building agentic consumer products with Temporal at Cursor — temporal.io/resources/on-demand/…（案例，未逐字抓取）
- Building Durable Agents with Temporal and AI SDK by Vercel（`@temporalio/ai-sdk` plugin 自动包 LLM 调用）— temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel ★
- temporalio/cursor-temporal-plugin — github.com/temporalio/cursor-temporal-plugin（存在性已核实）

**[未证实-细节]**
- Lovable 使用 Temporal：仅见员工 Jonathan Grahl 的 LinkedIn 分享邀约（「how we use Temporal and Durable Execution at Lovable」），工程细节未核实。原文档该表述已据此降级为「在用」级别。
- Lovable agent-mode 文档 docs.lovable.dev/features/agent-mode.md 未抓取，不含 Temporal 细节。

**本文档内对我们自己代码的引用**（供后续 wave 直接定位）
`src/nodes.ts`（node algebra = workflow 定义）、`src/pipeline.ts`（runPipelineTask / resume / `.complete`）、`src/replan/replan.ts`（stage→call-id-prefix drop）、`src/runtime-state-git.ts` + `src/harness-paths.ts`（v0.4.3 neverGitTracked）、`src/stages/implementation.ts`（deterministicPhaseCommit / 排除集并集）、`src/stages/checkpoint-rollback.ts`（latestGreenCommitBefore / rollback 链）、`src/agents/delegation-backend.ts` + `agent-runtime.ts`（= Activity 派发）、`src/review-findings.ts`（散文 verdict regex = L2 缺口）、`src/fault-classification.ts`（P5 non-retryable）、`src/wall-fuse.ts`（run wall 预算）。
