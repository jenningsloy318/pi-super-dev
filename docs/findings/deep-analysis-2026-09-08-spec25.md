# Deep Analysis: Spec 25 Multi-Run Failure Spiral — Root Cause, Cross-Reference, Improvement Design

Date: 2026-09-08 · Trigger: user report "we tried multiple times of spec 25, each time failed with different issue"
Method: full run-log archaeology (8 runs), first-principles decomposition, four SDLC source docs re-read line-by-line, external research (PDoctor arXiv:2404.17833, MAST arXiv:2503.13657, Turborepo 2.9, Galileo/MAST coordination strategies, arXiv:2509.02761 plan verification, spec-kit 1.0).

---

## 1. Evidence base — the 8-run failure matrix

| Run | Ver | Plan shape | Died at | Proximate cause | Systemic class |
|---|---|---|---|---|---|
| 00-49 (14.5h) | 0.3.74 | 10-phase | Stage 10 | stagnation: 3 recurring blockers after 4 fix cycles → PARTIAL | L3 routing |
| 13-23 (resume) | 0.3.76 | resumed | Stage 10 | same 3 blockers after 6 more fix cycles → PARTIAL | L3 routing |
| 13-43 (resume) | 0.3.76 | resumed | Stage 10 | same 3 blockers after 8 more fix cycles → PARTIAL (**18 total fix cycles on the same blockers**) | L3 routing |
| 13-57 (replan) | 0.3.76 | 3-phase | Phase 2 start | process death mid-phase-2, no close-out written | L4 infra |
| 14-03 | 0.3.76 | — | Stage 2A | user cancelled at classify (12s) | retry churn |
| 14-10 | 0.3.76 | — | Stage 2B | requirements-clarifier died 3×: "delegation failed: Requested…" (model-exclusion class — **v0.3.77 fixed non-retryable; not installed**) | L4 infra |
| 14-12 | 0.3.76 | — | Stage 2B | same, cancelled | L4 infra |
| 14-14 (19h) | 0.3.76 | 10-phase (re-derived!) | Stage 9 | phase-01/02 commit fusion → partial; attempt 2 phase-01 contradiction loop ×6 attempts; judge verdict DISCARDED ×2 (empty evidence); user stopped | L1+L2+L3 |

**The recurring blockers** (runs 00-49/13-23/13-43) were identified in the audit ledger:
1. `Code review did not complete` (4×/12×) — reviewer infra non-completion, not content
2. `Adversarial review did not complete` (4×/12×) — same
3. `Tests review did not complete` (4×/12×) — same
plus genuine content findings that fix-cycles never satisfied: `earlyBird classification has no behavioral assertion`, `利好出尽 forces fail when a positive catalyst exists and all positives are pre-priced (rule 2)`, `Unreachable disclosure data produces the disclosure-invisibility trio`.

**Run 14-14's contradiction loop** (the clearest single trace):
- Phase-01 deliverable clause: `requireContains CROSS_CUTTING_CITATION_FIELDS in tests/catalyst-contract.test.ts` with comment-stripped matching (the test must reference the identifier in executable code).
- The identifier is a module-private const in `src/stages.ts`, which the plan declares a deliverable of **phase-09** (`ts-thesis-stage-wiring-unit`).
- Every implementer attempt hits one of three walls: comments-only → deliverable FAIL; import-without-export → tests stay red (`tdd-targets-still-red`); export from `src/stages.ts` → **BLOCKING phase-boundary leak → engine REVERTS the only satisfiable fix** (implementation.ts:2951, fired 3×: 08:12, 08:24, 08:31).
- The escape valve fired twice and failed twice: `judge stage9.impl-no-progress.phase-01: verdict DISCARDED — evidence verification failed: evidence is malformed: every item is empty/whitespace` (03:24, 08:38) — **no fallback route after discard** (judge.ts:397), so the loop had no exit.
- Attempt 6 (09:23) found the workaround by chance (import a derived export) — after ~2h on phase 1 of 10.

Also: 12 quarantine events, **12/12 verdicts salvaged** (v0.3.73 M1 working — not a defect); 7 coverage-UNMEASURABLE gates (target repo lacks `@vitest/coverage-v8`); zero delegation timeouts (v0.3.73 M4 verified in production vs 7×20:00 last run).

---

## 2. First-principles root-cause chain

**The user's observation is the key diagnostic**: N runs failing N different ways means the failures are surface manifestations, not independent bugs. What is INVARIANT across all 8 runs?

### The invariant
Spec 25 ("catalyst dimension", like spec 24 before it) is a **horizontal** change: one dimension wired through many shared files (`catalyst.ts`, `schemas.ts`, `stages.ts`, `data_analyst.ts`, docs), with semantically hard acceptance rules (rule-2 pre-priced disjunct, disclosure-invisibility trio). The machinery routes this spec through stage-local loops that each have bounded patience and no escalation semantics, and re-plans it into different phase decompositions that are never validated for feasibility before execution.

### The variance
Which stage hits an unresolvable condition first is a **routing lottery**: Stage-10 verify-fix (runs 1-3), Stage-9 phase boundary (run 8), requirements infra (runs 6-7), process crash (run 4). Each run's path depends on timing, model behavior, and which plan variant was generated. The user experiences "different issue each time"; the system-level truth is one root with five layers:

- **L0 — the spec is genuinely hard.** The content findings are real requirements the system correctly refuses to fake. This is not a bug; it is the work. The system's job is to route hard requirements to a stage that can DO design work, cheaply and early.
- **L1 (design defect) — no plan feasibility validation.** The plan is a program; nobody type-checks it. Cross-phase contradictions (deliverable clause satisfiable only via a later-phase-owned file) execute for hours before hitting the wall. The harness HAS test-level contradiction machinery (`UNSATISFIABLE_TEXT_RE`, re-authoring on proven-unsatisfiable RED — implementation.ts:856-947) but nothing at plan level. Spec close-out runs a structural **trace gate**, not a satisfiability gate.
- **L2 (architectural defect) — single-worktree vertical ownership vs horizontal coupling.** Phase file-ownership is single-assignment; shared files are declared deliverables of exactly one phase; any earlier phase's need to touch them is BLOCKED and reverted. The SDLC playbook's own rule: *"Tasks that share files run in a single session, one after another"* / "only parallelize file-independent tasks" — the plan violates its own execution model's precondition, undetectably.
- **L3 (routing defect) — stage-local loops without escalation semantics.** Three manifestations: (a) the Stage-10 verify-fix loop attempts design-level work it cannot do (18 fix cycles on behavioral-semantics findings); (b) the Stage-9 phase loop burns 6 attempts on a deterministic contradiction with no contradiction detection; (c) the judge — the only cross-stage router — has its verdict discarded on evidence discipline **with no fallback route**, so the escape valve fails exactly when needed. A hook that blocks must name the route to approval; ours reverts and loops.
- **L4 (infra noise layer) — independent run-killers.** Model-exclusion (fixed in v0.3.77, serving copy was 0.3.76), process death without close-out, reviewer non-completion counted as content blockers (12× "review did not complete" = 3 of the "3 recurring blockers").

### Why every run failed differently — the one-sentence root cause
**The machinery executes plans it has never validated for feasibility, on a worktree model that horizontal specs structurally violate, through stage-local loops whose only escape valve (the judge) fails closed — so the same underlying infeasibility surfaces at a different stage each run, depending on the routing lottery.**

---

## 3. Cross-reference against the four SDLC source docs

Each row: principle from the docs → our current state → spec-25 evidence → verdict.

| SDLC principle (source) | Our state | Spec-25 evidence | Verdict |
|---|---|---|---|
| Bottleneck migrates to plan/review/verify when build accelerates (Google, Anthropic) | build stage is excellent (Stage 9 completes, suites green in hours) | 18 fix cycles + 19h runs; all deaths at plan/verify/judge | **Supported — and we optimized the fast stage further while the slow stages stayed weak** |
| Plan review before code is cheapest correction point; "iterate until an engineer who never saw the conversation could implement from the plan alone" (Anthropic plan mode) | plan validated for trace/structure only | contradiction loop on a plan a reviewer could not implement | **Violated — missing plan-completeness/satisfiability gate** |
| Agent can detect requirement contradictions at design time (user synthesis §design: "需求中是否存在明显矛盾") | no deterministic contradiction check | CROSS_CUTTING contradiction executed 6h before discovery | **Violated — the doc explicitly names this capability as the design stage's job** |
| A block must explain itself AND name the route to approval (Anthropic hooks) | BLOCKING revert explains the reason (implementation.ts:2951) but the loop has no route-out | 3 identical reverts, 6 blind attempts | **Half-violated — reason yes, route no** |
| Only parallelize file-independent tasks; shared-file tasks sequential or isolated worktrees (Anthropic parallel sessions; user synthesis 多Agent节) | single shared worktree, phases declared as sequential but files coupled | phase-01 needs phase-09's file | **Violated — the anti-pattern the docs name** |
| Verify independent: fresh-context verifier, tests-fail-first, no test weakening (all four docs) | implemented (RED oracle, quarantine, reviewer isolation, test-file rules) | worked correctly all 8 runs | **Aligned** |
| Maturity = detect, contain, explain, prevent recurrence (user synthesis 结语) | detect: hours late · contain: loops · explain: judge verdict discarded · prevent-recurrence: fresh runs re-hit same contradictions | 8 runs, 0 accepted changes | **Fails all four criteria on this spec — by the docs' own standard this axis is still "faster vibe coding"** |
| Metric = cost per accepted change, intent-to-verified-outcome time (user synthesis; OpenAI) | usage dashboard exists (v0.3.75+) | 8 runs ≈ 50h+, $XX, 0 accepted | **Metric exists, value = ∞; optimization target misplaced** |
| Traces→datasets→evals feedback loop (LangChain) | prior-run finding injection works (9 findings injected run 13-43) | findings injected but the PLAN was regenerated unvalidated each fresh run | **Half-aligned — finding memory exists, plan memory does not** |
| Governance is enforced at action time deterministically (all docs) | strong (BLOCKING reverts, quarantine, gates) | deterministic enforcement of a contradictory plan = guaranteed deadlock | **Aligned mechanically, misaligned semantically — enforcement without satisfiability checking produces livelock, not safety** |

**Where the docs do NOT apply directly** (honest limits): all four assume a human plan reviewer in the loop; our pipeline is autonomous, so the human review step must be substituted by deterministic plan validation plus judge escalation. The docs also don't address multi-run convergence of a single spec — that gap is ours to design.

---

## 4. External research synthesis

- **PDoctor (arXiv:2404.17833)**: plan correctness = **constraint satisfiability** — "a plan is erroneous if its execution violates constraints derived from the inputs." Their oracle checks execution against a derived constraint set. Our transfer: derive the constraint set (phase deliverable clauses + file ownership + toolchain availability) and check the PLAN against it before execution. Constraint checking is cheap (their Z3 overhead: ~0.03s/case).
- **MAST (arXiv:2503.13657)**: 14 failure modes in 3 categories — **system design issues, inter-agent misalignment, task verification**. Our matrix maps 1:1: L1/L2 = system design, L2 attribution/quarantine = inter-agent misalignment, L3 judge-evidence/coverage = task verification. Under-specification ≈ 15% of failures — our plan contradictions are exactly this class. "Failures require more sophisticated solutions" than prompt tweaks — i.e., machinery.
- **Turborepo 2.9**: they moved cycle detection from the Package Graph (proxy) to the **Task Graph (what actually executes)** — "a subtle mismatch in what was validated and what is needed to work." Lesson: validate the executable graph (phase×file×clause), at load time, not a proxy artifact (trace structure).
- **Galileo/MAST coordination**: ping-pong loops when ownership is unclear; fix = deterministic allocation + escalation circuit breakers; "failures stem from system design issues, not just LLM limitations."
- **Embodied plan verification (arXiv:2509.02761)**: Judge-Planner iterative critique converges in ≤3 rounds for 96.5% of cases when critiques are specific and the planner applies them deterministically. Transfer: our judge verdict-discard should become **critique-and-retry** (feed the verification failures back to the judge once), then escalate.
- **spec-kit 1.0**: GitHub's flow now ends in an explicit `/speckit.converge` phase — industry is converging on convergence machinery being first-class.

**Synthesis**: every studied system validates its decomposition BEFORE execution and routes detected infeasibility to a named escalation path. None re-executes an unvalidated plan 8 times. Our machinery's enforcement is world-class; its validation and routing are the gap.

---

## 5. Improvement design

Guiding principles (from the cross-reference): (1) shift feasibility left — cheapest correction point is the plan; (2) every deterministic block names its route-out; (3) escape valves fail open (escalate), never closed (discard); (4) infra findings never masquerade as content blockers; (5) optimize intent-to-accepted-change, not stage throughput.

### Wave A — v0.3.79: Plan feasibility + escape-valve integrity (this fix)
- **A1 Plan-feasibility validator** (deterministic, zero-LLM, runs at spec close before Stage 9):
  - **Cross-phase contract satisfiability**: for each phase P deliverable `requireContains ID in file F`, if ID is an identifier defined/exportable only from a file owned by a later phase Q (from the plan's own declared deliverables), emit contradiction finding naming P, Q, F, ID. Mirrors PDoctor's constraint oracle + Turborepo's executed-graph validation.
  - **Phase file-ownership coupling report**: any file touched by >1 phase's declared deliverables → flag as shared-file phase (see B1) or force merge into one phase.
  - **Toolchain preflight**: coverage tooling (`@vitest/coverage-v8` presence), test-runner availability per declared test family — findings for UNMEASURABLE-before-execution, with advisory-downgrade decision recorded.
  - Route: contradictions → REPLAN (existing machinery) with named findings; env gaps → loud named finding + gate downgrade BEFORE phases burn hours.
- **A2 Contradiction fast-fail at execution** (backstop when A1 misses): same failure signature on consecutive phase attempts AND a BLOCKING later-phase revert in the window → stop retrying, route judge immediately with the contradiction context (the two clause sources quoted). Also: judge verdict verification failure → one corrective retry with failures fed back (arXiv:2509.02761 pattern); still malformed → **escalate-now** (human), never silent discard (judge.ts:397 gains a fallback). BLOCKING revert message gains its route-out (which attempt pattern will trigger replan).
- **A3 Stagnation routes by finding class**: Stage-10 stagnation classifier separates (a) infra non-completion findings ("review did not complete") — not content blockers, tracked separately, never counted toward stagnation floor; (b) cross-phase/design findings — route REPLAN-with-findings instead of PARTIAL-stop; (c) local fix findings — keep current fix cycles.
- **A4 Metrics**: run-metrics gains `intentToAcceptedWallMs` (first-run-start → merge), rework rounds, judge-verdict acceptance rate, contradiction-detect stage (plan-time vs execution-time vs never).

### Wave B — v0.3.80: Ownership grammar for horizontal specs
- **B1 Shared-file phase ownership**: phases may declare a shared file with an explicit **contract-first handoff** (phase P exports the identifier; later phases extend it) — the plan validator (A1) requires every cross-phase reference to have a handoff edge, else contradiction. Alternative considered: per-phase worktrees/stacked branches — rejected this wave (cost; single deterministic commit chain is load-bearing).
- **B2 Commit fusion**: phase gate-window expiry must not leave work to be absorbed by the next phase's commit — stage-close re-verification (v0.3.66-style already-satisfied at stage level) before PARTIAL.
- **B3 Plan memory**: fresh runs on a spec dir with a REPLAN-approved plan reuse it (with prior findings injected into its validation) instead of re-deriving a new unvalidated plan (run 14-14 re-derived 10 phases after 13-57's 3-phase REPLAN).

### Wave C — ops/process
- **C1 Serving-copy freshness**: extension version stamped into every run.log header + startup WARN when installed copy < repo main (the 14-10 model-exclusion death was a fixed bug running live).
- **C2 Incident→eval loop for this analysis**: the spec-25 contradiction loop and judge-discard become regression tests in the incident eval suite (v0.3.69 E4).

### Explicit non-goals
- No weakening of deterministic gates (the gates were RIGHT; the plan was wrong).
- No LLM-based plan validation in Wave A (deterministic first; judge-of-plan only if the deterministic validator proves insufficient).
- No per-lane worktree isolation (rejected as cost-ineffective — prior decision stands until B1 proves insufficient).

---

## 6. Verification plan
- TDD per class: A1 satisfiability unit tests (the spec-25 CROSS_CUTTING shape as the canonical fixture), A2 discard-fallback tests, A3 classifier tests, A4 metrics tests.
- E2E provocation: a scratch spec with a known cross-phase contradiction must REPLAN at plan-close (not reach Stage 9); a scratch judge returning empty evidence must retry-then-escalate (not discard-and-loop).
- Dual fresh-context reviews (code + adversarial) before commit, per repo standard process.

## 7. Root-cause classification (per repo methodology)
| Defect | Class |
|---|---|
| Plan contradiction executed unvalidated | DESIGN (missing validation layer) |
| Phase ownership vs horizontal coupling | ARCHITECTURE |
| Judge discard without fallback | DESIGN (P5 fail-closed escape valve) |
| Verify-fix loop doing design work | DESIGN (stage responsibility mismatch) |
| Reviewer non-completion as content blocker | IMPLEMENTATION bug |
| Commit fusion on gate-window expiry | ARCHITECTURE (shared-worktree attribution) |
| Model-exclusion run-kill | fixed upstream (v0.3.77) — ops: serving copy stale |

---

## 8. v0.3.79 dual-review verdict table (2026-09-08)

| Finding | Severity | Reviewer | Disposition |
|---|---|---|---|
| Corrective-floor escalate preserved unverified evidence → FatalAbort at convergence caps | P1/blocking | code + adv chain | FIXED — floor returns `evidence: []`; pinned by test |
| version.test.ts shipped RED (2 stale assertions) | P2/ADV-1 HIGH | both (reproduced) | FIXED — bumped; suite 240 files / 3426 passed + 1 skipped |
| Check 1 one-directional (contains/notContains) | P3-1 | code | FIXED — mirrored both orderings |
| Python later-file def/class at HEAD not exempt | ADV-2a MED | adv (exploited) | FIXED — .py files use def/class matching |
| Bare `spec/` dir misclassified test-family | ADV-2b/P3-2c | adv (exploited) | FIXED — strict cross-phase predicate |
| Single-word ALLCAPS literals treated as identifiers | ADV-2c | adv (exploited) | FIXED — SCREAMING requires underscore |
| Validator re-runs on §D re-entries | ADV-2 secondary | adv | FIXED — once per run (`__planFeasibilityChecked`) |
| All-infra disarm removed the cheap stop (budget burn) | ADV-3 MED | adv | FIXED — 3 consecutive all-infra rounds stop with infra tally |
| "(verified evidence)" label on unverified floor diagnoses | ADV-4 MED | adv | FIXED — status-aware labels |
| boundaryRevertHits stale across signature changes | ADV-5/P3-3 | both | FIXED — reset on signature change |
| `planInfeasible` dead contract field | ADV-6 NIT | adv | FIXED — removed |
| Budget-exhausted discard branch unpinned | ADV-7 NIT | adv | FIXED — pinned test |

Cleared by reviewers (end-to-end traced): async conversion call sites; corrective budget invariants (INV-3, ≤2/signature, ≤12/run, timeout-retry interplay); fabrication discipline (unverified verdicts never route on claimed route — the P1 was the sole exception, now fixed); REPLAN double-fire impossibility (`__replan` guard + R5 + fingerprint dedupe); A3 infra classification (source-set + suffix defense); stagnation REPLAN status propagation (`__replan` → terminal replan before failed); judge corrective fall-through (verdict2 → allowed/confidence gates).

---

## 9. v0.3.80 (Wave B) dual-review verdict table (2026-09-08)

| Finding | Severity | Reviewer | Disposition |
|---|---|---|---|
| Close-out flip verified a weaker contract (requireTests hole + vacuous notContains-only + pre-existing content) | P2 / HIGH | both (probe-confirmed) | FIXED — affirmative-clause + changed-this-run guards + full runDeliverableCheck per flippable |
| Flipped phase kept stale lastFailures row and no deterministic commit | P3 / MED (adv-F3) | adv | FIXED — splice + deterministicPhaseCommit on flip |
| `allGreen` could be true over a phaseStatus subset (REPLAN break) | P3 | code | FIXED — length-parity guard |
| Own-scope normalization lacked leakNorm's trim/trailing-slash | P3/NIT | both | FIXED — unified on leakNorm |
| Exclude-set behavior + both envBlockedPhases.add sites unpinned | P3 | code | FIXED — 2 pin tests |
| B3 injected human-owned replan rows as machine hard constraints (AC-20) | MED (adv-F2) | adv (probe-confirmed) | FIXED — human rows filtered |
| Dead `rc12Deliverables` + stale docblock | P3 | code | FIXED |
| "revised N time(s)" conflated requests with rounds | NIT (adv-F5) | adv | FIXED — rounds wording |

Cleared by reviewers: §D re-entry double-count NOT reproducible (per-invocation local, green-skip); stash interaction correct (stashed work fails deliverables check); REPLAN double-fire impossible; import-cycle clean; prompt-injection residual (LLM titles verbatim) accepted as internal trust domain.
