# Code Assessment: Codebase Assessment: Verify-Loop Gating & Per-Agent Thinking Config

- **Date**: 2025-02-14
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a self-contained TypeScript pi extension (ESM, `"type": "module"`, tsc strict) implementing a 13-stage dev pipeline over a control-flow node algebra. There is no runnable server/UI — it's a library/extension bundle; tests run via vitest (`npm test` → `vitest run`), typecheck via `npx tsc --noEmit`, build via `npm run build`. All four GAP targets live in src/stages/verify.ts and the thinking-config targets in src/pi-spawn.ts, src/session-agent.ts, src/workflow.ts, and src/types.ts. The repo already contains a near-exact template for every change: GAP A/C mirror the existing `findingsSignature`/`reviewLoopUntil`/`__stagnated`/`__reviewSignatures` machinery (verify.ts:116-138); GAP B/D reuse the existing `buildGreen` predicate (verify.ts:42-44) and `reviewStep` node (verify.ts:50-79); and the THINKING work mirrors the established role-mapping + per-call-override + env-override pattern used for `timeoutMs` (isCodeWritingAgent/defaultAgentTimeoutMs at pi-spawn.ts:46-65, AgentCall.timeoutMs at types.ts:63, threaded via `common` in workflow.ts:91-113). Follow these existing seams exactly — the code carries a heavy explanatory-comment convention that new code must match.

## Patterns

### Content-similarity stagnation detection (template for GAP A & C)

- **Example**: src/stages/verify.ts:116-138
- **Consistency**: canonical — findingsSignature() builds a sorted, joined stable signature; reviewLoopUntil() pushes it into state.__reviewSignatures[], detects 2 identical consecutive, writes a bounded state.__stagnated record + non-fatal ctx.log, and returns early. Mirror this exact shape for __testSignatures/__testStagnated over sorted api+ui failures.
### Deterministic build-gate predicate (GAP B/D)

- **Example**: src/stages/verify.ts:42-44
- **Consistency**: consistent — buildGreen(s) reads state.buildGate.pass (true unless === false). reviewApproved(s) at verify.ts:27-30. Compose these for the new AND exit condition; both are already imported/local in verify.ts.
### Custom loop node with max-3 cap + non-fatal exhaustion

- **Example**: src/stages/verify.ts:233-273
- **Consistency**: canonical — integrationLoopNode runs initial test unconditionally, then a 2-retry for-loop (3 total), returns {status:'failed'} (non-fatal) on exhaustion. Every exit path is non-fatal; never throws. Preserve the max-3 cap when adding stagnation break.
### Role-based config with per-call + env override (template for thinkingForAgent)

- **Example**: src/pi-spawn.ts:46-65
- **Consistency**: canonical — CODE_WRITING_AGENTS Set + isCodeWritingAgent() gate a role default (defaultAgentTimeoutMs); overridden per-call via AgentCall.timeoutMs (types.ts:63) threaded through workflow.ts common (workflow.ts:102). Replicate: a role→level map, a SUPER_DEV_THINKING env override, and an optional AgentCall.thinking field.
### buildSpawnArgs argv construction (subprocess backend)

- **Example**: src/pi-spawn.ts:112-135
- **Consistency**: consistent — pushes flags conditionally (e.g. `if (opts.model) args.push('--model', opts.model)`). Append `--thinking <level>` the same way; the function is deliberately extracted to be unit-testable (arrays compared directly).
### createAgentSession best-effort session tuning (session backend)

- **Example**: src/session-agent.ts:329-357
- **Consistency**: consistent — runAgentViaSession creates a session then applies best-effort seams (onSteer). Add session.setThinkingLevel(level) wrapped in try/catch after createAgentSession; thread thinkingLevel through SessionAgentOptions (interface at session-agent.ts:120-140) mirroring timeoutMs.
### env-var feature flags

- **Example**: src/workflow.ts:124 (SUPER_DEV_BACKEND) & session-agent.ts (SUPER_DEV_DEBUG)
- **Consistency**: consistent — read via process.env with `?? default`. SUPER_DEV_THINKING should follow: env override wins over role default but a per-call thinking wins over env (match timeoutMs precedence).
### vitest test style with vi.hoisted/vi.mock + fake ctx

- **Example**: src/stages/implementation.test.ts:1-30
- **Consistency**: canonical — describe/it, vi.hoisted mock state, vi.mock('../build-runner.ts', importOriginal spread), fake ctx.agent/helper/budget/log, no real spawns/disk. New verify.ts and pi-spawn.ts tests should follow this. Note: no existing verify.test.ts — create src/stages/verify.test.ts; pi-spawn has no test file yet — create src/pi-spawn.test.ts.
### Heavy explanatory-comment convention

- **Example**: src/pi-spawn.ts:112-124 & session-agent.ts:2-48
- **Consistency**: canonical — every non-trivial function has a block comment explaining WHY (often citing past failure modes). All new helpers/loops must carry equivalent rationale comments.

## Files Assessed

- package.json
- README.md
- src/stages/verify.ts
- src/pi-spawn.ts
- src/session-agent.ts
- src/workflow.ts
- src/types.ts
- src/stages/implementation.test.ts
- src/build-runner.test.ts

## Recommendations

- GAP A/C: copy the findingsSignature/reviewLoopUntil/__stagnated block (verify.ts:116-138) verbatim as a template — build a testSignature over sorted [...apiFailures, ...uiFailures], track state.__testSignatures[], and trigger stagnation on EITHER identical-consecutive-signature OR non-decreasing count across 2 rounds. Apply the same dual trigger to reviewLoopUntil (findings count 5→5 or 5→6 = stagnant; 5→3→1 must NOT trigger). Write state.__testStagnated with rounds+signature+bounded failures and a non-fatal ctx.log. Keep the max-3 cap unchanged.
- GAP B/D: change reviewLoopUntil's success return from `reviewApproved(s)` to `reviewApproved(s) && buildGreen(s)`, but keep the stagnation short-circuit returning true first (stagnant loops still exit non-fatal). For GAP D, after reviewLoopNode exits by exhaustion (not approval, not stagnation), run one final reviewStep.run (budget-checked, no additional fix, non-fatal) so state.review reflects the terminal code — likely a small wrapper node around reviewLoopNode rather than editing the loop internals.
- THINKING: add thinkingForAgent(agent) in pi-spawn.ts mirroring isCodeWritingAgent (Set-based role map → high/medium/minimal/off, default medium), with precedence per-call thinking > SUPER_DEV_THINKING env > role default. Add `thinking?` to AgentCall (types.ts:49) and SessionAgentOptions (session-agent.ts:120), thread via workflow.ts common (alongside timeoutMs at :102). Append `--thinking <level>` in buildSpawnArgs; call session.setThinkingLevel(level) in try/catch in runAgentViaSession. Unit-test the role map, both override precedences, and buildSpawnArgs argv containing --thinking.
- Verify green with `npx tsc --noEmit` then `npm test` (vitest run) — do NOT touch docs/specifications/**/change-tracker.jsonl or unrelated runtime artifacts. Keep every new loop-exit path returning a status (never throw) to preserve the tolerant-pipeline contract; match the existing heavy explanatory-comment style on all new code, and add tests in new src/stages/verify.test.ts and src/pi-spawn.test.ts following the vi.hoisted/fake-ctx pattern in implementation.test.ts.
