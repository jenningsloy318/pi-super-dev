# Implementation Plan: Technical Specification, Implementation Plan & Task List — HITL Escalation (pause-ask-continue) for pi-super-dev

- **Date**: 2026-07-28
- **Last updated (docs-executor, Stage 11)**: 2026-07-29

---

## Phase status (post Stage-11 docs pass)

- ✅ **Phase 1 — COMPLETE** (committed `b782f3a4`)
- ✅ **Phase 2 — BUILT + GREEN, UNCOMMITTED** (needs commit before merge)
- ⛔ **Phase 3 — NOT STARTED** (firing points unwired; feature inert)
- ⛔ **Phase 4 — NOT STARTED** (no CHANGELOG entry; convergence gate not run on wired points)

## Phase 1: Phase 1 — Primitives (types + rollback helper)

Pure additions with zero pipeline behavior change. Add the EscalationKind/EscalationFailure/EscalationDecision/Escalate types and RunOptions.escalate to src/types.ts (beside userSteerProvider); confirm ctx.options.escalate is reachable with no workflow.ts edit. Author rollbackWorktreeTo in src/tracking.ts (discrete-argv spawnSync git reset --hard + clean -fd, never-throws, worktree-scoped). Extend src/tracking.test.ts. Independently testable: types compile; rollback resets a temp git repo and never throws on a non-git dir.

**STATUS: ✅ COMPLETE** — committed as `b782f3a4` (+601). Types land in `src/types.ts`; `rollbackWorktreeTo` lands in `src/tracking.ts`; hermetic git-binary tests in `tests/tracking-rollback.test.ts`.

## Phase 2: Phase 2 — Escalate plumbing + extension impl + report

Make ctx.options.escalate actually do something (best-effort, never throws) WITHOUT yet firing it. Author src/render/escalation-report.ts (writeEscalationReport, always-written, never-throws). Author src/escalation.ts (ESCALATION_RETRY_CAP=2, escalationBudgetRemaining, runEscalation, applyRetryDecision — all never-throw). Author makeEscalate(ctx) in src/extension.ts (writeEscalationReport + ctx.ui.select/input guarded by ctx.hasUI, 300s timeout, try/catch→undefined, accept-limitation omitted when severity hard) and wire it into runPipelineTask beside userSteerProvider. Generalize handleStagnation to delegate report-writing to writeEscalationReport. Tests via injected fakes (no firing points yet). Independently testable: impl contract, headless no-prompt, never-throw.

**STATUS: ✅ BUILT + GREEN — UNCOMMITTED.** `makeEscalate(ctx)` + `escalate: makeEscalate(ctx)` wiring land in `src/extension.ts` (+128/−21); `src/escalation.ts` (budget + `runEscalation` + `applyRetryDecision`, never-throw) and `src/render/escalation-report.ts` (`writeEscalationReport`, always-written, never-throw) are authored; all three test files pass. Change-tracker records `phase-01` + `phase-02`. **Deferred to merge prep:** stage + commit (currently untracked + unstaged).

## Phase 3: Phase 3 — Firing points + bounded recovery

Fire escalate at the two unrecoverable sites and act on the decision, bounded by ESCALATION_RETRY_CAP. Gate (src/nodes.ts gate() :395-436): wrap the attempt loop in an outer escalation loop; on exhaustion build failure{kind:'gate-exhaustion', severity: fatal?'hard':'soft'}, call runEscalation, branch retry/accept/revise/abandon (abandon/undefined → original throw new FatalAbort). Stagnation (src/stages/verify.ts :167 reviewLoopUntil and :329 integration loop): fire runEscalation{kind:'stagnation', severity:'soft', findings}; retry-with-guidance → clear __stagnated + return false (loop continues); accept-limitation → stamp __acceptedLimitations; else original break. Tests inject fake escalate (no real ctx.ui). Independently testable: rollback-then-retry wiring, bounded fallback, accept-offered-only-for-soft.

**STATUS: ⛔ NOT STARTED.** `grep` for `runEscalation` / `applyRetryDecision` / `ctx.options.escalate` / `escalate(` in `src/nodes.ts` (gate() :395-436) and `src/stages/verify.ts` (:167 / :329) returned **zero matches** — the inline firing points are not wired, so a real run still fails silently. The `escalate` callback built in Phase 2 is reachable but never invoked. This phase must land for the feature to actually pause-ask-continue.

## Phase 4: Phase 4 — Hardening + release

Convergence gate. Add a concise [Unreleased] ### Added CHANGELOG entry (Keep-a-Changelog, spec-NN anchor style) describing HITL pause-ask-continue. Run npm run typecheck (tsc --noEmit) strict-clean — fix .ts import specifiers and unknown casts for state.__escalationRetries/__acceptedLimitations. Run full npm test green — ensure new tests pass and no existing test regresses (update any test asserting today's silent-fail to the additive report+fail path). Regression sweep: headless run writes escalation-report.md and returns isError exactly as before; handleStagnation backward-compat report still emits; no prompt when ctx.hasUI===false.

**STATUS: ⛔ NOT STARTED.** No spec-18 `[Unreleased] ### Added` CHANGELOG entry exists (the `[Unreleased]` section currently holds only mid-run-context / spec-17 / spec-15 entries). Convergence gate (`npm run typecheck` strict-clean after wiring the Phase-3 firing points, including `unknown` casts for `state.__escalationRetries` / `__acceptedLimitations`) not yet run, because Phase 3 has not wired those casts.
