# Requirements: Harden Stage 10/11 Verify-Loop Gating and Add Per-Agent Model Thinking Configuration

- **Date**: 2025-06-13
- **Author**: super-dev:requirements-clarifier
- **Type**: bug-fix
- **Priority**: high
- **Status**: draft

---

## Executive Summary

The super-dev pipeline's Stage 11 integration loop lacks the stagnation/oscillation detection that Stage 10 already has, Stage 10 exits on review approval without requiring a green build gate, stagnation relies solely on byte-identical signatures (missing non-decreasing-count scope drift), and the terminal fix at loop exhaustion is left unreviewed. Additionally, spawned specialists run with no configured model thinking level. This work ports and strengthens the convergence guards across both verify loops (all exits non-fatal) and introduces per-agent thinking configuration threaded through both the subprocess and session backends, all behind unit tests with tsc clean and the existing 1387 tests preserved.

## Acceptance Criteria

- **AC-01**: GAP A: integrationLoopNode in src/stages/verify.ts computes a stable signature of current test failures (api + ui failures, sorted), tracks it across retries in state.__testSignatures, and when the same non-empty signature repeats on 2 consecutive rounds breaks early, sets state.__testStagnated (rounds, failing signature, bounded failures list ≤12), and logs a non-fatal message — mirroring the findingsSignature/reviewLoopUntil/__stagnated style. The max-3-round cap is unchanged.
- **AC-02**: GAP B: reviewLoopUntil terminates successfully only when reviewApproved(s) is true AND buildGreen(s) (reading state.buildGate) is true; approved+build-red keeps looping until stagnation or max rounds; stagnation short-circuits and exits non-fatal regardless of build state; exhaustion remains non-fatal. Tests cover approved+green→exit, approved+red→loop, stagnant→exit.
- **AC-03**: GAP C: both reviewLoopUntil and the new Stage 11 detection treat the loop as stagnant when the finding/failure COUNT fails to decrease across 2 consecutive rounds (e.g. 5→5 or 5→6), in addition to the existing identical-signature trigger; either condition triggers stagnation. Tests cover the non-decreasing-count trigger and a genuinely-converging 5→3→1 case that must NOT trigger stagnation.
- **AC-04**: GAP D: when the Stage 10 loop exits due to max-rounds exhaustion (not approval, not stagnation), exactly one final reviewStep runs (no additional fix) so state.review reflects the latest fixed code before the downstream reviewApproved merge gate reads it; this step is non-fatal and budget-checked.
- **AC-05**: THINKING CONFIG mapping: a thinkingForAgent(agent: string) function in src/pi-spawn.ts (mirroring isCodeWritingAgent) returns a pi thinking level from {off,minimal,low,medium,high,xhigh,max}: reasoning-heavy agents (design, spec-writer, adversarial-reviewer, code-reviewer, debug/debugger, assessment)→'high'; implementer/tdd-guide→'medium'; mechanical agents (commit/orchestrator commit, slug summarizer, cleanup)→'minimal' or 'off'; all others→a sane default (e.g. 'medium').
- **AC-06**: THINKING CONFIG overrides: the default level is overridable globally via SUPER_DEV_THINKING env var and per-call via an optional thinking?/thinkingLevel field on AgentCall/RunOptions threaded through workflow.ts common; per-call override takes precedence, then env override, then role default. Precedence is covered by unit tests.
- **AC-07**: THINKING CONFIG backends: buildSpawnArgs appends '--thinking <level>' using the resolved level (asserted by a unit test); runAgentViaSession in src/session-agent.ts calls session.setThinkingLevel(level) after createAgentSession, wrapped in try/catch (best-effort, tolerant of missing method / capability clamping) before prompting, with an optional thinkingLevel threaded through SessionAgentOptions.
- **AC-08**: Verification & safety: npx tsc --noEmit passes with 0 errors under strict mode, npm test passes with all 1387 existing tests plus the new tests green, every new loop-exit path is non-fatal (never throws to abort the tolerant pipeline), the existing heavy explanatory-comment convention is followed, and no unrelated runtime artifacts (e.g. docs/specifications/**/change-tracker.jsonl) are modified.

## Non-Functional Requirements

- Reliability/Tolerance: all four verify-loop changes and both thinking-config backends must be strictly non-fatal — setThinkingLevel is best-effort try/catch, loop exits never throw, and budget checks gate the added Stage 10 final re-review.
- Backward compatibility: preserve existing behavior and all 1387 passing vitest tests; the max-3-round caps in both stages remain unchanged; new state keys (__testSignatures, __testStagnated) are additive.
- Type safety: TypeScript strict mode must compile with zero errors (npx tsc --noEmit); new options (thinking?/thinkingLevel) are optional and thread through the shared common options object feeding both backends.
- Maintainability: mirror the exact style of the existing findingsSignature/reviewLoopUntil/__stagnated code and the isCodeWritingAgent role pattern; retain the repo's heavy explanatory-comment convention.
- Observability: stagnation/oscillation and exhaustion paths emit clear non-fatal log messages including round counts and bounded failure lists for post-run diagnosis.

## Open Questions

- For mechanical agents, should the level be 'minimal' or 'off'? (Spec allows either — recommend 'minimal' to retain minimal reasoning while keeping cost low.)
- Should SUPER_DEV_THINKING be validated against the allowed level enum (rejecting/ignoring invalid values) or passed through verbatim to pi? Recommend validating and falling back to the role default on an unrecognized value.
- Does the current pi runtime's session API expose setThinkingLevel, or must the try/catch fully absorb a missing method on all supported runtimes? Recommend treating absence as a no-op (best-effort) and asserting only the call attempt in tests.
- Should the Stage 11 __testStagnated bounded failures list use the same cap (12) as Stage 10's __stagnated findings slice for consistency? Recommend yes.
