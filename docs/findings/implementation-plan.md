# pi-super-dev 实施计划(已锁定)

**Date:** 2026-07-06
**Status:** 决策已锁定,待执行
**依据:**
- `docs/findings/rewrite-review-vs-super-dev-plugin.md`(对照原插件的差距分析)
- `docs/findings/gap-implementation-research.md`(逐项取舍)
- `docs/findings/pi-sdk-architecture-verification.md`(Pi SDK 取证,C1–C15 全 ✓)

本文是**唯一执行依据**。每项含锁定决策与落地步骤。

---

## 总原则(取证后强化)

1. **不迁移、不装任何 subagent 包。** `subagent` 由独立扩展 `pi-subagents` 提供,非核心;它是 LLM 驱动编排,与我们的确定性 TS 节点代数冲突。pi-super-dev 已在用正确的核心 SDK 原语 `createAgentSession`(C1/C2/C10 已验证)。
2. **工具级硬拦截的唯一干净入口 = per-session `tool_call` extension hook**(经 inline factory 注入 child 的 ResourceLoader),不是 `subscribe` 事件、也不是 Options 字段(C3/C4/C5/C6/C9 已验证)。
3. **确定性的 TS 控制流 + `createAgentSession` + 自定义 `structured_output` 工具就是 SDK 正道**(C10 已验证)。

---

## Tier 1 — 立即实施(正确性 + 安全)

### Gap A — 确定性 gate-build ★ 最高杠杆 ✅ 已完成

**问题:** `gate-build` 信任 QA agent 自报 `buildSuccess`/`allTestsPass`(空过风险)。原版真正跑 `npm test`/`cargo test`/`tsc`。

**锁定决策:**
1. **增强不替换** — 保留 QA agent 做规格对齐;确定性 build+test+typecheck 叠加为硬测试预言机。
2. **两个门控点 + 一个合并前 gate** — `implementation.ts` 逐阶段 + verify-loop 内 + pre-merge。
3. **每命令 120s 超时→失败(不挂起);无测试运行器时非致命**(绿地项目记日志跳过)。
4. **扩展 `detectLanguage` 输出精确命令** — 覆盖现有栈 + 经 `packageManager` 识别 bun/deno;JVM/gradle 暂缓。

**步骤:** 新 helper `gate-build-deterministic`(~150 LOC,复用 setup.ts 检测逻辑)→ 接入 `implementation.ts`/`verify.ts`/合并前。**~1 天。**

**结果(2026-07-06):** 新模块 `src/build-runner.ts`(`detectProjectCommands` + `runBuildGate`);接入三点(per-phase / pre-merge / verify-loop);移除多余的 per-phase QA 自报 spawn;9 个单测,全量 221/221 通过,typecheck 干净。

---

### Gap 4.3 — 安全(block-dangerous + protect-files) ✅ 已完成

**问题:** specialist 可跑 `rm -rf`/强推/`DROP TABLE`/`curl|sh`/覆盖 `.env`。当前无硬拦截。

**锁定决策(取证后升级为方案 B):**
1. **Session 后端(默认)— inline `tool_call` factory**:`createAgentSession` 传 `DefaultResourceLoader({ noExtensions:true, extensionFactories:[createSafetyExtensionFactory()] })`。`noExtensions:true` 关全局发现、inline factory 照常加载(C9 已验证)→ 既注入安全 hook,又顺带消除 C14 隐患(child 默认拉全局扩展)。**uniform 覆盖所有工具。**
2. **子进程后端 — system prompt 前言(软)**,作 `SUPER_DEV_BACKEND=subprocess` 的纵深防御。
3. **硬阻断**;**仅阻断对已存在密钥文件的覆盖,允许新建 + `.env.example`**。
4. **原样移植原版 ~24 条 denylist 模式** + 保护文件模式。

**步骤:** 新模块 `src/safety.ts`(denylist + protect-files + `createSafetyExtensionFactory()` 返回 `(pi)=>pi.on("tool_call", blocker)`);`session-agent.ts` 接 loader;`pi-spawn.ts` 加前言。**~1–2 天。**

**结果(2026-07-06):** `src/safety.ts`(原样移植 ~24 条 denylist + 保护文件检查,含 existing-only/`.env.example` 语义)+ `createSafetyExtensionFactory()`;session 后端子会话改用 `DefaultResourceLoader({noExtensions:true, extensionFactories:[safety]})`(硬拦截 + 消除 C14 隐患);子进程后端加 `safetyPreamble()`(软);13 个单测 + 8 个集成测试。**Caveat 已退役:** 集成测试针对真实 SDK 验证——factory 注册 `tool_call` 处理器 + block/allow 分发(经真实 `createSafetyExtensionFactory` 入口);真实 `DefaultResourceLoader({noExtensions,extensionFactories})` 无错加载我们的 factory。唯一剩余不可单测环节 = SDK 运行时把 child 工具调用路由到扩展处理器(文档化行为,C6 已从源码核实),需真会话方能端到端确认。

---

### Gap 4.6 — verify-loop 停滞检测 ✅ 已完成

**问题:** `loop({until:approvedAndGreen, times:4}, …)` 无停滞检测,同批发现反复则烧满 4 轮。

**锁定决策:**
1. **签名粒度** — 若 `codeReview`/`adversarialReview` schema 已含 file+severity 用结构化签名,否则 v1 粗粒度 JSON 哈希(构建时核实)。
2. **连续 2 次相同** = 停滞。
3. **静默中断**(Tier-1);用户可见升级作为独立 Tier-2 步骤。
4. **v1 精确集合相等**。

**步骤:** `verify.ts` 在 loop 内记 `state.__reviewSignatures`,加 `stagnating` 谓词,exit 条件加停滞分支。**~半天。**

**结果(2026-07-06):** 结构化签名(`file|severity|title`,排序、忽略 detail 措辞);`loopUntil` 异步 until 记录每轮签名、连续 2 次相同非空则中断(非致命、记日志);接入 loop 的 until;8 个单测(签名纯函数 + loopUntil 停滞决策),全量 243/243 通过,typecheck 干净。

> 里程碑:**v0.2.0 — 可信收敛 + 安全。**

---

## Tier 2 — 接下来实施(能力 + UX)

### Gap 4.1 — 丰富 `LANG_INSTRUCTIONS` ✅ 已完成

**锁定决策:** 仅散文惯用法无代码示例;丰富 rust/go/frontend/backend + **新增 python**,跳过移动/桌面;存为 `agents/lang/<lang>.md`;**纳入 `tdd-guide`** 注入测试框架知识。**~1–2 天。**

**结果(2026-07-06):** 新增 `agents/lang/{rust,go,python,frontend,backend}.md`(散文:命令/覆盖率/测试文件组织/惯用法,2024–2026 栈,从原插件专属 agent 蒸馏);`agents.ts` 新增 `loadLangProfile`(缓存);`route-specialist` 改用 profile;`buildTddPrompt` + implementer 双注入;`implementation.ts` 调整顺序(specialist 先行,lang 喂 tdd);6 个单测,全量 249/249 通过,typecheck 干净。

---

### Gap 4.4 — 移植协议文档 ✅ 已完成

**锁定决策:** 移植 `pivot-protocol`/`iteration-loops`/`verification-gates` 三个(跳过 `document-naming`);轻度改写去插件专属内容 + 加"设计意图"抬头;放 `docs/reference/`。**~半天。**

**结果(2026-07-06):** `docs/reference/{verification-gates,iteration-loops,pivot-protocol}.md`;逐篇去除插件专属(team-lead/doc-validator/`AskUserQuestion`/`gate-build.sh`/spec-29)并映射到实际实现(确定性 helpers、`gate()` 节点 + 反馈驱动重试、`runBuildGate`、verify-loop、停滞检测);每篇抬头诚实区分"设计意图 vs 当前实现"(完整 pivot 暂缓,仅停滞检测 + 计划中的升级)。

---

### Gap 4.6′-lite — 简单升级 UI(方案 C 混合式) ✅ 已完成

**锁定决策:**
- **基线(所有模式):** 停滞诊断进 `RunSummary` + `stagnation-report.md`。
- **可选交互(仅 `tui`/`rpc`,`ctx.hasUI` 且 `escalation:"interactive"`):** `ctx.ui.select()` 三选项(*修改 spec 并重跑设计* / *作为已知限制接受* / *放弃 worktree*)。
- 无头回退通知式;配置在 `~/.pi/agent/super-dev/config.json`,默认 `"informative"`。
- **诚实边界:** "重跑设计"在 Tier-2 只给建议并结束;自动回跳属 Tier-3。**~1 天。**

**结果(2026-07-06):** `loopUntil` 在停滞时写 `state.__stagnated`(结构化:轮数/verdict/findings);`SuperDevConfig` 新增 `escalation`(默认 `informative`);`extension.ts` 的 `execute` 取 `ctx`,新增 `handleStagnation`——基线写 `stagnation-report.md` + 进 `formatSummary`;opt-in(`hasUI`+`escalation:"interactive"`)走 `ctx.ui.select` 三选项;无头回退;6 个单测(标志位/报告/交互/无头不弹)通过。注:全套 256 中 `self-improving > loadLearnedLessons 冷启动` 为预先存在的 flaky 超时(非本次改动)。

---

### 新增 — Workflow Dashboard 扩展(v1 ✅ / v2 延后)

**问题:** 长流水线目前只有文本进度,缺全局可视性(原插件有 14 阶段 phase-tracker TUI)。

**取证可行性:** Pi 核心**无**内置 workflow UI,但 `tui.md` 的 `ctx.ui.custom()` + Container/Text/Box + `handleInput` 键盘 + overlay 全够用(已验证)。pi-super-dev 已具备全部状态(`PipelineState`/audit/onProgress),只差渲染。

**锁定决策:**
1. **增量** — v1 `setWidget` phase-tracker(常驻阶段列表 ✔/`6/6`/`❯`,无键盘)→ v2 完整两栏 dashboard(左阶段 + 右 agent 实时状态 + 键控)。
2. **数据来源** — 流水线**新增结构化 progress 事件**(`stage-enter`/`agent-start`/`agent-end` 带 timing/token),dashboard 订阅(reflection/审计复用)。
3. **v1 键控** — 仅 `x stop`(已有 AbortSignal)+ `esc back`;`p pause`/`s save` 需新原语(全局 pause gate + 状态快照),**延后 v2**。
4. **打包** — 进同一个 pi-super-dev 扩展;**仅 TUI**(`ctx.mode==="tui"`),`print`/`json`/headless 自动 no-op。

**步骤:** 流水线发结构化事件 → v1 widget 组件 → v2 `custom()` 两栏 + 键控 + stop 接 AbortSignal。**中等,~2–3 天。**

**结果(2026-07-06):** **v1 完成。** `task()` 节点新增结构化 `stage` 事件(running→terminal)走现有事件总线;`ProgressSink` 新增可选 `stage` 回调;`workflow.ts` 桥接;`extension.ts` 在 TUI 模式用 `ctx.ui.setWidget` 渲染常驻 phase-tracker(`super-dev · M/N stages` + 每阶段 ✔/●/⚠/↷),运行结束 finally 清除;`formatDashboardLines` 纯函数 + 6 个单测(task 事件发射 ✔/failed/skipped + 渲染)。无头 no-op。**v2**(两栏 `ctx.ui.custom()` + stop/pause/save 键控 + 每 agent timing/token)延后。全套 262/262 通过,typecheck 干净。

> 里程碑:**v0.2.1 — 能力 + UX。**

---

## Tier 3 — 跳过 / 暂缓

| # | 项 | 处置 | 理由 |
|---|----|------|------|
| 4.2 | 30 个 skill 库 | **跳过** | 多是薄壳;Pi 生态已覆盖 |
| 4.7 | team-lead 执行路径 | **跳过** | 隔离上下文是刻意架构;加它双倍维护面 |
| 4.5 | 多平台 manifest | **跳过** | Pi-only 既定范围 |
| — | 编辑即跑测试(`run-tests` hook) | **跳过** | Gap A 在正确检查点跑,更好 |
| — | 自动 checkpoint(`Stop` hook) | **跳过** | worktree + 逐阶段提交已覆盖 |
| 4.6′ | 完整 9 步 pivot 协议 | **暂缓** | 罕见且重;等 `learned.md` 证据;可由 4.6+升级长出 |
| 4.8 | 用量报告命令 | **暂缓** | nice-to-have;`stats.json` 已收数据 |

> 运行约 1 个月后,对照 `learned.md` 证据再评估 Tier 3。

---

## 执行顺序

1. **Gap A** 确定性 gate-build → 2. **Gap 4.3** inline `tool_call` 安全(+noExtensions) → 3. **Gap 4.6** 停滞检测 → **发布 v0.2.0**
4. **Gap 4.1** 丰富 LANG_INSTRUCTIONS → 5. **Gap 4.4** 协议文档 + **Gap 4.6′-lite** 升级 UI → 6. **Dashboard**(v1 widget→v2 两栏)→ **发布 v0.2.1**
7. 评估 Tier 3(对照 `learned.md`)。

---

## 取证备忘(支撑上述决策)

- 安全方案 B 的合法性:`resource-loader.js:361-374` 证明 `noExtensions:true` 不杀 inline factory;`extensions.md:721-749` 证明 `tool_call` 可硬阻断。
- 现状隐患 C14:`session-agent.ts:168/213` 未传 `resourceLoader` → child 默认加载用户全局扩展;方案 B 顺带消除。
- 不迁移的依据:`subagent` 非核心(C1)、无编程入口(C2)、gotgenes fork 是后台 spawn 模型 + 仅会话级事件(C13)。
- Dashboard 可行性:`tui.md` §Creating Custom Components / §Keyboard Input / Pattern 5 Widgets。
