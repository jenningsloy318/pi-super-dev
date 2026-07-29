# Code Assessment: Codebase Assessment — HITL Escalation (pause-ask-continue)

- **Date**: 2026-07-28
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a pure TypeScript ESM library + pi-extension ("super_dev" tool), not a server app — there is no API/UI server, PORT env, or /health path to bring up; the only "run" is `npm test` (vitest, LLM-free) or invoking the registered tool. The escalation feature fits the existing seam cleanly: (1) thread an `escalate` callback on `RunOptions` (src/types.ts:276, beside `userSteerProvider` at :318) → through `makeContext` (src/workflow.ts:108) so stages/gates can call it inline; (2) fire it inside `gate()` before the fatal throw (src/nodes.ts:436) and inside `reviewLoopUntil` where `state.__stagnated` is stamped (src/stages/verify.ts:167), generalizing the existing post-run `handleStagnation` (src/extension.ts:249); (3) the extension supplies the impl, using `ctx.hasUI` + `ctx.ui.select` (extension.ts:273,276) for interactive sessions and writing an escalation-report.md (mirror handleStagnation's report) for headless. Two corrections to the task brief: `rollbackWorktreeTo` does NOT exist in src/tracking.ts and must be authored; and `git reset --hard`/`git clean -fd` are on the safety.ts DENYLIST (src/safety.ts:35,39) — so the rollback helper must reuse tracking.ts's discrete-argv `spawnSync("git", [...])` form (NOT a shell string) to sidestep the guard, mirroring tracking.ts:27-28. The mid-run guidance store already exists and is best-effort/never-throws — the exact contract escalate must follow.

## Patterns

### RunOptions → makeContext → StageContext threading

- **Example**: src/workflow.ts:108 (makeContext) + :148 (drain) + src/types.ts:318 (userSteerProvider field) + src/extension.ts:521 (supplied by extension)
- **Consistency**: Canonical seam for all cross-cutting callbacks. `userSteerProvider` is the direct template: declared optional on RunOptions, consumed inside `realAgent` in makeContext, supplied by extension.ts which has ctx access. Thread `escalate` identically (add `escalate?` next to userSteerProvider at types.ts:318); makeContext passes it through so gates/stages read `ctx.options.escalate`.
### Best-effort / never-throws helpers (mirror for escalate + rollback + report)

- **Example**: src/render/user-notes.ts:appendUserNotes (try/catch swallow) + src/tracking.ts:13-17 ('NEVER throws. The entire begin/end body and every git op is wrapped in one try/catch')
- **Consistency**: Every pipeline-internal helper that touches the FS or git MUST degrade silently — a write/git failure must never abort a run. escalate(), rollbackWorktreeTo(), and the report write must each follow this exact try/catch-and-swallow discipline. handleStagnation already does (extension.ts:265,298).
### Discrete-argv spawnSync for git (bypasses the shell safety guard)

- **Example**: src/tracking.ts:27-28 ('Git primitives reuse the EXACT discrete-argv spawnSync shape... spawnSync("git", ["-C", wt, ...])')
- **Consistency**: All internal git ops use spawnSync with an argv array, never a shell string. This is load-bearing for escalation: `git reset --hard` and `git clean -fd` are DENYLISTED in src/safety.ts:35,39, but that guard only matches shell command strings. Build rollbackWorktreeTo with the same argv-array spawnSync form so it naturally sidesteps the guard.
### Fatal gate vs tolerant sequence (where to fire escalate on exhaustion)

- **Example**: src/nodes.ts:101 (FatalAbort class) + :436 (gate throws on exhaustion when opts.fatal) + :110 isFatalAbort + :172/:202/:550 (fatal propagates past tolerant sequences)
- **Consistency**: A `gate({fatal:true})` throws FatalAbort at nodes.ts:436. To give the user a chance BEFORE the abort propagates, fire `ctx.options.escalate?.(failure)` inline at ~line 435 (only when an escalate fn is present), await its decision, and act (retry-with-guidance → continue the loop / abandon → throw). Tolerant sequences re-throw FatalAbort, so anything not caught inline is lost — escalate must happen at the throw site, not at execute()'s catch.
### Stagnation stamping + post-run handling (generalize to inline)

- **Example**: src/stages/verify.ts:157 (reviewLoopUntil) + :167 (state.__stagnated = {...}) + src/extension.ts:249 (handleStagnation, called post-run at extension.ts:536)
- **Consistency**: Stagnation is detected INLINE (verify.ts:167) but currently only handled AFTER the run (extension.ts:536). To enable pause-and-continue, fire escalate INLINE at the stagnation point (verify.ts:167-176) so 'retry-with-guidance' can loop again rather than break. Keep handleStagnation's report-writing (extension.ts:258-269) as the headless/no-UI fallback and the model for escalation-report.md.
### Interactive detection + bounded UI prompt (mirror for escalate)

- **Example**: src/extension.ts:273 ('ctx?.hasUI === true && mode === "interactive"') + :276 (ctx.ui.select(..., { timeout: 120_000 })) wrapped in try/catch returning undefined on dismissal
- **Consistency**: Interactive gating is `ctx.hasUI === true`; the select is wrapped in try/catch so dismissal/timeout → undefined (treated as non-interactive fail-with-report). escalate's interactive path must reuse this exactly: guard on ctx.hasUI, pass a {timeout} (spec says 300_000), catch → undefined. 'Default-on' is realized by flipping getConfig().escalation default to 'interactive' when ctx.hasUI (currently the mode comes from getConfig at extension.ts:272).
### Tests are LLM-free vitest unit tests over pure functions

- **Example**: README.md:288 ('vitest — LLM-free unit tests') + src/render/dashboard.test.ts, regression-guard.test.ts, implementation.test.ts
- **Consistency**: All *.test.ts are deterministic, no real agent spawns. New escalation tests follow this: assert the escalate callback contract (interactive returns decision; headless returns undefined + report written), rollback-then-retry wiring, default-on guard, no-prompt-when-non-interactive — all via injected fakes (fake escalate fn, fake ctx.hasUI, tmp spec dir).
### ESM + explicit .ts import specifiers + strict TS

- **Example**: package.json '"type": "module"' + imports like '../types.ts' (src/stages/verify.ts:20) + 'npm run typecheck' = tsc --noEmit
- **Consistency**: All intra-project imports use the .ts extension. New code must too, and `npm run typecheck` must be strict-clean (the project treats it as a gate).

## Files Assessed

- package.json
- src/types.ts
- src/workflow.ts
- src/nodes.ts
- src/extension.ts
- src/tracking.ts
- src/render/user-notes.ts
- src/stages/verify.ts
- src/safety.ts
- README.md

## Recommendations

- Author `rollbackWorktreeTo(worktreePath, commit?)` in src/tracking.ts — it does NOT exist yet (the task brief is mistaken). Copy the discrete-argv spawnSync shape already in tracking.ts:27-28 (`spawnSync('git', ['-C', wt, 'reset','--hard', commit ?? 'HEAD'])` then `['clean','-fd']`), wrap the whole body in one try/catch that returns a {ok:boolean} verdict and NEVER throws (tracking.ts:13-17 is the template). This argv form is what keeps it off the src/safety.ts:35,39 denylist — do NOT shell out.
- Thread `escalate?: Escalate` exactly like `userSteerProvider`: add the field to RunOptions beside userSteerProvider (src/types.ts:318), pass it through makeContext (src/workflow.ts:108) so stages/gates reach it via ctx.options.escalate, and supply the implementation in extension.execute alongside the existing userSteerProvider wiring (src/extension.ts:521). The extension owns the impl because only it has ctx.ui.
- Fire escalate INLINE at the two failure sites, not at execute()'s catch — because FatalAbort (src/nodes.ts:436) and the broken loop have already lost the live context by the catch. In gate() ~line 435 (before `throw new FatalAbort`) and in reviewLoopUntil ~line 167 (where __stagnated is stamped), call `const decision = await ctx.options.escalate?.(failure)` and branch on choice: retry-with-guidance → appendUserNotes + rollbackWorktreeTo + continue the loop (resume already re-runs a thrown gate since thrown calls are uncached in createMemoizingAgent); revise-manually/abandon → throw/return failed; accept-limitation → stamp state.__acceptedLimitations and continue. Bound retries (use the gate's existing `attempts` cap, e.g. nodes.ts:408, before falling back to abandon).
- Make interactive escalation default-ON but never blocking in headless: the impl must guard `ctx.hasUI === true` (extension.ts:273) — when false (print/json/rpc/headless) write escalation-report.md and return undefined so the run fails-with-report exactly as today. For 'default-on' in TUI, resolve the mode from ctx.hasUI at the call site (or flip getConfig().escalation default) rather than requiring config. Keep handleStagnation's report-writing code as the shared headless path so informative and interactive modes both emit the report.
