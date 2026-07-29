# Implementation Plan — HITL Escalation (pause-ask-continue)

- **Spec**: 18-hitl-escalation-pause-continue
- **Date**: 2026-07-28
- **Author**: super-dev:spec-writer
- **Reference**: 06-technical-specification.md (§ for every detail)

---

## Phasing Philosophy

Four coarse, independently-shippable phases, sequenced as a dependency chain (1 → 2 → 3 → 4). Each phase is **independently testable** with a clear deliverable. Phases are deliberately coarse: every file a phase touches is committed within that phase, so a phase is never left half-wired (the documented cascade-failure mode for granular interdependent phases). A phase compiles green only when its deliverable actually exists.

- **Phase 1 — Primitives:** pure types + the rollback helper. No pipeline behavior change. Testable against a temp git repo.
- **Phase 2 — Escalate plumbing + extension impl + report:** thread `escalate` (free, via `ctx.options`), author the extension's never-throw impl + the always-written report. Testable with injected fakes (no firing points yet).
- **Phase 3 — Firing points + bounded recovery:** wire the gate (nodes.ts) and stagnation (verify.ts) firing points + bounded budget + recovery branches. Testable with injected fake `escalate`.
- **Phase 4 — Hardening + release:** CHANGELOG entry, full `npm run typecheck` strict-clean, full `npm test` green.

**Parallelism:** Phases 1 and 2 share no files except `src/types.ts` (Phase 1 adds the type, Phase 2 adds nothing to types). They could overlap, but because Phase 2's impl references the Phase-1 `Escalate` type, the chain is safer. Phase 3 depends on both. Phase 4 is the convergence gate. Net: sequential chain; no parallel fan-out (the feature is a single cohesive seam).

---

## Phase 1 — Primitives (types + rollback helper)

- **Goal:** Ship the pure additions every later phase depends on, with zero pipeline behavior change.
- **Depends on:** nothing.
- **Parallelizable with:** nothing (foundational).
- **Testable in isolation:** YES — types compile; `rollbackWorktreeTo` exercises a temp git repo via mocked/injected spawnSync.

### Tasks

1. **Add escalation types to `src/types.ts`** (`domain: types`). Add `EscalationKind`, `EscalationSeverity`, `EscalationFinding`, `EscalationFailure`, `EscalationChoice`, `EscalationDecision`, `Escalate` (verbatim from spec §3.1) immediately above the `RunOptions` interface (:276).
2. **Add `RunOptions.escalate`** (`domain: types`). Add `escalate?: Escalate;` beside `userSteerProvider?: () => string[]` (:318). Verify `StageContext.options: RunOptions` (:196) already exposes it — no `workflow.ts` edit.
3. **Author `rollbackWorktreeTo` in `src/tracking.ts`** (`domain: tracking`). Implement spec §7.1 verbatim: discrete-argv `spawnSync("git", ["-C", worktreePath, "reset","--hard", commit])` then `["clean","-fd"]`, `resolveTimeoutMs` envelope, one try/catch returning `{ok:boolean, error?}`, never throws.
4. **Extend `src/tracking.test.ts`** (`domain: test`). Add `rollbackWorktreeTo` tests: resets a dirty temp git repo + removes untracked files → `{ok:true}`; non-git dir → `{ok:false}` no-throw; asserts argv form (no `shell:true`).

### Deliverables (phase gate)
- `requireFiles`: `src/escalation.ts` is NOT in this phase (moved to Phase 2). Files: edits to `src/types.ts`, `src/tracking.ts`, `src/tracking.test.ts`.
- `requireContains`:
  - { file: "src/types.ts", pattern: "export type Escalate =" }
  - { file: "src/types.ts", pattern: "escalate\\?:\\s*Escalate" }
  - { file: "src/tracking.ts", pattern: "export function rollbackWorktreeTo" }
  - { file: "src/tracking.ts", pattern: "\"clean\",\\s*\"-fd\"" }
- `requireTests`: [ "rollbackWorktreeTo resets a dirty git worktree", "rollbackWorktreeTo never throws on a non-git dir" ]

---

## Phase 2 — Escalate plumbing + extension impl + report

- **Goal:** Make `ctx.options.escalate` actually DO something (interactive prompt or headless report), entirely best-effort, WITHOUT yet firing it from gates/stages.
- **Depends on:** Phase 1 (the `Escalate` type + `rollbackWorktreeTo`).
- **Parallelizable with:** Phase 1's tests (but not its type edits).
- **Testable in isolation:** YES — the impl is a pure function of `(ctx, failure)`; tests inject a fake `ctx` (`hasUI`, `ui.select`/`input` throwing/returning) and a tmp spec dir. No gate/stage changes.

### Tasks

1. **Author `src/render/escalation-report.ts`** (`domain: render`). Implement spec §8.2: `writeEscalationReport(specDir, failure, decision?)` (mkdir + writeFileSync, never-throws) and `renderEscalationReportBody(failure, decision)` (markdown: kind/stage/message/findings/decision/next-steps).
2. **Author `src/escalation.ts` helpers** (`domain: escalation`). Implement spec §8.1 + §7.3: `ESCALATION_RETRY_CAP = 2`, `escalationBudgetRemaining(state, key, cap)`, `runEscalation(state, ctx, key, failure, cap)` (guards callback presence + budget + try/catch → `undefined`), `applyRetryDecision(state, decision)` (rollbackWorktreeTo + appendUserNotes, never-throws).
3. **Author `makeEscalate(ctx)` in `src/extension.ts`** (`domain: extension`). Implement spec §4.2 verbatim: always `writeEscalationReport`; `interactive = ctx.hasUI === true && getConfig().escalation !== "informative"`; `ctx.ui.select` (300_000 ms timeout) + `ctx.ui.input` for `retry-with-guidance`; `accept-limitation` omitted when `failure.severity === "hard"`; try/catch → `undefined`.
4. **Wire `escalate` into `runPipelineTask`** (`domain: extension`). At src/extension.ts:509, add `escalate: makeEscalate(ctx)` beside `userSteerProvider`.
5. **Generalize `handleStagnation`** (`domain: extension`). At src/extension.ts:249, have the post-run hook delegate its report-writing to `writeEscalationReport` (keep the existing `stagnation-report.md` alias for backward compat). The post-run call at :536 stays.
6. **Tests** (`domain: test`):
   - `src/render/escalation-report.test.ts` — report written to tmp dir; contains failure fields + decision; never throws on unwritable dir.
   - `src/escalation.test.ts` — `escalationBudgetRemaining` decrements; `runEscalation` returns `undefined` when no callback / no budget / callback throws; `applyRetryDecision` calls rollback + appendUserNotes.
   - `src/extension.escalation.test.ts` — interactive returns `EscalationDecision`; headless (`hasUI:false`) returns `undefined` AND writes report; `ctx.ui.select` throwing → `undefined`; default-on guard; `retry-with-guidance` calls `ctx.ui.input`.

### Deliverables (phase gate)
- `requireFiles`: [ "src/escalation.ts", "src/render/escalation-report.ts", "src/escalation.test.ts", "src/render/escalation-report.test.ts", "src/extension.escalation.test.ts" ]
- `requireContains`:
  - { file: "src/escalation.ts", pattern: "export async function runEscalation" }
  - { file: "src/escalation.ts", pattern: "ESCALATION_RETRY_CAP" }
  - { file: "src/render/escalation-report.ts", pattern: "export async function writeEscalationReport" }
  - { file: "src/extension.ts", pattern: "escalate:\\s*makeEscalate" }
  - { file: "src/extension.ts", pattern: "ctx\\.ui\\.select" }
- `requireTests`: [ "escalate interactive returns an EscalationDecision", "escalate headless returns undefined and writes the report", "runEscalation returns undefined when no callback" ]

---

## Phase 3 — Firing points + bounded recovery

- **Goal:** Actually fire escalate at the two unrecoverable sites and act on the decision (rollback+retry / accept / revise / abandon), bounded by `ESCALATION_RETRY_CAP`.
- **Depends on:** Phase 1 (rollback) + Phase 2 (`runEscalation`, `applyRetryDecision`, `ctx.options.escalate` impl).
- **Parallelizable with:** Phase 2's report tests, but NOT its extension edits (both touch extension.ts firing consumption — keep sequential).
- **Testable in isolation:** YES — tests inject a fake `escalate` onto `ctx.options` and assert loop/throw behavior with no real `ctx.ui`.

### Tasks

1. **Gate firing point in `src/nodes.ts`** (`domain: nodes`). Wrap the gate exhaustion site (src/nodes.ts:395–436, spec §5) in an outer escalation loop bounded by `ESCALATION_RETRY_CAP`. On exhaustion: build `failure` (`kind:"gate-exhaustion"`, `severity:"hard"` for fatal gates, `"soft"` for non-fatal), `runEscalation(...)`, branch: `retry-with-guidance` → `applyRetryDecision` + `continue`; `accept-limitation` → (soft only) stamp `__acceptedLimitations` + return ok/continue; `revise-manually` → return failed (clean partial); `abandon`/`undefined` → original `if (opts.fatal) throw new FatalAbort(msg)`.
2. **Stagnation firing point (review) in `src/stages/verify.ts`** (`domain: verify`). At `reviewLoopUntil` stagnation stamp (src/stages/verify.ts:167, spec §6.2): before returning `true`, call `runEscalation` with `key:"verify-review"`, `kind:"stagnation"`, `severity:"soft"`, `findings`; on `retry-with-guidance` → `applyRetryDecision` + clear `__stagnated` + `return false` (loop continues); on `accept-limitation` → stamp `__acceptedLimitations` + `return true`; else original break.
3. **Stagnation firing point (integration) in `src/stages/verify.ts`** (`domain: verify`). Mirror task 2 at the `recordTestStagnation()` site (src/stages/verify.ts:329) with `key:"verify-integration"`, `stage:"verify-integration"`.
4. **Tests** (`domain: test`):
   - `src/nodes.escalation.test.ts` — `retry-with-guidance` re-runs the attempt loop and guidance lands in `.user-notes.json`; `abandon` throws `FatalAbort`; `accept-limitation` not offered when `severity:"hard"`; cap exhausted → original throw (bounded).
   - `src/stages/verify.escalation.test.ts` — `reviewLoopUntil` retry → returns `false` (continues) and clears `__stagnated`; `accept-limitation` stamps `__acceptedLimitations`; `undefined` → original break; integration-loop site mirrors.

### Deliverables (phase gate)
- `requireContains`:
  - { file: "src/nodes.ts", pattern: "runEscalation" }
  - { file: "src/nodes.ts", pattern: "gate-exhaustion" }
  - { file: "src/stages/verify.ts", pattern: "kind:\\s*\"stagnation\"" }
  - { file: "src/stages/verify.ts", pattern: "verify-integration" }
- `requireNotContains`:
  - { file: "src/nodes.ts", pattern: "throw new FatalAbort\\(msg\\);\\s*$" } — (the bare throw must now be guarded by escalation; ensure it is no longer the unconditional final statement of the exhaustion branch — a phase gate reviewer confirms the escalate call precedes it)
- `requireTests`: [ "gate retry-with-guidance re-runs the attempt loop", "gate abandon throws FatalAbort", "reviewLoopUntil retry continues the loop", "escalation cap falls back to abandon after the cap" ]

---

## Phase 4 — Hardening + release

- **Goal:** Make the whole tree strict-clean and green; document the change.
- **Depends on:** Phases 1–3.
- **Parallelizable with:** nothing (final gate).
- **Testable in isolation:** YES — `npm run typecheck` + `npm test` are the deliverable.

### Tasks

1. **CHANGELOG entry** (`domain: docs`). Add a concise `[Unreleased]` `### Added` entry to CHANGELOG.md (Keep-a-Changelog; mirror the existing spec-NN anchor style): describe HITL escalation (pause-ask-continue), the two firing points, default-on interactive, headless report-only, bounded retry, never-throw.
2. **Typecheck** (`domain: verification`). Run `npm run typecheck` (tsc --noEmit); fix any strict errors introduced (esp. `.ts` import specifiers, `unknown` casts on `state.__*`).
3. **Full test suite** (`domain: verification`). Run `npm test`; ensure all new tests pass and no existing test regresses (esp. any test asserting today's silent-fail behavior — update assertions to the additive report+fail path).
4. **Regression sweep** (`domain: verification`). Confirm `stagnation-report.md` / `handleStagnation` backward-compat path still emits its report; confirm headless runs produce `escalation-report.md` and return `isError` exactly as before (no new prompt).

### Deliverables (phase gate)
- `requireContains`:
  - { file: "CHANGELOG.md", pattern: "escalat" }
  - { file: "CHANGELOG.md", pattern: "\\[Unreleased\\]" }
- `requireTests`: [ ] (gate is `npm run typecheck` clean + `npm test` green, asserted by the build)

---

## Cross-Domain Dependency DAG

```
Phase 1 (types + rollback)
   │
   ▼
Phase 2 (escalation helpers + extension impl + report)
   │
   ▼
Phase 3 (gate + stagnation firing points + recovery)
   │
   ▼
Phase 4 (CHANGELOG + typecheck + full test)
```

| Task | Depends on | Parallelizable with |
|---|---|---|
| P1-T1 types | — | — |
| P1-T2 RunOptions field | P1-T1 | P1-T4 (test authoring) |
| P1-T3 rollbackWorktreeTo | — | P1-T1, P1-T2 |
| P1-T4 tracking tests | P1-T3 | — |
| P2-T1 report writer | P1-T1 (EscalationFailure type) | P2-T2 |
| P2-T2 escalation helpers | P1-T1, P1-T3 | P2-T1 |
| P2-T3 makeEscalate | P2-T1, P2-T2 | — |
| P2-T4 wire escalate | P2-T3 | — |
| P2-T5 generalize handleStagnation | P2-T1 | P2-T3 |
| P2-T6 impl/report/escalation tests | P2-T2, P2-T3 | — |
| P3-T1 gate firing | P2-T2 (runEscalation/applyRetryDecision) | P3-T2, P3-T3 |
| P3-T2 review stagnation firing | P2-T2 | P3-T1, P3-T3 |
| P3-T3 integration stagnation firing | P2-T2 | P3-T1, P3-T2 |
| P3-T4 firing-point tests | P3-T1, P3-T2, P3-T3 | — |
| P4-T1 CHANGELOG | P1–P3 | — |
| P4-T2 typecheck | P1–P3 | — |
| P4-T3 full test | P1–P3 | — |
| P4-T4 regression sweep | P4-T3 | — |

---

## Risk Register & Mitigations

| Risk | Mitigation |
|---|---|
| Gate wrapper changes control flow → silent regression in non-fatal gates | Phase 3 test asserts: with no `escalate` on options, gate behaves byte-identically to today (same return/throw). |
| `git reset --hard`/`git clean -fd` matched by safety.ts denylist | Use discrete-argv `spawnSync("git", [...])` (never `shell:true`); Phase 1 test asserts argv form. Confirmed safe by code-assessment. |
| RPC `ctx.ui.select` no-ops (research ISS-01) | try/catch + `undefined` fallback → degrades to informative; strictly additive. |
| Infinite retry loop / unbounded agent spend | `ESCALATION_RETRY_CAP = 2` per blocker id, tracked on `state.__escalationRetries`; Phase 3 test asserts cap fallback. |
| Report write failure crashes run | `writeEscalationReport` swallows; `applyRetryDecision` swallows; both have no-throw tests (Phase 2). |
| `state.__*` typed as `unknown` under strict TS | Use the established `(state as Record<string, unknown>).__feedback` cast pattern already in nodes.ts/verify.ts. |

---

## Out of Scope

- Full `Result<T,E>` threading of the pipeline (research rejected this as over-engineering; the never-throw error-boundary shape is the idiomatic framework-boundary choice).
- A new `ctx.ui.custom` overlay UI (research SRC-04 footgun — `select`/`input` chosen instead).
- Changing the `accept-limitation` semantics beyond soft-block skip (no auto-fixing).
- Auth/RPC protocol changes (guarded by existing `ctx.hasUI`).
