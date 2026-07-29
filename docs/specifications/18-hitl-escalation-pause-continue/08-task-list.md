# Task List — HITL Escalation (pause-ask-continue)

- **Spec**: 18-hitl-escalation-pause-continue
- **Date**: 2026-07-28
- **Author**: super-dev:spec-writer
- **Reference**: 06-technical-specification.md (§), 07-implementation-plan.md (phases)

Task IDs: `P<phase>.T<seq>.<domain>`. Each task lists exact files to create/modify and the acceptance it serves.

Legend — `create` / `modify` / `extend` / `verify`. All paths relative to repo root. All intra-project imports use the `.ts` extension.

---

## Phase 1 — Primitives (types + rollback helper)

### P1.T1.types — Add escalation types to `src/types.ts`  (AC-01, SCENARIO-001/002)
- **Files:** `modify src/types.ts`
- **Action:** Immediately above the `RunOptions` interface (src/types.ts:276) add the type block from spec §3.1 verbatim: `EscalationKind` (`"stagnation" | "gate-exhaustion" | "design-conflict"`), `EscalationSeverity` (`"soft" | "hard"`), `EscalationFinding` (`{file?, severity?, title?}`), `EscalationFailure` (`{kind, stage?, message, specDirectory?, worktreePath?, findings?, severity?}`), `EscalationChoice` (union of 4), `EscalationDecision` (`{choice, guidance?}`), `Escalate = (failure: EscalationFailure) => Promise<EscalationDecision | undefined>`.
- **Done when:** `npm run typecheck` compiles with the new exports; no behavior change.

### P1.T2.types — Add `RunOptions.escalate`  (AC-01, SCENARIO-002)
- **Files:** `modify src/types.ts`
- **Action:** Add `escalate?: Escalate;` to the `RunOptions` interface beside `userSteerProvider?: () => string[]` (src/types.ts:318). Confirm `StageContext.options: RunOptions` (src/types.ts:196) already exposes it — **do NOT edit src/workflow.ts** (threading is automatic).
- **Done when:** `ctx.options.escalate` typechecks inside nodes.ts/verify.ts.

### P1.T3.tracking — Author `rollbackWorktreeTo`  (AC-05/AC-10, SCENARIO-010/012)
- **Files:** `modify src/tracking.ts`
- **Action:** Add spec §7.1 verbatim. Signature: `export function rollbackWorktreeTo(worktreePath: string | undefined, commit: string = "HEAD"): { ok: boolean; error?: string }`. Body: `spawnSync("git", ["-C", worktreePath, "reset", "--hard", commit], { encoding:"utf8", timeout: resolveTimeoutMs() })` then `["clean", "-fd"]`; one try/catch returning `{ok:false, error}` on any failure; never throws. Reuse `resolveTimeoutMs` from `./build-runner.ts` (already imported in tracking.ts). **Never use `shell:true`** (safety.ts denylist bypass).
- **Done when:** helper exists, typechecks, and is exported.

### P1.T4.test — Extend `src/tracking.test.ts` for rollback  (AC-11, SCENARIO-024)
- **Files:** `extend src/tracking.test.ts`
- **Action:** Add tests: (a) `rollbackWorktreeTo` resets a dirty temp git repo (modified + untracked file) to HEAD → `{ok:true}` and tree is clean; (b) on a non-git/missing path → `{ok:false}` and never throws; (c) asserts the spawn argv form (no `shell:true`).
- **Done when:** `npm test src/tracking.test.ts` green.

**Phase 1 gate:** `requireContains` types.ts (`export type Escalate =`, `escalate\?:\s*Escalate`), tracking.ts (`export function rollbackWorktreeTo`, `"clean",\s*"-fd"`); `requireTests` rollback reset + no-throw.

---

## Phase 2 — Escalate plumbing + extension impl + report

### P2.T1.render — Author `src/render/escalation-report.ts`  (AC-07, SCENARIO-016/017)
- **Files:** `create src/render/escalation-report.ts`
- **Action:** Implement spec §8.2. `export async function writeEscalationReport(specDirectory, failure, decision?): Promise<void>` — mkdir recursive + `writeFileSync(join(specDir, "escalation-report.md"), body)`; never throws (try/catch swallow). `renderEscalationReportBody(failure, decision)` returns a markdown string: title, `kind`/`stage`/`message`, `findings` table (if any), `decision.choice` (if any), and "what to change" bullets for `revise-manually`. Import `EscalationFailure`/`EscalationDecision` from `../types.ts`. Subsumes `handleStagnation`'s `stagnation-report.md` body (stagnation → same report with `kind:"stagnation"`).
- **Done when:** module exists, exports both functions, typechecks.

### P2.T2.escalation — Author `src/escalation.ts` helpers  (AC-05/AC-09/AC-10, SCENARIO-010/020/022)
- **Files:** `create src/escalation.ts`
- **Action:** Implement spec §8.1 + §7.3. (1) `export const ESCALATION_RETRY_CAP = 2;`. (2) `export function escalationBudgetRemaining(state, key, cap = ESCALATION_RETRY_CAP): number` — reads `state.__escalationRetries[key] ?? 0`, returns `max(0, cap - used)`, never throws. (3) `export async function runEscalation(state, ctx, key, failure, cap = ESCALATION_RETRY_CAP): Promise<EscalationDecision | undefined>` — guards `ctx.options?.escalate` presence, budget, increments counter on `state.__escalationRetries`, calls escalate, try/catch → `undefined`. (4) `export async function applyRetryDecision(state, decision): Promise<void>` — `rollbackWorktreeTo(state.setup?.worktreePath)` + `appendUserNotes(state.setup?.specDirectory, [decision.guidance ?? ""])`, never throws. Import `rollbackWorktreeTo` from `./tracking.ts`, `appendUserNotes` from `./render/user-notes.ts`, types from `./types.ts`.
- **Done when:** module exists, all four exports typecheck.

### P2.T3.extension — Author `makeEscalate(ctx)` in `src/extension.ts`  (AC-02/AC-06/AC-08/AC-10, SCENARIO-003/015/018/022)
- **Files:** `modify src/extension.ts`
- **Action:** Implement spec §4.2 verbatim. `function makeEscalate(ctx): Escalate` returns an async fn that: (1) `writeEscalationReport(failure.specDirectory, failure, undefined)` (fire-and-forget `.catch(()=>{})`); (2) `interactive = ctx?.hasUI === true && getConfig().escalation !== "informative"`; (3) if not interactive → `return undefined`; (4) build choices array: `retry-with-guidance`, `revise-manually`, (`accept-limitation` only when `failure.severity !== "hard"`), `abandon`; (5) `await ctx.ui.select("super-dev hit a blocker — " + failure.message, choices, { timeout: 300_000 })`; (6) dismissal/timeout (`!select`) → `undefined`; (7) `retry-with-guidance` → `await ctx.ui.input("What guidance should the next attempt follow?", { timeout: 300_000 })` → `{choice, guidance}`; (8) whole body in try/catch → `undefined`. Import `writeEscalationReport` from `./render/escalation-report.ts`, `Escalate`/`EscalationChoice`/`EscalationFailure` from `./types.ts`, `getConfig` already imported.
- **Done when:** function exists, typechecks, wired (P2.T4).

### P2.T4.extension — Wire `escalate` into `runPipelineTask`  (AC-02, SCENARIO-003)
- **Files:** `modify src/extension.ts`
- **Action:** At the `runPipelineTask(task, {...})` call (src/extension.ts:509), add `escalate: makeEscalate(ctx),` beside the existing `userSteerProvider: () => getActiveRun()?.drain() ?? [],` (src/extension.ts:521).
- **Done when:** the supplied options object contains `escalate`; typechecks.

### P2.T5.extension — Generalize `handleStagnation` report-writing  (AC-07, SCENARIO-016)
- **Files:** `modify src/extension.ts`
- **Action:** At `handleStagnation` (src/extension.ts:249), replace the inline `stagnation-report.md` write (~:258–269) with a call to `writeEscalationReport(summary.specDirectory, failure, decision)` where `failure = {kind:"stagnation", stage:"verify", message:..., specDirectory: summary.specDirectory, findings:...}`. Keep the post-run invocation at src/extension.ts:536 unchanged so the post-run report still emits. (Backward compat: if a `stagnation-report.md` alias is desired, write it too — best-effort.)
- **Done when:** `handleStagnation` delegates to `writeEscalationReport`; existing stagnation tests still pass.

### P2.T6.test — Impl / report / escalation helper tests  (AC-11, SCENARIO-024)
- **Files:** `create src/render/escalation-report.test.ts`, `create src/escalation.test.ts`, `create src/extension.escalation.test.ts`
- **Action:**
  - **escalation-report.test.ts:** writes `escalation-report.md` to a tmp spec dir; body contains `kind`/`stage`/`message` + decision; never throws on an unwritable dir (chmod/stub).
  - **escalation.test.ts:** `escalationBudgetRemaining` decrements per key and floors at 0; `runEscalation` returns `undefined` when no `escalate` on options, when budget is 0, and when a fake escalate throws; `applyRetryDecision` calls `rollbackWorktreeTo` (spy) + `appendUserNotes` (assert `.user-notes.json` gains the guidance).
  - **extension.escalation.test.ts:** fake `ctx` with `hasUI:true` + `ui.select`/`ui.input` returning values → `makeEscalate` returns an `EscalationDecision`; `hasUI:false` → returns `undefined` AND `escalation-report.md` exists; `ui.select` throwing → `undefined`; `retry-with-guidance` → `ui.input` called; `accept-limitation` absent from choices when `severity:"hard"`.
- **Done when:** `npm test` for the three files green.

**Phase 2 gate:** `requireFiles` src/escalation.ts, src/render/escalation-report.ts + the three test files; `requireContains` runEscalation, ESCALATION_RETRY_CAP, writeEscalationReport, `escalate:\s*makeEscalate`, `ctx\.ui\.select`; impl tests green.

---

## Phase 3 — Firing points + bounded recovery

### P3.T1.nodes — Gate firing point in `src/nodes.ts`  (AC-03/AC-05/AC-06/AC-09, SCENARIO-004/005/006/010/013/014/020/021)
- **Files:** `modify src/nodes.ts`
- **Action:** In `gate()` (src/nodes.ts:395), wrap the existing attempt loop in an outer escalation loop (`for (let escAttempt = 0; escAttempt <= ESCALATION_RETRY_CAP; escAttempt++)`). At the exhaustion site (src/nodes.ts:435–436, after `ctx.log("gate: EXHAUSTED...")`), when `ctx.options?.escalate` is present and `escalationBudgetRemaining(state, opts.feedbackKey ?? "gate") > 0`: build `failure = {kind:"gate-exhaustion", stage: opts.feedbackKey, message: msg, specDirectory: state.setup?.specDirectory, worktreePath: state.setup?.worktreePath, severity: opts.fatal ? "hard" : "soft"}`; `const decision = await runEscalation(state, ctx, opts.feedbackKey ?? "gate", failure);`; branch: `retry-with-guidance` → `await applyRetryDecision(state, decision)` + `continue` (re-run attempt loop); `accept-limitation` (soft only) → stamp `state.__acceptedLimitations` + `return {status:"ok", attempts:max, accepted:true}`; `revise-manually` → `return {status:"failed", error: msg + " (user chose revise-manually)", attempts:max}`; `abandon`/`undefined` → fall through to original `if (opts.fatal) throw new FatalAbort(msg)`. Import `runEscalation`, `applyRetryDecision`, `ESCALATION_RETRY_CAP`, `escalationBudgetRemaining` from `./escalation.ts`; `EscalationFailure` from `./types.ts`. Use `(state as Record<string, unknown>).__acceptedLimitations` cast pattern.
- **Done when:** gate typechecks; with no `escalate` on options, behavior is byte-identical to today.

### P3.T2.verify — Review stagnation firing point  (AC-04/AC-06, SCENARIO-007/008/009/013)
- **Files:** `modify src/stages/verify.ts`
- **Action:** At `reviewLoopUntil` (src/stages/verify.ts:157), at the stagnation-stamp point (:167), implement spec §6.2 verbatim: before stamping/returning `true`, if `escalationBudgetRemaining(s, "verify-review") > 0`, call `runEscalation(s, ctx, "verify-review", {kind:"stagnation", stage:"verify-review", message:`Verify review loop stagnant after ${rounds} round(s)`, specDirectory, worktreePath, findings: currentFindings, severity:"soft"})`; `retry-with-guidance` → `applyRetryDecision` + `delete s.__stagnated` + `return false` (loop continues); `accept-limitation` → stamp `s.__acceptedLimitations` (`"verify-review-stagnation"`) + `return true`; else → original stamp + `return true`. Imports same as P3.T1.
- **Done when:** `reviewLoopUntil` typechecks; with no `escalate`, original break behavior unchanged.

### P3.T3.verify — Integration stagnation firing point  (AC-04/AC-06, SCENARIO-007/008/009/014)
- **Files:** `modify src/stages/verify.ts`
- **Action:** Mirror P3.T2 at `recordTestStagnation()` / the `__testStagnated` stamp (src/stages/verify.ts:329). Key/stage = `"verify-integration"`. On `retry-with-guidance` → `applyRetryDecision` + `return false`/continue the integration loop (do not break at :346/:364); on `accept-limitation` → stamp `"verify-integration-stagnation"` + break; else original break. `message:`Integration testing stagnant across rounds``.
- **Done when:** integration-loop site typechecks; with no `escalate`, original break unchanged.

### P3.T4.test — Firing-point tests  (AC-11, SCENARIO-024)
- **Files:** `create src/nodes.escalation.test.ts`, `create src/stages/verify.escalation.test.ts`
- **Action:**
  - **nodes.escalation.test.ts:** build a `gate({fatal:true})` over a failing validate; inject fake `escalate` on options. `retry-with-guidance` (with guidance text) → the gate re-runs its attempt loop AND the guidance appears in `.user-notes.json`; `abandon` → throws `FatalAbort` (`isFatalAbort` true); `accept-limitation` NOT in choices when `severity:"hard"`; after `ESCALATION_RETRY_CAP` retries the fake escalate is no longer called and the original throw fires (bounded).
  - **verify.escalation.test.ts:** `reviewLoopUntil` with fake `escalate` returning `retry-with-guidance` → returns `false` (continues) and `__stagnated` is cleared; `accept-limitation` → stamps `__acceptedLimitations`; `undefined` → returns `true` (original break). Mirror one assertion for the integration-loop path.
- **Done when:** `npm test` for both files green.

**Phase 3 gate:** `requireContains` nodes.ts (`runEscalation`, `gate-exhaustion`), verify.ts (`kind:\s*"stagnation"`, `verify-integration`); firing-point tests green.

---

## Phase 4 — Hardening + release

### P4.T1.docs — CHANGELOG `[Unreleased]` `### Added` entry  (AC-12, SCENARIO-025)
- **Files:** `modify CHANGELOG.md`
- **Action:** Add a concise bullet under the existing `## [Unreleased]` → `### Added` (CHANGELOG.md:8/10) in Keep-a-Changelog style, mirroring the spec-NN anchor convention used by prior entries. Content: HITL pause-ask-continue escalation; two firing points (fatal-gate exhaustion, verify-loop stagnation); default-on interactive in TUI/RPC (`ctx.hasUI`), headless report-only; bounded retry cap (2); never-throw / strictly additive; `escalate` callback on `RunOptions`.
- **Done when:** entry exists under `[Unreleased]`/`### Added`.

### P4.T2.verification — `npm run typecheck` strict-clean  (AC-12, SCENARIO-025)
- **Files:** `verify`
- **Action:** Run `npm run typecheck` (tsc --noEmit). Fix any strict errors: `.ts` import specifiers on new modules, `unknown` casts for `state.__escalationRetries` / `state.__acceptedLimitations`, the `ExtensionCtx`/`ctx` typing in `makeEscalate`.
- **Done when:** exit 0, no diagnostics.

### P4.T3.verification — Full `npm test` green  (AC-11/AC-12, SCENARIO-024/025)
- **Files:** `verify`
- **Action:** Run `npm test`. Ensure all new tests pass and no existing test regresses. Pay attention to: any test asserting today's silent-fail (update to the additive report+fail path); `handleStagnation`-related tests (report still emitted via the generalized writer); tracking tests (rollback added without breaking existing ChangeTracker tests).
- **Done when:** full suite green.

### P4.T4.verification — Regression sweep  (AC-07/AC-08)
- **Files:** `verify`
- **Action:** Manual/automated confirm: (a) a headless run produces `escalation-report.md` and returns `isError` exactly as before (no new prompt, no new throw); (b) `stagnation-report.md`/`handleStagnation` backward-compat report still emits; (c) no prompt can fire when `ctx.hasUI === false`.
- **Done when:** all three confirmations hold.

**Phase 4 gate:** `requireContains` CHANGELOG.md (`escalat`, `\[Unreleased\]`); `npm run typecheck` exit 0; `npm test` green.

---

## Summary — File Inventory

### CREATE (7)
- `src/escalation.ts`
- `src/render/escalation-report.ts`
- `src/escalation.test.ts`
- `src/render/escalation-report.test.ts`
- `src/extension.escalation.test.ts`
- `src/nodes.escalation.test.ts`
- `src/stages/verify.escalation.test.ts`

### MODIFY (6)
- `src/types.ts` (P1.T1, P1.T2)
- `src/tracking.ts` (P1.T3)
- `src/tracking.test.ts` (P1.T4 — extend)
- `src/extension.ts` (P2.T3, P2.T4, P2.T5)
- `src/nodes.ts` (P3.T1)
- `src/stages/verify.ts` (P3.T2, P3.T3)
- `CHANGELOG.md` (P4.T1)

### DELETE (0)
- None.

### Unchanged (verified)
- `src/workflow.ts` — NO edit (threading is automatic via `StageContext.options: RunOptions`).
- `src/render/user-notes.ts` — REUSE (`appendUserNotes`, `userNotesForAgent`).
- `src/safety.ts` — NO edit (discrete-argv spawnSync bypasses the denylist).

---

## AC / Scenario Coverage Trace

| AC | Tasks |
|---|---|
| AC-01 | P1.T1, P1.T2 |
| AC-02 | P2.T3, P2.T4 |
| AC-03 | P3.T1 |
| AC-04 | P3.T2, P3.T3 |
| AC-05 | P1.T3, P2.T2, P3.T1, P3.T2 |
| AC-06 | P2.T3, P3.T1, P3.T2, P3.T3 |
| AC-07 | P2.T1, P2.T5 |
| AC-08 | P2.T3 |
| AC-09 | P2.T2, P3.T1 |
| AC-10 | P1.T3, P2.T1, P2.T2, P2.T3 |
| AC-11 | P1.T4, P2.T6, P3.T4 |
| AC-12 | P4.T1, P4.T2, P4.T3 |

| Scenario range | Covered by phase |
|---|---|
| SCENARIO-001/002 (types) | P1 |
| SCENARIO-003 (impl) | P2 |
| SCENARIO-004/005/006 (gate) | P3 |
| SCENARIO-007/008/009 (stagnation) | P3 |
| SCENARIO-010/011/012 (rollback+retry) | P1+P2+P3 |
| SCENARIO-013/014/015 (choices) | P2+P3 |
| SCENARIO-016/017 (report) | P2 |
| SCENARIO-018/019 (default-on) | P2 |
| SCENARIO-020/021 (bounded) | P2+P3 |
| SCENARIO-022/023 (no-throw) | P1+P2 |
| SCENARIO-024 (tests) | P1+P2+P3 |
| SCENARIO-025 (green+changelog) | P4 |
