# Pi SDK 架构取证与验证

**Date:** 2026-07-06
**Question:** pi-super-dev 该用"原生 subagent"吗?当前用 `createAgentSession`
的架构对不对?安全缺口最 Pi 原生的修法是什么?
**Method:** 对每条结论拆成可证伪条目,逐条去 Pi SDK 源码(`dist/*.d.ts`)和
官方文档(`docs/*.md`)核实,回填 ✓/✗ + 引用。版本:**installed = latest =
`@earendil-works/pi-coding-agent` 0.80.3**。

> 本文档的每条 **[Cn]** 都是一个可证伪断言。Verification 列在取证后回填。

---

## 结论速览(待验证支撑)

1. **不迁移、不装任何 subagent 包。** `subagent` 工具由独立扩展 `pi-subagents`
   提供,不在核心 SDK 里;它是 LLM 驱动编排,与我们的确定性 TS 节点代数冲突。
2. **pi-super-dev 已经在用正确的核心 SDK 原语(`createAgentSession`)。**
   没有"偏离 Pi 标准"——`pi-subagents` 本身也只是 `createAgentSession` 之上的
   另一种编排层。
3. **安全缺口最 Pi 原生的修法 = inline `tool_call` extension factory**,注入到
   child session 的 `ResourceLoader`。比"工具包装"更 uniform、与 host 同构。
4. **确定性的 TS 控制流 + `createAgentSession` + 自定义 `structured_output` 工具
   就是 SDK 的正道**,无更高级的"跑 subagent 拿结构化结果"原语。

---

## A. 关于核心 SDK 的断言

| ID | 断言 | 验证来源 | Verification |
|----|------|----------|--------------|
| C1 | `subagent` 工具**不在**核心包;由独立扩展 `pi-subagents` 提供 | `grep -r subagent dist/*.d.ts` → **空**。✓ | ✓ 核心无 subagent |
| C2 | 核心导出 `createAgentSession`,但**没有** `subagent`/`runSubagent`/`spawnAgent` 等可编程函数 | `dist/index.d.ts` grep → **空**。核心只有 `createAgentSession`/`createAgentSessionFromServices`/`createAgentSessionRuntime`/`createAgentSessionServices` + `runPrintMode`/`runRpcMode`。✓ | ✓ 无 subagent 编程函数 |
| C3 | `CreateAgentSessionOptions` **没有** hook/拦截器字段;只有 `cwd/agentDir/authStorage/modelRegistry/model/thinkingLevel/scopedModels/noTools/tools/excludeTools/customTools/resourceLoader/sessionManager/settingsManager/sessionStartEvent` | `dist/core/sdk.d.ts:11-58` 全字段列出,**无** `hooks`/`onToolCall`/`interceptor`/`middleware`。✓ | ✓ 无 per-session hook 字段 |
| C4 | session 的 `subscribe()` 事件**全是只读通知**,无一能阻断 | `docs/sdk.md:268` "receive streaming output and lifecycle **notifications**";事件类型 `message_update`/`tool_execution_*`/`turn_*`/`agent_*`/`queue_update`/`compaction_*`/`auto_retry_*` 均无 block 语义。✓ | ✓ 事件只读 |
| C5 | `tool_call` 事件**能阻断**(`return {block:true, reason}`),且 `event.input` 可变 | `docs/extensions.md:721` "tool_call … **Can block**";`:733` "only control blocking via `{ block: true, reason }`";`:749` 例。✓ | ✓ tool_call 可硬阻断 |
| C6 | 经 `DefaultResourceLoader({extensionFactories:[…]})` 注入的扩展 hook,**绑定到由该 loader 创建的 child session** | `dist/core/resource-loader.d.ts:70` `extensionFactories?: ExtensionFactory[]`;`resource-loader.js:686 loadExtensionFactories(runtime)` 用 **该 loader 的 runtime** 加载;`docs/sdk.md` Extensions 节 loader→createAgentSession→session 持有这些扩展。✓ | ✓ inline factory 绑定 child |
| C7 | 核心导出细粒度工具工厂 | `dist/core/sdk.d.ts` 导出 `createBashTool/createEditTool/createWriteTool/createReadTool/createGrepTool/createFindTool/createLsTool` + `createCodingTools/createReadOnlyTools`。✓ | ✓ 工厂可单独构造/包装 |
| C8 | `noTools:"builtin"` 禁用默认内置;`customTools` 与扩展工具合并;`tools` 是白名单 | `docs/sdk.md` Tools 节 + `CreateAgentSessionOptions`。✓ | ✓ 语义如所述 |
| C9 | `DefaultResourceLoader` 默认会发现全局/项目扩展;**但** `noExtensions:true` 只关发现、**不杀** inline factory | `docs/sdk.md:559` 发现路径;`resource-loader.js:270` `extensionPaths = this.noExtensions ? cliEnabled : merge(...)`;`:361-374` `loadExtensionFactories` 在 noExtensions 门控**之后**独立执行并 push 进结果。✓ | ✓✓ 关键:可 noExtensions+inline factory 共存 |
| C10 | **无**独立的"跑 subagent 拿结构化结果"原语 | 核心导出仅 `createAgentSession*` + `runPrintMode/runRpcMode`;`docs/sdk.md` 全文以 createAgentSession + customTools 为唯一做法。✓ | ✓ 无更高级原语 |
| C11 | `session.agent.state.tools = tools` 可在创建后**替换工具集** | `docs/sdk.md:259-260` "Replace tools: `session.agent.state.tools = tools`"。✓ | ✓ 创建后可换工具 |

## B. 关于 subagent 包的断言(已取证,附证)

| ID | 断言 | 证据 |
|----|------|------|
| C12 | 本机装的是**无 scope 的 `pi-subagents`**(nicobailon,v0.33.1),无 `main`/`exports`(纯扩展);`@tintinweb`/`@gotgenes`/`@bacnh85` 均未装 | `~/.pi/agent/npm/node_modules/pi-subagents/package.json`;`settings.json` 登记为 `npm:pi-subagents` |
| C13 | `@gotgenes/pi-subagents`(v18.0.1)虽导出 typed API,但是**后台 spawn 模型**(`spawn` 返回 ID,`result` 为字符串),事件仅会话级(started/completed/failed/compacted/created/steered),**无工具级** | 其 `dist/public.d.ts`(已拉取逐行读) |

## C. 关于 pi-super-dev 自身的断言(已取证,附证)

| ID | 断言 | 证据 |
|----|------|------|
| C14 | session 后端用 `createAgentSession` + `customTools`,**未传** `resourceLoader`(即用默认发现 → 当前 child 会加载用户全局扩展) | ✓ 已核实:`session-agent.ts:168/213` 两处 `createAgentSession` 仅传 `customTools`/`sessionManager`/`settingsManager`/`cwd`/`agentDir`,**无** `resourceLoader`。 |
| C15 | 子进程后端对非 browser agent 传 `--no-extensions` | `src/pi-spawn.ts:buildSpawnArgs` |

---

## 验证结果汇总(A 区全部回填)

**A 区 C1–C11:全部 ✓,无一被证伪。** 结论速览无需修正。

**两条对实施最关键的发现:**

1. **C9 的精确语义(决定安全方案能否干净落地):** `noExtensions:true` 只关闭"发现的"全局/项目扩展,`extensionFactories`(inline)**照常加载且独立合并**(`resource-loader.js:361-374`)。→ 所以 pi-super-dev 可以给 child 传一个 `DefaultResourceLoader({ noExtensions:true, extensionFactories:[safetyFactory] })`,**既注入安全 hook,又不拖入用户全局扩展**(顺带让 child 变得确定性,不再受 ambient 全局扩展影响)。这是**比"工具包装"更 Pi 原生、更 uniform** 的安全实现路径,且**比现状更干净**(现状 C14:child 默认加载全局扩展,其实是不确定性的隐性来源)。
2. **C3+C4+C5 三条合起来 = 工具级硬拦截的唯一干净入口是 `tool_call` extension hook**(per session,经 inline factory),不是 `subscribe` 事件、也不是 `CreateAgentSessionOptions` 字段。

**对结论速览的强化:**
- 结论 1–4 全部成立且证据闭环。
- Gap 4.3(安全)的实施方案**确认为 B(inline `tool_call` factory)+ `noExtensions:true`**,替换原计划的"工具包装"为主路径(工具包装降为备选)。
- 这条修法**同时修掉一个现状隐患**(C14:child 默认拉全局扩展)——一举两得。
