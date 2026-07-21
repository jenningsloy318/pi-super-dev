# Code Review: Code Review — spec-11 Git Change-Tracker + Cross-Check Gate

- **Date**: 2025-11-12
- **Author**: super-dev:code-reviewer
- **Verdict**: Changes Requested

---

## Verdict: Changes Requested

The spec-11 implementation is structurally faithful and the headline requirement is met: `src/tracking.ts` ships a never-throwing `ChangeTracker` with begin/end at stage|phase granularity, git baseline + delta (committed `diff --name-status <beginHead>` UNION `status --porcelain`), created/modified/deleted classification (with correct `A`/`C`/`R`→created and `D`→deleted handling plus rename-source capture), a one-directional cross-check, and an append-only `<specDir>/change-tracker.jsonl`. Bracketing is wired via the minimal-touch event seam (workflow.ts subscribes to `ctx.events` "stage"; implementation.ts begins/ends each phase), the structured `{filesCreated,filesModified,filesDeleted}` contract is in both implementer + fix prompts with legacy-flat tolerance, `computeChangeGate` is AND-ed into phase-green (`(gate.pass||gate.inScopePass) && deliverableCheck.pass && changeGate.pass`), `claimedNotChanged` is fed into the next retry, `changedNotClaimed` stays advisory, git-unavailable degrades to pass, and `claimed.filesCreated` unions into deliverable `requireFiles`. Stage brackets are balanced because `nodes.ts` `record()` emits the terminal "stage" event for ok/failed/skipped. Security is clean: every git op is discrete-argv `spawnSync` (no `shell:true`) under `resolveTimeoutMs()`, so agent paths never reach a shell. No new runtime deps. AC-01..AC-06 are satisfied by inspection.

However, one HIGH-severity correctness gap blocks approval: the claimed-vs-actual cross-check is an EXACT string match with zero path normalization, and the implementer/fix prompts do not constrain the path format. Git emits repo-relative paths; an LLM that returns absolute, `./`-prefixed, or cwd-relative paths will be falsely classified as `claimedNotChanged`, flipping `changeGate.pass` to false and turning real GREEN phases RED — the precise inverse of the feature's "be conservative, avoid false alarms" intent. The unit tests pass because they use repo-relative paths, masking the risk. The remaining findings are minor (orphan end records on skipped stages, dangling phase-start on budget exhaustion, blocking spawnSync volume, singleton concurrency). No Critical; one High → Changes Requested.

## Findings

### CR-01: Cross-check has no path normalization; non-repo-relative LLM claims cause spurious changeGate FAIL (false-red on legitimate phases)

- **Severity**: High
- **File**: `src/tracking.ts`
- **Line**: computeCrossCheck (~388-405); src/stages/implementation.ts parseStructuredChanges; src/prompts.ts GIT_CROSSCHECK_WARNING/buildImplementPrompt
computeCrossCheck() compares claimed paths to gitActual paths with exact string equality (`gitCreatedOrModified.has(p)` / `claimedAll.has(p)`), and parseStructuredChanges() does no normalization. Git's `diff --name-status` and `status --porcelain` emit paths relative to the worktree root, but the implementer/fix prompts only say 'report the exact files you created/modified/deleted' with no format constraint. An LLM agent commonly returns absolute paths (`/home/.../src/foo.ts`), `./`-prefixed paths, or cwd-relative paths (and cwd need not equal the repo root). Any such mismatch makes a real change appear in `claimedNotChanged`, so `changeGate.pass === false` and a phase that genuinely created/modified the file is forced RED — the opposite of the feature's goal and a direct violation of the spec's repeated 'be conservative to avoid false alarms' requirement. This is silent in tests because they feed repo-relative paths. Fix: normalize both sides to repo-relative before comparison inside computeCrossCheck (strip leading `./`, strip a `worktreePath`/`cwd` prefix, collapse `\`, reject empty), OR normalize once in parseStructuredChanges; and add a one-line prompt contract: 'Report file paths repo-relative to the worktree root.' Add a regression test: implementer returns `join(worktreePath, 'src/x.ts')` while git shows `src/x.ts` → crossCheck.claimedNotChanged must be empty.
### CR-02: Skipped stages emit a terminal 'stage' event with no preceding 'running' → orphan end record in change-tracker.jsonl

- **Severity**: Low
- **File**: `src/workflow.ts`
- **Line**: 175-181 (subscription); src/nodes.ts:108/113 record(ctx,"skipped")
In nodes.ts `task()`, the disabled/budget-exhausted paths call `record(ctx, "skipped")` WITHOUT first emitting `{status:"running"}`. The workflow.ts stage subscription therefore calls `tracker.end("stage", id)` for a unit that was never begun. computeEndRecord() then reads a missing baseline (defaults to `{beginHead:null}`) and appends an `{event:"end"}` line with no matching `{event:"start"}`. It does not corrupt the gate (stages carry no `claimed`), but it breaks the append-only trace's start/end pairing contract that SCENARIO-008 asserts for 'every stage'. Fix: in workflow.ts, only `end` when a begin was recorded (e.g. guard on a `began` Set, or call `tracker.end` only for `status==='ok'||'failed'`), or have nodes.ts emit 'running' before 'skipped'.
### CR-03: Phase bracket left dangling (start without end) when budget exhausts inside the attempt loop

- **Severity**: Low
- **File**: `src/stages/implementation.ts`
- **Line**: attempt-loop early return on !ctx.budget.check()
implementation.ts opens `tracker.begin("phase", phaseId)` before the attempt loop, but the early `return` on `!ctx.budget.check()` inside the loop executes before `tracker.commitEnd("phase", phaseId)` (which sits after the loop). Result: a `{event:"start"}` jsonl line with no matching `{event:"end"}` for the in-flight phase when a run is budget-killed mid-phase. Not gate-affecting (the run is terminating), but violates the single begin/end-per-phase nesting contract. Fix: wrap the phase body in try/finally with `tracker?.commitEnd("phase", phaseId)` in finally, or call commitEnd before each early return.
### CR-04: Synchronous blocking git spawns on the event loop scale with phases × attempts

- **Severity**: Low
- **File**: `src/tracking.ts`
- **Line**: gitSpawn:300-315
Each begin issues 1 spawnSync (rev-parse); each probeEnd/commitEnd/end issues 3 (rev-parse + diff --name-status + status --porcelain). For N phases × MAX_ATTEMPTS(3) that is ~1 + 3·3 ≈ 10 blocking spawns per phase, plus 2 per stage, all via spawnSync on the main thread. Local git is fast (~tens of ms each) so this is acceptable today, but it is pure synchronous I/O interleaved with an async pipeline; if stage count or attempts grow it will stall the event loop. No change required now — flagging for awareness; if it ever matters, switch to async `execFile` or cache the per-begin HEAD (it cannot change within a phase's begin/end bracket).
### CR-05: Per-run singleton is a blind overwrite, not a concurrency guard; overlapping runs in one process clobber each other

- **Severity**: Low
- **File**: `src/stages/setup.ts`
- **Line**: 28-35 (setActiveTracker call)
setup.ts does `setActiveTracker(new ChangeTracker(...))` unconditionally with a comment claiming a 'stale-singleton discard guard', but it is a blind overwrite. If two pi runs overlap in the same process (the activeRun pattern has the same shape), the second setup overwrites the first's tracker, so the first run's remaining phases write records to the second run's specDir and read the wrong worktreePath. This is accepted per the spec ('mirror the activeRun pattern'), so severity is Low, but the comment overstates the guarantee. Consider keying the singleton by runId or documenting the single-concurrent-run assumption explicitly.
