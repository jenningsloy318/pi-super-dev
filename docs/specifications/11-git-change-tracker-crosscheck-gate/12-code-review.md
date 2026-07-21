# Code Review: Code Review — spec-11 Git Change-Tracker & Cross-Check Gate

- **Date**: 2026-07-21
- **Author**: super-dev:code-reviewer
- **Verdict**: Blocked

---

## Verdict: Blocked

The ChangeTracker module (src/tracking.ts), computeChangeGate, the structured-change parsing, the prompt contract, the stage-event subscription seam, and the per-attempt phase bracketing are all implemented cleanly and pass typecheck + 78 new unit tests. The discrete-argv git spawns, never-throw contract, conservative parse, append-only jsonl, dedupe reuse, and spec-10 deliverable bridge (claimed.filesCreated → requireFiles) are faithful to the spec.

However, the feature is **never wired into production**: there is zero `new ChangeTracker(...)` construction anywhere in `src/`. `src/stages/setup.ts` imports `ChangeTracker`/`setActiveTracker` and contains a 7-line comment describing the install, but the actual `setActiveTracker(new ChangeTracker(specDirectory, worktreePath))` call is absent — the comment is immediately followed by unrelated code. `src/pipeline.ts` (which the spec Phase-2 plan explicitly named as the install site) has no tracking references at all. The only production `setActiveTracker` call is `setActiveTracker(null)` in extension.ts's finally.

Consequence: `getActiveTracker()` returns `null` for every stage and every phase in every real run. The workflow.ts subscription (`if (tracker && stage?.id)`) and the implementation.ts guards (`if (tracker) tracker.begin/end`) are dead branches. `phaseChangeRec` stays null, so `computeChangeGate(null)` returns `{pass:true}`. No `change-tracker.jsonl` is ever written. **The headline false-green killer (AC-08) — "a phase that claims filesCreated:[X] but changed nothing in git is caught" — is silently a no-op in production.** This is the exact "implemented-and-unit-tested-but-NOT-wired-in helper" anti-pattern: every test manually calls `setActiveTracker(new ChangeTracker(...))` in its own setup, so CI is all-green while production is inert. No test exercises the real execute()→setup→tracker-active path, which is why the gap is invisible.

This Critical defect defeats the entire purpose of the spec and must be fixed (one-line install + a production-path regression test) before merge. Secondary findings: phase bracketing emits N end-records per phase (one per attempt) instead of the spec's single begin/end pair; porcelain classification misclassifies staged-adds; and no test guards the install seam against future regressions.

## Findings

### CR-01: ChangeTracker is never constructed/installed in production — entire bracketing + cross-check gate + false-green killer is dead code in real runs

- **Severity**: Critical
- **File**: `src/stages/setup.ts`
- **Line**: 31
There is no `new ChangeTracker(` call anywhere in `src/` (confirmed by grep). `src/stages/setup.ts:11` imports `ChangeTracker, setActiveTracker` and carries a 7-line comment describing the install ("install the per-run ChangeTracker singleton the instant the setup's worktreePath + specDirectory are finalized..."), but the comment is immediately followed by `const relWorktree = abbreviatePath(...)` — the actual install line is missing. `src/pipeline.ts` (the install site the spec Phase-2 plan explicitly named — "Wire setActiveTracker(new ChangeTracker(specDir, worktreePath)) in src/pipeline.ts runPipelineTask at the point state.setup is finalized") has zero tracking references. The only production `setActiveTracker` call is `setActiveTracker(null)` in `src/extension.ts:460` (the finally teardown).

Downstream impact: `getActiveTracker()` always returns null. `src/workflow.ts:174` (`if (tracker && stage?.id)`) is dead. `src/stages/implementation.ts:143` (`const tracker = getActiveTracker(); if (tracker) tracker.begin(...)`) is dead, so `phaseChangeRec` stays null (implementation.ts `if (tracker)` guards the end/getRecord block too) and `computeChangeGate(null)` returns `{pass:true, claimedNotChanged:[]}`. No `change-tracker.jsonl` is ever persisted. AC-04 (all stages bracketed), AC-08 (claimed-but-not-changed hard-fails) and AC-10 (evidence surfacing) silently fail in production — the stockfan Phase-5/6 false-green this spec set out to kill a second way remains fully possible.

The 78 new tests pass only because every one of them manually installs the tracker (e.g. `tests/tracker-bracketing.test.ts:83 setActiveTracker(new ChangeTracker(specDir, worktree))`, `tests/change-tracker-nonregression.test.ts:129-130`). No test exercises the production install path, so CI cannot see this. This is precisely learned-lesson [score:62] (an implemented-and-unit-tested-but-NOT-wired-in helper survives every review).

Fix: in `src/stages/setup.ts`, immediately after `const setup = runSetup(...)`, add `setActiveTracker(new ChangeTracker(setup.specDirectory, setup.worktreePath));` (the import is already present). Then add a regression test that runs the setup stage (or execute()) WITHOUT manually installing a tracker and asserts `getActiveTracker()` is non-null and that emitting a synthetic `stage` event produces a record in `<specDir>/change-tracker.jsonl` — i.e. test the production install path, not the manual one. Note the stage-event seam itself is correctly wired (nodes.ts:98/127 emit `{id, label, status}` and workflow.ts subscribes), so once the tracker is installed the stage bracketing will work without further changes.
### CR-02: No test guards the production install path — the missing install (CR-01) is invisible to CI and will recur

- **Severity**: High
- **File**: `tests/change-tracker-nonregression.test.ts`
- **Line**: 120
Every tracker test constructs and installs the tracker in-test (`tests/tracking.test.ts`, `tests/tracker-bracketing.test.ts:83`, `tests/structured-changes.test.ts:154-184`, `tests/change-tracker-nonregression.test.ts:129-130`, `tests/implementation-crosscheck-gate.test.ts`). `tests/change-tracker-nonregression.test.ts` section (C) only asserts the two singletons are independent get/set — it does NOT assert that `execute()` / the setup stage installs a non-null tracker. `tests/tracker-bracketing.test.ts` layer (2) reads `src/workflow.ts` SOURCE text to confirm the subscription exists (a source-grep assertion), which passes regardless of whether the tracker is ever active at runtime. As a result the acceptance criterion AC-04 ("Verify via a test that runs a tiny synthetic pipeline and asserts change-tracker.jsonl contains stage-start/stage-end...") is satisfied by a test that pre-installs the tracker rather than by one that runs the real pipeline. This is the structural reason CR-01 shipped green. Add an end-to-end test that runs the real setup stage and asserts the tracker becomes active with no manual install, so this class of regression is caught.
### CR-03: Phase bracketing emits one begin but N ends (one per attempt), breaking the spec's single begin/end-per-phase nesting contract

- **Severity**: Medium
- **File**: `src/stages/implementation.ts`
- **Line**: 143
In `src/stages/implementation.ts`, `tracker.begin("phase", phaseId)` is called ONCE before the attempt loop (~line 143), but `tracker.end("phase", phaseId, structured)` is called INSIDE the attempt loop on every iteration. The spec Phase-3 plan explicitly states: "tracker.begin('phase', phaseId) before the attempt loop AND tracker.end('phase', phaseId, claimedFromImplementer) after it" with nesting `stage-start → phase1-start → phase1-end → phase2-start → phase2-end → stage-end` (SCENARIO-009). A phase that exhausts 3 attempts instead emits `phase1-start → phase1-end(a1) → phase1-end(a2) → phase1-end(a3) → phase2-start`: multiple end records with no matching begins, polluting the jsonl trace and breaking any downstream consumer that pairs start/end records. The code comment justifies this as intentional (per-attempt verdict, freshest end-record wins via getRecord), and gate correctness IS preserved because `end()` reads the never-cleared phase-start baseline and `getRecord` returns the last record — so this is a contract/observability deviation rather than a gate-correctness bug. To honor the spec contract either (a) move `tracker.end` to after the loop using the final attempt's `structured` claim, or (b) re-`begin` at the top of each attempt so every end has a matching start (cleaner per-attempt bracketing). At minimum document the deviation in the record shape.
### CR-04: classifyPorcelain misclassifies staged-add (`A `) and staged-copy (`C `) as 'modified' instead of 'created'

- **Severity**: Low
- **File**: `src/tracking.ts`
- **Line**: 140
`classifyPorcelain` in src/tracking.ts maps only `??`→created and `D*`/`*D`→deleted, defaulting everything else (including `A `, `AM`, `C `) to 'modified'. A staged-new file (`A ` in porcelain) is genuinely new (added to index, absent from HEAD) and should be 'created'. Impact is limited because (a) during a phase bracket files are normally untracked (`??`) or worktree-modified (` M`), not staged — staging happens in the separate commit step after the phase; and (b) even misclassified, the file lands in the `modified` bucket so `claimedNotChanged` (which checks created∪modified) does not false-trigger — gate correctness is preserved. The only observable effect is the `📝 N files changed (C/M/D)` summary counts and the advisory `changedNotClaimed` bucket being slightly wrong for the staged-add edge case. Recommend extending the map: `xy[0]==='A' || xy[0]==='C'` → created. Low severity.
### CR-05: Porcelain rename handling captures only the destination path; the deleted source is dropped from the advisory set

- **Severity**: Low
- **File**: `src/tracking.ts`
- **Line**: 300
In `buildGitActual`, a porcelain rename line `R  old -> new` is parsed via `path.split(" -> ").pop()` which keeps only `new`; the `old` path (which git treats as deleted) is never added to the `deleted` bucket. This makes the advisory `changedNotClaimed`/deleted counts incomplete for rename cases. Gate correctness (`claimedNotChanged`) is unaffected since renames are not claimed-file misses. For completeness, when a rename is detected, push `old` into the deleted bucket and `new` into created/modified per its XY code.
