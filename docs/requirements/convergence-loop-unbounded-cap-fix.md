# Root-Cause Analysis & Fix Plan — Unbounded Convergence Loop (OOM)

> Status: **implemented (574e7968, v0.1.44 — MAX_CONVERGENCE_ROUNDS=8 FatalAbort in artifact-convergence.ts + spec-convergence.ts; stale tests fixed; liveness test added).**
> Scope: `src/stages/artifact-convergence.ts`, `src/stages/spec-convergence.ts`,
> `tests/artifact-convergence.test.ts`.
> Pre-existing: reproduces on `main` with the RED-loop fix reverted. **Not** caused by
> the RED-loop fix (different module, different loop).

## 0. Symptom

`tests/artifact-convergence.test.ts` alone consumes >8 GB and is killed (OOM) by the
OS. A standalone probe of `requirementsConvergenceNode` ran **166,667 rounds** before a
probe-supplied budget cap stopped it:

```
FatalAbort: requirements convergence stopped before all ambiguity/validation issues
were resolved because the global agent budget was exhausted after 166667 round(s)
```

In the full suite, this single file's runaway allocation trips the OOM for what looks
like "many" runs — but every batch that **excludes** this file passes cleanly.

## 1. Root cause (two facets, both must be fixed)

### 1A. CODE liveness defect — the convergence loops have NO hard round cap

`src/stages/artifact-convergence.ts:234` (and the identical `src/stages/spec-convergence.ts:117`):

```ts
while (ctx.budget.check()) {
    round++;
    …  // NO `if (round > MAX) …` guard anywhere (grep confirms none, ever)
}
```

Termination depends **entirely** on:
- `ctx.budget.check()` returning `false` (global agent budget exhausted), OR
- reviewer approval: `reviewVerdictApproves(reviewControl?.verdict) && !reviewHasBlockingFinding(reviewControl)` (artifact line 306), OR
- `options.skipped?.(state)` (design-skip), OR
- `ctx.signal?.aborted`.

There is **no bounded round ceiling**. This violates the codebase's own guaranteed-
termination convention (`ESCALATION_RETRY_CAP = 2` in `escalation.ts`, with a dedicated
"bounded termination" test). **Both** convergence nodes are the exception.

### 1B. TEST staleness + a regression that turned it into an infinite loop

`tests/artifact-convergence.test.ts` was written in `98e868a7` for the **pre-reviewer**
model, and has **exactly one commit in its history** (never updated since):

- It supplies `budget.check = () => true` (never exhausted), AND
- its writer controls carry **no `verdict` field**.

**The regression** (`git blame` + `git show` confirm):
- In `98e868a7` (when the test was added), the loop terminated on `options.validate`
  passing → `return { status: "ok" }` **immediately**. Requirements convergence was
  driven by `openQuestions` being empty (`requirementsComplete`). The test's empty-
  `openQuestions` control triggered `pass: true` at round 6 → converged. **Test passed.**
- `584ab8f5` + `0d56c147` added the shift-left reviewer as a **mandatory second gate**.
  After `validate` passes (line 287) the loop now **falls through** to the reviewer gate
  instead of returning. `reviewVerdictApproves(undefined)` returns `false` (empty verdict
  → reject, `artifact-convergence.ts:222`).
- The test was **never updated** to supply verdicts → the reviewer gate can never be
  satisfied → the loop runs forever (always-true budget) → unbounded `seen`/state growth
  → OOM (specifically for `requirements` and `bdd` nodes which have `options.review`).

> Note on `researchConvergenceNode`: it does **not** configure `options.review`. When
> `researchComplete` passes at round 6 it bypasses the review block and returns
> `{ status: "ok", attempts: 6 }` cleanly (verified empirically). The OOM in this test
> file is driven specifically by `requirements` and `bdd` nodes.

> Co-located test: `src/stages/artifact-convergence.test.ts` is correct — it supplies
> `verdict` fields AND a bounded budget (`check: () => rounds++ < maxRounds`); passes 10/10.

## 2. Deep online research — bounded refinement loops in LLM pipelines

The convergence loop is a **generate-validate-repair loop with a noisy (stochastic) LLM
reviewer** — the exact object studied by recent agent-loop research.

### 2.1 Every major framework enforces a HARD iteration cap

| Framework | Mechanism | Default |
|---|---|---|
| **LangGraph** | `GRAPH_RECURSION_LIMIT` (hard cap on cyclic-graph steps; "often due to an infinite loop") | **25** |
| **OpenAI Agents SDK** | `Runner(…, max_turns=…)` | **10** |
| **CrewAI** | `Agent(max_iter=…)` | **25** |
| **AutoGen** | `max_consecutive_auto_reply` + `max_turns` | configurable |

No production agent framework relies solely on a global budget or "iterate until satisfied."

### 2.2 Empirical: most gains land in rounds 1–4; cap + stop-on-plateau

- **Kiecker et al. 2026** (arXiv:2607.05197): gains concentrate in the **first 3–4 repair
  rounds**; completion curves **consistently concave**; "a property of the loop, not any
  one model."
- **Arimbur 2026** (arXiv:2604.10508): same concave shape; default = **low cap +
  stop-on-plateau**.
- Caveat: frontier models on hard bugs keep improving past round 3 → prefer plateau
  detection; with a thin oracle more rounds can *worsen* overfitting → the cap guards
  correctness too.

### 2.3 "Iterate until satisfied" has no convergence proof

Practitioner analysis (tianpan.co): a stochastic reviewer makes "until satisfied" a
"search through a space whose extrema may not exist"; the `max_iterations` cap is "the
architectural admission that the loop has no convergence proof."

### 2.4 The codebase already encodes this philosophy

`ESCALATION_RETRY_CAP = 2` (`src/escalation.ts`, bounded-termination test), the verify-
loop **4-round** budget, the per-phase **3-attempt** budget. The convergence loops are
the inconsistency.

## 3. Fix plan

### Fix 1 (CODE, REQUIRED) — Hard convergence round cap: the liveness guard

**Add** an exported `MAX_CONVERGENCE_ROUNDS` constant + an optional per-node override,
enforce it at the **top of the loop body** (right after `round++`), before the writer
runs. Apply to **both** `artifactConvergenceNode` and the spec-convergence node.

```ts
export const MAX_CONVERGENCE_ROUNDS = 8; // liveness guard; see docs/requirements/convergence-loop-unbounded-cap-fix.md
…
// inside each node factory:
const maxRounds = options.maxRounds ?? MAX_CONVERGENCE_ROUNDS;
…
while (ctx.budget.check()) {
    round++;
    if (ctx.signal?.aborted) return { status: "cancelled" as const };
    if (round > maxRounds) {
        // Unconditional liveness floor. The existing STALL path (artifact ~line 318)
        // already routes ACTIONABLE stagnation (a recurring blocking finding) to HITL
        // escalation. This cap is the safety net for NON-actionable non-convergence
        // (e.g. a stochastic reviewer that never approves). It FatalAborts exactly like
        // the global-budget-exhaustion path below (artifact ~line 367 / spec ~line 178)
        // — deliberately NOT escalating, so it does NOT consume the shared
        // `stagnation:<feedbackKey>` escalation budget (ESCALATION_RETRY_CAP = 2) that
        // the stall path relies on (see Review finding R-2).
        const msg = `${options.feedbackKey} convergence did not converge within ${maxRounds} round(s)${lastErrors.length ? `: ${lastErrors.join("; ")}` : ""}`;
        ctx.log(`${options.feedbackKey} convergence: ROUND CAP (${maxRounds}) EXHAUSTED (FATAL — aborting run) — ${msg}`);
        throw new FatalAbort(msg);
    }
    … // rest of loop unchanged
}
```

**Why a direct `FatalAbort` (not escalation + round extension):** the previous draft
escalated at the cap and did `maxRounds += 3` on guided retry. That works and is bounded
(max 2 extensions), but (a) deviates from the codebase convention (budget-exhaustion
`FatalAbort`s without escalating) and (b) reused `kind: "stagnation"` — the SAME budget
key as the stall path — so the two would share one cap of 2. A non-escalating cap is
simpler, convention-consistent, and cannot starve the stall path's HITL budget. Actionable
cases are still caught earlier by the stall path; the cap is only the unconditional floor.

> **Alternative (if HITL-at-cap is desired):** escalate but with a **distinct**
> `kind: "convergence-cap"` (NOT `"stagnation"`) so it gets its own budget, then
> `maxRounds += 3`. More complex; only choose this if non-actionable non-convergence
> should regularly prompt the user rather than abort. Default recommendation: direct
> `FatalAbort`.

**Why `8`:** research default 3–4; pipeline verify-loop uses 4; 2× the empirical default
is generous for multi-dimensional artifact convergence with HITL, yet guarantees
termination. It is a **calibration knob** (`options.maxRounds` per-node override), not a
magic constant. The existing stall detector (`priorBlockingSignature`) is the plateau
detector for early exit; the round cap is the floor beneath it.

`ArtifactConvergenceOptions` (and the spec node's options) gain `maxRounds?: number`.
Helpers (`FatalAbort`) already imported.

### Fix 2 (TEST, REQUIRED) — Resolve the stale `tests/artifact-convergence.test.ts`

**Option A (recommended) — satisfy both gates + bound the budget**, preserving the file's
unique bdd/research coverage:

1. **Bound the budget** — replace `budget().check = () => true` with
   `check: () => calls++ < maxRounds` (maxRounds ~ 8–10). This alone removes the OOM.
2. **Supply reviewer verdicts** — update `ctx.agent` to branch on `call.id` /
   `call.agent`: when `call.id === "pipeline.requirementsReview"` (or `…bddReview`),
   return `{ verdict: "Approved", findings: [] }` once openQuestions/AC coverage is met,
   else a non-approving verdict. Re-verify `result.status === "ok"`, `attempts === 6`,
   and the `renderRetryFeedbackBlock(seen[5])` expectations under the validate+reviewer model.

**Option B — remove the file.** Not recommended: uniquely covers bdd/research paths.

With Fix 1's cap, this file can **never OOM again** — it fails fast at the cap instead.

### Fix 3 (NO CODE CHANGE — comment only)

Add a comment at `artifact-convergence.ts:287` clarifying that deterministic-validation
pass falls through to the review gate by design (shift-left review must run even when the
deterministic gate passes).

## 4. Validation plan

1. **Cap-termination test** (artifact + spec): a node that can never approve + always-true
   budget **terminates at exactly `MAX_CONVERGENCE_ROUNDS`** and throws `FatalAbort`.
   Mirrors the `escalation.test.ts` bounded-termination contract.
2. **Fix 2 applied** — `tests/artifact-convergence.test.ts` passes with both gates
   satisfied + bounded budget.
3. **Co-located test** still 10/10; spec-convergence tests still green.
4. **Full suite** no longer OOMs on this file.
5. **Typecheck** clean; version bump per `AGENTS.md`.

## 5. Risk assessment

- **Fix 1 (cap):** low risk. Pure additive guard at loop top; existing approval/stall/skip
  paths unchanged. Non-escalating → cannot affect the stall path's HITL budget. The only
  behavioral change is guaranteed termination where today there is none — strictly safer.
- **Fix 2 (test):** low risk. Test-only; Option A preserves coverage and assertions.
- **Cap value (`8`):** the one judgment call. Overridable per node; empirically grounded
  (2× the 3–4 default). If real runs legitimately need more, raise via `options.maxRounds`.

---

## 8. Formal Plan Review & Audit Result

An independent-model review was performed; its three findings were then **verified against
the code and online sources**. All three findings are **factually correct**. One
finding's *resolution* was over-engineered and introduced a risk the review missed; the
plan has been adjusted accordingly. Summary:

### R-1 ✅ Verified — Fix 1 re-escalation bug (review Finding 1)
- **Claim:** the original draft fell through on `retry-with-guidance` without extending
  the cap, so `round > maxRounds` stayed true and re-triggered escalation next round.
- **Verification:** CORRECT. `round` only increments (`round++`); the original `const
  maxRounds` was never extended → `round > maxRounds` re-fires every subsequent round,
  consuming `ESCALATION_RETRY_CAP = 2` in two consecutive rounds then `FatalAbort`. The
  agent gets ≤1 round per guided retry.
- **Plan change:** Fix 1 resolution switched from "escalate + `maxRounds += 3`" to a
  simpler **direct `FatalAbort` at the cap** (see R-2 for why).

### R-2 ⚠️ Verified + sharpened — shared escalation-budget conflation (missed by the review)
- **Finding:** the review's `+= 3` resolution used `kind: "stagnation"`. Verified via
  `escalation.ts` `budgetKey = ${kind}:${stage}` that this is the **same key** as the
  existing stall path (artifact lines 327-328) → the two **share one cap of 2**
  (`ESCALATION_RETRY_CAP`). A stall at round 3 would starve the round-cap escalation at
  round 8. Also: the existing budget-exhaustion path (artifact ~line 367, spec ~line 178)
  `FatalAbort`s **without escalating** — the `+= 3` resolution deviated from convention.
- **Plan change:** Fix 1 now does a **non-escalating `FatalAbort`** (convention-consistent,
  cannot starve the stall path). Actionable stagnation is still routed to HITL by the
  unchanged stall path; the cap is only the unconditional floor. (An explicit HITL-at-cap
  variant using a **distinct** `kind: "convergence-cap"` is documented as an alternative.)

### R-3 ✅ Verified — per-node convergence nuance (review Finding 2)
- **Claim:** `researchConvergenceNode` omits `options.review` and converges in 6 rounds
  without looping.
- **Verification:** CORRECT. Confirmed via node config (no `review` field) and an
  empirical probe (`{"status":"ok","attempts":6}`, no loop). The OOM is driven
  specifically by `requirements` and `bdd` nodes (which have `options.review`).

### R-4 ✅ Verified + promoted to in-scope — sister module (review Finding 3)
- **Claim:** `src/stages/spec-convergence.ts:117` uses the identical unbounded pattern.
- **Verification:** CORRECT. Line 117 `while (ctx.budget.check())`, `round++`, no cap;
  only `FatalAbort` at global-budget exhaustion (line 178). Identical structure.
- **Plan change:** spec-convergence.ts moved from "follow-up" to **in-scope** — the same
  cap guard applies in the same change (Fix 1), closing the known unbounded loop now
  rather than deferring it.

### Net effect of the review on the plan
- Fix 1 simplified (direct `FatalAbort`, no `+= 3`, no budget conflation).
- Scope widened to include `spec-convergence.ts`.
- One test file (Option A) repaired; cap makes it OOM-proof.
- No code was changed during the review — only this plan document.

---

## 9. Decision needed from user

- Approve Fix 1: `MAX_CONVERGENCE_ROUNDS = 8`, **non-escalating `FatalAbort`**, applied to
  BOTH artifact-convergence and spec-convergence? (Or the HITL-at-cap alternative with
  distinct `kind: "convergence-cap"` + `maxRounds += 3`?)
- Approve Fix 2 Option A (update stale test to supply verdicts + bounded budget) vs B (remove)?
- Confirm cap value 8, or set a different ceiling?
