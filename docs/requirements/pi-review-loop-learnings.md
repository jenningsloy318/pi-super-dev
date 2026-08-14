# Learnings from pi's Parent-Orchestrated Review Loop

**Date:** 2026-08-14
**Sources studied:** `~/.pi/agent/npm/node_modules/pi-subagents/prompts/review-loop.md` (the orchestration contract), `pi-subagents/docs/agents.md` (agent model: context modes, acceptance, overrides), `pi-subagents/agents/reviewer.md` (the reviewer role definition), `pi-subagents/docs/workflows.md`.
**Compared against:** our verify-stage review convergence (`src/stages/verify.ts` reviewStep/fixStepReview/stagnation), artifact-convergence nodes, escalation machinery, and the audit fixes just landed (A-2/C-5).

---

## 1. What pi's review-loop actually is

A **prompt-level orchestration contract** for a parent agent driving child subagents:

1. **Parent = loop controller + final decision-maker.** Children get concrete role-specific tasks; children never orchestrate or spawn further subagents (unless an explicit fanout agent was chosen).
2. **Fresh-context parallel reviewers per round.** Reviewers inspect the repo/instructions/diff directly from files and commands — never from the parent's conversation history — and never edit files (reviewer agent's tools are read/grep/find/ls only; "Do not use shell commands or write files. Report any test or Git command that a supervisor must run").
3. **Angles chosen from the actual change** (correctness/regressions, tests/validation, simplicity; + security/perf/docs when warranted). "Prefer three strong reviewers over many vague reviewers."
4. **Explicit synthesis step by the parent**, categorizing feedback into: (a) blockers / scope-product-architecture decisions needing user approval; (b) fixes worth doing now; (c) optional improvements; (d) feedback to ignore or defer **with a short reason**. "Do not blindly apply every reviewer suggestion."
5. **Bounded loop:** default max 3 review rounds; early stop when no blockers/fixes-worth-doing, or only optional/deferred items remain, or an unapproved decision surfaces (→ ask the user). Re-review only after material changes — never loop for optional polish.
6. **Writer policy:** one writer at a time; no hard turn/tool/usage caps on workers (a default tool budget blocks read/search tools, not mutation tools; reported usage has no reservation model — counts don't measure delivery safety); narrow delivery slice + outer elapsed deadline; checkpoint requested *before* the deadline ("an elapsed timeout is not a mutation-safe boundary").
7. **Worker handoff = transition into review**, not completion.
8. **On completion the parent itself** inspects the final diff and runs/confirms focused validation, then summarizes rounds/fixes/validation/deferred/stop-reason.

## 2. Side-by-side with our extension

| pi review-loop element | pi-super-dev equivalent today | Verdict |
|---|---|---|
| Parent controller, leaf children | Stages orchestrate; writers/reviewers/testers are leaf `ctx.agent` calls | ✅ same shape |
| Fresh parallel reviewers, read-only | `reviewStep = parallel(code-reviewer, adversarial-reviewer)`, both `source-read-only`, re-spawned per round with no conversation history | ✅ partially — but only **2 fixed angles** (see L-1) |
| Angles from the actual change | None — the two roles are static regardless of taskType/uiScope/language | ❌ gap → L-1 |
| Synthesis: triage before fixing | **None** — all merged findings flow into `fixStepReview`'s implementer prompt; verdict-gated convergence keeps looping while any finding recurs | ❌ gap → L-2 (biggest learning) |
| Defer-with-reason registry | None — advisory findings recur each round, feed the recurrence fingerprint, and can trip stagnation | ❌ gap → L-3 |
| Early stop on "only optional findings" | Only via C-5's downgrade rules at verdict level; a round whose verdict is Changes-Requested-but-all-advisory still forces a fix round | ❌ gap → L-2 stop rule |
| Max 3 rounds, no polish loops | `MAX_CONVERGENCE_ROUNDS = 8` + stagnation + budget + `finalSafetyReReview` | ✅ equivalent intent, different bound (our rounds are cheaper/verdict-gated; keep 8) |
| One writer, narrow slice, elapsed deadline | One implementer per phase, 1200s timeout, per-phase scope | ✅ already our model |
| No turn/tool caps on writers | No tool budgets exist; budget = agent-call count | ✅ already our model |
| Checkpoint before deadline | One-shot agent calls can't checkpoint mid-flight; text-tail surfacing (Fix 3) is our equivalent recovery | ➖ N/A with rationale |
| Parent runs focused validation at the end | **Stronger:** deterministic RED oracle, build/deliverable/change/symbol gates, pre-merge build, and now A-2 git-verified merge + A-3 git-carried sensitive scan | ✅ we exceed pi here |
| Reviewers must not run commands | Our reviewers keep read-only bash (inspect-only) | ➖ keep ours — inspection without mutation is safe and more capable |

## 3. Initial adoptable-improvement candidates (pre-research — see §6 for verified/refined verdicts)

> **Status: SUPERSEDED by §6/§7** after deep research. Kept for traceability of what was originally proposed.

### L-1 Change-shaped third review angle (parallel reviewer fan-out)
`reviewStep` grows an optional third task. Angle selected deterministically from `state.classify` + audit context:
- taskType `feature` or phases with `requireScenarios` → **tests/validation reviewer** (coverage-vs-BDD-mapping angle — the exact gap class the audit's Verified-OK list keeps re-finding);
- language `rust|go|python` → **cross-language reviewer** (research shows LLM review reliability degrades on lower-resource languages; a second pass on language-idiom hazards);
- auth/payment/data tasks (keyword gate on task/spec) → **security reviewer**.
Merged verdict already takes max severity rank (`VERDICT_RANK`), so wiring is additive: one more parallel task + its prompt builder + schema. Cost: +1 agent call per review round.

### L-2 Finding triage (the synthesis step) before the fix writer — **highest value**
Deterministic partition of merged findings in `verify.ts` before `fixStepReview`, reusing the C-5 machinery (`reviewHasHighSeverityFinding`, `reviewFindingBlocks`):
- **fix-now**: blocking OR high/critical-class severity → routed into the implementer fix prompt (unchanged behavior);
- **deferred**: non-blocking medium/low → recorded in `state.review.deferredFindings` (id, reason), surfaced to docs stage + run summary, **not** routed to the fix writer;
- **stop rule**: a round whose verdict is `Changes Requested` but whose findings are ALL deferred-class → treated as `Approved with Comments` + recorded comments (loop exits instead of churning another fix round over advisory items).
Expected effect: kills the "advisory findings recur → recurrence fingerprint → false stagnation/HITL" failure class; shortens typical verify loops; focuses the implementer on real blockers. This is pi's "do not blindly apply every suggestion" made deterministic.

### L-3 Deferred-findings registry threaded into reviewer prompts
Feed the deferred registry into the next round's reviewer prompt as "known deferred items (with reasons) — do NOT re-report unless the code regressed or your evidence contradicts the deferral reason" — the code-review sibling of the `priorResponses` mechanism the spec-review convergence already uses. Without it, L-2's deferrals would still reappear in fresh reviewers' outputs every round (fresh context = no memory of the deferral decision; only the parent/orchestrator layer can carry it).

### L-4 Reviewer role hygiene note (documentation-level)
Mirror pi's reviewer.md working rules into `agents/code-reviewer.md` / `agents/adversarial-reviewer.md`: "inspect-only; report commands for the harness to run; do not invent issues — every finding must cite evidence." Low cost; reduces fabricated-findings noise at the source.

## 4. Deliberately NOT adopted (with reasons)

- **pi's 3-round cap:** our rounds are cheap, verdict-gated, and bounded at 8 with stagnation + budget + final safety re-review; artifact convergence legitimately needs more rounds than code review. Keep 8.
- **Reviewers without bash:** our reviewers need to read run artifacts/logs under the spec dir; read-only bash without edit/write is safe and strictly more capable. Keep.
- **Checkpoint-before-deadline for workers:** not implementable on one-shot `ctx.agent` calls; the shipped equivalent (Fix 3 text-tail + HITL escalation evidence) covers the failure mode.
- **Pi's acceptance/evidence levels:** superseded by our deterministic gates (build/deliverable/change/symbol + A-2 merge verification) — machine-checked beats attested.

## 5. Priority recommendation

1. **L-2 + L-3 together** (triage + registry — one commit; they are useless apart), then
2. **L-1** (third angle), then
3. **L-4** (doc-level).

All three code-level items are verify-stage-local, additive, and testable with the existing hermetic `ctx.agent` scripting pattern (`tests/stagnation.test.ts`, `src/stages/artifact-convergence.test.ts`). Cross-language by construction (triage and angles are language-agnostic; the L-1 language angle explicitly covers rust/go/python).

---

# Part 2 — Deep Research (2026-08-15, pre-decision)

Method: (A) empirical grounding from our own runs and code traces; (B) online research (AnySearch batch + source extraction) on LLM review triage, reviewer ensembles, bias, and production review-loop design; (C) first-principles system analysis of each candidate against the evidence. No code was changed.

## 4. Empirical findings from our own system (Part A)

### A-E1 — Stage 10 has ZERO production exposure
All 9 recorded runs (`~/.super-dev/runs/`) ended at Stage ≤ 9. The verify review loop (Stage 10a/b/c) has never executed against a real task; every historical failure we fixed (RED loop, testDefects channel, stagnation) happened earlier. **Consequence: every candidate here is pre-hardening of an unexposed stage, not a fix for an observed failure. Priority must weigh first-exposure reliability above optimization.**

### A-E2 — C-5 already shipped the loop-control half of L-2
`reviewApproved` accepts `"Approved"` OR `"Approved with Comments"` (verify.ts:459). Post-C-5, `normalizeReviewVerdict` downgrades an all-advisory "Changes Requested" to AwC (helpers.ts Changes-Requested branch: requires `reviewHasFindings && !reviewHasBlockingFinding && !reviewHasHighSeverityFinding` for the downgrade). So a round whose findings are all open-but-non-blocking/non-high **already exits the loop**. L-2's original "stop rule" is live. What remains of L-2 is only *fix-prompt hygiene* and *visibility*, not convergence.

### A-E3 — Verified/deferred findings are re-fed to the fixer and counted in the stagnation fingerprint
`mergeReviewVerdicts` (helpers.ts) concatenates **all** findings from both reviewers with **no status filtering**. `fixStepReview` passes `s.review.findings` verbatim into `buildFixPrompt`, and `findingsSignature` hashes `file|severity|title` for every finding regardless of status. So `status=verified` items (confirmations of already-fixed issues) and `status=deferred` items (reviewer explicitly deferred) are (a) re-fed to the implementer as work items, (b) keep the recurrence signature stable. Post-C-5 this is mostly prompt noise rather than a convergence bug, but it directly contradicts the finding contract ("status=verified and blocking=false") and invites the fixer to re-touch fixed code.

### A-E4 — Reviewers are not diff-scoped; cross-stage findings route to the code fixer
Both review prompts say "Review the implementation against the specification" — the whole worktree, not the diff. The Finding schema carries `ownerStage` ("requirements, bdd, …, implementation, verification, environment") but `buildFixPrompt` renders it as metadata only; a finding owned by `requirements`/`spec` is handed to the code implementer, who is simultaneously told to "make minimal, targeted changes". This is the cross-boundary anti-pattern (fixer applies a code workaround → reviewer re-flags → oscillation). Separately, `detectStagnation` deliberately treats count growth as legitimate ("a fresh reviewer can legitimately discover new findings"), so a reviewer that keeps emitting NEW advisory findings in untouched code never trips stagnation; the only bounds are the 8-round cap and budget.

### A-E5 — Triage inputs already exist
Every finding is contractually required to carry `status` (open/verified/deferred/needs-human), `blocking`, `confidence`, `evidence`, `recommendation`. The triage layer needs no new reviewer output — it is a pure deterministic post-filter.

## 5. Online research findings (Part B)

### B-R1 — The false-positive crisis makes "fix everything" structurally wrong
Top single-pass review configurations reach F1 ≈ 19-21% (arXiv 2509.01494; zylos survey): for every real bug flagged, roughly nine non-bugs get flagged. CodeRabbit's actionable rate ≈ 46-58%; well-tuned pipelines filter to 84% actionable by excluding minor/style items. SonarQube-style quality gates "block merges on critical findings while ignoring low-severity noise". The zylos design principles state it directly: **"Classify findings before feeding them back: severity, category, confidence, boundary_owner. Only in-scope findings above a severity threshold should drive the fix loop."** → Validates narrowing the fix loop to open+blocking/high findings (the residual of L-2).

### B-R2 — Cross-boundary findings must be excluded from the convergence loop, logged separately
The cross-boundary pattern (client flagged for server-side drift) is documented to oscillate: fixer applies mitigation → reviewer flags it as smell → repeat. The recommended resolution is a `boundary_owner`-style field with findings **"logged but excluded from the convergence check"**. Our unused `ownerStage` is exactly this field. → New candidate (R-1c).

### B-R3 — Scope creep / review paralysis is a documented convergence killer
Production systems constrain the critic to the diff plus one hop of dependencies and classify findings "in-scope" vs "tracked for later". Our whole-worktree review with no deferral ledger is the un-mitigated shape. Full diff-scoping is a big design change (and would weaken regression detection in untouched files, which B-6's baseline comparison will cover deterministically) → defer, but the "tracked for later" ledger is cheap.

### B-R4 — Ensemble value comes from diversity, and the first added angle has the steepest gain
arXiv 2510.21513 ("Wisdom and Delusion of LLM Ensembles"): consensus strategies fall into a popularity trap; **diversity-based selection realizes up to 95% of theoretical potential, effective even in two-member ensembles**. arXiv 2607.20429 ("More Is Not More"): the steepest diversity gain is None→Role (adding the FIRST role/angle); deeper personas plateau; temperature/generic-diversity instructions do nothing. Self-aggregation plateaus at n=5-10 (zylos/Multi-Agg). Production corroboration: Cursor BugBot's 8 randomized-order passes + majority vote; cubic.dev's micro-agent decomposition (security/duplication/editorial) cut false positives 51%. → Validates L-1 in the narrow form "add ONE well-chosen angle" (tests/validation), not a committee.

### B-R5 — Reviewer-side suppression (original L-3) is contraindicated
Two independent evidence lines: (1) **Agreeableness bias** — LLM evaluators confirm correct feedback but fail to reject incorrect feedback (true-negative rates < 25%; arXiv 2510.11822) — a reviewer handed a "known deferred" list is primed to agree with the deferral and stop looking, including when the code HAS regressed on that item. (2) **Context isolation** — the actor-critic literature requires the critic in a separate session with no access to prior negotiation state; feeding parent-side deferral decisions into the reviewer prompt breaks exactly that isolation. The industry pattern is **post-filter at the aggregation layer, never pre-filter at the reviewer** (CodeRabbit verifies findings after generation; BugBot majority-votes after the passes). → **L-3 as originally designed is rejected.** Deferred items must be carried by the orchestrator (docs/summary), not shown to reviewers.

### B-R6 — Verification-before-fix is the FP killer we already half-own
CodeRabbit's verification agent re-checks each finding with grep/ast-grep before posting; findings failing verification are dropped. We have deterministic gates for build/tests but none for finding validity. A cheap deterministic subset exists: findings citing a `file` that does not exist (fabricated path) can be demoted+logged without any model call. → New optional candidate (R-5).

### B-R7 — Loop bounds consistent with ours
Interactive review loops converge in 3-5 rounds typically; hard caps universally recommended; escalation at cap is the standard. Our MAX_CONVERGENCE_ROUNDS=8 + 2-identical-signature stagnation + final safety re-review + HITL matches the industry shape. Keep.

## 6. Verified/refined verdicts on the original candidates

| Candidate | Verdict | Basis |
|---|---|---|
| L-2 stop rule (all-advisory round exits) | **Already shipped** via C-5 | A-E2 |
| L-2 fix-prompt triage (route only fix-now) | **Adopt, narrowed**: drop `verified`; fix-now = open ∧ (blocking ∨ high); defer the rest to a logged ledger | B-R1, B-R3, A-E3 |
| L-2 deferred-ledger visibility | **Adopt**: surface in review report + run summary; NEVER in reviewer prompts | B-R5 |
| L-3 deferred-registry → reviewer prompt | **REJECT** (agreeableness bias + context isolation) | B-R5 |
| L-1 third reviewer angle | **Adopt, narrowed to ONE deterministic angle**: tests/validation reviewer, gated on requireScenarios/requireTests in spec control; reuse CodeReviewData schema + VERDICT_RANK merge. Language/security angles deferred (keyword gating weakly evidenced; keep complexity down for first exposure) | B-R4 |
| L-4 reviewer role hygiene | **Adopt** (doc-level) | pi reviewer.md; B-R1 evidence discipline |
| — new: cross-stage (ownerStage) exclusion from fix loop | **Adopt**: ownerStage ∉ {implementation, verification, environment, empty} → log + docs, exclude from fix prompt; if blocking ∧ cross-stage → route to escalation (upstream artifact defect), not the code fixer | B-R2, A-E4 |
| — new: deterministic finding verification (file-existence) | **Optional**: demote findings citing nonexistent files | B-R6 |
| — new: diff-scoped review | **Defer**: large design change; regression-in-untouched-files is B-6's deterministic job | B-R3 |

## 7. Decision-ready proposal (awaiting approval — no code changed)

**R-1 (one commit, helpers.ts + verify.ts + tests): deterministic merge-layer finding triage.**
In `mergeReviewVerdicts` (or immediately after, in verify.ts), partition merged findings:
1. **verified/resolved** (`status ∈ {verified, addressed, resolved, fixed}`) → dropped from the fix prompt and from `findingsSignature` (they are confirmations, not work); still counted in the rendered review report.
2. **fix-now** (open ∧ (`blocking` ∨ high/critical severity)) → the only findings routed to `buildFixPrompt`.
3. **deferred ledger** (everything else open, incl. `status=deferred` and needs-human non-blocking) → recorded in `state.review.deferredFindings` (id, title, severity, reason-class), surfaced to the docs stage and the run summary; excluded from the fix prompt and the signature.
4. **cross-stage** (`ownerStage` set ∧ ∉ {implementation, verification, environment}) → excluded from the fix prompt; logged in the ledger; if blocking/high → escalation entry (upstream artifact defect) instead of a code-fix round.
Verdict computation (normalizeReviewVerdict path) is untouched — this is strictly the findings-list semantics. Signature is computed after filtering, making the recurrence fingerprint track *actionable* residue only.

**R-2 (one commit): tests/validation third reviewer angle.**
A third parallel task in `reviewStep`, spawned only when the spec control declares `requireScenarios`/`requireTests` (deterministic gate); agent reuses the reviewer role with a tests/validation prompt builder; merge via existing VERDICT_RANK max + findings concat; `accessMode: source-read-only`. This is the steepest-diversity-gradient addition per B-R4 and covers the audit's recurring "tests/validation" angle.

**R-3: rejected** (was L-3). **R-4 (doc-only commit):** mirror pi reviewer.md evidence discipline into `agents/code-reviewer.md` / `agents/adversarial-reviewer.md` ("do not invent issues; every finding cites evidence; commands are reported, not run"). **R-5 (optional):** file-existence verification for findings citing `file`. **R-6 (deferred):** diff-scoped review.

### Risks & guards for R-1
- A wrongly-deferred real bug is the core risk → mitigation: deferral never applies to `blocking` or high-severity findings; ledger is user-visible in the run summary (not silently dropped); escalation/HITL message continues to include the raw findings slice.
- `needs-human` + blocking findings must route to escalation, not the ledger (guard in tests).
- `findingsSignature` change alters stagnation semantics → pin in tests: identical *actionable* signature stagnates; identical signature consisting only of ledger items is no longer stagnation (loop should have exited via AwC anyway — cross-checked with A-E2).
- Cross-language by construction: triage keys on structured fields, not language.

### Relationship to the existing queue
B-6 (cross-language baseline comparison for out-of-scope regressions) from the audit remains pending and is independent; R-1/R-2 touch verify-stage review semantics only. Recommended order if all approved: **B-6 first (audit commitment), then R-1, R-2, R-4.**
