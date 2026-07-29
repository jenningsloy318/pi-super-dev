# Specification: Technical Specification, Implementation Plan & Task List — HITL Escalation (pause-ask-continue) for pi-super-dev

- **Date**: 2026-07-28
- **Last updated (docs-executor, Stage 11)**: 2026-07-29

---

## Deviations from this specification (recorded post-implementation)

The design in this document (4 phases: Primitives → Plumbing → Firing Points → Hardening) was implemented as **2 of 4 phases only**. The plumbing is complete and the suite is green, but the feature is **functionally inert** — it does not yet pause-ask-continue in a real run.

| # | Spec says | Implementation reality | Impact | Reason |
| --- | --- | --- | --- | --- |
| DEV-01 | 4 phases delivered end-to-end; pipeline pauses-asks-continues at gate-exhaustion and verify-stagnation. | **Phases 3 & 4 not run.** `grep runEscalation\|applyRetryDecision\|ctx.options.escalate\|escalate(` in `src/nodes.ts` (gate `:395-436`) and `src/stages/verify.ts` (`:167` / `:329`) → **zero matches**. | A real run still fails silently on a fatal-gate exhaustion / stagnation exactly as pre-spec-18 — the `escalate` callback is built and threaded into ctx but never INVOKED at any blocker. | Phase-budget / iteration boundary; firing-point wiring deferred. The feature cannot be claimed working until Phase 3 wires the two inline firing sites and Phase 4 hardens + documents. |
| DEV-02 | `npm run typecheck` strict-clean against the FULL wired surface (incl. `state.__escalationRetries` / `__acceptedLimitations` `unknown` casts at the firing points). | Typecheck is clean **only for the landed plumbing** (Phase 1 committed + Phase 2 uncommitted). The firing-point `unknown` casts described in the spec are not yet exercised because Phase 3's call sites do not exist. | Cannot assert the full strict-clean contract until Phase 3 lands. | Consequence of DEV-01. |
| DEV-03 | Concise `[Unreleased] ### Added` CHANGELOG entry describing HITL pause-ask-continue. | **Absent.** The `[Unreleased]` section holds only mid-run-context / spec-17 / spec-15 entries; no spec-18 entry. | Public/release notes do not yet mention the feature. | Deferred to Phase 4 (T1). |
| DEV-04 | All work committed with docs. | **Phase 1 committed** (`b782f3a4`, +601). **Phase 2 is UNCOMMITTED** — `src/escalation.ts`, `src/escalation.test.ts`, `src/extension.escalation.test.ts`, `src/render/escalation-report.ts`, `src/render/escalation-report.test.ts` are untracked and `src/extension.ts` is unstaged. On-disk + green, but not in history. | Merge will be incomplete / carry uncommitted churn if Phase 2 is not staged first. | Phase boundary; a single follow-up commit resolves it. |
| DEV-05 | Self-reporting: implementer `claimed` manifest matches `gitActual`. | Phase-1 implementer `claimed` was empty `{created/modified/deleted:[]}` while `gitActual` showed 5 files; cross-check flagged `changedNotClaimed` but returned `verdict:"ok"` (advisory-only for under-reporting). | No functional impact (work is real, on-disk, tested); observability gap only. | Existing change-gate rule: under-reporting is advisory, over-claiming fails. |

**No design deviation:** the architecture as specified (escalate callback on `RunOptions` reachable as `ctx.options.escalate` with zero `workflow.ts` edits; `makeEscalate(ctx)` always-write report + `ctx.ui.select`/`input` guarded by `ctx.hasUI`; `ESCALATION_RETRY_CAP=2`; `rollbackWorktreeTo` discrete-argv `spawnSync`; never-throw everywhere; headless never prompts) was implemented **verbatim** for the landed phases. The gap is **scope, not design** — Phases 3 & 4 remain to land.

Full per-phase detail: `13-implementation-summary.md`.

---

## Summary

Three documents specifying HITL escalation for pi-super-dev: when super-dev hits an unrecoverable blocker (fatal-gate exhaustion or verify-loop stagnation), it pauses, asks the user via ctx.ui.select/input (the canonical pi pause-ask-continue pattern), and continues the run on their decision — instead of failing silently. Design (additive, never-regressing): thread an `escalate(failure)` callback on RunOptions (reachable as ctx.options.escalate with zero makeContext edits, mirroring userSteerProvider); the extension supplies the impl (ctx.ui.select/input guarded by ctx.hasUI, 300s timeout, try/catch→undefined, never throws; ALWAYS writes escalation-report.md); fire it INLINE at two sites — gate exhaustion in src/nodes.ts:436 (before throw new FatalAbort) and verify-loop stagnation in src/stages/verify.ts:167/329 (before break). Recovery: retry-with-guidance → rollbackWorktreeTo (worktree-scoped git reset --hard + clean -fd, discrete-argv spawnSync to bypass safety.ts denylist, never-throw — AUTHORED, does not exist) + appendUserNotes (reused) + uncached inline re-run; revise-manually → clean partial stop; accept-limitation → stamp state.__acceptedLimitations (soft blocks only); abandon → FatalAbort. Bounded by ESCALATION_RETRY_CAP=2 per blocker. Default-on in TUI/RPC; print/json/headless never prompt (report + fail exactly as today). Covers AC-01..AC-12 and SCENARIO-001..025; typecheck strict + full vitest green + CHANGELOG entry. Decomposed into 4 coarse, independently-testable phases (Primitives → Plumbing+Impl+Report → Firing Points+Recovery → Hardening+Release).

## Architecture

Single cohesive seam, threaded exactly like the existing userSteerProvider callback. (1) Types: add EscalationFailure/EscalationDecision/Escalate to src/types.ts and escalate?: Escalate to RunOptions (beside userSteerProvider at :318). Because StageContext.options: RunOptions (types.ts:196) and makeContext already assigns options onto the context, escalate is reachable as ctx.options.escalate inside every node/stage/gate with NO edit to src/workflow.ts — confirmed by reading the source. (2) Extension impl (src/extension.ts): makeEscalate(ctx) ALWAYS writes escalation-report.md (generalizing handleStagnation's report body into a new src/render/escalation-report.ts writer), then — only when ctx.hasUI===true and mode is interactive (default-on) — awaits ctx.ui.select (300s timeout) and ctx.ui.input for retry guidance; wrapped in try/catch so dismissal/timeout/error → undefined; accept-limitation omitted when failure.severity==='hard'. Uses select/input NOT ctx.ui.custom (research SRC-04 footgun: custom is TUI-only and silently degrades). Wired into runPipelineTask at :509 beside userSteerProvider. (3) Firing points fire INLINE before giving up because FatalAbort/stagnation lose live context by execute()'s catch. Gate (src/nodes.ts gate() :395-436): wrap the attempt loop in an outer escalation loop bounded by ESCALATION_RETRY_CAP; on exhaustion build failure{kind:'gate-exhaustion', severity: opts.fatal?'hard':'soft'} and call runEscalation; retry-with-guidance → applyRetryDecision (rollback+notes) + continue (re-run uncached, since createMemoizingAgent only caches completed calls); abandon/undefined → original throw new FatalAbort. Stagnation (src/stages/verify.ts reviewLoopUntil :167 and recordTestStagnation :329): fire runEscalation with kind:'stagnation', severity:'soft', findings; retry-with-guidance → clear __stagnated + return false (loop CONTINUES — the key pause-and-continue generalization); accept-limitation → stamp __acceptedLimitations + break. (4) Primitives: rollbackWorktreeTo (src/tracking.ts — AUTHORED, code-assessment confirmed it does not exist) reuses the discrete-argv spawnSync('git',['-C',wt,'reset','--hard',commit]) then ['clean','-fd'] shape so it sidesteps the safety.ts denylist (:35/:39 match shell strings only); one try/catch → {ok,error}, never throws, scoped to the worktree only (never main checkout). appendUserNotes/userNotesForAgent (src/render/user-notes.ts) are REUSED — guidance persisted to .user-notes.json is auto-drained into the next specialist prompt by realAgent (workflow.ts:148), so retry guidance needs no new plumbing. (5) Bounded budget (new src/escalation.ts): escalationBudgetRemaining/runEscalation track per-blocker retries on state.__escalationRetries with ESCALATION_RETRY_CAP=2, guaranteeing termination and bounded spend; applyRetryDecision composes rollback+notes; all never-throw. Non-functional: strictly additive (no escalate or undefined decision → byte-identical to today); no-throw everywhere (callback/rollback/report each degrade to fail-with-report); headless safety (ctx.hasUI guard); ESM + .ts import specifiers + strict TS.

## Testing Strategy

LLM-free vitest unit tests over pure functions with injected fakes (the established pattern — README:288, src/render/*.test.ts); no real agent spawns. (a) Escalate callback contract: src/extension.escalation.test.ts — interactive fake ctx (hasUI:true, ui.select/input returning values) returns an EscalationDecision; headless (hasUI:false) returns undefined AND writes escalation-report.md; ui.select throwing → undefined; default-on guard (no prompt when hasUI:false); retry-with-guidance also calls ui.input; accept-limitation absent when severity hard. (b) Rollback-then-retry wiring: src/escalation.test.ts — applyRetryDecision calls rollbackWorktreeTo + appendUserNotes (guidance lands in .user-notes.json); runEscalation returns undefined when no callback/no budget/callback-throws. src/tracking.test.ts — rollbackWorktreeTo resets a dirty temp git repo + removes untracked → {ok:true}; non-git dir → {ok:false} no-throw; asserts argv form (no shell:true). (c) Firing points: src/nodes.escalation.test.ts — gate retry-with-guidance re-runs the attempt loop and guidance appears in .user-notes.json; abandon throws FatalAbort; accept-limitation not offered when severity hard; cap exhausted → original throw (bounded). src/stages/verify.escalation.test.ts — reviewLoopUntil retry → returns false (continues) + clears __stagnated; accept-limitation stamps __acceptedLimitations; undefined → original break; integration-loop mirror. (d) Bounded retry: escalationBudgetRemaining floors at 0; runEscalation stops calling escalate after ESCCALATION_RETRY_CAP (cap-fallback assertion). (e) No-throw: every helper has a variant where a dependency throws and asserts a safe default is returned. (f) Report: src/render/escalation-report.test.ts — report written to tmp dir with failure+decision fields; never throws on unwritable dir. Acceptance gates: npm run typecheck strict-clean (tsc --noEmit) + full npm test green + concise [Unreleased]/### Added CHANGELOG entry.

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018
- SCENARIO-019
- SCENARIO-020
- SCENARIO-021
- SCENARIO-022
- SCENARIO-023
- SCENARIO-024
- SCENARIO-025
