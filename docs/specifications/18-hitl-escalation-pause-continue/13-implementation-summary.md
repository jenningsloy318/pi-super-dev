# Implementation Summary: spec-18: HITL Escalation (pause-ask-continue) — Implementation Summary

- **Date**: 2026-07-28

---

## Summary

## Task

Spec-18 adds Human-In-The-Loop (HITL) escalation to pi-super-dev: when a run hits an unrecoverable blocker (fatal-gate exhaustion or verify-loop stagnation), it PAUSES, ASKS the user via `ctx.ui.select`/`input` (the canonical pi pause-ask-continue pattern), and CONTINUES on their decision — instead of failing silently. Recovery options: retry-with-guidance (rollback worktree + persist guidance + uncached re-run), revise-manually (clean stop), accept-limitation (stamp soft-block), abandon (FatalAbort). Bounded by `ESCALATION_RETRY_CAP=2` per blocker; default-on in TUI/RPC, never prompts in headless/print/json.

## Phases planned (4, coarse + independently testable)
1. **Primitives** — types + `rollbackWorktreeTo` + budget helpers.
2. **Plumbing + Impl + Report** — extension `makeEscalate`, escalation-report writer, wire `escalate` into `RunOptions`/ctx.
3. **Firing Points + Recovery** — inline fire at `nodes.ts` gate exhaustion + `verify.ts` stagnation; recovery actions.
4. **Hardening + Release** — no-throw/full-coverage pass + CHANGELOG entry.

## What was actually built — 2 of 4 phases landed

**NOTE:** The pipeline's pre-rendered metadata said "1/4 phases, files modified: none." Both are STALE. On-disk reality: Phase 1 AND Phase 2 landed; 8 files changed; full suite green. The stale figures reflect an earlier snapshot (the 02:23 summary captured only Phase 1; work continued through 02:57).

### Phase 1 — Primitives (committed: `b782f3a4`, +601 insertions)
- **`src/types.ts` (+64)** — Pure additive types, no runtime behavior: `EscalationKind`, `EscalationSeverity`, `EscalationFinding`, `EscalationFailure` (rich live blocker context), `EscalationChoice` (closed 4-value union), `EscalationDecision`, async `Escalate` (never-throws contract → `EscalationDecision | undefined`), and `escalate?: Escalate` on `RunOptions` (reachable as `ctx.options.escalate` with ZERO edits to `workflow.ts`, mirroring `userSteerProvider`).
- **`src/tracking.ts` (+55)** — `rollbackWorktreeTo(worktreePath, commit='HEAD')`: worktree-scoped `git reset --hard` + `clean -fd` via discrete-argv `spawnSync` (sidesteps the `safety.ts` denylist which matches shell strings only); one try/catch → `{ok,error}`, never throws, scoped to the worktree only (never the main checkout).
- Tests: `tests/tracking.test.ts` (+68, argv-form assertions proving no `shell:true`), `tests/escalation-types.test.ts` (new, `expectTypeOf` + runtime construction), `tests/tracking-rollback.test.ts` (new, AUTHORITATIVE hermetic coverage driving a REAL `git` binary in a fresh `mkdtempSync` repo per test — resets dirty tracked + removes untracked → `{ok:true}`, sibling dir untouched, non-git dir → `{ok:false}` no-throw).

### Phase 2 — Plumbing + Impl + Report (UNCOMMITTED/untracked, but on-disk + green)
- **`src/extension.ts` (+128/−21)** — `makeEscalate(ctx)` builder (never-throwing inline `escalate` callback, spec-18/AC-01) and threads it into the run context at the RunOptions assembly point (`escalate: makeEscalate(ctx)`). Additive, never-regressing.
- **`src/escalation.ts` (new, 98 LOC)** — escalation decision/construction logic.
- **`src/render/escalation-report.ts` (new, 73 LOC)** — report writer.
- Tests: `src/escalation.test.ts` (6 tests), `src/extension.escalation.test.ts` (11 tests), `src/render/escalation-report.test.ts` (114 LOC) — all pass.

## Test results — ALL GREEN
Full suite: **101 test files, 1574 tests, 0 failures** (17.5s). The spec-18 suites (`escalation`, `extension.escalation`, `escalation-report`, `tracking-rollback`, `escalation-types`) all pass. No regressions.

## Deviations from spec
1. **Phase 2 work is UNCOMMITTED** (untracked files + unstaged `extension.ts` edit). It is on-disk and tested, but only Phase 1 is committed (`b782f3a4`). A commit is needed before merge.
2. **Phases 3 & 4 did NOT run** (no `phase-03`/`phase-04` records in change-tracker.jsonl). Consequences:
   - **Firing points are NOT wired:** `grep` for `escalate`/`makeEscalate` in `src/nodes.ts` (fatal-gate exhaustion) and `src/verify.ts` (stagnation) returned ZERO matches. The `escalate` callback is built and threaded into ctx, but is never INVOKED at any blocker, so a real run today will still fail silently — the feature is inert until Phase 3 lands.
   - **No CHANGELOG entry** for the spec-18 pause-ask-continue feature (the only related entry is an earlier "Stagnation escalation UI (Gap 4.6′-lite)" informative baseline, not the new recovery/rollback path). Deferred to Phase 4.
3. **Self-reporting gap (Phase 1):** the implementation agent's `claimed` manifest was empty `{filesCreated/Modified/Deleted:[]}` while gitActual showed 5 files changed; the cross-check flagged them `changedNotClaimed` but still returned `verdict:"ok"`. Work is real and on-disk.

## Bottom line
Phases 1–2 deliver the complete *plumbing* for pause-ask-continue (types, rollback primitive, never-throwing `escalate` callback, report writer, full test coverage) and the suite is green. But the feature CANNOT fire yet: Phase 3's firing points at gate-exhaustion and verify-stagnation are unwired, and Phase 4's hardening/CHANGELOG is absent. Functionally, today's run behavior is still identical to pre-spec-18.

## Phases

- **Phases Completed**: 2 of 4 — Phase 1 (Primitives: types + rollbackWorktreeTo) committed; Phase 2 (Plumbing + Impl + Report: makeEscalate, escalation-report writer, escalate threaded into ctx) on-disk + uncommitted but fully tested/green. Phase 3 (Firing Points + Recovery at nodes.ts/verify.ts) and Phase 4 (Hardening + CHANGELOG) did NOT run.
- **All Green**: false

## Files Modified

- src/types.ts
- src/tracking.ts
- tests/tracking.test.ts
- tests/escalation-types.test.ts
- tests/tracking-rollback.test.ts
- src/extension.ts
- src/escalation.ts
- src/escalation.test.ts
- src/extension.escalation.test.ts
- src/render/escalation-report.ts
- src/render/escalation-report.test.ts
