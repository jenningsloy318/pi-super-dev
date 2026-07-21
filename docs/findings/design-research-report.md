# Design Research Report — pi-super-dev Architecture

**Date:** 2026-07-21
**Inputs:** (1) Full `src/` code audit → see sibling `architecture-audit.md` (34 KB, evidence-backed, `file:line` citations); (2) external design research (OpenHands *Verification Stack*, SDLC-pipeline patterns, deterministic-verification literature); (3) two design questions from the maintainer: *fail-fast on incomplete implementation*, and *how to gate an implement/review/test loop that iterates multiple times*.

---

## Executive summary

pi-super-dev is well-engineered — the control-flow node algebra is correct, the never-throw/conservative-degrade discipline in the gate layer is exemplary, and the TDD false-green stack (build ∧ deliverable ∧ change-gate) is genuinely strong (audit §7). **Three architectural asymmetries account for almost every recurring pain this codebase has hit:**

1. **Gate-symmetry hole** (audit Finding 1, CRITICAL): every *document* stage is wrapped in `gate(validate, attempts)`, but **implementation** — the only stage that writes deliverable code — has **no completeness gate**. `allGreen` is recorded and ignored; `hasImplementation` keys on `totalPhases>0`; `canMerge` checks build-only. Partial implementations flow through review → test → merge. This is the root cause of "merged 2/6 phases" and the recurring "not all phases implemented" pain.

2. **Loop-gate fragmentation** (this report, §D): implementation, review, and integration are **three separate siloed loops** with three different exit conditions and **no unified convergence gate**. Worse, the review/test loops spawn the *implementer* to fix findings — so *verification stages do implementation work* (responsibility leak), and those fixes **don't re-run the per-phase deliverable/change-gates**, so a review-fix can silently introduce a deliverable regression.
3. **Implementation-agent operating model** (this report, §F — the *front* cause): the recurring phase failure is **not** a gate problem (gates are sound). It is that the implementer operates **blind to existing state** (it repeatedly lands on already-done work and can't tell "done" from "todo" — systemic across 10+ runs), **blind to cross-cutting impact** (self-verifies only its phase's tests, so it breaks unrelated tests the gate later catches), **burned by malformed TDD tests** the RED oracle misclassifies as genuine red, and **batch-then-gate** (no tight inner edit→test→fix loop, so the 3-attempt budget is spent on one-error-at-a-time ping-pong). The gates are the *backstop*; §F is the *front* fix.

The external research (OpenHands *Verification Stack*) validates the maintainer's instincts directly: **fail fast at the agent level before code is pushed**, **separate generation from verification** (the verifier never fixes; it reports — the generator fixes), **iterate-until-green as one loop**, and **honestly report what couldn't be verified rather than merge it**. The fix is not new primitives — super-dev already has `gate`/`loop`/`branch` — it is *applying them consistently* to implementation and *unifying the three loops into one convergence-gated iterate loop*.

---

## Part A — Code audit (summary; full detail in `architecture-audit.md`)

The audit read every `src/` file, ran `npm run typecheck` (clean) and `npm test` (1361/1361). Top findings:

| # | Finding | Severity | Evidence |
|---|---|---|---|
| 1 | **Implementation has no completeness gate**; `allGreen` ignored; `hasImplementation`=`totalPhases>0`; `canMerge`=build-only | **CRITICAL** | `stages/index.ts:124` (bare `task`), `:65-66`, `:58-61` |
| 2 | **Tolerant sequence + vacuous-pass merge**: `canMerge` treats a *missing* build result as mergeable (`!== false`), the opposite of the correct `notBlocked` (`missing → block`) | HIGH | `stages/index.ts:60` vs `:39-42`; `nodes.ts:148-172` |
| 3 | **Recovery via Stage 10c "Address Findings"** does implementation work but **doesn't re-run per-phase gates**; sequential phases can't be recovered at all | MED | `verify.ts:159-175` |
| 4 | **Responsibility leak**: review/integration fix steps spawn the implementer; build-gate is the only merge gate | MED | `verify.ts:159,283`; `index.ts:58` |
| 5e | **`gate()` dead code**: pass-case `auditAppend` is after `return` → audit trail never records a success | LOW | `nodes.ts:356-358` |
| A | **`integrationLoopNode` always returns `ok`** even on exhaustion | LOW-MED | `verify.ts:264-266` |
| 8a | **`build-runner.ts` is a 2010-line god-module** | MED | — |

**What's already excellent (don't break):** the never-throw/degrade discipline; the build∧deliverable∧change false-green stack; gate convergence-via-feedback (retries converge, not resample); the resume durable-execution pattern; 1361 regression tests covering every documented crash class (`testFiles.join`, `phases.entries`, `fgColors` detachment).

---

## Part B — External design research (what the industry learned)

**Primary source — OpenHands "The Verification Stack"** (Wang & Smith, OpenHands blog, 2026-06, openhands.dev/blog/20260506-the-verification-stack) — directly on point. Key principles, mapped to super-dev:

- **"Agents made generation cheap; the bottleneck is verification."** Super-dev's heavy investment in the gate layer is the right instinct.
- **Layered verification — different mistakes caught at different stages:**
  - *Layer 1 — Agent-level verifier (Critic):* a fast model that scores the run **while the agent is still working, before code is pushed**; a low score **stops the run early or triggers retry** so "a broken attempt never reaches a human reviewer." → **This is exactly the maintainer's fail-fast instinct.** Super-dev has no Layer 1 — implementation incompleteness isn't caught until review/merge.
  - *Layer 2 — Repo-level verifier:* code-review (diff, structured checklist) **+ a QA agent that actually RUNS the software** ("Understand → Setup → Exercise → Report" — tests changed behavior as a real user would). → Super-dev's gate verifies *compile+test+deliverable-present*, never *behavioral exercise*. This is the next capability gap.
- **The verifier never fixes; it reports.** OpenHands separates generation from verification cleanly. Super-dev's Stage 10c/11c fix-steps violate this (review/test spawn the implementer).
- **"Iterate" skill = one loop until green:** run verification → fix → push → repeat until everything passes, then mark ready. → Super-dev has *three* siloed loops instead of one unified iterate loop.
- **Honest give-up:** "if multiple fundamentally different approaches fail, [the QA agent] reports honestly what couldn't be verified." → Super-dev merges 2/6 instead of reporting "could not verify completeness."
- **"Rejects mock-only tests; requires tests that exercise real code paths."** → Validates super-dev's real-Theme parity work (the `fgColors` class of bug).

**Secondary sources** (SDLC-pipeline guide `jwbron/egg`, deterministic-verification-pipelines paper, agentic-pipeline repos) converge on the same patterns: *structurally enforced checkpoints*, *deterministic verifiers as the hard oracle*, *convergence-via-feedback retry*.

**Net:** super-dev's gate *technology* (deterministic oracles, feedback convergence) is at/above industry parity. The gap is *gate topology* — where the gates sit in the DAG and how the loops compose.

---

## Part C — The fail-fast completeness gate (designer question #1)

**The hole (audit §1 + §2):** `task(implementationStage)` → `branch(hasImplementation=totalPhases>0, {yes: review…})` → `canMerge` (build-only). Partial impl flows through.

**The fix, in three layers of defense-in-depth** (all use existing primitives):

1. **Gate implementation completeness** (mirror the upstream `gate` pattern):
   ```ts
   task(implementationStage),
   // NEW: fail-fast boundary — review/test never run on partial impl
   branch((s) => implAllGreen(s),
     { yes: sequence([reviewLoopNode, branch(reviewApproved, { yes: integrationLoopNode, no: noop() })]),
       no:  task(logIncompleteImplStage) }),   // logs "INCOMPLETE — use resume to continue"; no review/test/merge
   ```
2. **Make `canMerge` conservative** (affirmative pass, not "not failed"; +completeness +review):
   ```ts
   const canMerge = (s) => notBlocked(s)
     && implAllGreen(s)              // completeness
     && reviewApproved(s)            // defense-in-depth
     && (s.preMergeBuild?.pass === true);   // affirmative, not !== false
   ```
3. **Recovery = resume, not review.** On `partial`, surface a "resume to continue" escalation (mirror the existing `handleStagnation` interactive path) instead of flowing forward. Resume replays cached agents and fast-forwards to the first un-converged phase — the *correct* recovery for sequential phases (Stage 10c cannot recover those).

This makes "merged 2/6" **impossible** and aligns implementation with every other gated stage.

---

## Part D — The multi-iteration implement/review/test loop gate (designer question #2 — the centerpiece)

### The current design (three siloed loops, no unified gate)

```
impl (Stage 9)          per-phase TDD loop, 3-strike break, build∧deliverable∧change-gate
  → reviewLoop (10)     loop{ review→fix→re-review }  max 3, exit: reviewApproved
    → integrationLoop(11)  custom loop{ test→fix→re-review→re-test }  max 3, exit: testsGreen && reviewApproved
      → docs → cleanup → merge
```

**Problems (why multi-iteration is poorly handled today):**

1. **Three loops, three exit conditions, no single convergence definition.** "Done" means something different in each loop. There's no place that says "the *whole* implement↔verify cycle is converged."
2. **Verification stages do implementation work.** `fixStepReview`/`fixStepIntegration` (`verify.ts:159,283`) spawn the *implementer*. So review/test findings are fixed by re-implementing *inside the review stage* — a responsibility leak (OpenHands explicitly separates generation from verification).
3. **Review-fixes bypass the per-phase gates.** The deliverable-check and change-gate run *only* in Stage 9's phase loop. A fix applied during review/test **does not re-run them** — so a review-fix can silently drop a deliverable (e.g. re-delete `e2e_x.rs`) or unwire a call site, and the gate won't catch it. This re-opens the false-green the gates were built to prevent.
4. **No cumulative feedback across iterations.** Each fix-step sees only the current reviewer's findings, not the union of all prior failures across all gates → fix-one-break-another ping-pong (the exact churn that exhausted spec-12's phase 3 in 3 tries).
5. **Siloed budgets, no global convergence budget.** 3(impl)+3(review)+3(test) tries, but exhaustion in any one just proceeds (tolerant) → merge of non-converged code.
6. **Sequential phases can't be recovered by review.** A phase the 3-strike `break` skipped is invisible to reviewers (no artifact to review) — so the loop can't fix what was never attempted.

### The target design — ONE unified iterate-until-convergence loop with a single gate

Collapse the three loops into **one** implement↔verify loop whose exit is a single AND-of-all-gates convergence condition, with a global budget and honest stop. (This is the OpenHands *iterate* pattern, realized in super-dev's existing `loop`/`gate`/`branch` primitives.)

```
loop({
  while: (s) => !converged(s) && globalIters < MAX_CONVERGE_ITERS,
  body: sequence([
     implementStage,        // (re)implements every not-yet-green phase, fed by CUMULATIVE feedback
     verifyStage,           // the FULL stack, verify-ONLY (never fixes): build ∧ deliverable ∧ change ∧ review ∧ integration
  ]),
})
branch(converged, { yes: sequence([docs, cleanup, merge]),
                    no:  task(reportUnverifiedStage) })   // honest stop: "could not verify — not merged"
```

**`converged(state) = impl.allGreen && reviewApproved(state) && testsGreen(state)`** — the single source of truth for "done." Six design rules:

1. **One convergence gate.** The loop exits *only* when every gate is green. No more "review approved but integration not run" or "impl partial but review proceeded."
2. **Verify-only vs fix.** `verifyStage` runs all checks and *reports*; it never spawns the implementer. Only `implementStage` mutates code. This kills the responsibility leak (audit §4) and makes verification cheap/repeatable.
3. **Per-phase gates re-run every iteration.** Because `implementStage` runs inside the loop, its build∧deliverable∧change-gate stack runs on *every* iteration — review-fixes can no longer silently regress a deliverable (Problem 3 closed).
4. **Cumulative feedback.** Feed the *union* of all gate failures from all prior iterations into the next `implementStage` run (extend the existing `__feedback` mechanism, audit §8b). This is the cure for the ping-pong that burned spec-12.
5. **Global budget + honest stop.** `MAX_CONVERGE_ITERS` (e.g. 5) across the *whole* implement↔verify cycle. On exhaustion: **stop, do not merge, report exactly which gates/PHASES didn't converge** (OpenHands: "reports honestly what couldn't be verified"). Resume remains the human-invoked recovery for a later, fresh attempt.
6. **Best-effort all phases per iteration.** Drop the 3-strike `break` (audit §3): each `implementStage` iteration *attempts every not-yet-green phase*, so the convergence gate sees the full picture and the report names every failing phase — instead of orphaning phases 4–6.

**What this buys:** multi-iteration becomes the *normal mechanism* (not a recovery hack); verification is deterministic and repeatable; false-green merges become impossible (no convergence ⇒ no merge); the report is always honest. The existing node algebra implements this with no new primitives — only re-topology.

### Optional deeper layers (OpenHands-inspired, future)

- **Layer-1 critic** (agent-level verifier): a cheap check that scores the implementation *during* `implementStage`, before the expensive full verify — fail-fast on obviously-broken attempts (catches "agent went off-track" before burning a full verify cycle).
- **Layer-2 QA-exercise** (behavioral verification): a verify sub-step that actually *runs* the changed software (API/UI/CLI smoke), not just compile+test — the capability super-dev most lacks vs OpenHands.

---

## Part E — Prioritized design roadmap

| Pri | Change | Source | Effort |
|---|---|---|---|
| **P0** | Gate implementation completeness: `hasImplementation`=allGreen; add the fail-fast `branch(implAllGreen,…)` | Audit #1; Q1; OpenHands L1 | S |
| **P0** | Make `canMerge` conservative: `pass===true` + `allGreen` + `reviewApproved` | Audit #1,#2,#4b | S |
| **P0** | Fix `gate()` dead code (audit-append before return) | Audit #5e | XS |
| **P1** | **Unify impl/review/test into one convergence-gated iterate loop** (§D) — verify-only, per-phase gates each iter, cumulative feedback, global budget, honest stop | Q2; OpenHands iterate | M-L |
| **P1** | Surface `partial` as terminal "resume to continue" (not flow-through) | Audit #3,#5 | M |
| **P2** | `integrationLoopNode` returns `failed` on exhaustion; `failedStages` for custom nodes | Audit A,B | XS-S |
| **P2** | Split `build-runner.ts` (detect/scope/gates) | Audit #8a | M |
| **P3** | Layer-1 critic; Layer-2 QA-exercise (behavioral verify) | OpenHands L1/L2 | L |

**Recommended first PR (P0):** the three small, high-leverage gate fixes — they close the false-green-merge hole immediately, are 1-line-ish each, and require no control-flow changes. **Recommended second PR (P1):** the unified convergence loop (§D) — the structural answer to "not all phases implemented" and the multi-iteration question. **Recommended third PR (P1):** the implementation-agent front-fixes (§F) — attack phase failure at the source, before any gate sees it.

---

## Part F — Implementation-agent root causes (why a phase *actually* fails — the front cause)

Parts A–E are about **gates and topology** (the backstop). This section is about **why the implementation agent fails a phase in the first place** — the front cause. Forensics across recent runs (spec-08/10/12 and contrast spec-11) show the gates are *not* the problem; the implementer's **operating model** is.

### The smoking gun (spec-12, phase 3)
The implementer's own words mid-attempt:
> *"The implementation appears to already exist (Phases 1-3 done)... `live-stream.ts` is already modified with the full implementation. Let me run the tests to determine the actual state."*

And the gate failures were **not** "the agent couldn't write the code":
- **Attempt 2 build fail:** `tests/live-stream-flush-sections.test.ts(74): error TS2339: Property 'onUpdate' does not exist on type '{ body: string }'` — the **tdd-guide's own test file was malformed**. The implementer could never go green because the *test* was broken.
- **Attempt 3 test fail:** `regression-guard.test.ts:234` — the implementer's change to `live-stream.ts` **broke an unrelated existing test** it never looked at.

### It's systemic, not a one-off
"already exists / already implemented / appears to already" **state-confusion** appears across **10+ runs** (some with 9–14 hits each). Meanwhile **spec-11 (all 5 green)** converged because its phases were genuinely greenfield (new modules) *and* its research stage crisply pre-resolved 4 design issues (ISS-01…04) before implementing — so the agent had an unambiguous target.

### The six root causes

| # | Root cause | Evidence |
|---|---|---|
| **1** | **State-confusion / non-idempotent** — the agent lands on a phase whose work is already partially/fully present (prior attempt, pre-existing file, earlier phase's side-effect) and can't distinguish "done" from "todo" → re-touches working code (breaks it) or flails | 10+ runs; spec-12 "appears to already exist" |
| **2** | **TDD test-quality not verified** — the RED oracle checks the test *fails*, not that it's *well-formed against real source types*. A malformed test (compiles in isolation, fails the build) is misclassified as a genuine RED → the phase can never go green | spec-12 `onUpdate` type error |
| **3** | **Cross-cutting regression blindness** — the implementer self-verifies only its *phase's* tests, never the full suite; the gate runs the full suite and catches regressions the agent never saw | spec-12 `regression-guard.test.ts` break |
| **4** | **Batch-then-gate (no tight inner loop)** — the agent makes changes, runs a narrow test, declares done; the gate then surfaces *multiple* issues (deliverable + compile + test) at once → the 3-attempt budget burns one-at-a-time → ping-pong | spec-12: att1 deliverable-miss, att2 compile, att3 test |
| **5** | **Over-decomposition into no-op/interdependent phases** — 6 phases for one feature; phase 3's work was already present, so it churned on state-confusion and broke adjacent tests | spec-12 6 phases vs spec-11's 5 real modules |
| **6** | **No cumulative feedback** — each retry sees only the last gate's error, not the union | the ping-pong |

**Common thread:** the agent operates **blind to existing state and to cross-cutting impact**, and the gate catches the fallout **too coarsely** (3 attempts, one error type at a time).

### The five front-fixes (attack failure at the source)

1. **Pre-implement no-op detection** — run the deliverable-check *before* spawning the implementer; if the phase's deliverables are already satisfied → **skip the phase** (mark green, don't churn). Hand the implementer the current git diff / change-tracker state so it sees what's already done. *(Root cause 1.)*
2. **Test-quality gate** — after the tdd-guide writes tests, **typecheck them against the real source** (not just "did they fail"). A test that doesn't compile against real types → re-prompt the tdd-guide, don't proceed. Extend the RED oracle: `red` = compiles-against-source AND fails; `malformed` = doesn't compile. *(Root cause 2.)*
3. **Full-suite self-verification in the implementer prompt** — *"Run the WHOLE test suite (`npm test`/`cargo test`), not just the phase's tests, before declaring done; fix every regression you introduce."* *(Root cause 3.)*
4. **Tight inner edit→test→fix loop** — instruct (and budget) the implementer to iterate *within its turn*: edit → run full build+test → read errors → fix → repeat until green — instead of batch-then-declare-done. *(Root causes 4 + 6.)*
5. **Coarser, independent phases** — guide the spec prompt to avoid over-decomposition; each phase must be a real, independently-shippable unit with its own deliverable, not a slice of an interdependent whole. *(Root cause 5.)*

These are **agent/prompt/stage-design changes** — the gate topology (Parts C–E) is the *backstop*; this is the *front* fix that stops the failure before any gate sees it.

---

## Answer to the three questions, in one line each

- **"When not all phases implemented, it should stop"** → Yes. Add an implementation completeness gate + conservative `canMerge` (P0); recover via *resume*, not review.
- **"Implement/review/test iterate multiple times — how to gate?"** → Collapse the three siloed loops into ONE iterate-until-convergence loop with a single `converged = allGreen ∧ approved ∧ testsGreen` gate, verify-only verification, per-phase gates re-run each iteration, cumulative feedback, and an honest stop on budget exhaustion (§D).
- **"Why does one phase always fail — is the implementation agent/stage itself the problem?"** → Yes. The gates are sound; the implementer fails because it's blind to existing state (state-confusion, systemic in 10+ runs), blind to cross-cutting regressions, burned by malformed TDD tests the RED oracle misclassifies, and batch-then-gate. Fix at the source: pre-implement no-op detection, a test-quality (typecheck) gate, full-suite self-verification, and a tight inner edit→test→fix loop (§F).
