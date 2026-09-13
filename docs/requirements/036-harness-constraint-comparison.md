# Harness 约束对比研究：我们的验证机器是否过量

Status: research (comparative study of 4 external harnesses — no implementation in this commit)

研究对象（全部本地全码深读，非文档浏览）：

| Harness | 规模 | 深读内容 |
|---|---|---|
| DeepSeek Harness (DSH) | 60+ 包 | guard 全家（repeat-tool-reminder/index.ts 全文、timeout-policy）、goal-round-driver、tool-goal（authority/wrapup）、Ralph 完整 479 行源码、workflow types、subagent seam、architecture.md |
| openai/codex (Rust) | codex-rs/core 130 文件 | safety.rs 全文（writable-path sandbox）、agent/control.rs 全文（859 行，注册表+执行限制器）、rollout_budget.rs 全文、responses_retry.rs、builtins/awaiter.toml |
| SWE-agent | python | reviewer.py 全文（664 行，全部重试机器）、config/default.yaml 全文（69 行）、agents.py retry 入口 |
| cumora（此前已深读） | — | 协调哲学、prompt 纪律、守护分层 |

## 一、四个 harness 的约束清单（读码实测）

### DSH：整个 guard 家族只有 2 个插件，且明确"advisory only"

`repeat-tool-reminder`（唯一的行为守护）源码注释原话：**"Observe-and-enrich, never veto"** —— 检测到重复调用后只是注入一条提醒消息，"决策（换方法、继续取证、还是收尾）完全留给模型：合法的重复调用不被延迟、不被阻止"。`timeout-policy` 只做协作式 deadline（声明了 timeoutMs 的工具超时返回结构化错误，不杀进程）。

DSH 对"评估器"的官方立场（goal-round-driver README "Known Limitations" 原话）：

> **No independent evaluator** — the model-facing goal policy decides when evidence is sufficient for completion and whether a blocker is semantically unchanged; evaluator-backed certification remains deferred.

他们**有意推迟**了我们已建成的整个 judge 机器。Ralph（fresh-agent 迭代循环，最接近我们 implementation 阶段的东西）的设计：

- 每轮 fresh agent，上限 **256 轮**（我们 6 轮 RED + 若干 impl attempts 就 no-progress）
- 工作区即长期记忆（"The shared workspace is the long-term memory and source of truth"）
- worker 自报 `continue | complete | blocked` 三态 —— **没有任何 harness 侧验证**
- 渲染层原话："completion and blockers are **worker reports, not independent certification**"
- 失败处理：一轮 child 挂了 → 返回错误 + 保留最后一个 handoff，**不重试该轮**

### Codex：语义验证代码行为零

`core/src/` 130 个文件里，grep `review|verif|judge|gate|conv|retry` 只命中 **transport 层**（responses_retry.rs 163 行：连接退避重试）。语义层的全部"约束"：

- `safety.rs`：**只有文件系统安全**（patch 是否在 writable roots 内 → AutoApprove/AskUser/Reject），无任何语义判断
- `rollout_budget.rs`：token 预算**不是 kill 而是 reminder** —— `pending_reminder()` 在剩余 token 跨过阈值时给**每个线程投递一条提醒消息**，模型看到后自己决定怎么办
- `agent/control.rs` + `execution.rs`：唯一的执行约束是**并发线程数上限**（AgentExecutionLimiter，`has_capacity()` 检查），不是语义
- agent 挂了 → `InternalAgentDied` → 从注册表移除。就这些。
- 唯一的"验证 agent"是 builtins/awaiter.toml —— 28 行 prompt，靠指令让 awaiter"不要幻觉完成"

### SWE-agent：整个 default 配置 69 行，全部重试+评审机器 664 行

验证就是 instance prompt 里的第 4 步："Rerun your reproduce script and confirm that the error is fixed!" —— **模型自己跑自己的复现脚本**，harness 不验证。

重试架构（reviewer.py，唯一两种 loop）：

- **ScoreRetryLoop**：agent 完整提交 → reviewer 模型**读 trajectory 文本**打分（n_sample=5 次采样取均值，std 惩罚）→ 分数 ≥ accept_score 收货，否则 fresh attempt；`max_attempts`/`cost_limit` 兜底
- **ChooserRetryLoop**：跑 N 个完整 attempt → LLM chooser 从提交列表里**选最好的**
- 关键细节：`get_best()` **在全部失败时也返回最优解**（"Only call this at the end"，取 max score，同分选 API 调用最少的）—— **run 永远以"保留最好成果"结束，不以 escalation 归零结束**
- reviewer 的打分解释是"取回复最后一行的最后一个数字"，故意简陋；分数是**概率过滤器，不是保证**

### Cumora（此前已深读）

规则："prompt 只放 shape 级规则，永远不在代码机制该上场时加 prompt 规则，也永远不在 brain 面对正确状态做清晰决策时加代码机制"。

## 二、对照：我们的机器与我们的死亡记录

我们的 implementation/verify 约束栈（每一层都有注释里的 run 编号，都是为真实事故加的）：

```
RED review 强度门(fail-closed) → GREEN: build gate(全仓) + deliverable-check
+ symbol-check + change-tracker(越界) + post-RED oracle + baseline-verify(合并基线)
→ classifyGateFault(环境/产品分类, 需 foreignDirtCount) → quarantine(git stash)
→ 再 gate → 再分类 → judge(路由×6 + 证据校验 INV-2 豁免集×4 + 置信度
+ 每签名预算×2 + 每run预算×12) → escalate(HITL) → convergenceBlocked → 终止
```

**关键数据 —— track 07 五连死的死因全是机器相互作用，零次是模型能力死**：

| 死亡 | 直接死因 | 性质 |
|---|---|---|
| 01-47 (v0.2.3) | 环境分类器误判（无 foreign dirt 也判环境）| 机器误杀 |
| 03-16 (v0.2.3) | judge 120s 超时 → 无裁决 → escalate | 机器误杀 |
| 05-09 (v0.2.5) | 分类器误判 → **quarantine 隔离了 implementer 自己的修复**（自伤循环）| 机器误杀 |
| 02-01 (v0.2.4) | judge 正确诊断 re-author-tests 被**证据校验丢弃** | 机器误杀 |
| 14-54 (v0.2.10) | judge 正确诊断 challenge-test 被**证据校验丢弃**（572/573 测试通过的状态下）| 机器误杀 |

对照：仅有的两次完整成功（spec-05、spec-06）都是 **judge/escalation/replan 零触发**的 run —— 机器没开火，run 就活了。这几乎是个受控实验：**机器参与度与 run 存活率负相关**。

代码量对比（读码实测）：

| | 语义验证/仲裁代码 | 失败时保底 |
|---|---|---|
| Codex | **0 行**（safety 只有 FS 安全）| agent 死→移除 |
| DSH | ~200 行 guard（advisory）+ Ralph 验证=worker 自报 | 保留 last handoff |
| SWE-agent | 664 行（评审=模型打分）| **get_best() 永远保留最优** |
| 我们 | 数千行（judge+分类+quarantine+baseline+escalation，implementation.ts 单文件 ~2900 行）| **convergenceBlocked → 0 phase 保留** |

## 三、结论：不是"约束多"，是三个结构性错位

约束本身大多有正当性（每条都对应真实事故）。错在**语义、时机、和终点**：

### 1. 硬阻断 vs 提醒（Codex 教训）

Codex 的预算是 reminder（投递"还剩 N token"消息），我们的是 kill（round cap→FatalAbort、MAX_RED_RETRIES→停、convergenceBlocked→终态）。**行业把约束做成模型可见的上下文，我们做成模型不可见的断路器。**

### 2. 循环中仲裁 vs 循环后选择（SWE-agent 教训）

我们在 loop 中间插多步仲裁链（分类→隔离→judge→证据校验→escalate），每条链的每一步都是潜在误杀点，且 5 连死证明组合交互无法穷举测试。SWE-agent 让 attempt **完整跑完**再评估，失败也 fresh 重来，**终点永远是 get_best() 保留最优** —— 他们的 run 结构上不可能"以零成果死亡"，我们的 5 连死全是 0 phase 保留。

### 3. 不信任模型 vs 工作区即真相（DSH 教训）

我们结构化验证模型的每个声明（symbol-check 防空壳、deliverable regex 防缺文件、oracle 防 RED 造假）；DSH 的回答是 workspace-as-authority + worker 自报三态 + "非独立认证"明示。我们的机器防住的真缺陷（空壳符号、缺失字面量、prior-run 污染）确实存在，但**每次误杀的代价（30–120 分钟 agent 时间 + 整 run 归零）远大于一次漏放**（verify 阶段还有第二道，且最终 merge 前 build gate 必过）。

### 该保留的（便宜、单发、确定性、零交互）

worktree 沙箱隔离、密钥扫描、deliverable 文件存在性、symbol-check、post-RED oracle、**in-scope** build/test —— 单步、无链、误报率低、每次都是真信号。

### 该降级的（改成反馈注入，不阻断）

baseline 回归判定、越界修改检测（实际上 v0.2.2 后已是 advisory）、judge 全部路由 —— 诊断作为 feedback 进 retry prompt（我们已有 judgeGuidance 机制），**但不再作为 gate**。

### 该删掉或彻底简化的（多步仲裁链）

classifyGateFault→quarantine→re-gate→re-classify 链（v0.2.6 已把它修成几乎不可达，维护成本>收益）；judge 证据校验豁免集矩阵（v0.2.4/0.2.5/v0.2.11 三次逐路由打补丁，每补一个杀一个）；convergenceBlocked 终态（应改为"保留最优成果结束"）。

## 四、建议的最小改动集（Ralph 化改造，供决策）

按性价比排序，前两条即可消除 5 连死的整个死类：

1. **终点保留最优（SWE-agent get_best 语义）**：no-progress/cap 终结时不再"0 phase 收场"，把该 phase 已有的最好 attempt（本次 run 的最后一次完整 attempt）作为成果保留并在 summary 里如实标注"unverified best-effort"——消除"归零死亡"。
2. **仲裁链降级为反馈注入**：judge/classifier 的诊断全部走 judgeGuidance 反馈通道进 retry（已有机制），删证据校验丢弃路径（诊断永远可达模型）；escalate 只在绝对 cap 时触发一次。
3. **预算提醒化**：phase 失败计数到达阈值前 1 次，注入"你还剩 N 次尝试，失败签名 X 已重复 M 次"上下文（Codex reminder 模式），模型多数情况会自行换路。
4. **fresh attempt 替代 mid-loop 重试**：同签名两次失败后不再仲裁，直接 fresh 重来该 phase（Ralph 轮语义），上限内无限重试由预算控制。

预计净删除数千行仲裁代码及其测试面（2559 tests 中估计 800+ 是钉仲裁语义的），换来的是：run 结构上不可能归零、误杀类死因整体消失、机器与模型的责任边界与行业一致（机器管安全和预算，模型管语义）。

## 五、诚实的反面（不删的理由也记录）

- 我们的确定性门确实抓住过真缺陷：v0.2.2 honest-deliverable 门抓到真实缺失字面量（`export function` vs `export async function`）；symbol-check 抓过空壳。SWE-agent 式"模型自证"在**无人复核的 headless 批量跑**里会放进幻觉成功 —— 但我们 headless 跑的终点本来就是 PARTIAL+人工检查，幻觉成功的代价可控。
- 本仓库的 super-dev 是 dogfood 对象：这些约束的历史事故编号就是它的进化记录。方向应该是"保留单发确定性门 + 删除多步仲裁"，不是全盘 Ralph 化。
- DSH/Codex 是**交互式产品**（人就在旁边），我们是无人值守流水线 —— 但这恰好加强而非削弱结论：无人值守更应该"保底保留成果"，因为没有人会当场救 run。
