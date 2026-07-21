# Implementation Summary: Git Change-Tracker with per-stage/phase bracketing + claimed-vs-actual cross-check gate (spec-11)

- **Date**: 2026-07-21

---

## Summary

spec-11 killed the false-green root cause a second way by replacing the advisory flat filesModified[] with a structured {filesCreated, filesModified, filesDeleted} set plus a git-snapshot ChangeTracker that brackets every stage and implementation phase, then AND-ed a claimed-vs-actual cross-check gate into phase-green. A phase that claims to create/modify a file git does not show changed now hard-fails, even when the build gate and deliverable check pass; the whole subsystem never throws and degrades to pass when git is unavailable.

What was built, per phase:

• Phase 1 — ChangeTracker core (NEW src/tracking.ts, ~386 lines): begin/end(unit: "stage"|"phase", id) brackets each unit with a git baseline (rev-parse HEAD + status --porcelain); end() recomputes the delta as `diff --name-status <beginHead>` UNION `status --porcelain`, classifies into gitActual {created(A/+untracked), modified(M), deleted(D)}, and one-directionally cross-checks vs claimed into {claimedNotChanged[], changedNotClaimed[]}, appending one line to an append-only <specDir>/change-tracker.jsonl. Reuses spawnSync + dedupePreservingOrder from src/build-runner.ts; no new deps. Never-throw: git failure records {gitUnavailable:true} and continues.

• Phase 2 — Per-run singleton + structured-change parsing + prompt contract: added activeTracker/setActiveTracker/getActiveTracker mirroring activeRun; setActiveTracker(null) in src/extension.ts execute() finally. src/prompts.ts buildImplementPrompt/buildFixPrompt now request filesCreated/filesModified/filesDeleted with the "git-cross-checked; claiming a file you didn't change fails the phase" instruction. src/stages/implementation.ts gained parseStructuredChanges(control) with legacy flat-filesModified backward tolerance, deriving the flat summary list.

• Phase 3 — Stage + phase bracketing + summary surfacing: src/workflow.ts subscribes to ctx.events 'stage' (running→begin, terminal→end); implementation.ts adds tracker.begin/end('phase', phaseId, claimed) around the attempt loop, producing correctly nested stage-start→phase-start→phase-end→stage-end records. A `📝 N files changed (C/M/D)` evidence line is surfaced from the phase end-record's gitActual.

• Phase 4 — Git cross-check gate + spec-10 bridge + retry injection: computeChangeGate(rec) (co-located in src/build-runner.ts) returns pass===false iff a non-gitUnavailable record has non-empty claimedNotChanged; AND-ed into phase-green (~(gate||inScopePass) && deliverableCheck.pass && changeGate.pass). Misses are fed back into the next implementer attempt under a "## Claimed changes not present in git — actually create/wire these" section via the existing retry channel, bounded by MAX_ATTEMPTS; changedNotClaimed stays advisory-only. AC-09 spec-10 bridge UNIONs claimed.filesCreated into deliverables.requireFiles before runDeliverableCheck (no circular double-count).

• Phase 5 — Quality gate: npm run typecheck (tsc --noEmit) is clean; npm test = 74 files / 1251 tests ALL GREEN (the untouched existing suite + 6 new test files: tracking.test.ts, structured-changes.test.ts, tracker-bracketing.test.ts, compute-change-gate.test.ts, implementation-crosscheck-gate.test.ts, change-tracker-nonregression.test.ts = 78 new tests). No regression to runRedCheck, runDeliverableCheck + cache reset, npm in-scope classification, scope-aware cargo gate, themed stream, mid-run input injection, dashboard, or real-theme parity; pi Theme methods used method-style (no destructuring).

Deviations: none material — the design followed the spec's minimal-touch event-seam preference for stage bracketing (ctx.events subscription) rather than editing nodes.ts/pipeline.ts internals, and chose build-runner.ts for computeChangeGate co-location with the other gates, both as the plan permitted. The false-green that motivated the spec (a phase claiming a file never created/wired) is now provably impossible.

Task type: bug (false-green prevention). UI scope: none — this is an engine/tracking enhancement; the only user-facing surface is the summary evidence line and change-tracker.jsonl.

## Phases

- **Phases Completed**: 5/5 — Phase 1 (ChangeTracker core module src/tracking.ts), Phase 2 (per-run singleton threading + structured-change parsing + prompt contract), Phase 3 (stage + phase bracketing via ctx.events seam + summary surfacing), Phase 4 (git cross-check gate AND + spec-10 deliverable bridge + claimedNotChanged retry injection), Phase 5 (quality gate: typecheck clean + full suite green + no-regression audit).
- **All Green**: true

## Files Modified

- src/tracking.ts
- src/build-runner.ts
- src/extension.ts
- src/prompts.ts
- src/workflow.ts
- src/stages/setup.ts
- src/stages/implementation.ts
- src/stages/implementation.test.ts
- tests/tracking.test.ts
- tests/structured-changes.test.ts
- tests/tracker-bracketing.test.ts
- tests/compute-change-gate.test.ts
- tests/implementation-crosscheck-gate.test.ts
- tests/change-tracker-nonregression.test.ts
- tests/implementation-deliverable-wiring.test.ts
- tests/implementation-deliverable-wiring-edges.test.ts
- tests/implementation-red-loop.test.ts
- tests/implementation-red-loop-edges.test.ts
- tests/implementation-tdd-rust-wiring.test.ts
- docs/specifications/11-git-change-tracker-crosscheck-gate/01-requirements.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/02-bdd-scenarios.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/03-research-report.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/04-debug-analysis.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/05-code-assessment.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/06-specification.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/07-implementation-plan.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/08-task-list.md
- docs/specifications/11-git-change-tracker-crosscheck-gate/09-spec-review.md

## Fix round 2 (post-review gate pass)

Targeted fixes applied after the code-review round, verified against the full
spec-11 test set (76 tests across 5 files, all green):

- **Build-gate blocker resolved** — the implementation stage was refactored to
  the single begin/end-per-phase path (`probeEnd` per attempt → `commitEnd`
  once, review finding CR-MED), but `tests/implementation-crosscheck-gate.test.ts`'s
  hoisted fake tracker still only exposed `begin`/`end`/`getRecord`, so
  `tracker.probeEnd(...)` threw `TypeError: tracker.probeEnd is not a function`
  (SCENARIO-019). The fake now mirrors the real `ChangeTracker` phase path
  (`probeEnd` shifts the queued record into `lastEnd` and captures the claim;
  `commitEnd` is a no-op counter), and the two stale `getRecordCalls > 0`
  assertions moved to the probe API (`probeCalls > 0`).
- **[High] Path normalization in the cross-check** (`src/tracking.ts`) —
  `computeCrossCheck` did exact string equality, so an LLM claim like
  `./src/x.ts`, `src//x.ts`, `src\x.ts`, or `/src/x.ts` was spuriously flagged
  `claimedNotChanged` against git's repo-relative `src/x.ts` → a false-red
  `changeGate` FAIL on a legitimate phase. Added a pure
  `normalizeTrackerPath` (backslash→POSIX, collapse `//`, strip leading `./`
  and leading `/`, strip trailing `/`) used for MATCHING only; output arrays
  still carry the original claim/git strings (more actionable in the retry
  prompt). Case-preserving by design (case sensitivity is FS-dependent).
  No regression to the 33 `tracking.test.ts` cross-check cases (clean paths
  normalize to themselves).
