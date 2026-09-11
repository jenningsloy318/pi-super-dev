# SDLC tips adoption — implementation spec (FINALIZED 2026-09-11)
Status: finalized 2026-09-11 (grilling closed; living — implementation-period corrections write back)

Source: `docs/requirements/sdlc/tip.md` (11 tips distilled from the four SDLC research docs). Produced by a grilling session (2026-09-11), updated after every confirmed decision. **This is the single artifact of the session** — scope, language, decisions, verdicts, and delta requirements all live here; when grilling completes it becomes the implementation spec. Verdicts judge the **staged pipeline** (requirements → research → design → spec → TDD implementation → verification convergence → docs → merge; pipeline-primary; the historical "13-stage" naming was deprecated repo-wide in v0.3.87); tips 7/11 are judged at the engine surface where they live. Scale: **adopt / already-have / reject**; partial outcomes land as delta requirements.

## 1. Session scope (confirmed)

- **Goal**: adoption verdicts for each of the 11 tips + a delta-requirements list; this doc is the deliverable and later the implementation spec.
- **Surface**: pipeline-primary (what the staged pipeline does to user projects); tips 7/11 at the engine level (delegation/routing/budget).
- **Verdict scale**: adopt / already-have / reject per tip or tip-half; gaps become delta requirements (§5).

## 2. Language

**Test**: Deterministic verification run as code: given input must produce expected output (RED/GREEN oracles, build gates). Checked by executing code, never by model judgment. _Avoid_: eval, check.

**Eval**: Quality verification of non-deterministic behavior — agent trajectories, verdicts, final responses — against labelled golden cases and scoring rubrics. Checked by datasets and rubrics (LM-scored), not by code alone. _Avoid_: test, benchmark, assessment.

**Judge**: The bounded LLM adjudicator that breaks reviewer/implementer deadlocks during convergence. A control-flow role, not a quality measurement. Evals may use LM judges as scorers — a different job with the same word; here, Judge means the deadlock router. _Avoid_: grader, eval judge.

**Golden case**: A labelled scenario → expected-verdict pair drawn from historical runs, postmortems, and requirement dossiers; the dataset unit evals score against. 住址：`~/.super-dev/evals/`（用户本地，不进仓——与 learned-index 同区；重装即失，已接受）。_Avoid_: fixture, sample, example.

**Dataset row**: 每次 run 由 scorer 发射的运行时观测行（得分 + 证据指针），存 `~/.super-dev/evals/`；与金标同区但语义相对——金标是期望，row 是观测。飞轮用 row 对金标回归。_Avoid_: golden case, log。

**Proposal（变更提案工件）**: 系统性 eval 失败触发的自动起草变更件（证据链 rows 引用、受影响金标清单、建议 diff、回归验证计划）；prompt/tool 变更的唯一合法来路——人批 + 机械回归门双护栏后落地。_Avoid_: auto-fix, patch。

**诚实栏（honesty bar）**: final-response scorer 的报告层断言组（claims↔已执行证据），与确定性 gate（事实）、spec 保真（语义）三层分权。_Avoid_: quality check。

**Spec 保真**: 交付物与 AC 的语义一致性，仅限 `verifiedBy=test/manual` 的 AC（确定性盲区）。_Avoid_: AC 覆盖检查（那是确定性 gate 的事实层）。

**Rubric**: Persisted scoring criteria an eval grades behavior against; versioned alongside the golden cases it interprets. _Avoid_: checklist, criteria doc.

**Intent（≡ Requirement）**: 发起人以自己的话陈述的问题与期望结果；在本管线中即 stage-1 requirements 的输入（task 字符串，已入 run 记录）及其结构化输出物。研究语料中的独立 intent.md 工件**不被采纳**——单操作者工具无需跨会话拾取流程。_Avoid_: intent.md（独立工件）、user story。

**Harness**: 模型外层的脚手架——prompts、工具、上下文策略、hooks/gates、沙箱、子代理编排、可观测性；在本仓库指 pi-super-dev 产品整体（tip 4 语源）。_Avoid_: 用裸词 harness 指测试脚手架。

**TDD harness**（限定词）: 实现阶段内的测试脚手架治理层（HARNESS_FILE_ROLES 注册表管理的 RED/GREEN 脚手架文件体系）。_Avoid_: 裸写 harness。

## 3. Decisions (ADR-style records)

### DEC-1 — Adopt a full evals layer alongside deterministic verification

"Verify, never trust" re-derives every LLM self-report with deterministic code — it verifies outputs but cannot measure non-deterministic behavior quality (trajectory choice, verdict quality, response bar). Adopt tips 1+3 in full: labelled golden-case datasets, persisted scoring rubrics, trajectory scoring, wired into a continuous flywheel (evaluate → cluster failures → optimize prompts/tools → regression-verify the fix).

Rejected: (a) "already-have" — the deadlock Judge plus oracles adjudicate disagreements and verify outputs but never score behavior against a bar; (b) "reject evals" — agent-behavior regressions across releases have no systematic detector today (poisoned-baseline postmortem class). Structural trajectory enforcement (stages, gates, toolBudget) stays the primary trajectory control; scoring measures and tracks it, never replaces it.

### DEC-2 — Evals execute as an in-pipeline stage

Every super-dev run carries an eval surface scoring its own agents (trajectory + verdict quality) against golden cases and rubrics, so datasets bootstrap continuously from real runs and trajectory decay is measurable in-flight. Rejected: release-gate-only suite (regressions caught only at version bumps; flywheel starved of data between releases; the v0.3.4 `SUPER_DEV_BENCH` real-LLM bench — deleted in v0.3.88 — is *historical* precedent for a deterministic layer, and D4's golden-case runner is new machinery, not its revival) and on-demand mode (nothing forces the flywheel). Cost accepted: every user run pays eval tokens + latency. Hard constraint: the eval stage is **fail-open** (P4/P5 — eval timeout, violation, or spawn error never fails or blocks the run under review). Confirmed semantics: **two scorers, advisory verdicts** — (1) a mid-run trajectory scorer at convergence boundaries that turns run-observability/sigma-band counters into a scored verdict — **strictly observational (2026-09-11 评审裁定)**: it READS the counters the existing stagnation/fault machinery already consumes and never actuates them (`eval.*` events + run-report rows + dataset rows only; any future actuation wiring is a named D3-era amendment carrying its own P3 failure-path table — a checker-class verdict tripping FaultActuators would violate this record's own fail-open constraint), and (2) a final-response scorer before the report. Verdicts land in the run report and emit golden-case dataset rows; no new merge gate exists.

## 3.1 DEC-3 — 工件链：intent ≡ requirement，不设独立 intent.md

用户裁决：研究报告（tip 9，源自 Anthropic playbook）的 intent.md 与本管线 stage-1 requirements 是同一事物——task 字符串（发起人原话）有两路持久化：`run.started` 事件（截 2000 字符入 run 账本）+ spec 目录 `.task` 锚文件（`SPEC_TASK_ANCHOR`，原文）。requirements 阶段输出结构化需求物。spec（含 AC、spec-required files 契约）与 plan（plan-feasibility 阶段）已存在。曾被提出并否决的增量：发起人原话的独立保真工件——否决理由：原话已双重持久化，额外工件是仪式开销。

## 3.2 DEC-4 — 路由立场：机械任务 → 确定性代码，而非廉价模型

tip 7（智能模型路由）与 tip 11（Shunt 成本路由）的目的是同一个：不把昂贵 token 花在机械工作上。本管线用比“路由给廉价模型”更强的方式实现：机械工作（文档格式、样板、验收检查、自述复核）归**确定性代码**（src/render/ 渲染层、gates、re-derivation）——免费且可验证，而廉价模型是“便宜但不可验证”。剩余的模型工作基本全是判断型工作（requirements/design/review/RED 编写），正是语料中“用小模型”建议最可疑的部分。自动模型路由表否决；手动调优手段已存在（super_dev 的 model 覆写、pi-subagents per-agent pin）。

复议修正（同日）：上文“更强”仅成立于**输出侧**；输入侧（implementer/reviewer 按 grounding 直接读源码，全价前沿 token）无 Shunt 的读取拦截等价物 → tip 11 账面改为**部分已具备**，缺口由 D6（工件换重读）在 super-dev 可动面内补齐；真正的 hook 读取拦截属 pi-subagents 上游，不在此实现。第三类工作“机械型代码”（脚手架/import 接线/类型 plumbing）确认存在且当前全价计价：per-phase model hint 配置否决（档位误判的质量风险 > 配额收益；RED/评审阶段不可降档）。本仓库的真实成本压力是配额而非美元（zai 5h 窗口、429 排除史）——tip 7 在此的正确名字是**配额韧性**，由现有 fallback/排除机制 + 手动覆写承担。

## 3.3 DEC-5 — 金标案例集住址：全放 ~/.super-dev/evals/，不进仓

金标与 dataset rows 同区存放（与 learned-index/config 一致）。裁决理由：pi-super-dev 是个人工具，金标属累积性个人校准数据而非随仓产品资产；数据不进 src/ 也避免数据/代码耦合。代价（已接受）：不版本化、不进 PR 评审、重装即失——缓解：金标种子从仓内 postmortem/dossier 档案可随时重建（source 字段强制回指仓内档案路径）。否决替代：仓内 evals/golden/（版本化但与个人工具定位不符）。

## 3.4 DEC-6 — 金标 schema：六字段 + expected.verdict 枚举闭包

金标案例六字段：`id` / `title` / `source`（强制回指仓内 postmortem/dossier 路径，DEC-5 重建缓解的落地字段）/ `target`（stage｜agent，支持按层过滤套件）/ `scenario` / `expected`。分层判定契约：`expected.verdict` 只允许**既有 verdict 枚举值**（收敛评审、prototype pass/fail、judge ACCEPTED/DISCARDED、故障分类表），加载时对枚举闭包表做确定性校验（配对 generate/validate，P2 教训的落地）；`mustHold`/`mustNot` 语义断言交 scorer LM 判。即：verdict 比对零 LM，语义判断必有 LM。

## 3.5 DEC-7 — rubric 形态：断言级 boolean + 0..1 confidence，版本分键基线

每个 rubricId 一个文件（`~/.super-dev/evals/rubrics/`）：维度名 + 判定指引 + mustHold/mustNot 评估准则。刻度沿用仓库已有惯例（finding 的 0..1 confidence），断言级 boolean 过/不过 + confidence；每条 dataset row 强制盖 rubricVersion 章；σ-带基线按 rubric 版本分键，<8 行不给带的诚实规则照搬（rubric 措辞修改不得污染漂移历史）。种子期 rubric 由维护者手写——质量刻度本身不被自动生成。否决：1–5 维度分（对断言型金标过粗）、纯 boolean（丢低 confidence 聚类信号）。

## 3.6 DEC-8 — rubric 格式全库同构，刻度各就各职，eval 不改 reviewer 契约

统一的是**格式**（命名准则 + 指引 + 显式刻度 + 版本章，一份规范所有评估面共用），不是**刻度**：spec 评审维持 1–5 维度分（服务收敛循环的 verdict 聚合，已收敛校准，不动）、judge/prototype 维持枚举、eval 维持断言级 boolean+confidence。eval scorer 只把评审输出**读作观测行**，不指挥 reviewer——飞轮聚类靠格式同构对齐，靠刻度差异区分职责。否决：全面迁断言级（动已校准契约、零增益）、eval 独立格式（两套词汇并存，跨面分析变脆）。

## 3.7 DEC-9 — 双打分器异构：trajectory 确定性为主，final-response 前沿档

trajectory scorer ＝ 确定性代码为主：σ-带漂移分类（已存在）→ rubric 带位映射表 → 带内 verdict，核心零 LM；工具选择质量部分用低档 LM 作可选叙述。final-response scorer ＝ 新注册 specialist agent + 前沿档 pin（质量栏是判断工作，DEC-4 立场一致）。两器都发射 dataset rows。成本面：每次 run 仅一次前沿档打分。否决：双前沿（收敛边界 × 前沿 token，带位判定本可确定性完成，违反 DEC-4）；双低档（用低档测质量＝测量系统自身失真，飞轮基于失真分数做错误优化，比没有 eval 更危险）；单打分器末尾打（丢 mid-run 时效，违反 DEC-2 已定案语义）。

## 3.8 DEC-10 — final-response scorer 断言集：三层分权

确定性 gate 管事实（AC 覆盖核对、deliverables）；**诚实栏**管报告层（claims↔已执行证据：① 总结声明可溯源、② AC 覆盖声明退化为纯比对——报告说 vs 核对结果，零语义判断、③ 残余风险如实列出，P10）；**spec 保真**管语义区（交付物 vs AC 语义），且仅限 `verifiedBy=test/manual` 的 AC——确定性查不出的那部分。零重叠：每个事实唯一属主（ownerStage 思想的落地）。trajectory scorer 词表复用既有枚举（σ-带状态 + 故障分类表），新 `eval.*` 事件类型包装（DEC-6 闭包哲学）。否决：混合断言集（AC 覆盖区双结论噪声）、只做诚实栏（语义保真盲区无人评）、保真为主（诚实维度丢失）。

## 3.9 DEC-11 — D4 飞轮：提案-上架分离（propose/apply split）

四环节：① 聚类自动化——reflection 引擎代理（src/render/reflection.ts，引擎运行、非 pi 扩展）读 rows.jsonl，按 target/assertion/defectClass 聚类，更新 learned-index（知识数据自动机制，非 prompt 代码，无新风险类）+ 系统性失败（≥N run 同断言失败）写 findings；② 提案自动化——自动起草 Proposal 工件，不直接改任何 prompt；③ 人工闸门（唯一人工环节）——维护者批准/修改/拒绝提案；④ 回归验证自动化——eval 回归执行器（golden-case runner，新机器——非已删除的 v0.3.4 bench 复活）按 target 匹配受影响金标，场景注入 → expected verdict 确定性比对（DEC-6 词表），绿了才落地。否决：全自动改 prompt（P4 正面冲突：无人工把关的坏聚类污染所有后续 run）、纯手工聚类（飞轮锈死）、独立聚类 agent（与 reflection 职责重叠，双份维护）。

## 3.10 DEC-12 — D6 执法形态：prompt 规则 + 确定性频次检查 + 观测性叙述

D6 落地形态：work-unit prompt 规则（上游工件为首选证据源）+ **确定性频次检查** + trajectory scorer 的低档 LM 叙述**观察**重读行为（观测，非执法）。确定性层（2026-09-11 评审裁定**恢复**）：v0.3.76 的 tool-usage 遥测已把每个子代理的工具调用（工具名 + 60 字符 argHead）落入 `<specDir>/tool-usage.jsonl`（src/evolution/tool-usage.ts，delegation tick 通道）——**调用级观测在 super-dev 可动面内**；据此对 rows 做频次/层级检查（如：对已作为上游工件注入的路径 >N 次源码读取调用），fail-open。上游边界（如实）：内容级读取、拦截、重定向仍属 pi-subagents 上游，记为 upstream ask 可选项，不实现。（原记录的“源码读取不可观测”前提为假——v0.3.76 遥测已证伪，且本记录的低档叙述层恰恰依赖该可观测性；问询中默认值无否决确认——保留为历史注记，部分被本次裁定取代。）

## 4. Verdict ledger

### Cluster 1 — Verification (tips 1 + 3): ADOPT (DEC-1, DEC-2)

| Tip's demand | Verdict | Basis |
| --- | --- | --- |
| Tests for deterministic parts (tip 1) | already-have | RED/GREEN oracles, TDD implementation stage, build gates |
| Evals for non-deterministic parts (tip 1) | **adopt** | Judge is deadlock-only control flow; no rubric-scored golden-case datasets；行为 bench 曾仅覆盖收敛单节点（v0.3.4 SUPER_DEV_BENCH 双形状，v0.3.88 已删除——docs/requirements/shape-dual-benchmark-v0.3.4.md 存档），且本就非跨 release 行为回归套件 |
| Output eval (tip 3) | already-have | Deterministic re-derivation of every LLM self-report |
| Trajectory eval (tip 3) | **adopt** (scoring; enforcement stays structural) | Stages/gates/toolBudget enforce; run-observability 记录 + sigma-bands 已对健康计数器做确定性 σ-带分类（漂移监测）；缺的是 rubric/LM 对轨迹质量的打分（工具选择、verdict 质量） |
| Eval execution placement | **adopt** — in-pipeline stage (DEC-2) | Datasets bootstrap from real runs; fail-open per P4/P5 |
| Eval verdict semantics | **adopt** — both scorers, advisory (DEC-2) | Trajectory scorer at convergence boundaries + final-response scorer before report; verdicts → report + dataset rows; no new gate |

### Cluster 2 — Artifact chain (tips 8 + 9 + 10): ALREADY-HAVE (DEC-3)

| Tip | Verdict | Basis |
| --- | --- | --- |
| tip 8 意图即接口 | already-have | 管线本体就是 task 进、可验证 spec 出的意图接口 |
| tip 9 intent.md | already-have（intent ≡ requirement，DEC-3） | task 字符串入 run 记录 + stage-1 requirements 结构化输出；独立 intent.md 不采纳 |
| tip 10 plan.md | already-have | plan-feasibility 阶段（风险/可行性）、spec-required file 契约（files）、AC + RED/GREEN oracle（proof）、阶段顺序（order） |

### Cluster 3 — Context (tips 2 + 6): ALREADY-HAVE

| Tip | Verdict | Basis |
| --- | --- | --- |
| tip 2 六类上下文 | already-have（六类全部有落点） | Instructions＝work-unit prompt 指令块；Knowledge＝上游工件逐级注入 + grounding 验证规则；Memory＝learned-index 跨 run 注入（Tier-1/Tier-2）+ run 账本 + mid-run guidance；Examples＝prompt 内联正反例 + assessment patterns（file:line）——六类中最弱但实质覆盖；Tools＝skill-domains 目录 + per-agent 注册；Guardrails＝fenced-data 规则、phase-boundary guard、deliverables 契约、gates |
| tip 6 动态上下文 | already-have | skills/MCP 按 agent 动态注册即 tip 所述机制本体 |

否决的增量：专门 few-shot 样例库——与 learned-index 职责重叠，新机器换边际收益。

### Cluster 4 — Routing/cost (tips 7 + 11, engine surface): ALREADY-HAVE (DEC-4)

| Tip | Verdict | Basis |
| --- | --- | --- |
| tip 7 智能模型路由 | already-have（精神上）；自动路由表否决；机械型代码类＝已知未路由、hint 配置否决（质量优先，DEC-4 复议） | 机械任务→确定性代码强于→廉价模型；判断型工作保留前沿模型；手动 model 覆写/per-agent pin 已存在 |
| tip 11 Shunt 成本路由 | **部分已具备**（复议修正）：输出侧已覆盖且更强；输入侧（长文件读取拦截→廉价摘要）无等价物 | 输出侧＝结构化输出 + 渲染层；输入侧缺口 → D6；真读取拦截属 pi-subagents 上游面，不在此实现 |

### Cluster 5 — Identity (tips 4 + 5): ALREADY-HAVE（验证性）

| Tip | Verdict | Basis |
| --- | --- | --- |
| tip 4 harness 解剖 | already-have（验证性） | 语料描述的正是本仓库架构本体；顺带钉入 Harness vs TDD harness 词义区分 |
| tip 5 orchestrator 技能 | already-have（验证性） | specification＝task→spec、decomposition＝phases/tasks、evaluation＝DEC-1 eval 层、system design＝design+gates；人保留 Delegate/Review/Own 最终责任 |

## 5. Delta requirements (implementation-ready, accumulating)

- **D1** — Golden-case dataset: labelled scenario → expected-verdict pairs seeded from historical postmortems, requirement dossiers, and the archived v0.3.4 bench scenarios (docs/requirements/shape-dual-benchmark-v0.3.4.md — the bench machinery itself was deleted in v0.3.88); the dataset the in-pipeline eval stage scores against. 住址/schema **RESOLVED**（DEC-5/6）：`~/.super-dev/evals/`，六字段 + verdict 枚举闭包校验；种子集 accumulating。 *(cluster 1)*
- **D2** — Persisted rubric artifacts (RESOLVED，DEC-7): per-rubricId 文件于 `~/.super-dev/evals/rubrics/`；断言级 boolean + 0..1 confidence；row 盖 rubricVersion 章；σ-带基线按 rubric 版本分键 + <8 行诚实规则；种子期手写。
- **D3** — Trajectory scoring (RESOLVED，DEC-9): 确定性为主——σ-带分类（现有基底，不重造分带）→ rubric 带位映射 → 带内 verdict；工具选择质量部分低档 LM 可选叙述；测量，非执法。
- **D4** — Flywheel wiring (RESOLVED，DEC-11): 提案-上架分离——聚类自动（reflection 引擎代理 + learned-index）→ Proposal 工件自动起草 → 人工点头唯一闸门 → eval 回归执行器（golden-case runner）跑受影响金标，绿了才落地。
- **D5** — In-pipeline eval stage (RESOLVED，DEC-2/9/10): fail-open surface inside every run；trajectory scorer（确定性，收敛边界处，词表复用既有枚举 + `eval.*` 事件）+ final-response scorer（前沿档 specialist agent，run 末尾，诚实栏 + 限界 spec 保真断言集）；verdicts advisory——run report + golden-case dataset rows，无新 merge gate。

- **D6** — 工件换重读 (RESOLVED，DEC-12 评审裁定修订)（artifact-instead-of-reread）：下游 agent 以上游工件为首选证据源，源码重读仅用于 grounding 验证；落地＝work-unit prompt 规则 + **确定性频次检查**（tool-usage.jsonl rows，fail-open）+ 观测性 LM 叙述；内容级拦截/重定向降级为 upstream ask 可选。约束：不禁止验证性重读——省 token 不许换来偏信过时工件。*(cluster 4 复议)*

## 6. Closure

Spec 定稿（2026-09-11，三轮 grilling 收口）。tip 账目见 §4，增量需求 D1–D6 全部 RESOLVED（DEC-5–DEC-12），实现就绪。建议分期：**P1** = D1+D2（金标集 + rubric 地基）→ **P2** = D5+D3（双打分器）→ **P3** = D4 飞轮 + D6。后续实现期的修正仍回写本文档（living 约定保留）。定稿后同日独立 grill 评审（pi-super-dev 会话，glm-5.3-flash）：33 项主张核验（29 ✅），4 处漂移修正（SUPER_DEV_BENCH 现存时引用×2、“13-stage”命名、DEC-12 不可观测假前提、bench 幽灵命名）+ 2 项 owner-proxy 裁定已 fold（D6 确定性层恢复 / v1 严格只读）；Status 行同步翻转。
