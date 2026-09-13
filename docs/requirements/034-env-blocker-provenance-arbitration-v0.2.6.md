# Requirements — Env-blocker provenance, re-gate re-classification, judge arbitration, bounded re-entry

Status: implemented (this commit — v0.2.6)
Type: fix
UI scope: arch (implementation-stage fault routing; no UI)
Source of failure: runs `~/.super-dev/runs/2026-08-19T01-47-29-690Z` (first misfire, v0.2.3)
and `~/.super-dev/runs/2026-08-19T05-09-21-800Z` (confirmed misfire + self-inflicted
quarantine, v0.2.5), both on pi-omisis track `07-staged-execution`
Affected files: `src/fault-classification.ts`, `src/stages/implementation.ts`,
`src/stages/judge.ts`, plus tests
Current version: `0.2.5` → target `0.2.6`

---

## 1. Executive summary

Two consecutive dogfood runs of the v0.2.3 environmental-blocker machinery died at
Phase 1 with **the same deterministic misclassification**: `classifyGateFault` row (2)
called a failure `environmental-blocker` when the failing out-of-scope subject was
broken by **this attempt's own edits** — not by prior-run dirt or a broken toolchain.

Run `05-09-21-800Z` made the misfire worse than a wrong label: the quarantine arm
**stashed the implementer's own live fix** (`src/persistence.ts` — the `WriterId "07"`
extension the phase's declared deliverables typecheck against), guaranteeing the
post-quarantine re-gate fails on freshly-created in-scope tsc errors. The re-gate's
failure evidence was **never re-classified** (adv-F5 only covers the green-re-gate +
failed-deliverable path), so the stale `class=environment` rode into the judge with
`allowedRoutes: ["fix-environment"]` — a route set that cannot express the judge's
grounded conclusion ("NOT environmental — cross-phase sequencing conflict"). The
judge's only honest exit was `escalate-now`; the user answered `retry-with-guidance`
("do it again, and show me why this happen>") and the decision was **dead-lettered**
(guidance persisted, then `convergenceBlocked` tripped — terminal, no re-entry). Run
ended PARTIAL 0/11.

The v0.2.4/v0.2.5 judge-resilience layer worked exactly as designed — 147s verdict
inside the 240s budget, `control=yes`, evidence-less escalate degraded with diagnosis
preserved. The failure is in the deterministic actuation layer above it.

## 2. Root causes

| id | root cause | evidence |
|----|-----------|----------|
| RC-A | **No dirt provenance.** `collectDirtPaths` cannot distinguish prior-run foreign dirt (the mac-run class the quarantine was built for) from this-attempt undeclared edits (the implementer's live work). The quarantine stashed a live fix. | `quarantined foreign uncommitted state — paths: src/persistence.ts` (stash diff verified: exactly the `WriterId` extension); re-gate then failed on `src/staged.ts(75,51): Type '"07"' is not assignable to type 'WriterId'` — an error the quarantine itself created |
| RC-B | **Row (2) classifies own-caused regressions as environment.** On a tree clean at phase start, an out-of-scope-only failure with baseline=regression is by construction caused by this attempt's own edits (in-scope edits breaking a pre-existing test, or undeclared out-of-scope edits). Both runs: the implementer's in-scope `src/schemas.ts`/`src/config.ts` edits broke a pre-existing untouched test (`tests/interface-contracts-ownership.test.ts:618`, opaque-registration pin) that passes at merge-base. | Identical classifier verdict in `01-47` (v0.2.3, judge: "spec-owned opacity-test conflict") and `05-09` (v0.2.5, judge: "cross-phase sequencing conflict… nothing environmental to repair") |
| RC-C | **Still-failing re-gate never re-classifies.** adv-F5's `reRunClassifiedProduct` computes only when the re-gate went green and the fresh deliverable check failed. A still-failing re-gate (now carrying in-scope tsc errors) proceeds to the environmental judge tail on the stale class. | seq 70 `phase-build:env-blocker-regate` errors all in touched files, yet `next=<judge: fix-environment/escalate>` |
| RC-D | **The env-blocker judge cannot contradict the classifier.** `allowedRoutes` is exactly `["fix-environment"]`; a judge whose grounded diagnosis says "product, not environment" has no route to express it. | Judge verdict text both runs; route set at the `stage9.impl-env-blocker.<phaseId>` call site |
| RC-E | **`retry-with-guidance` is dead-lettered.** adv-F3 persists the guidance, then adv-F2 trips `convergenceBlocked` — the outer loop never re-enters, so the persisted guidance reaches nothing. The escalation offers an option that does nothing. | `decision: retry-with-guidance … logged only, NOT applied` followed by `convergence blocked (no automatic re-entry)`; run ended |

## 3. Research grounding (established prior cycles, applied here)

- **Track-30 first principle "evidence is only as good as its provenance"** — the
  classifier quarantined and re-gated against dirt of unknown provenance. The fix
  attaches provenance (phase-start tree snapshot) before any mutation.
- **Leveson STAMP / unsafe control action (Track-30 S-3, embedding #1)** — a control
  action (quarantine / terminal stop) that is unsafe in context needs a context
  check. Here: a deterministic phase-start snapshot for the mutation, and the judge
  as the context-checker for the classification.
- **"A retry is a bet the next attempt differs" (Track-30 P-3)** — the bet is only
  sound when the retry actuator can change the outcome. Re-spawning the implementer
  against a quarantined-away dependency is a guaranteed-losing bet (this run);
  likewise terminal-stopping on a guidance decision that cannot reach any agent (RC-E).
- **v0.2.5 J5 INV-2 rationale** — diagnosis-driven routes (`re-author-tests`,
  `fix-environment`) route with a documented missing-evidence exemption because they
  never acquit a gate and are budget-bounded. `implementer-retry` at the env-blocker
  boundary has exactly the same shape and joins the exemption set.

## 4. Fixes

### G1 — Dirt provenance gate (RC-A + RC-B)

- `src/fault-classification.ts` exports `listPorcelainPaths(worktreePath): string[]`
  — the RAW `git status --porcelain --untracked-files=all` path list (rename
  new-path semantics and `core.quotepath=false` identical to `collectDirtPaths`),
  no exclusions. `[]` on any git failure (never throws).
- `src/stages/implementation.ts` captures a **run-start snapshot** once per run
  (stage entry, before any dispatch — amended per code-review sd26-CR-1: phases
  commit via an orchestrator call that stages only declared files, so per-phase
  provenance would make prior-phase residue "foreign"; one snapshot partitioned
  by every phase, persisted across §D convergence iterations via the control
  field `runStartDirt`). A git failure degrades to `[]` — unknown provenance can
  NEVER support an environment claim (safe direction: product, the pre-v0.2.3
  ladder of implementer-retry → no-progress judge, which is bounded and honest).
  Known limitation (sd26-CR-4): a process resume re-captures at the resumed
  invocation's start; bounded by G2's product fall-through.
- At the classification point, the post-exclusion dirt inventory is partitioned:
  `foreignDirt` (present in the phase-start snapshot) vs `ownDirt` (modified during
  this phase). `classifyGateFault` row (2) requires `foreignDirt.length > 0` for
  `environmental-blocker`; without it the verdict is `product-defect`
  (`implementer-retry`).
- The quarantine arm stashes **`foreignDirt` only** — this-phase edits are never
  stashed, so a live dependency can no longer be quarantined away.
- On the product fall-through with non-empty `ownDirt`, explicit feedback lines
  (`out-of-scope edit (this attempt): <path> — fold into declared scope (spec
  change) or revert`) join `failureReasons`, so the implementer sees its undeclared
  edits named.

### G2 — Still-failing re-gate re-classification (RC-C)

- adv-F5's re-classification extends to the still-failing re-gate: whenever a
  post-quarantine `gate2` exists and did not go green (or its fresh deliverable
  check failed), `classifyGateFault` runs on gate2's evidence. Non-environmental ⇒
  `class=product; next=<implementer-retry> — environmental judge skipped`,
  `failureReasons` carries gate2's errors (the current tree truth), no judge call.
- After the quarantine, `foreignDirt` is empty by construction, so a still-failing
  re-gate deterministically re-classifies as product — the environmental judge tail
  is reachable only while foreign dirt plausibly explains the failure.

### G3 — Judge arbitration route (RC-D)

- `JUDGE_ROUTES` gains `implementer-retry`; it joins
  `DIAGNOSIS_DRIVEN_MISSING_OK` (same INV-2 rationale as J5). The allowed/confidence
  gates still apply after the evidence gate.
- The env-blocker judge call widens to `allowedRoutes: ["fix-environment",
  "implementer-retry"]`.
- A routed `implementer-retry` is an **audited override**: log line names
  classifier-vs-judge disagreement, the ledger records
  `{kind: "judge-environmental", reason: "implementer-retry: <diagnosis>"}`, the
  diagnosis joins the implementer feedback, `convergenceBlocked` is NOT tripped, and
  the attempt falls through to the normal implementer-retry path (no HITL surface,
  no terminal stop). Bounded by the existing per-signature budget (≤2).

### G4 — Bounded re-entry for retry-with-guidance (RC-E)

- Per-phase one-shot `envBlockerGuidanceReentryUsed`. On the FIRST
  `retry-with-guidance` at the env-blocker boundary: persist guidance (existing
  adv-F3 behavior), skip the adv-F2 `convergenceBlocked` trip, and log
  `re-entry granted (1/1)` — the outer convergence loop re-enters the phase and the
  guidance reaches the fresh agent calls. A subsequent guidance choice finds the
  budget spent and terminal-stops as today. No rollback, no `applyRetryDecision`,
  mutation-free — the grant only declines to trip the windup flag.

### Non-goals

- No auto-pop of quarantine stashes anywhere (recovery stays the logged
  `git stash pop`; an in-loop pop risks conflicts mid-attempt).
- No new replan routes at this boundary; a genuine spec conflict still escalates
  with the judge diagnosis once retries are exhausted (impl-no-progress ladder).
- No change to the RED loop, escalation budget caps, or baseline-verify.

## 5. Verification

- RED-first: 17 fix-specific tests fail on stashed pre-fix code; the pure
  classification controls (unchanged truth-table rows) pass on both trees. The
  foreign-only-stashing test is FIX-pinned (RED pre-fix) per adversarial
  sd26-F6 — pre-fix the quarantine swept untracked this-phase files too.
- `tests/fault-classification.test.ts` — row (2) provenance truth table.
- `tests/implementation-env-blocker.test.ts` — phase-start-clean → product (no
  quarantine, no judge); foreign-only quarantine; still-failing re-gate → product
  fall-through; judge override route; guidance re-entry grant/exhaustion.
- `tests/judge.test.ts` — `implementer-retry` route acceptance, missing-evidence
  exemption with documented audit, allowed-route enforcement.
- Full suite + `npx tsc --noEmit`; version 0.2.5 → 0.2.6 across `src/version.ts`,
  `package.json`, `package-lock.json` (2-space), `tests/version.test.ts`,
  regenerated `docs/ARCHITECTURE.md`, CHANGELOG Unreleased bullet.

## 6. Review outcome (adversarial CONTEST — remediated)

Findings and their remediations:
- **sd26-F1** (medium, provenance resets per stage run): the phase-start
  snapshot is now the phase's FIRST-EVER snapshot, persisted per phaseId
  (`phaseProvenance` on the stage control, riding `state.implementation`
  like `phaseStatus`) — a §D convergence re-entry no longer reclassifies the
  prior iteration's own uncommitted work as foreign.
- **sd26-F2** (medium, grant refresh windup): the guidance re-entry grant is
  consumed per phase EVER (`phaseGuidanceReentryUsed`, same persistence), so
  guidance-driven re-entry is one-shot across all iterations.
- **sd26-F3** (low): the grant is consumed only AFTER `appendUserNotes`
  succeeds; a persistence failure leaves the budget intact and the stop is
  the blocked variant.
- **sd26-F4** (low): stale five-entries comment corrected (post-G1/G2 the
  judge tail is reachable only via kill-switch and quarantine-FAILED); the
  dead gate2 outputTails clause removed.
- **sd26-F5** (low): the gate2 re-classification now passes an OBSERVED
  foreign count (inventory recomputed post-quarantine, partitioned against
  the first-ever snapshot) instead of the asserted 0.
- **sd26-F6** (low): the foreign-only-stashing test relabeled FIX-pinned; the
  stash-show assertion now checks the untracked parent (`refs/stash^3`);
  design-doc/CHANGELOG control claims corrected.
- **sd26-F7** (info): the snapshot-null comment corrected (git failure
  degrades to `[]`, never null); ownDirt feedback literal says "(this phase)".

The code-reviewer spawn died on a provider 429 (rate limit) with no verdict;
it was respawned after remediation.

## 7. Review outcome, round 2 (code-reviewer Changes Requested — remediated)

- **sd26-CR-1** (high): provenance re-referenced from per-phase to RUN-START —
  one snapshot at stage entry, persisted across §D iterations (`runStartDirt` on
  the control), partitioned by every phase; prior-phase residue is this run's
  own work and never quarantineable.
- **sd26-CR-2** (medium): new behavioral round-trip test — the returned control
  fed back through `state.implementation` reuses the run-start snapshot (no
  recapture; post-iteration-1 dirt stays own) and the second retry-with-guidance
  finds the per-phase-EVER grant spent.
- **sd26-CR-3** (medium): the outcome-ladder log no longer fires its HITL/
  terminal wording for the implementer-retry override (skip-arm + negative
  assertion in the CR-3 test).
- **sd26-CR-4** (low): documented as a known limitation (resume re-captures;
  G2 bounds the harm; durable spec-dir persistence rejected — it would freeze
  the motivating prior-run-dirt class as own).
- **sd26-CR-5** (low): an override arriving via a still-red re-gate feeds the
  implementer gate2's errors (postRegateProductErrors carrier mirrored).
- **sd26-CR-6** (info): dead ternary removed, q.skipped comment corrected,
  CHANGELOG/doc wording aligned (one-shot per phase EVER; run-start boundary).
- **sd26-CR-7** (info): `runStartDirt` validated with `Array.isArray` (the
  per-value map validation became moot with the single-array restructure).
