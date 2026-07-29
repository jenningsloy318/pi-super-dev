# Requirements: HITL escalation — pause, ask via ctx.ui, then continue the run on unrecoverable blockers

- **Date**: 2026-07-28
- **Author**: super-dev:requirements-clarifier
- **Type**: enhancement
- **Priority**: high
- **Status**: draft

---

## Executive Summary

Today super-dev fails silently on unrecoverable blockers: a `gate({fatal:true})` exhaustion throws `FatalAbort` (caught in `execute()` with no prompt), and only verify-loop stagnation has opt-in, post-run HITL (`handleStagnation`). When a human is present, super-dev must pause, ask, and continue. This threads an `escalate(failure)` callback from `extension.ts` through `RunOptions` into the pipeline so each unrecoverable point fires INLINE — before giving up, while failure context is still live — and, in interactive sessions, blocks via `ctx.ui.select`/`ctx.ui.input` so the user's decision (retry-with-guidance / revise-manually / accept-limitation / abandon) drives an inline pause-and-continue. Headless/print/json/rpc runs degrade to today's behavior (write an escalation-report + fail), and the whole escalation path is no-throw/best-effort so it can never crash a run.

## Acceptance Criteria

- **AC-01**: `src/types.ts` defines `EscalationFailure` (`kind: "stagnation" | "gate-exhaustion" | "design-conflict"`; with `stage?`, `message`, `specDirectory?`, `worktreePath?`, `findings?`), `EscalationDecision` (`choice: "retry-with-guidance" | "revise-manually" | "accept-limitation" | "abandon"`; optional `guidance?`), and `Escalate = (failure: EscalationFailure) => Promise<EscalationDecision | undefined>`. `RunOptions` gains `escalate?: Escalate`, reachable inside every node/stage via `ctx.options.escalate` (mirroring how `userSteerProvider` lives on `RunOptions` and is drained in `workflow.ts` `realAgent`).
- **AC-02**: `extension.ts` `execute()` supplies `escalate` to `runPipelineTask` (alongside `userSteerProvider`). The implementation calls `await ctx.ui.select("super-dev hit a blocker — <message>", [<options>], { timeout: 300_000 })` and `await ctx.ui.input(...)` for guidance when "retry-with-guidance" is chosen, returning the decision. It is guarded by `ctx.hasUI`, wrapped in try/catch so dismissal/timeout returns `undefined`, and NEVER throws.
- **AC-03**: Fatal-gate exhaustion: in `src/nodes.ts` `gate({fatal:true})`, immediately before the `throw new FatalAbort(msg)` branch, when `ctx.options.escalate` is present the gate calls it with `{kind:"gate-exhaustion", stage: feedbackKey, message, specDirectory: state.setup?.specDirectory, worktreePath: state.setup?.worktreePath}` and acts on the returned decision (retry/accept/abandon) before propagating any abort.
- **AC-04**: Verify-loop stagnation: in `src/stages/verify.ts`, when stagnation is detected (`reviewLoopUntil` stamping `state.__stagnated`, and the integration-loop path stamping `state.__testStagnated`), the firing point calls `ctx.options.escalate({kind:"stagnation", findings})` INLINE so a "retry-with-guidance" decision lets the loop CONTINUE (re-run the body) instead of breaking — generalizing the post-run `handleStagnation` path into an inline pause-and-continue.
- **AC-05**: Recovery — "retry-with-guidance": the firing point runs `rollbackWorktreeTo(worktreePath)` (pipeline-internal `git reset --hard <HEAD>` + `git clean -fd`, scoped to the super-dev worktree, never-throws) + `appendUserNotes(specDirectory, [guidance])`, then retries the failed gate/stage inline. Guidance flows into the next specialist prompt via the existing `userNotesForAgent` drain in `workflow.ts` `realAgent`, and a re-run of a thrown gate is uncached (`createMemoizingAgent` only caches completed calls).
- **AC-06**: Recovery — other choices: "revise-manually" aborts cleanly (partial run) and the escalation-report tells the user exactly what to change; "accept-limitation" marks the finding on `state.__acceptedLimitations` and continues/skips, and is offered ONLY for soft blocks (never for hard build failures); "abandon" throws `FatalAbort` / returns failed. The `EscalationDecision.choice` is the single source of which branch runs.
- **AC-07**: An `escalation-report.md` is ALWAYS written to the spec dir in every mode (reusing/generalizing `handleStagnation`'s report-writing, including its `stagnation-report.md` body). Non-interactive runs (or a `undefined` decision) proceed to fail/abort exactly as today — interactive escalation is strictly additive.
- **AC-08**: Default-on: interactive TUI/RPC sessions escalate by default (interactive when `ctx.hasUI` is true). print/json/rpc-headless/headless runs NEVER block on a prompt — the `ctx.hasUI` guard short-circuits to the report + fail path. No new prompt can fire in automation/test/headless modes.
- **AC-09**: Bounded retry: "retry-with-guidance" is capped at a small N (a dedicated escalation-retry cap, e.g. 2, or the gate's existing `attempts`/`times` cap) before falling back to "revise-manually"/"abandon". The firing point tracks its own escalation-retry count so the run can never loop infinitely or spend unbounded agent budget.
- **AC-10**: No-throw / best-effort everywhere: the escalate callback, the rollback, and the report-write are each individually wrapped so ANY failure degrades to fail-with-report and never crashes the pipeline. A misbehaving `ctx.ui` call, a non-git/missing worktree, or a write failure cannot abort the run.
- **AC-11**: Focused tests are added covering: (a) the escalate callback contract — interactive returns an `EscalationDecision`, headless returns `undefined` and writes the report; (b) rollback-then-retry wiring (rollback fires, guidance is appended, the failed stage re-runs); (c) the default-on guard (interactive session prompts, non-interactive does not); (d) bounded retry falls back after the cap; (e) no-throw under callback/rollback/write failure.
- **AC-12**: `npm run typecheck` is strict-clean and the full `npm test` suite is green. A concise `[Unreleased]` entry is added under `### Added` in the CHANGELOG.

## Non-Functional Requirements

- Fault-tolerance / no-throw: the entire escalation path (callback, rollback, report-write, ctx.ui calls) must never crash a run — every step degrades to fail-with-report under any failure (best-effort try/catch).
- Latency / liveness: the interactive prompt carries a timeout (≈300s) so a dismissed or forgotten prompt cannot hang the run indefinitely; bounded escalation retries prevent infinite loops and unbounded specialist-agent spend.
- Safety: rollback is strictly pipeline-internal (`git reset --hard <HEAD>` + `git clean -fd`) scoped to the super-dev worktree — it must never touch the user's main checkout; persisted guidance is bounded by the existing MAX_QUEUED_INPUTS cap so a specialist prompt cannot be token-bombed.
- Observability: every escalation surfaces a log line via the progress sink/transcript and a durable `escalation-report.md` artifact in the spec dir, so the blocker and the user's decision are auditable post-run.
- Backward compatibility: interactive escalation is strictly additive — print/json/headless/rpc and the existing `escalation:"informative"` config must remain byte-identical to today (report + fail, no prompt).

## Open Questions

- `rollbackWorktreeTo` is NOT present in the codebase today (`rg rollbackWorktreeTo src/` returns nothing), although the task states it was 'just added' to `src/tracking.ts'. Confirm whether this work must ADD the helper, or whether it lands in a prior/parallel change — it materially changes AC-05 from 'wire to existing' to 'add + wire'.
- The verify loop has TWO stagnation points (`state.__stagnated` in the review loop and `state.__testStagnated` in the integration loop). Should the inline `escalate` fire at BOTH, or only the review-loop path that `handleStagnation` currently reads?
- Default-on resolution: `handleStagnation` today requires BOTH `ctx.hasUI === true` AND `getConfig().escalation === "interactive"`. For default-on, should the config default flip to `"interactive"` for interactive sessions, or should default-on be decided purely by `ctx.hasUI` at runtime (ignoring the config key)?
- Retry cap source: re-use each gate's existing `attempts`/`times` cap for escalation retries, or introduce a single dedicated escalation-retry cap (e.g. 2) shared across all firing points?
- "accept-limitation" scope: which findings qualify as soft (offered) vs hard (not offered)? Build failures are hard; are review findings and/or test failures soft and acceptable-to-record on `state.__acceptedLimitations`?
