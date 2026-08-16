# Postmortem 0001 — Verify-Loop Dead State: two case studies

Status: implemented — case study 1 in v0.1.43 (de133d19), case study 2 in v0.1.75–0.1.82 (7dd18363..e1e8cde8). Rules derived below live in `defensive-patterns.md`.

Two production failure shapes, one year apart in maturity, same genus: **the loop's termination semantics contradicted its action semantics** — the pipeline demanded an action from a component that was simultaneously forbidden from performing it. Each case below states the observable symptom, the causal chain, and the fix class, then maps to named defensive rules.

## Case study 1 — the RED-loop deadlock (v0.1.42 era, runs of 2026-08-12/13)

**Symptom.** Stage 9 exhausted every retry on a greenfield module: RED tries oscillated between `broken (No test files found)` and `red-polluted`, then an oscillation halt fired; the RED gate failed; zero GREEN code was ever written.

**Causal chain.**
1. The RED oracle required the test suite to *collect and run* — but the module under test did not exist yet, so collection failed at import time (`No test files found`, `Failed to load url ./persistence`).
2. `classifyRedStatus` classified every module-resolution failure as `broken`, directly contradicting the TDD prompt, which promised the agent that "a test failing because the implementation is missing is valid RED."
3. The agent's escape (a minimal throwing type-stub so tests collect) violated the RED boundary classifier (production files may not change during RED) → `red-polluted`, cleanup, retry.
4. A compounding harness bug (`normalizeStringArray` wrapping a JSON-array string as one filename) made the oracle's own command match nothing — deterministically, on every try — and the oscillation detector then read the identical broken evidence as "no progress."

**Fix class.** Make the oracle's semantics match the prompt's promise (greenfield module-absent import failures classify RED, cross-language), fix the harness bug at the source, and never let a deterministic harness defect masquerade as agent no-progress. Commits de133d19 (+ greenfield parity 1552c120).

## Case study 2 — the blocked-on-decisions dead state (v0.1.71/74 era, run 2026-08-16T01-00-35-613Z)

**Symptom.** Spec 03-staging attempt 2: build green, code review Approved, adversarial CONTEST with four open findings — every one of them design/spec-level (resume protocol undefined; unbounded re-injection; ±0.10 tolerance hard-coded; dispatcher default unverified). The run ended PARTIAL telling the human "the same findings recurred … fix the implementation."

**Causal chain.**
1. `reviewFindingBlocks` promoted `needs-human` to blocking unconditionally — correct for *routing* (the fixer must never receive it) but wrong for *verdict pinning*: the merged verdict stayed `Changes Requested` on a medium non-blocking needs-human note (AR-03-02).
2. R-1 triage simultaneously deferred the same finding to the human (correct).
3. Result: a verdict demanding changes with zero findings any component was allowed to act on — the loop's no-actionable break fired, a *dead state*, not stagnation.
4. The report reused the stagnation template (misdiagnosis: "fix the implementation" — the one direction the pipeline itself forbids), and the one real code fix of the round (`M tests/persistence.test.ts`) sat uncommitted — nothing between reviewFix and merge commits it; merge verification checked only branch geometry, so the fix would have been silently dropped under a green banner.

**Fix class.** Separate WHO from HOW at every boundary: verdict pinning uses the finding's own signals, not its needs-human marker (F-A); reports carry the honest kind (`blocked-on-decisions` says "awaiting human decision", never "fix the implementation") (F-C); fixes are committed deterministically at the moment they happen and a dirty worktree can never claim a merge (F-B); and the structural answer — routable upstream-owned findings trigger a bounded replan restart back to the owning artifact stage (R3/R4/R5) instead of a dead end.

## Loop vocabulary (canonical terms — use these, not synonyms)

| Term | Definition | Terminal? |
|---|---|---|
| convergence | A loop's exit condition met: artifact validates + review approves / review approved ∧ build green ∧ integration passed | yes (success) |
| stagnation | The SAME non-empty failure signature recurring across consecutive rounds — the fixer tried and failed | yes (HITL) |
| dead state | Not approved with ZERO actionable findings and no build driver — nothing in the loop body can change state | yes (HITL, kind `blocked-on-decisions`) |
| blocked-on-decisions | The dead state's honest report kind: residue is advisory / needs-human / cross-stage; a human decision or upstream revision is the only move | yes (HITL) |
| replan boundary | Routable upstream-owned findings persisted; run ends `status: replan` deliberately and auto-resumes with downstream invalidated | yes (deliberate; auto-restart) |
| budget exhaustion | The global agent budget ran out; distinct from every semantic stop above | yes (fatal) |
| round cap | MAX_CONVERGENCE_ROUNDS liveness floor (a non-actionable non-convergence safety net) | yes (fatal) |
| escalation | Any HITL pause (stagnation / gate / no-progress), bounded by ESCALATION_RETRY_CAP per (kind, stage) | no (awaiting decision) |

## Degradation ladder (what "degraded" means at each layer)

Every layer below must fail * quieter than the layer above it* — a diagnostic mechanism may never become a new deadlock source:

1. **Judge degraded** (INV-6): the judge call fails on infrastructure → the wiring point behaves exactly as before the judge existed; `.judge.jsonl` + `events.jsonl` record the degradation.
2. **Replan-lead degraded**: classification failure, low confidence, or unverified evidence → owner degrades to `human`; the replan trigger returns false → today's honest HITL path.
3. **Replan fallback**: no routable residue, R5 budget exhausted, or duplicate pending requests → no restart; `blocked-on-decisions` report stands.
4. **Ledger degraded**: any events.jsonl write failure is a silent no-op (the ledger must never kill the run it observes); an interrupted run's trailing block is tolerated by INV-L5/L6.
5. **Merge honesty**: a merge claim that cannot be git-confirmed (including a dirty worktree) is rewritten `merged:false` → run reports partial, never success.
