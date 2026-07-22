# Code Review: Code Review — Verify-Loop Gating & Per-Agent Thinking Config (Task 13)

- **Date**: 2026-07-22
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation fully satisfies all four verify-loop gaps (A/B/C/D) and the Phase 2 thinking-configuration requirements against the specification. GAP A adds testFailuresSignature + __testStagnated detection to the Stage 11 integrationLoopNode, mirroring the existing findingsSignature/__stagnated style and preserving the max-3-round cap. GAP B changes reviewLoopUntil to require reviewApproved(s) AND buildGreen(s) for a successful exit, while stagnation and exhaustion remain non-fatal. GAP C introduces a shared detectStagnation helper providing both the identical-signature trigger and the new non-decreasing-count trigger (n→n or n→n+1 scope drift), correctly leaving a converging 5→3→1 sequence untriggered. GAP D adds reviewStageNode — a budget-checked, try/catch-wrapped final reviewStep on max-rounds exhaustion — and it is correctly wired into the pipeline replacing reviewLoopNode so the downstream reviewApproved merge gate reads terminal code. Phase 2 adds ThinkingLevel/thinkingForAgent role map, resolveThinking precedence (per-call → SUPER_DEV_THINKING env → role default), a --thinking append in buildSpawnArgs, and a best-effort applyThinkingLevel(session.setThinkingLevel) in the session backend, threaded through AgentCall/types.ts and workflow.ts common. Verification is green: `npx tsc --noEmit` produces 0 errors and the 20 targeted new tests (14 thinking-config + 6 verify-loop-gating) pass. All new loop-exit paths are non-fatal and consistent with the pre-existing exhaustion return contract. Coverage across dimensions is strong; only minor Low-severity robustness observations were found, none of which block approval.

## Findings

### F1: GAP D: approved-but-build-red at exhaustion skips the final re-review

- **Severity**: Low
- **File**: `src/stages/verify.ts`
- **Line**: 196
reviewStageNode gates the final safety re-review on `!reviewApproved(state) && !stagnated`. After GAP B, reviewLoopUntil returns false whenever the build is red even if the review verdict is Approved, so the loop can reach max-rounds exhaustion in an approved+build-red state. In that case reviewApproved(state) is true, so the GAP D epilogue is skipped and no final reviewStep runs. This is defensible (a re-review would not change the already-approved verdict, and the downstream merge gate reads reviewApproved which is already fresh-ish), but it means the terminal fix produced by the last fixStep is not re-reviewed in this specific corner. Consider basing the epilogue trigger on the loop's actual exit reason rather than re-deriving reviewApproved, if strict 'terminal fix always re-reviewed' semantics are desired.
### F2: SUPER_DEV_THINKING env override is case-sensitive and silently ignored on mismatch

- **Severity**: Low
- **File**: `src/pi-spawn.ts`
- **Line**: 91
asThinkingLevel narrows only exact lowercase matches against THINKING_LEVELS. A user setting SUPER_DEV_THINKING=HIGH or 'High' gets no override (falls through to the role default) with no warning. Given this is an operator-facing env knob, a case-insensitive compare (value.toLowerCase()) and/or a one-line log when an unrecognized value is provided would reduce silent-misconfiguration surprise. Functionally correct for the documented lowercase values; low impact.
### F3: Stage 11 stagnation never triggers when tests fail but expose no structured failures

- **Severity**: Low
- **File**: `src/stages/verify.ts`
- **Line**: 296
recordTestStagnation relies on testFailuresSignature (empty string when no api/ui failures) and testFailureCount (0 when failures arrays are empty). If a test run reports not-green (testsGreen false via pass flags) yet carries empty failures arrays, sig=='' skips the identical trigger and count==0 skips the `cur>0` count trigger, so stagnation is never recorded and the loop simply runs to the max-3 cap. This mirrors the intentional findingsSignature '' behavior and remains non-fatal, so it is acceptable, but worth noting that oscillation detection only engages when structured failure records are present.
### F4: Non-fatal contract preserved: stagnation returns status 'failed' consistent with existing exhaustion path

- **Severity**: Info
- **File**: `src/stages/verify.ts`
- **Line**: 352
Stage 11 stagnation short-circuits with `return { status: 'failed', error: 'integration testing stagnated (non-fatal)' }`, matching the pre-existing max-retries-exhausted return which also uses status 'failed' and is treated as non-fatal by the tolerant workflow runner. No throw is introduced on any new loop-exit path (reviewStageNode wraps reviewStep in try/catch; detectStagnation is pure). This satisfies the 'never throw to abort the tolerant pipeline' constraint. No action required.
### F5: Coverage confirmed: tsc clean and 20 new tests green; thinking config threaded through both backends

- **Severity**: Info
- **File**: `src/pi-spawn.ts`
- **Line**: 181
Verified `npx tsc --noEmit` returns 0 errors and tests/thinking-config.test.ts (14) + tests/verify-loop-gating.test.ts (6) all pass. buildSpawnArgs appends `--thinking <resolved>`; session-agent.ts calls applyThinkingLevel(session, resolveThinking(agent, thinkingLevel)) after createAgentSession guarded by try/catch; AgentCall.thinking is threaded into workflow.ts common as both `thinking` (subprocess) and `thinkingLevel` (session). Role map matches the spec (reasoning agents→high, code writers→medium, mechanical→minimal, default→medium) and precedence per-call→env→role is implemented in resolveThinking. Existing predicates reviewApproved/buildGreen are correctly reused for GAP B. Reported as coverage confirmation, not a defect.
