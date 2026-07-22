# Specification: Verify-Loop Gating & Per-Agent Thinking Configuration

- **Date**: 2026-07-24

---

## Summary

Two independent improvements to the pi-super-dev TypeScript pipeline. (1) Harden the Stage 10 review loop and Stage 11 integration loop in src/stages/verify.ts: add test-failure stagnation/oscillation detection to the Stage 11 integrationLoopNode (GAP A), require the deterministic build gate to be green — not just review-approved — before the Stage 10 loop exits successfully (GAP B), add a non-decreasing-count convergence trigger to both stagnation detectors alongside the existing identical-signature trigger (GAP C), and run one final safety re-review at Stage 10 max-rounds exhaustion so the merge gate reads the latest fixed code (GAP D). (2) Introduce per-agent model thinking configuration: a thinkingForAgent role map in src/pi-spawn.ts, a SUPER_DEV_THINKING global env override and per-call thinking override threaded through AgentCall/workflow.ts common, wired into both the subprocess backend (buildSpawnArgs → --thinking) and the session backend (runAgentViaSession → session.setThinkingLevel). All new loop-exit paths remain non-fatal; TypeScript strict must pass and all 1387 existing tests plus new tests must be green.

## Architecture

The change spans two decoupled areas that share no files, so they are structured as two independent phases.

AREA 1 — Loop gating (src/stages/verify.ts). The existing Stage 10 machinery is: reviewApproved(s) and buildGreen(s) predicates; findingsSignature(s) producing a sorted file|severity|title signature; reviewLoopUntil(s, ctx) which pushes the signature into state.__reviewSignatures, detects a byte-identical repeat across 2 consecutive rounds → writes state.__stagnated and returns true; reviewLoopNode = loop({until: reviewLoopUntil, times: 3}, sequence([reviewStep, fixStepReview, buildGateStep])). Stage 11 integrationLoopNode is a custom Node (not loop()) that runs testBlock first, then retries fix→re-review→build→re-test up to 2 more times (3 total), exiting when testsGreen && reviewApproved.

GAP A: add testFailuresSignature(s) — sorted, stable signature over api failures (s.apiTest.failures) + ui failures (s.uiTest.failures). Inside integrationLoopNode, after each retry's test run, push the signature into state.__testSignatures; when the same non-empty signature repeats on 2 consecutive rounds, write state.__testStagnated = { rounds, signature, failures: bounded ≤12 } , log a non-fatal message, and break the retry loop early (return {status:"ok"} or {status:"failed"} non-fatally — never throw). The max-3-round cap (initial + 2 retries) is preserved exactly.

GAP B: change reviewLoopUntil so successful exit requires reviewApproved(s) AND buildGreen(s) reading state.buildGate. Return value becomes: if stagnant → true (short-circuit, non-fatal); else return reviewApproved(s) && buildGreen(s). Approved+build-red keeps looping until stagnation or the times:3 cap. Exhaustion stays non-fatal (loop simply ends).

GAP C: generalize stagnation in BOTH reviewLoopUntil and the Stage 11 detector. In addition to the identical-signature trigger, track the finding/failure COUNT per round; treat the loop as stagnant when the current non-zero count does not decrease relative to the previous round (n→n or n→n+1 scope drift). Either condition (identical signature OR non-decreasing count) triggers stagnation. A genuinely converging sequence (5→3→1) must NOT trigger. Store counts alongside signatures (e.g. state.__reviewCounts / state.__testCounts) mirroring the signature-history style.

GAP D: after reviewLoopNode runs, when it exited due to max-rounds exhaustion (not approval via reviewApproved, not stagnation via state.__stagnated), run exactly one final reviewStep (no additional fix) so state.review reflects the terminal fixed code before the downstream reviewApproved merge gate. Implement as a small wrapper Node placed after reviewLoopNode (or an epilogue inside a composed sequence) that is budget-checked (ctx.budget.check()) and non-fatal.

AREA 2 — Thinking config (src/pi-spawn.ts, src/session-agent.ts, src/workflow.ts, src/types.ts). Add THINKING_LEVELS union type ThinkingLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'. Add thinkingForAgent(agent: string): ThinkingLevel mirroring isCodeWritingAgent with role sets: REASONING_AGENTS (design, spec-writer, adversarial-reviewer, code-reviewer, debug, debugger, assessment)→'high'; CODE_WRITING (implementer, tdd-guide)→'medium'; MECHANICAL (commit, orchestrator-commit, slug summarizer, cleanup)→'minimal'/'off'; default→'medium'. Add resolveThinking(agent, perCall?): perCall override → SUPER_DEV_THINKING env override → thinkingForAgent(agent). Add optional thinking?: ThinkingLevel to SpawnAgentOptions and thinkingLevel?: ThinkingLevel to SessionAgentOptions; add thinking?: ThinkingLevel to AgentCall in types.ts and thread it into workflow.ts common (mapping call.thinking → common.thinking for subprocess and → common.thinkingLevel for session). buildSpawnArgs appends "--thinking", resolveThinking(...) to the argv. runAgentViaSession, after createAgentSession, calls session.setThinkingLevel(resolved) inside try/catch (best-effort; older runtimes may lack the method and it clamps to model capability) before session.prompt.

## Testing Strategy

Unit tests via vitest (npm test) plus strict typecheck (npx tsc --noEmit). All 1387 existing tests must remain green; new tests are additive.

LOOP GATING (verify.ts) tests — drive reviewLoopUntil and integrationLoopNode with synthetic PipelineState objects and a stub StageContext (budget.check()→true, log capture, no-op agent). GAP A: test that repeating the same non-empty api+ui failure signature across 2 rounds writes state.__testStagnated (rounds, signature, ≤12 failures), logs non-fatal, breaks before round 3, and that the 3-round cap is unchanged. GAP B: approved+build-green → reviewLoopUntil returns true (exit); approved+build-red → returns false (keep looping); stagnant → returns true regardless of build state; exhaustion non-fatal (never throws). GAP C: non-decreasing count 5→5 and 5→6 → stagnant true; converging 5→3→1 → NOT stagnant across all rounds; identical-signature trigger still fires. GAP D: on max-rounds exhaustion (not approved, no __stagnated) exactly one final reviewStep runs (assert reviewStep invoked once more, no extra fix), it is budget-checked, and non-fatal. Assert no path throws.

THINKING CONFIG tests — thinkingForAgent role mapping for each bucket (reasoning→high, implementer/tdd-guide→medium, mechanical→minimal/off, unknown→medium default). Precedence: per-call thinking override wins over SUPER_DEV_THINKING env, which wins over the role default (set/restore process.env.SUPER_DEV_THINKING around the test). buildSpawnArgs(opts, promptPath) includes "--thinking <level>" with the resolved level. Session backend: assert thinkingLevel threads through SessionAgentOptions and that a missing/throwing setThinkingLevel is tolerated (try/catch) without failing the run.

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018
- SCENARIO-019
- SCENARIO-020
- SCENARIO-021
- SCENARIO-022
- SCENARIO-023
- SCENARIO-024
- SCENARIO-025
- SCENARIO-026
- SCENARIO-027
- SCENARIO-028
- SCENARIO-029
