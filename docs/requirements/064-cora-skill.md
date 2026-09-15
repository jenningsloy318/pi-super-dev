# 064 — COBRA-Skills (contextual bandit-guided evolution for agent skill optimization)

Status: reference — paper study (2026-09-15). Source: arXiv:2609.11682, HTML full text fetched and read.

Paper: **"COBRA-Skills: Contextual Bandit-Guided Evolution for Agent Skill Optimization"** — Wang Xiangyi, Li Xiang, Mao Jie, Qu Zikun, Luo Junfeng, Shu Yao, Low Bryan Kian Hsiang, Dai Zhongxiang (CUHK-Shenzhen, Tianjin University, HKUST-Guangzhou, NUS). Code: https://github.com/Jerry-LuP/COBRA-Skills

**Original session note (kept):** this is a skill we may be able to learn from — see the Lessons section for what transfers.

---

## 1. The problem

LLM agents benefit from *reusable skills* distilled from prior task experience (a skill encodes task-specific guidelines, reasoning strategies, or tool-use procedures, injected into the agent's context). But obtaining reliable skills is hard:

- Manual authoring needs domain expertise and effort.
- Skills generated from the LLM's parametric knowledge are "plausible but ungrounded guidance that does not reliably improve downstream performance."
- Existing grounding methods (build skills from real trajectories + execution feedback, then iterate) hit **two efficiency bottlenecks**:
  1. **Candidate utility is expensive to assess** — generate–evaluate–refine loops must *execute* candidates on tasks before utility is known, so "substantial optimization budgets can be spent evaluating low-quality or unpromising skills before they can be identified as such."
  2. **Skill refinement itself is expensive** — repeatedly invoking LLMs to re-analyze trajectories, diagnose failures, and aggregate modifications burns tokens.

> The key challenge: **selectively allocate candidate evaluations** and **efficiently reuse the resulting execution evidence**, rather than exhaustively evaluating and repeatedly rewriting candidates.

## 2. The formulation — budgeted sequential optimization over an evolving candidate space

Each candidate skill is treated as a **bandit arm** represented by its semantic embedding; the observed target-agent performance is the **reward**. Because the arms are described by features *and vary across rounds*, this is a **contextual bandit** — conditioning reward prediction on arm features lets *previous evaluations inform the prioritization of semantically related skills, including those not yet evaluated*.

Formally: small optimization set `D_opt` (50 examples), initial no-skill trajectories `T_0`, finite horizon of `T` rounds; the goal is the skill `s*` that maximizes expected metric on the *task distribution*, not just on `D_opt`.

## 3. The method

**Closed loop between (a) contextual-bandit prioritization and (b) evidence-grounded evolution.**

### (a) Bandit-guided skill search

- **Neural reward prediction.** Each candidate `s` → embedding `z_s = φ(s)` (φ = fixed embedding model, Qwen3-Embedding-4B). A lightweight **two-layer MLP** `f_θ` (ReLU hidden, scalar output) estimates reward from `z_s`, refit every round on all accumulated history with MSE + ℓ₂ regularization.
- **LinearUCB exploration bonus.** `b_t(z_s) = ν · √(z_sᵀ Aₜ₋₁⁻¹ z_s)`, where `A = λI + Σ z zᵀ` over previously evaluated embeddings. "Candidates in less explored regions of the embedding space retain larger confidence bonuses, whereas repeatedly evaluated skills and their nearby semantic regions become less uncertain."
- **Priority score** `U_t(s) = f_θₜ₋₁(z_s) + b_t(z_s)` — evaluate the **highest-priority** candidate, allocating budget toward skills that are **either promising or insufficiently explored**. The *same* score is reused at population updates to prune low-value candidates.

### (b) Evidence-grounded evolution — scheduled, not every round

Population updates fire on a **schedule condition**: `t − t_last ≥ d AND log(t / t_last) ≥ η` (d=3, η=0.35) — a *logarithmic* schedule, so evolution gets rarer as rounds accumulate. At each update, prune the `m` lowest-priority skills and replenish via three operators:

- **Regeneration** — an independent skill derived from the *original no-skill trajectories* `T_0`, with **no parent**. "Introduces new strategies beyond the current population, helping maintain population diversity and avoid premature convergence."
- **Rollout mutation** — locally refines the skill evaluated this round, sampling its **successful and failed trajectories** as concrete evidence. "Directly connects bandit-guided evaluation with evidence-grounded local refinement."
- **Crossover** — a high-performing skill as **backbone**, compatible strategies from other strong skills as **positive evidence**, low-performing skills as **negative evidence** — "performance-grounded recombination **without directly concatenating parent skills**."

> Newly generated skills **receive no inherited reward** and must re-enter the same bandit loop.

Hyperparameters (fixed across all models/benchmarks): T=30 rounds, population K=10, prune m=3, ν=0.1, crossover enabled after >8 distinct skills evaluated, operator ratio 2:1:0 (regen:mutate:crossover) early then 1:1:1.

### Separation of concerns (the architectural point)

> `M_teach` performs **only** evidence-grounded skill generation and refinement, while **candidate evaluation scores are determined solely from feedback obtained by executing the target agent `A`**.

The teaching model never scores its own candidates. Scoring is execution-grounded only.

## 4. Results

- Best average across **six heterogeneous benchmarks** (SearchQA, SpreadsheetBench, DocVQA, LiveMath, SocialMaze-HRD, ALFWorld) for **every** target model: **+13.1 / +26.9 / +22.5** points over the no-skill baseline on Qwen3.6-35B-A3B / GPT-5.4-Nano / Gemma-4-26B-A4B-it.
- vs **SkillOpt** (the prior SOTA iterative method): total optimization cost **reduced 55–58%**, cost per point of improvement **reduced 60–69%**, using **only 50 optimization examples** (vs SkillOpt's larger pool). Teaching-model tokens are ~3–4M vs SkillOpt's 12–15M — most of the saving is in *not* re-analyzing trajectories every round.
- **Harness-independent**: same gains under **Claude Code** and **Codex** as external harnesses.
- **Self-teaching works**: the target model itself can be the teaching model — gains are not tied to a stronger external teacher.

## 5. Lessons for super-dev (what is actually transferable)

The paper optimizes *one skill for a task distribution*; super-dev builds *one pipeline for one task*. That is a different object. But four mechanisms are directly relevant:

1. **Scoring must be execution-grounded, never self-assessed.** The teaching model generates and refines; the score comes only from the target agent's execution. This is the same honesty principle as our P10 and our "reviewers verify, writers declare" (059 DEC-8) — and it is why LLM-judge-only eval is weaker than deterministic-gate + LLM-judge. *Where we could apply it:* any place an agent both produces and grades its own work.

2. **No inherited reward for new candidates.** A regenerated/mutated skill starts with **no reward prior** and must earn its own evidence. *Our analogue and its bug class:* the 058/059 anchor-superseding work — a re-rendered artifact must not inherit the green stamp of the artifact it replaced. Stale green stamps are false evidence (P5). COBRA makes "no inherited reward" a first-class rule of the search, not a cleanup.

3. **Bandit allocation of a costly evaluation budget.** When evaluation is expensive (a full target-agent run), don't evaluate everything — prioritize by *predicted utility + exploration uncertainty over a semantic embedding*, so prior evaluations inform *unseen* candidates. *Where we could apply it:* our eval layer (v0.3.89–91) currently measures escape rates across a fixed suite; a bandit would allocate the next eval toward the configurations that are either promising or underexplored. The LinearUCB bonus is the principled fix for the "we keep testing what already passes" failure mode. **Cost note:** it needs an embedding model over the search space — a real dependency, not free.

4. **Scheduled, log-spaced evolution instead of every-round refinement.** Evolution fires on `t − t_last ≥ d AND log(t/t_last) ≥ η`, and most of the token saving vs SkillOpt comes precisely from *not* re-analyzing trajectories every round. *Our analogue:* our convergence loops re-prompt every round; a scheduled-evolution design would bound the analysis cost. The log schedule is the boundedness mechanism (our P8: every retry loop has a proven bound).

**What NOT to lift:** the paper's 50-example optimization set and single-skill object are too small a unit for a pipeline; and embedding-similarity transfer assumes the search space is *semantically smooth*, which is plausible for skill phrasing and much less plausible for architecture choices.

## 6. Sources

1. arXiv abstract: https://arxiv.org/abs/2609.11682
2. arXiv HTML full text (read): https://arxiv.org/html/2609.11682v1
3. Code: https://github.com/Jerry-LuP/COBRA-Skills
4. SkillOpt (the baseline it beats): https://arxiv.org/pdf/2502.00728
5. Contextual bandits — Li et al. 2010; Chu et al. 2011 (cited in the paper's background)
6. Trace2Skill (baseline): cited as Ni et al. 2026
