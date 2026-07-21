# Adversarial Review: Adversarial Review — spec-11 Git Change-Tracker & Cross-Check Gate

- **Date**: 2026-07-21
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

The implementation realizes spec-11's intent: a never-throws ChangeTracker (src/tracking.ts) brackets stage + phase units with git baselines/deltas, classifies created/modified/deleted (with rename/copy source-deletion fix), writes an append-only change-tracker.jsonl, exposes a per-run singleton, parses structured {filesCreated,filesModified,filesDeleted} with legacy-flat tolerance, and ANDs a one-directional changeGate (claimedNotChanged hard-fails, changedNotClaimed advisory, gitUnavailable→no-block) into phase-green — closing the false-green a second way for the single-attempt case. The contract is honored and degrade paths are safe (no production/data-loss/security risk → not REJECT). However three CONTEST-level gaps weaken the headline guarantees against the stated acceptance criteria: (1) the gate only cross-checks the CURRENT attempt's claim, so a phase that silently drops a previously-claimed file on retry evades the "false-green killer"; (2) the setup stage is literally NOT bracketed (stage-start fires before the singleton is installed), breaking AC-02's "EVERY stage" claim; (3) the cross-check uses exact string path equality with no normalization, risking false claimedNotChanged on ./prefix, trailing-slash, or case-insensitive-FS variants. Plus an orphaned phase-start on budget-abort and minor verbosity. Author response requested on F1–F3.

### AR-01: Cross-attempt claim evasion: dropping a claim on retry vacates the change-gate

- **Severity**: medium
- **Lens**: Architect
The false-green killer only holds for a claim that survives into the GREEN attempt. changeGate is computed from `tracker.probeEnd("phase", phaseId, structured)` where `structured = parseStructuredChanges(impl.control)` is THIS attempt's parsed claim, and `claimedNotChanged = changeGate.claimedNotChanged` is reassigned each iteration. Scenario: attempt 1 claims filesCreated:[X] but git shows no X → gate fails, X is injected into the retry block. Attempt 2's implementer simply omits X from its claim → `structured.filesCreated` no longer contains X → cross-check's claimedNotChanged is empty → changeGate.pass===true → phase can go GREEN even though X was never created. The spec-10 deliverable bridge (src/stages/implementation.ts ~line 245) ALSO unions only the current attempt's `structured.filesCreated`, so a non-spec-declared claimed file is fully unenforced once retracted. AC-04's regression test only covers the single-attempt case. Recommend retaining the UNION of claimed.filesCreated across ALL attempts of the phase (or pinning the first claim) so retracting a claim cannot vacate enforcement; spec-declared requireFiles remain independently caught.
### AR-02: The setup stage is NOT bracketed — literal violation of AC-02 "stage-start/stage-end for EVERY stage"

- **Severity**: medium
- **Lens**: Skeptic
The 'running' stage event is emitted at src/nodes.ts:127 BEFORE `await stage.run(state, ctx)` (line 129). setActiveTracker(...) is called INSIDE setup's runSetup body (src/stages/setup.ts:37), i.e. after the running event has already fired. Net effect for the setup stage: getActiveTracker() is null at 'running' → no begin("stage","setup"); by the time the terminal 'ok' event fires the singleton is set → tracker.end("stage","setup") writes an orphaned end-record whose beginHead is null (baseline missing) so the committed-diff delta is skipped and only `git status --porcelain` is recorded. AC-02/AC-02's synthetic-pipeline test asserts start+end for every stage — setup fails that literally. Recommend installing the tracker earlier (pipeline.ts runPipelineTask, before the workflow root runs) or explicitly accepting/excluding the setup stage from the 'every stage' claim.
### AR-03: Cross-check uses exact string path equality — no normalization → false claimedNotChanged

- **Severity**: medium
- **Lens**: Skeptic
claimedNotChanged = claimedCreatedOrModified.filter(p => !gitCreatedOrModified.has(p)) is exact Set string membership. git emits repo-relative posix paths (src/foo.ts) from both `diff --name-status` and porcelain, but agents are free to report `./src/foo.ts`, `src/./foo.ts`, a trailing slash, backslashes, or a case variant. On case-insensitive filesystems (macOS APFS default, Windows) `Src/Foo.ts` vs `src/foo.ts` would falsely register as claimedNotChanged → false gate FAILURE. The spec's 'conservative parse' clause only covers git-unavailability, not path variance. This is the opposite-direction bug of the false-green killer: a real change mis-classified as a miss. Recommend normalizing both sides (path.posix.normalize + strip leading ./, and casefold on darwin/win32) before the set comparison.
### AR-04: Orphaned phase-start record on budget exhaustion (unbalanced jsonl)

- **Severity**: low
- **Lens**: Architect
tracker.begin("phase", phaseId) is called before the attempt loop (~line 143). On budget exhaustion the loop body does `return { phasesCompleted, ... summary: "Budget exhausted" }` at line 148 — a direct return from stage.run that SKIPS the post-loop `tracker.commitEnd("phase", phaseId)`. Result: change-tracker.jsonl carries a phase-start record with no matching phase-end, breaking the 'single begin/end-per-phase nesting' invariant the probeEnd/commitEnd split was specifically introduced to preserve (review finding CR-MED). The stage-level end still fires so the run looks complete. Recommend wrapping the attempt loop in try/finally that always calls commitEnd, or moving commitEnd into a finally.
### AR-05: Partial git failure collapses the whole record to gitUnavailable

- **Severity**: low
- **Lens**: Skeptic
computeEndRecord wraps rev-parse(endHead), diff --name-status, AND status --porcelain in ONE try/catch. If any one of the three throws (e.g. a transient porcelain spawn timeout, a partial stdout), the entire record degrades to {gitUnavailable:true} even though the committed diff was valid — silently discarding a correct cross-check and (correctly but wastefully) skipping the gate. No-block contract preserved, so impact is observability/coverage only. Recommend computing each git op in its own try/catch and unioning whatever subset succeeded, marking only the missing piece unavailable.
### AR-06: Verbosity / redundant doc blocks inflate token cost for every downstream agent

- **Severity**: low
- **Lens**: Minimalist
src/tracking.ts end() carries two stacked JSDoc comment blocks (the original plus a second describing the stage-vs-phase path), and implementation.ts/build-runner.ts are dense with inline SCENARIO-xxx provenance tags. The provenance is useful but these files are read by implementer/reviewer agents whose token budget is the dominant run cost (per learned.md). Recommend merging the duplicate end() JSDoc into one and trimming the most repetitive SCENARIO citations to a single header reference. Pure cleanup; no behavior change.
