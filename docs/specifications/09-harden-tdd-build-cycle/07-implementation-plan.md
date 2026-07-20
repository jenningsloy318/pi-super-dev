# Implementation Plan: Technical Specification — Harden super-dev TDD/Implement/Build Cycle (RED oracle, no-`--lib` parity, scope-aware npm gate, render-layer test parity)

- **Date**: 2026-07-20

---

## Phase 1: P1 — Extract shared touchedFilePaths git helper (Gap 4 foundation)

Extract the raw git `diff --merge-base` + `ls-files --others` union currently embedded in `detectTouchedCargoPackages` (build-runner.ts:485) into a new exported `touchedFilePaths(cwd, baseRef?): string[]` that returns raw file paths (never throws, `[]` on error). Refactor `detectTouchedCargoPackages` to map `CRATE_SEGMENT_RE` over the new helper — zero behavior change. Independently testable: new touchedFilePaths unit tests + existing touched-crates/autospace/nonregression suites stay green. No dependency on other phases; foundation for P5.
## Phase 2: P2 — Add runRedCheck RED oracle to build-runner.ts (Gap 1a)

Add `RedStatus` type, `RedCheckOptions` interface, and `runRedCheck(cwd, testTargets, opts): RedStatus` modeled on the `runBuildGate` skeleton, reusing `detectProjectCommands`, `resolveTimeoutMs`, and `resolveIntegrationStems`; per-language scoped invocation (cargo per-stem, vitest/jest/npm, pytest); classify stdout+exit into red/green/broken/unknown; entire body try/catch → unknown (never throws); no runner/empty targets → unknown. Independently testable via new per-status `vi.mock` spawnSync suite. No dependency on other phases.
## Phase 3: P3 — Wire RED enforcement loop into implementation.ts (Gap 1b)

Depends on P2. Capture the tdd-guide result (currently discarded at implementation.ts:70), read `testFiles`, add `MAX_RED_RETRIES=2`, and implement the bounded re-prompt loop: while status is green/broken and retries < cap, re-prompt tdd-guide with a status-specific hint and re-run runRedCheck; proceed on red/unknown; loud warning on cap exhaustion; augment the implementer prompt with confirmed-red context. Log each `red-oracle` outcome. Never stall (unknown proceeds immediately; cap proceeds with warning). Independently testable via a stubbed-runRedCheck loop test. `MAX_ATTEMPTS=3` and `gate.pass||gate.inScopePass` unchanged.
## Phase 4: P4 — Mirror no-`--lib` discipline into the TDD prompt (Gap 3)

Pass `rustDiscipline(setup)` (the shared `RUST_SELF_VERIFY_DISCIPLINE` source string, Rust-gated) as the `langInstructions` arg to `buildTddPrompt` in implementation.ts:70 (buildTddPrompt already accepts the param; prompts.ts:99/105 unchanged text). Export `rustDiscipline` from prompts.ts if needed so both buildTddPrompt and buildImplementPrompt share the identical source string. Independently testable via a prompt snapshot test (rust setup contains no-`--lib` clause + integration-target instruction; non-rust omits it). No dependency on other phases.
## Phase 5: P5 — Generalize in-scope/out-of-scope classification to npm/vitest/jest in runBuildGate (Gap 4)

Depends on P1. Add `parseFailingNpmTestFiles(combinedOutput): string[]` (vitest `❯ <path>` / jest `FAIL <path>`; never throws). In `runBuildGate`, after a failed npm-family test step, compute `touchedFilePaths(cwd, baseRef)`, classify each failing file out-of-scope if absent from touched, populate `outOfScopeErrors`/`inScopePass` exactly like the cargo path (build-runner.ts:1098-1100), degrading conservatively to in-scope on any ambiguity/empty-touched. Cargo branch byte-for-byte unchanged. Independently testable via a stubbed failing-stdout + git-diff suite.
## Phase 6: P6 — Render-layer Theme parity helper + whole-layer regression + convention doc (Gap 2)

Discover the real pi Theme proxy accessor in @earendil-works/pi-coding-agent exports (the existing test only fakes ClassTheme). Create `tests/helpers/real-theme.ts` (`withRealTheme<T>(fn:(theme:Theme)=>T):T` via idempotent `initTheme()`, method-style only — never destructured) and `tests/render/real-theme-parity.test.ts` exercising themeLine/commandBackground/buildResultComponent/packDashboardLines/createDashboardWidgetFactory output (no-throw + ANSI), generalizing `tests/stream-theme-class-theme.test.ts`. Create `docs/testing-parity.md` documenting the parity convention + the future-work graph-based gate note. Independently testable; no dependency on other phases.
## Phase 7: P7 — Full-suite integration, typecheck, and regression gate

Run `npm run typecheck` (strict-clean, no `any` leaks across new boundaries) and the complete `npm test` (existing scoped-args/touched-crates/autoscope/inscope-classification/resolver-validation/nonregression/package-wiring suites — updated wherever signatures change — PLUS the new red-oracle/parity/npm-inscope/implementation-red-loop suites). Regression sweep: dashboard widget, themed stream, scope-aware cargo gate, mid-run input injection, Markdown §3 artifacts unchanged; nodes.ts/workflow.ts/pipeline.ts untouched; MAX_ATTEMPTS=3; Stage 10/11 structure unchanged; no new runtime deps. Depends on all prior phases.
