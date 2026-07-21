# Requirements: Reproduce and fix the trivial-task execution path in the super-dev tool

- **Date**: 2026-07-20
- **Author**: super-dev:requirements-clarifier
- **Type**: bug-fix
- **Priority**: high
- **Status**: draft

---

## Executive Summary

Running a minimal trivial task (task: "repro trivial", skipWorktree=true, maxAgents=1) through the extension's registered tool currently crashes or returns an error result, as exercised by the existing repro-execute.mjs harness. This spec requires that the trivial-task happy path execute end-to-end without throwing, without an error result, and without writing to /tmp/sd-crash.log, locked behind a regression test. The goal is a deterministic, crash-free minimal run that proves the pipeline is usable for the simplest possible input.

## Acceptance Criteria

- **AC-01**: Running `node repro-execute.mjs` (which invokes the extension default export's registered tool with task="repro trivial", skipWorktree=true, maxAgents=1) completes and the tool's execute() resolves WITHOUT throwing and WITHOUT printing "EXECUTE THREW:".
- **AC-02**: The resolved result has isError===false AND a non-empty content[0].text body (a real pipeline summary), rather than an error envelope.
- **AC-03**: No crash record is written to /tmp/sd-crash.log during the trivial run (the harness's tail dump prints nothing under "=== /tmp/sd-crash.log ===").
- **AC-04**: The trivial-task run is deterministic: two consecutive invocations both succeed per AC-01/AC-02 with no unhandled promise rejection or non-zero process exit.
- **AC-05**: A vitest regression test under tests/ (following the repo's existing test naming/layout) drives the registered tool with the exact trivial-task inputs from repro-execute.mjs and asserts isError===false and non-empty result text, so the happy path is guarded on CI (`npm test`).
- **AC-06**: No widget render path crashes during setup: the harness exercises ui.setWidget factories without printing "WIDGET RENDER CRASH:" for the trivial task.

## Non-Functional Requirements

- Performance: the trivial-task happy path must complete well under the pipeline's stage/overall timeout budgets (skipWorktree + maxAgents=1 implies a minimal single-agent run), so the repro is cheap to run repeatedly.
- Reliability: no unhandled promise rejection, no swallowed-then-leaked error, and a clean (exit 0) process termination under `node repro-execute.mjs`.
- Observability: the /tmp/sd-crash.log crash sink must remain intact for genuine failures — the fix must not silence or delete crash logging, only stop producing a crash for the trivial input.
- Maintainability: the regression test must reuse the same pi extension/tool bootstrap shape as repro-execute.mjs (stubbed pi.registerTool/registerCommand) so it stays faithful to the real execute() entry point.

## Open Questions

- Where is the actual crash located — the extension tool's execute() body, the pipeline setup stage (repro-pipeline.mjs), or the session-agent summarizeSlug path (repro-slug.mjs)? All three repro harnesses exist; which one is in scope for this spec?
- What is the canonical 'success' output for a trivial task — should the pipeline short-circuit to a trivial summary, or run the full stage graph with maxAgents=1? This determines what content[0].text should contain.
- Should the regression test live alongside the existing tests/ suite or co-locate with the repro harness as a scripted mjs check? Confirm the preferred assertion style (vitest vs. node script exit code).
- Is skipWorktree=true + maxAgents=1 the permanent fixture for the trivial happy path, or a temporary repro simplification that should be generalized once the crash is fixed?
