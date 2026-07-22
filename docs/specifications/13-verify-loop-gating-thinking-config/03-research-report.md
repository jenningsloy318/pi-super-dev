# Research Report: Deep Research: Verify-Loop Gating Convergence & Per-Agent Thinking Config for pi-super-dev

- **Date**: 2025-02-14
- **Author**: super-dev:research-agent

---

## Summary

Deep-research pass resolving the four open issues from the prior report by reading the actual source. All four are now resolved: (ISS-001) pi runtime confirms subprocess `--thinking <level>` and session `setThinkingLevel(level)` with levels {off,minimal,low,medium,high,xhigh,max}, clamped to model capability — justifying best-effort try/catch [SRC-001,SRC-002]. (ISS-002) verify.ts stores Stage 11 failures at `s.apiTest.failures` and `s.uiTest.failures` (arrays of records); the correct testSignature mirrors the existing `findingsSignature` (map each failure to a stable `file|test|message` key, `.sort()`, `.join("\n")`) and `__testStagnated.failures` must use `slice(0,12)` to match the `__stagnated` convention [SRC-003]. (ISS-003) workflow.ts already threads per-call optional fields into `common` (e.g. `timeoutMs: call.timeoutMs`), so adding `thinking: call.thinking` alongside an env fallback is strictly additive and preserves the 1387-test baseline and strict-tsc [SRC-004]. (ISS-004) `reviewLoopUntil` returns true both on stagnation (which sets `state.__stagnated`) and on `reviewApproved`; the post-loop exhaustion discriminator is therefore `!reviewApproved(s) && !state.__stagnated`, on which exactly one final `reviewStep` (no fix) runs, non-fatal and budget-checked [SRC-003]. Best practices: mirror the existing `findingsSignature`/`reviewLoopUntil`/`__stagnated` style exactly, keep every new loop-exit path non-fatal, and make the thinking field additive-only with precedence per-call > SUPER_DEV_THINKING env > role default.

## Options Considered

### Stagnation signature: reuse findingsSignature pattern (map|sort|join) for Stage 11 test failures

PRO: byte-for-byte consistency with the proven Stage 10 `__stagnated` mechanism; stable across retries; easy to unit test. CON: relies on failure records exposing stable file/test/message fields — must read exact shape from verify.ts (confirmed: `s.apiTest.failures`/`s.uiTest.failures`). RECOMMENDED — sort by `file|test|message`, cap `__testStagnated.failures` at slice(0,12).
### Dual convergence trigger: identical-signature OR non-decreasing-count

PRO: catches both oscillation (same findings) and scope-drift (5→5 or 5→6 expansion) that a pure content-hash misses; converging 5→3→1 correctly does NOT trip. CON: two conditions increase test surface. RECOMMENDED per GAP C — either condition sets stagnation; add explicit tests for the non-decreasing trigger and the converging counter-case.
### Build-gate AND approval exit (GAP B) with exhaustion re-review (GAP D)

PRO: prevents premature exit on approved+build-red; the terminal fix is re-reviewed exactly once on the exhaustion path so `state.review` is fresh before the merge gate. CON: extra reviewStep costs budget/time (mitigated by budget.check()). RECOMMENDED — exhaustion discriminator = `!reviewApproved && !__stagnated`; never re-trigger a fix; all paths non-fatal.
### Thinking config: additive `thinking?` on AgentCall + SUPER_DEV_THINKING env + role map

PRO: strictly additive (mirrors existing `timeoutMs` threading through `common`), preserves 1387-test/strict-tsc baseline; precedence per-call > env > role default is deterministic and testable. Session backend wraps `setThinkingLevel` in try/catch for capability clamping/older runtimes. CON: role map must be maintained as agents are added. RECOMMENDED — reasoning-heavy→'high', implementer/tdd-guide→'medium', mechanical→'minimal'/'off', default 'medium'.
