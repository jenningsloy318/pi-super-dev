# Requirements: Smoke test: super_dev runs without the fgColors crash after reload

- **Date**: 2026-07-20
- **Author**: super-dev:requirements-clarifier
- **Type**: bug-fix
- **Priority**: high
- **Status**: draft

---

## Executive Summary

super_dev's result/stream render paths crash at runtime with "Cannot read properties of undefined (reading 'fgColors')" whenever a real pi Theme instance is used: pi's Theme is a class whose fg()/bold() read this.fgColors, so destructuring (const fg = theme.fg) detaches this and throws. A method-style HOTFIX is already in place in src/render/dashboard.ts (L347-353) and src/render/stream-theme.ts (L142-143), plus a unit test in tests/stream-theme-class-theme.test.ts. This requirement closes the remaining gap: a deterministic smoke test that exercises the actual super_dev render path — and ideally a full pipeline run — against a freshly reconstructed (reloaded) class-instance Theme, proving the crash is gone and cannot regress.

## Acceptance Criteria

- **AC-01**: REPRODUCTION IS FIXED & DOCUMENTED: A regression test demonstrates that routing theme color/bold calls destructured-style (`const fg = theme.fg; fg(color, text)`) throws "reading 'fgColors'" against a class-instance Theme, while the current method-style routing (`theme.fg(color, text)` / `theme.bold(text)`) does NOT — mirroring the existing tests/stream-theme-class-theme.test.ts structural-class mock.
- **AC-02**: POST-RELOAD SMOKE: After simulating a Theme reload (the pi TUI reload event that reconstructs the Theme instance), invoking the super_dev render path (buildResultComponent + themeLine + commandBackground + stageIcon) against the reconstructed class-instance Theme completes without throwing any 'fgColors' / 'reading ... of undefined' error.
- **AC-03**: NO DESTRUCTURED DETACH ANYWHERE: Every theme color/bold call in the result+stream render path is method-style bound (`theme?.fg(color, text)`, `theme?.bold(text)`); a grep/source check confirms zero instances of destructured `const { fg|bold } = theme` or `const fg = theme.fg` in src/render/.
- **AC-04**: FULL PIPELINE SMOKE: A super_dev run (or a no-op/empty-task variant that bounds runtime) started AFTER a reload reaches a terminal pipeline status (success/partial/failed) and produces a rendered result dashboard — with no uncaught fgColors exception in the run log or stderr.
- **AC-05**: REGRESSION GUARD LANDS IN REPO: The post-reload class-Theme smoke is committed as an automated vitest case (sibling to tests/stream-theme-class-theme.test.ts) that constructs TWO class-instance Theme objects (initial + post-reload) and asserts both render without the fgColors crash; `npm run build` (tsc) and `npm test` both pass with zero failures.
- **AC-06**: OBSERVABILITY OF THE CRASH: If the fgColors error ever recurs, the smoke/assertion surfaces the exact failing render function and the theme method (fg vs bold) — the failure message must name the render entry point, not a generic TypeError.

## Non-Functional Requirements

- Performance / cost: The automated regression must NOT spawn the live 13-stage LLM pipeline (that path is non-deterministic and minutes-long). Prefer an in-process render-path smoke using a structural class-instance Theme mock (like the existing tests/stream-theme-class-theme.test.ts) plus, separately, a short documented MANUAL runbook for the full-pipeline E2E after reload.
- Determinism: The smoke test must be hermetic and order-independent — no reliance on wall-clock timing, live model calls, or filesystem run-state — so it cannot be flaky in CI.
- Reliability: The Theme-reload simulation must reconstruct a fresh instance (new Map backing fgColors) rather than mutating the existing one, so it genuinely exercises the detach-this failure mode.
- Maintainability: Regression test lives alongside tests/stream-theme-class-theme.test.ts and reuses its structural-class-Theme fixture; the method-style HOTFIX comments in dashboard.ts (L347) and stream-theme.ts (L142) are kept as the in-code rationale.

## Open Questions

- What exactly does 'reload' mean here — the pi TUI/extension hot-reload event that reconstructs the Theme instance, or simply a second super_dev invocation after a theme refresh? (Recommended: pi TUI reload that constructs a new Theme instance — this is what re-triggers the class-instance detach path.)
- Is the full-pipeline smoke meant to be automated, or a manual runbook? (Recommended: automated in-process render-path regression via vitest + a short manual E2E runbook, since spawning 13 live LLM stages is non-deterministic and slow.)
- For the E2E full-pipeline run, should the task be a real task or a no-op/empty task to bound runtime and avoid flakiness? (Recommended: a documented no-op/empty task, or the shortest single-stage task, to keep the smoke fast and repeatable.)
- Is the target render path only the final result dashboard (buildResultComponent), or also the live stream render during the run? (Recommended: both — the live-stream themeLine path is the one most likely to be hit repeatedly after reload.)
