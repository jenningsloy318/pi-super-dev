# Implementation Plan: Per-Phase Deliverable Assertions for the Build Gate

- **Date**: 2026-07-21

---

## Phase 1: Deliverable Checker Primitive ✅ COMPLETE (committed 92a1056d; requireTests per-line match fix staged)

Add the never-throwing runDeliverableCheck(cwd, deliverables, opts?) primitive to src/build-runner.ts as a sibling of runRedCheck/runBuildGate, enforcing requireFiles/requireContains/requireNotContains/requireTests with tolerant matching, a single cached test-list spawn per cwd per run, and a {pass,missing,ran} return; plus its full unit-test suite. Independently testable via temp-cwd + spawnSync mock with no dependency on the other phases. Covers AC-01/AC-02 → SCENARIO-001..010. **Delivered in `src/build-runner.ts` + `tests/build-runner-deliverable-check.test.ts` (26 tests, all 10 cases a–j).**
## Phase 2: Schema, Normalizer, and Prompt Elicitation ✅ COMPLETE (committed 60eeb51f)

Make phases carry an optional deliverables object end-to-end: extend SpecificationData in src/render/schemas.ts (accept phases[].deliverables), widen normalizePhases in src/doc-validators.ts to preserve deliverables so phase.deliverables is typed, and update buildSpecPrompt in src/prompts.ts to instruct declaring non-compiler-checkable deliverables. Pure type/string changes with no runtime behavior until Layer 3 consumes them; parallelizable with Phase 1. Covers AC-04/AC-05 → SCENARIO-018..020. **Delivered across `src/render/schemas.ts`, `src/doc-validators.ts`, `src/prompts.ts` + `tests/spec-deliverable-declaration.test.ts`.**
## Phase 3: AND-Semantics Wiring in the Implementation Stage ✅ COMPLETE (staged in worktree)

Wire runDeliverableCheck into src/stages/implementation.ts: call it after runBuildGate, log the PASS/FAIL+missing verdict, change the GREEN condition at line 162 to `(gate.pass || gate.inScopePass) && deliverableCheck.pass`, and feed deliverableCheck.missing into the next implementer attempt under a `## Deliverables still missing — create/wire these` block while respecting MAX_ATTEMPTS. Depends on Phase 1 (the checker) and Phase 2 (typed phase.deliverables). Covers AC-03 → SCENARIO-011..015. **Delivered in `src/stages/implementation.ts` (+38: AND condition, verdict log, missing-injection block, resetDeliverableCheckCache import); plus wiring tests `tests/implementation-deliverable-wiring.test.ts` (10) and `tests/implementation-deliverable-wiring-edges.test.ts` (5).**
## Phase 4: Stockfan Regression and Full-Suite Gate ✅ COMPLETE (regression covered via wiring files; full-suite gate green)

Add the stockfan Phase-5/6 false-green regression test proving AND-semantics both ways (deliverables absent → not green despite a green stub build-gate; deliverables present → green), then run npm run typecheck (strict-clean) and npm test (all green) verifying no regression to runRedCheck, npm-in-scope, cargo gate, themed stream, mid-run input, or dashboard. Depends on Phases 1 and 3. Covers AC-06/AC-07 → SCENARIO-016, 017, 021..025. **Regression test was delivered split across `tests/implementation-deliverable-wiring.test.ts` (Case A + Case B) and `tests/implementation-deliverable-wiring-edges.test.ts` (edge cases) rather than a single file — see deviations. Full-suite gate: `npm run typecheck` ✓ strict-clean, `npm run test` ✓ 1173/1173 across 68 files; no regression to runRedCheck, npm-in-scope, scope-aware cargo gate, themed stream, mid-run input, or dashboard suites.**
