# Harness 约束研究终稿：11 个来源的综合分析与 super-dev 重架构

Status: implemented (this commit — v0.3.0)

本研究综合四类证据：(A) 4 个本地 harness 全码深读（DSH、Codex-Rust、SWE-agent、cumora），(B) 全文精读的 7 篇一手工程文献（Anthropic×2、OpenAI、Cognition×2、ghuntley、alatirok、Tian Pan、Aider 文档），(C) 本仓库 track-07 五连死的死因记录，(D) 仅有的两次完整成功 run 的机器参与度对照。

## 一、全部来源的收敛结论（每条都有原文锚点）

### 1. 验证是反馈，不是门 —— 所有系统无一例外

- **Aider**（文档原文）："If there are test errors... Aider will try and fix any errors if the command returns a non-zero exit code." —— lint/test 的非零退出码直接喂回 LLM 上下文，模型自己修。没有 judge、没有分类器、没有 escalation。
- **Claude Code 最佳实践**（原文）："Give Claude something that produces a pass or fail, and the loop closes on its own. Claude does the work, runs the check, reads the result, and iterates until the check passes." —— 检查的产物是**模型可读的信号**，不是 harness 的裁决。
- **alatirok/AWS**：typed status（ok|no_results|error）让模型分支；模糊反馈才是循环之源。检测到重复时返回 BLOCKED **消息**（"Do not call this tool again... change strategy"），不杀 run。
- **OpenAI harness-engineering**（原文）："We intentionally chose... minimal blocking merge gates. Pull requests are short-lived. Test flakes are often addressed with follow-up runs rather than blocking progress indefinitely. **In a system where agent throughput far exceeds human attention, corrections are cheap, and waiting is expensive.**" —— 1500 个 PR、百万行代码、3 个工程师、零人写代码。
- **Devin**（Cognition）：review loop 是 Devin + Devin Review **互相迭代到干净**，不是 review 否决就停。

### 2. 预算 = 上限 + 提醒，不是语义裁决

- **ghuntley Ralph**：`while :; do cat PROMPT.md | claude-code; done` —— 循环次数即预算（数百轮），失败就下一轮 fresh agent，"eventual consistency"。
- **Codex-Rust 源码**：rollout_budget 是 `pending_reminder()` —— 给每个线程投递"还剩 N token"的提醒消息；语义层验证代码为 0 行（safety.rs 只有文件系统安全）。
- **SWE-agent**：`cost_limit` / `max_attempts` 兜底，循环内零仲裁。
- **alatirok**："max_turns is a fuse, not a fix" —— 上限是保险丝，真正的控制是反馈质量。

### 3. 永远保留最优成果 —— 我们是唯一的例外

- **SWE-agent reviewer.py**（源码）：`get_best()` 在**全部尝试都失败时也返回最优解**（取 max score，同分选 API 调用最少的）—— run 结构上不可能零成果结束。
- **Anthropic harness**（原文）："ask the model to commit its progress to git with descriptive commit messages... This allowed the model to use git to revert bad code changes and **recover working states of the code base**."
- **ghuntley**：每个 loop git commit；"you will wake up to a broken code base... Is it easier to do a `git reset --hard` and kick Ralph off again?" —— 崩溃的恢复单位是 git 状态，不是 run。
- **Tian Pan**（原文）："An agent that holds all task state in its context window has no recovery surface" —— checkpoint 外置是部分完成的前提。
- **我们**：convergenceBlocked → PARTIAL 0/12 phase → 前面 9 个阶段的全部文档成果 + phase 内 572/573 通过的代码**全部作废**。五连死每一死都如此。

### 4. 反谎报靠"事前承诺"，不靠"事后对抗"

- **Devin**（原文）："Devin will lie less about its findings if it **annotates its expected behavior right before performing an action** — much like test-driven development, if you commit to the expectation upfront it makes it much harder to rationalize an unexpected result as a pass."
- 我们已有的 RED-first TDD 就是这个机制 —— 它是对的，保留。但 RED **review 强度门**是事后对抗，post-RED oracle（实现后测试转绿）才是廉价确定性验证。
- **Devin 年度评审**："Devin excels at tasks with **clear, upfront requirements and verifiable outcomes**... Humans check unit testing logic after Devin takes the first pass." —— 人类验收在最后，不在循环内。

### 5. 评估器存在时，其输出是生成器的输入（GAN 模式），且随模型进步做减法

- **Anthropic GAN 文章**（原文）：evaluator 的 finding "flowed back to the generator **as input for the next iteration**"；且 "every component in a harness encodes an assumption about what the model can't do on its own, and **those assumptions are worth stress testing**... they can quickly go stale as models improve" —— 他们逐个删件验证哪些还在承重。
- **Cognition**：clean-context review agent 平均每 PR 抓 2 个 bug、58% 严重 —— 但它的产出进 generator 迭代，不是 merge 门。
- **Jules（Latent Space 访谈）**："we had the agent scaffolding around it was incredibly complex... **scaffolds get simpler and simpler over time as the models get better**... less is more."
- **我们**：v0.1.97 → v0.2.11 每版加一层机器（judge→证据校验→分类器→隔离→re-gate→再分类→escalate），无一做过减法，五连死全是机器相互作用。

### 6. 环境问题 = 提供恢复原语，不代模型仲裁

- **OpenAI**：worktree per change（"the app bootable per git worktree, so Codex could launch and drive one instance per change"）+ 隔离的 observability stack —— 给 agent 干净环境，而不是在脏环境上判断谁是罪魁。
- **我们的 v0.2.6 已经走对**：全新 worktree 消除了 prior-run dirt 类（本次 run 05 的 v0.2.10 验证了这点）。分类器/quarantine 链在干净 worktree 世界里已无事可做。

## 二、重架构（v0.3.0）：反馈闭环 + 预算保险丝 + 永不归零

### 设计原则（按来源映射）

| 原则 | 来源 |
|---|---|
| 1. 确定性检查的输出是 retry prompt 的一部分，不是裁决 | Aider / Claude Code / alatirok |
| 2. judge 降级为顾问：诊断注入反馈，永不门控 | Anthropic GAN / Cognition |
| 3. phase 失败耗尽预算 → 保留最好 attempt，标记 partial，**继续下一 phase** | SWE-agent get_best / Anthropic git / OpenAI |
| 4. run 永不以 0 phase 收场；verify 如实报告 verified/partial/gap | SWE-agent / Devin |
| 5. 预算提醒进上下文（"剩 N 次，签名 X 已重复 M 次"） | Codex-Rust rollout_budget / alatirok |
| 6. 保留的硬门只剩安全类：密钥扫描、worktree 隔离、main-checkout 保护 | Codex safety.rs / OpenAI running-codex-safely |
| 7. RED-first 保留（事前承诺），RED 强度 review 降为 advisory | Devin annotate-before-act |

### 具体改动

**F1 — Phase 失败不再终结 run（最大改动）**
- 删除 `convergenceBlocked` 终态语义：budget 耗尽的 phase 标记 `status: "partial"`，best attempt 的 diff 通过 git stash 保存（`phase-<id>-partial` 标签 + stash），phase 状态表如实记录 `attempts/bestResult/reason`。
- 外层循环（stages/index.ts 的 while）继续跑后续 phase —— 后续 phase 依赖缺失时其 RED 会自然失败，同样标 partial；最终 summary 给出 `X green / Y partial / Z blocked-by-upstream` 的诚实账目。
- escalation 保留为**通知**（headless 写报告 + 有 UI 时询问一次"继续/停止"），但缺省继续。

**F2 — Judge 全降级为顾问**
- `runJudge` 的所有 consumer 从"路由状态机"改为"诊断注入"：routed 与否都只产生 `judgeGuidance` 文本进下一次 retry prompt（机制已存在）。
- 证据校验不再丢弃任何诊断：fabricated 证据只意味着"诊断标记为 unverified"，照样注入。
- 删除 env-blocker judge 专用通道（v0.2.3 遗产）—— 分类器（classifyGateFault）同样降级：环境类失败 = 注入"这些 out-of-scope 失败疑似环境性：baseline 在 merge-base 通过；可用 git stash 自证/修复"的建议，不再 quarantine。

**F3 — 预算提醒**
- 每 phase attempt N（N ≥ 2）的 implementer prompt 头部注入："这是第 N/M 次尝试。之前的失败签名：X（已重复 R 次）。剩余预算 M-N 次。"（Codex reminder 模式）

**F4 — RED review 强度门 → advisory**
- 弱 RED 的处理从"打回 tdd-guide 重写（最多 6 轮）"改为：注入 weakness 分析进 implementer prompt + 照常实现；post-RED oracle 仍是确定性终点（测试必须转绿）。tdd-guide 重写只在天真 RED（non-red，测试一开始就绿）时触发一次。

**F5 — 保留不动的（每条都有承重证据）**
- 密钥扫描/merge 阻断（安全类硬门）；worktree 隔离 + 全新 worktree（OpenAI per-change 环境）；main-checkout 拒绝提交；deliverable 文件存在性 + contains 检查（廉价单发，run 15-07 类真缺陷）；post-RED oracle；in-scope build/test 本身（它就是 Aider 的 test-cmd —— 关键是结果进 prompt 而非进裁决器）。

### 预期效果对照 track-07 五连死

| 死亡 | v0.3.0 行为 |
|---|---|
| 01-47 环境误判 | 无分类器；out-of-scope 失败原文进 prompt，模型自判（572/573 的状态下模型已经自己诊断对了）|
| 03-16 judge 超时 | judge 是顾问，超时只损失一条建议；预算保险丝管终局 |
| 05-09 quarantine 自伤 | 无 quarantine |
| 02-01 / 14-54 证据校验丢弃 | 无丢弃；诊断（本来就是对的）直接进 retry prompt |
| 所有死亡的 0-phase 归零 | 结构上不可能：partial 保留 + 后续 phase 继续 + verify 诚实报告 |

## 三、诚实记录：这个方向的风险

1. **幻觉成功可能率上升**：post-RED oracle 挡住"假绿"（测试必须真转绿），但"测试本身弱"的空隙比 RED 强度门时代大 —— 与 SWE-agent/Devin 同等水平，靠 verify 报告 + 人工 merge 把关（我们本来就有）。
2. **多 phase 依赖断裂时后续 phase 会连锁 partial**：可接受 —— 每个都留了诚实账目，比 0-phase 归零信息量大得多。
3. **失去的机器里有些是用户血汗**（v0.2.2 honest-deliverable 抓过真缺陷）：F5 明确保留 deliverable 检查；被删的只有"多步仲裁链"。
4. **这是哲学切换**：从"机器不信任模型"到"模型管语义、机器管安全和预算"。OpenAI/Anthropic/Google/Cognition/DSH/SWE-agent 全部站在后者；我们五连死的实证也站在后者。
