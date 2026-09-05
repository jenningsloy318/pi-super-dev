# External-Knowledge Review — v0.3.68 planning (2026-09-05)

> Inputs: (1) the three SDLC docs under docs/requirements/sdlc/ (LangChain
> agent-development-lifecycle, OpenAI building-an-ai-native-engineering-team,
> the AI-native SDLC playbook); (2) online research 2026-09-05 (Anthropic
> "Effective context engineering for AI agents" + "How we built our multi-agent
> research system", Sourcegraph/cruxdigits context-engineering 2026 guides,
> GitHub spec-kit, pi 0.82–0.85 release notes); (3) full codebase survey
> (src 38.9k lines, 33 agent prompts, 200 test files).

## What the research CONFIRMS we already do right

| Published pattern | Our implementation |
| --- | --- |
| Tool output truncation is mandatory (pi docs canon; Anthropic "smallest high-signal set") | v0.3.60 R8: 50KB/2000-line canon + full-output pointer |
| Verifier with FRESH context ("verdict not colored by the assumptions that produced the code") | every reviewer is a fresh delegated child; code-reviewer.md forbids reviewing own output |
| Evidence discipline (spec-kit / Anthropic judge patterns) | judge verdicts carry byte-verified verbatim quotes; fabricated quotes discard the verdict |
| Scale review effort to change size | adversarial-reviewer scope-scaled lenses (S/M/L) |
| Structured data → deterministic render (agent never fights markdown) | schemas.ts TypeBox + njk render pipeline since v0.3.2 |
| Durable execution + checkpoints + resume-from-error (Anthropic production lesson) | resume memoizer + .resume-cache.jsonl + partial-preserve (v0.3.0 harness research) |
| Just-in-time retrieval (paths, not contents) | upstream artifacts referenced by path in every stage prompt |
| LLM intent classifier over keyword routing (2026 routing research) | task-classifier agent (v0.3.x), cited in code |
| Coverage hard gates in CI | 85% lines/functions/statements + 80% branches, commit-blocking |
| Incident → regression-test loop (LangChain traces→datasets) | incident-named test suites (F1–F9) per fix wave |

## Findings (gaps the research exposes)

### F10-1 [HIGH · governance/token] Delegation usage is logged, never accounted
Anthropic: multi-agent ≈ 15× chat tokens — cost governance is the #1 published
multi-agent lesson (also LangChain "Govern → Cost"; SDLC playbook "how to
measure it"). We PARSE `DelegationUsage` (turns/toolCalls/input/output/
cacheRead/cacheWrite/cost/durationMs — delegation-backend.ts:178–186) but it is
formatted into one log line and dropped: `SpawnResult` carries no usage, nothing
aggregates per-agent or per-run totals, `RunSummary` has no usage block, and the
budget fuse counts agent SPAWNS only — a run can burn unbounded tokens within
the spawn budget. **Fix (implemented v0.3.68):** `SpawnResult.usage` +
delegation threading + a run-scoped accumulator in workflow.ts + `RunSummary.usage`
(+ rendered in the run summary log) + two fail-closed env fuses:
`SUPER_DEV_MAX_RUN_COST` / `SUPER_DEV_MAX_RUN_TOKENS` (checked pre-call; breach
returns an honest per-call error naming the fuse, mirroring the budget fuse —
never a silent drop).

### F10-2 [HIGH · closing-the-loop] No deterministic run-metrics harvest
The SDLC playbook's closing-the-loop play (deterministic scripts watch
production; findings re-enter the pipeline) and LangChain's monitor stage both
require machine-readable run outcomes. Our run.log is prose; findings F1–F9 were
hand-mined from 4,000–8,000-line logs. **Fix (implemented v0.3.68):** at run end
append one JSON row to `<specDir>/run-metrics.jsonl`: runId, status,
wallMs, agentsSpawned, stage-status histogram, agent-error round count,
FatalAbort count, usage totals (F10-1). Trend watching becomes `jq` over rows;
the σ-band play can be layered later without re-mining logs.

### F10-3 [MED-HIGH · token efficiency] No effort scaling to task complexity
Anthropic lesson 3 ("scale effort to query complexity" — explicit effort tiers
in prompts; agents cannot judge their own effort). Our taskType affects exactly
one branch (bug ⇒ skip design stage). A one-line typo fix and a 10-phase
feature get identical convergence round caps (8), identical extension behavior
(3× ceiling), identical research/review budgets — small tasks over-spend rounds
and large tasks under-extend only via the generic progress-extension mechanism.
**Fix (implemented v0.3.68):** deterministic `effortProfile(taskType, phaseCount)`
table (no LLM — P4): trivial (bug / ≤1 phase) rounds 4, standard (feature, 2–4
phases) 8 (unchanged), large (feature/refactor, ≥5 phases) 10 with unchanged
3× ceiling. Applied where `options.maxRounds ?? MAX_CONVERGENCE_ROUNDS` resolves
in artifact-convergence; fail-open (standard) on any unknown shape.

### F10-4 [MED · review signal] Review policy lacks the REVIEW.md plays
SDLC playbook REVIEW.md play + OpenAI review guidance: define Important-vs-Nit,
**cap the nits**, and a do-not-report list — "concise, high-signal feedback;
overly verbose responses are ignored just as easily as noisy lint warnings."
Our reviewers emit severity+confidence per finding but no cap and no
do-not-report rules; every nit burns implementer tokens and Stage-10 rounds.
**Fix (implemented v0.3.68):** severity-calibration + nit-cap + do-not-report
sections in code-reviewer.md and adversarial-reviewer.md (prompt-level;
deterministic caps stay in the convergence machinery).

### F10-5 [MED · token efficiency] inheritSkills is uniform ON
Every child pays ambient skill-listing/discovery tokens even for pure-mechanical
roles (classifiers, judges, boundary classifier) that never need user skills.
**Fix (implemented v0.3.68):** per-role table in register-agents.ts —
mechanical roles get `inheritSkills: false`; writers/researchers keep the
configured default.

### F10-6 [MED · reliability] `call.schema` is dead plumbing at the delegation seam
`AgentCall.schema` (TypeBox) is threaded to the delegation backend but the
DelegationRequest carries no schema and the backend never embeds it — the child
sees only the prompt's prose "Data to return" list; engine-side validation is
post-hoc (missingControlKeys + render-time Value.Errors), and the corrective
re-prompt loop re-checks only missing KEYS, not schema SHAPE violations — a
wrong-typed field burns a full round before render-time rejection.
pi 0.82's constrained tool sampling cannot engage through this seam either.
**Plan (documented, next wave):** extend the delegation corrective loop to run
`Value.Errors` on strict-capable schemas and feed the actual violations back in
the corrective task (bounded, honest). Full constrained sampling needs an
upstream pi-subagents request field — tracked in docs/upstream-watch.md.

### F10-7 [LOW · SDLC plan play] implementation-plan lacks per-phase Risks
Playbook plan.md play: Files-that-change / Order / **Risks** / **Proof**. Our
phases carry deliverables (≈Proof, enforced) but no Risks field.
**Plan (documented, advisory schema addition next wave).**

### F10-8 [LOW · code standard] implementation.ts is a 3,688-line module
34 exports; RED-oracle machinery, phase loop, commit machinery and 40+ helpers
interleaved (F8/F9 both lived here). **Plan:** extract the pure red-evidence
family (`classifyRedEvidence`, `redEvidence*`, signatures — already unit-tested)
to `src/stages/red-evidence.ts` as the first slice; no behavior change.

### F10-9 [LOW · evals-in-CI] E2E harness is scratch-dir knowledge
The full-stages E2E pattern proven in v0.3.65/v0.3.67 verifications lives only
in session memory. **Plan (documented):** testing-strategy.md recipe section.

## Research notes (for future waves)
- pi 0.85.0: restorable in-memory sessions (SDK) — candidate for bench resume.
- pi 0.82: constrained tool sampling — blocked on upstream (F10-6).
- pi 0.80.4: `agent_settled` events — not needed while delegation-only.
- Anthropic structured note-taking / memory tool — our convergence ledger +
  workspace-as-memory cover the run-local case; cross-run memory is out of
  scope for this wave.

## 2026-09-05 双审查员复审裁决（ten-commit range c13824f3^..HEAD）

sd-code-reviewer + sd-adversarial-reviewer（fresh-context 前台子代理）+ 本机对抗核查合并裁决：
**CONTEST → 修复后可推**。v0.3.72 落地以下类级修复：

| # | 发现 | 裁决/修复 |
|---|------|----------|
| M1 | corrective/瞬态重试丢弃前几次 usage（fuse 少计） | **修**：`mergeUsage`（types.ts）逐字段求和；delegation-backend 所有 corrective/失败终端 return 求和；`runWithTransientRetry` 合并全部尝试 |
| M2 | 版本偏斜 shape B（`Cannot find module '…/pi-subagents/…'`）逃过 sticky degrade | **修**：`DELEGATION_RUNTIME_EXTENSION_FAILURE_RE` 增加模块解析形态（路径必须含 pi-subagents，不误伤） |
| M3 | fuse env 非数值 → NaN 静默失效 | **修**：按变量一次性 WARN（`WARN usage fuse DISABLED … is not a number`），loud-unlimited 而非假上限 |
| M4 | register-agents 部分注册文案仍说 "degrades to the session backend" | **修**：改为 Unknown agent per-call 失败 + 修复指引 |
| M5 | deliverablesAlreadyMet notContains-only 空虚满足 | **CLEAR（带证据）**：pre-implement 跳过仅 resume-gated（implementation.ts:1739）；green-already-satisfied 仅在 RED oracle 跑绿时触发（:388）；验证节点确定性复跑 build+deliverables（:2374-2386）；polluted-red 先分类（:385）。notContains 的"缺失即满足"是文档化语法语义（gates.ts:1799），同类契约 oracle 在实现后同样通过 |
| N1 | model-not-found 不在 NON_RETRYABLE（白烧 3 轮） | **修**：`unknown subagent model / model X not found / no such model` 入 NON_RETRYABLE_AGENT_RE → 即刻 FatalAbort |
| N2 | STRUCTURED_UNSUPPORTED_RE 裸词 "structured" 太宽 | **修**：必须命名 delegation field（`unsupported delegation field: … result|schema|outputschema`） |
| N3 | sigma-band MAD=0 恰 3σ / pooled 基线 / prediction 3 样本定案 | **记录**：advisory-only（从不 gate），已知噪声，不动 |

审查员明确 CLEARED：sigma 自基线排除（sigma-bands.ts:131-134）、__replan 崩溃窗口（per-run in-memory + resume 只存 AgentResult + 失败进程以命名 skip 退场）、降级后 text 路径字节一致、结构化双层校验均运行、计数器重置/回放守卫正确。套件 3251 passed + 1 skipped，coverage 92.75%/81%/94.96% 过门。
