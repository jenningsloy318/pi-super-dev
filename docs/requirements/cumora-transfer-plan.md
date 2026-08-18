# Cumora → super-dev Transfer Plan — Actionable Mapping

Status: proposed — pending decision on which items to implement

Companion to `cumora-deep-analysis.md` (the full repo study). That doc holds
the *analysis*; this one holds the *repo-mapped action plan* — every lesson
tied to a concrete super-dev touch-point, plus priorities. Nothing here is
implemented yet.

---

## 1. Mechanism-design philosophy (highest leverage)

### P-01 Prompt 是软机制；该用代码就别加 prompt 规则
Cumora: "Never add a prompt rule when a code mechanism is the right fix."
Their deterministic loop floors (hard cap 20 agent-messages since human
attention, lapping detector, every-8th-DM check) were deleted twice "for
AI-native elegance"; loops regressed both times; the doc now marks them
**DO NOT REMOVE** with incident history attached.

**super-dev mapping**: our equivalents are `REVIEWER_DUTY_ROUND` (3),
`effectiveRoundCap` (min(prior+max, 3×max)), the one-shot +4 strict-progress
extension, and `MAX_CONVERGENCE_ROUNDS` (8). Each was earned by a dead-run
class (run 08-56 plateau; run 02-16 moving target; 11 runs / 10.75h).
**Action**: annotate these in their requirements docs as unremovable floors,
each with the incident ids that justify it, so a future "simplification"
pass cannot silently delete them the way Cumora's were deleted twice.

### P-02 乐观发送 + HELD 包络 > 先锁后动
Cumora's coordination model: post optimistically → server detects stale
state → returns a HELD envelope with the fresher messages inline →
recompute → resend, all within one round. No claim-then-act, no queue.

**super-dev mapping**: our convergence loops are strictly serial (review →
upstream rework → re-review, one round each). The retry feedback for
upstream stages should inline the blocking finding's full context (title,
detail, evidence, recommendation — the fields already exist on
`ConvergenceFinding`) directly in the writer prompt, so the upstream stage
fixes in one round instead of re-reading the whole review doc.
Note: F1's route-back replan already does part of this via the targeted
revision prompt — the gap is the *feedback payload* for in-loop rounds.

### P-03 旁路标志必须有代价 — 软门会磨损
Cumora's hardest lesson (2026-06-12 double-deliverable): agents learned to
pass `--send-anyway` preemptively; the freshness gate silently stopped
existing. Fix: every HELD records a short-TTL token; the bypass flag only
works by atomically consuming a token for state the agent was actually
*shown* — and reply tokens are seq-bound (void if the room moved on).

**super-dev mappings**:
1. `accept-limitation` escalation currently fabricates gate success with no
   recorded marker (known low finding from the spec-28 review). Cumora's
   answer is the token/acknowledgement pattern: accept-limitation must
   persist an auditable decision record (who/what/why/when) that later gates
   and reports can read — never a silent pass.
2. Kill-switches (`SUPER_DEV_NO_SPEC_REUSE`, `SUPER_DEV_REPLAN_MANUAL`,
   `SUPER_DEV_MAX_REPLAN_ROUNDS`) are legitimate ops bypasses, but each
   activation deserves a same-weight log line so postmortems can see which
   gates were switched off during a dead run.

**Principle**: any bypass on a coordination gate must be an acknowledgement
of server-shown state, not a client-side opinion.

### P-04 fail 方向按路径选择,写成原则
Cumora: triage fails OPEN when a human is waiting (never leave a human
hanging), fails CLOSED on pure agent-to-agent loops (never amplify), and a
classifier outage degrades to a narrow deterministic fallback rather than
silent death. Our F4 judge-degrade discovered this ad hoc.
**Action**: write the fail-direction of every failure path (replan trigger,
escalation, judge, gates) into one table in the convergence docs, with the
reason each direction was chosen — so new paths inherit the principle
instead of re-deriving it.

---

## 2. Directly transferable engineering practices

### P-05 逐调用 purpose 成本账本 + CI 警戒线
Cumora's `llm_calls` records every outbound call: who (tenant/agent/run),
what (purpose + model + source), how much (cache-aware tokens, cost,
latency), result (status + error), why (extras). Two static guards:
`guard:big-brain` (the big model may be reached through exactly two gated
paths — anything else is P0) and `guard:llm-tracked` (an untracked call is
P1).

**super-dev mapping**: we have stage budgets but no per-call purpose ledger
and no static tripwires. The 11-run / 10.75-hour STEP failure marathon could
only be attributed by hand-reading run.log.
**Action**: a uniform spawn-level record in `src/pi-spawn.ts` (stage × role
agent × purpose × tokens × cost × result) written to the run dir, plus a
static scan test that fails if any spawn path bypasses the recorder. Then
"which reviewer burned the tokens without converging" is one grep.

### P-06 统计性、形状对偶的真实 LLM 基准
Cumora's benchmarks: `chain` (team must adapt when a member is absent — lap
when needed) vs `counting` (explicit cap — never lap) are **shape-duals**;
a principle regression breaks exactly one. Thin harness (impersonate a human
seed message → poll → natural termination; zero harness LLM calls);
statistical pass bars ("≥67% of trials exact-match AND median collisions
0"), never per-trial.

**super-dev mapping**: all our 2,347 tests are unit-level with fake agents.
RC1 (moving-target reviewers) was only caught by postmortem.
**Action**: a benchmark pair against a small fixture repo —
`converges` (a well-specified task must converge within the round budget;
catches spiral regressions) and `holds-firm` (a genuine High/Critical
blocker must NOT be duty-downgraded into a false pass; catches
over-permissive convergence). N trials, statistical bar, cost budgeted per
Cumora's honest-cost-table convention.

### P-07 教练式 gate 错误信息
Cumora's anti-monologue rejection text names three legitimate next moves
("fold it into your next message… react 👀… or set_turn_status done and step
back") instead of just rejecting.
**super-dev mapping**: our gate errors are terse (`spec.phases must be a
non-empty array…`). The F6 structural-repair hint already moved this way;
the same pattern should cover the common rejection classes — each retry
feedback lists the *legal* next actions, not only the violation.
Cheap, directly reduces retry spirals.

### P-08 文档即带基线的工程日志
Cumora pins dated baselines ("coordination was perfect at 2026-05-28T22:17Z,
SHA X") so regressions are diffable against a known-good shape, and their
debug method is "diff against the last good baseline, revert to the SHAPE,
don't pile on."
**Action**: each major mechanism doc in `docs/requirements/` gains a
"last-known-good" line (version + behavior baseline), e.g. "convergence
loops: v0.2.1, requirements+BDD converge ≤3 rounds on the rethink corpus."

### P-09 "先读 transcript" 制度化为排障第一守则
Cumora's #1 methodology lesson: read the agent transcripts before
speculating — their T5 finding (agent diagnosed the math correctly but
refused on social grounds) existed only in the transcript. Ours: run 08-56's
BDD-019 six-round refusal was only visible in run.log.
**Action**: make "read the run.log verbatim first" line one of a short
debugging doc for dead runs, alongside their complementary lessons: re-query
live state before declaring failure (a watcher window is not a verdict);
diagnose infra (model/auth/sub2api-class outages) before adding mechanisms.

---

## 3. Warnings (anti-patterns to hold ourselves to)

### P-10 不要堆积机制
"Adding a fourth mechanism for a specific observed loop is usually wrong —
find which of the existing layers didn't catch it and fix that." Cumora
names the existing four (triage gate, activation floor, cost gate, agenda
throttle) so the question is always answerable.
**super-dev mapping**: post-v0.2.1 we carry ~206 new pins and several new
layers (duty enforcement, route-back replan, progress caps, repair hints).
Before any new gate/check, name which existing layer should have caught it:
replan circuit / duty downgrade / round cap / escalation / judge.

### P-11 Prompt 保持 shape-level,拒绝场景枚举
Cumora measured that scenario-example clauses make agents *worse* at the
same shape in a different context and start the "one rule per bug" slide.
Our convergence-duty contract in `src/prompts.ts` must stay shape-level
(no per-stage examples), and every future prompt edit should cite this.

### P-12 状态文件也会编码错误教训
Cumora's agent wrote itself a memory file codifying "stay silent on stalled
chains" — the system actively self-poisoning. Memory/state is not neutral
data.
**super-dev mapping**: `replan-requests.json` (addressed flips),
`.knowledge.json`, and the resume cache can all persist stale lessons or
stale verdicts. Re-entry/reuse paths must treat persisted state as
auditable, not authoritative — the G1 knownFindingIds shield already
gestures at this; the principle should be stated once in the docs.

---

## Priority (if only three things)

| # | item | why first |
|---|---|---|
| 1 | P-05 purpose ledger + static guard | closes the root blind spot — dead-run cost attribution; purely additive, low risk |
| 2 | P-06 shape-dual statistical benchmarks | the only systematic way to catch RC1-class regressions; fills the no-real-agent-tests gap |
| 3 | P-03 bypass tokens (accept-limitation record + kill-switch logging) + P-07 coach-style errors | closes a known low finding and cheaply reduces retry spirals |

One-line summary: Cumora demonstrates that a system of *optimistic attempts
+ server backstop + deterministic floors + an honest ledger + statistical
benchmarks* keeps N independent LLMs collaborating stably — we have the
floors; the backstop payloads, ledger, and benchmarks are the open items.

## Traceability

| item | cumora-deep-analysis.md source |
|---|---|
| P-01 | §4.1 layer 6, §4.3 anti-patterns, §15.2 |
| P-02 | §4.1 layer 5, §17.1 |
| P-03 | §4.1 layer 5d/5e, §4.3 "soft gates erode", §17.1 |
| P-04 | §4.1 layer 5c/6, §15.6 |
| P-05 | §7, §15.2 |
| P-06 | §12, §17.3 |
| P-07 | §10, §17.5 |
| P-08 | §15.1, §17.6 |
| P-09 | §4.4, §17.10 |
| P-10 | §4.3 |
| P-11 | §4.3, §4.1 layer 7 |
| P-12 | §4.4 T6, §16 |
