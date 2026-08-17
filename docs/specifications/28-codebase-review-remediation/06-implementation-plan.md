# Implementation Plan — Whole-Codebase Review Remediation (Spec 28)

- **Date:** 2026-08-17
- **Source:** `05-technical-specification.md` (authoritative design). This file is the landable-milestone DAG; `07-task-list.md` carries the per-task file inventories.
- **Entry condition:** working tree at v0.1.99 @ 441b97df, suite green, `npx tsc --noEmit` clean.
- **Exit condition:** all 7 phases landed; 71/71 scenarios green; full suite (re-counted per D12) green; strict-clean; `package.json` at 0.1.100 with changelog `### Fixed` bullets.

## Milestones (ordered; each is a coherent landable unit)

### M1 — Approval-chain integrity (Phase 1)
- **Domain:** `convergence` (verdict/finding classification, duty, ledger, replan consumption).
- **Delivers:** AC-01, AC-28, AC-35, AC-34 (+B7, +B8), AC-18.
- **Depends on:** nothing.
- **Parallelizable with:** M2, M5, M6 (disjoint files except `tests/replan-restart.test.ts`, which M1 edits first — M3 rebases on it).
- **Key files:** `src/helpers.ts`, `src/review-findings.ts`, `src/convergence-ledger.ts`, `src/stages/artifact-convergence.ts`, `src/stages/spec-convergence.ts`.
- **Test gates:** `tests/helpers.test.ts`, `tests/artifact-convergence.test.ts`, `tests/doc-validators.test.ts` (verdict tables only — the rest is M4 territory), `tests/convergence-ledger-review-findings.test.ts`, `tests/replan-restart.test.ts` (M8 pin flip), `tests/spec-convergence.test.ts`.
- **Red-first:** transcribe SCENARIO-001/039/057/068/070 traces before the fixes.

### M2 — Secrets & worktree fail-closed (Phase 2)
- **Domain:** `setup`/`git` (safety of the merge set and the worktree lifecycle).
- **Delivers:** AC-07 → AC-08 → AC-09 → AC-10 (internal order is a dependency chain: detection before prevention; fail-closed add before the refusal that assumes it).
- **Depends on:** nothing (M2.1 exports `isEnvFile`, consumed by M2.2 internally).
- **Parallelizable with:** M1, M4, M5, M6.
- **Key files:** `src/setup.ts`, `src/helpers.ts`, `src/stages/verify.ts` (single `commitWorktreeChanges` call site).
- **Test gates:** `tests/cleanup-sensitive-scan.test.ts`, new `tests/setup-env-exclude.test.ts`, `tests/setup.test.ts`, `tests/verification-fix-commit.test.ts` (D6 fixture conversion), audit `tests/merge-verify.test.ts`.
- **Risk note:** AC-10 is the phase's churn hotspot — budget the fixture conversion before landing.

### M3 — Track state & resume-cache correctness (Phase 3)
- **Domain:** `setup`/`resume`/`replan` (durable state across runs and restarts).
- **Delivers:** AC-02 + AC-21 (+R8) → AC-04 + AC-05 (+B6) → AC-20 → AC-30 (last — exemption sets touched once).
- **Depends on:** M1 (AC-18 consumption semantics precede AC-20's human-row contract); M1's `tests/replan-restart.test.ts` edits.
- **Parallelizable with:** M4, M5 (M6 shares `extension.ts` — sequence M6.5 after M3.6 or rebase).
- **Key files:** `src/setup.ts`, `src/resume.ts`, `src/replan/replan.ts`, `src/replan/owners.ts` (type only), `src/stages/verify.ts`, `src/extension.ts` (resume log), `src/helpers.ts` + `src/tracking.ts` (exemption sets), `src/pipeline.ts`.
- **Test gates:** `tests/setup.test.ts`, `tests/resume.test.ts`, new `tests/replan-stage-prefix-edges.test.ts` (drift-guard tripwire), `tests/replan-restart.test.ts`, `tests/verify.test.ts`, `tests/replan-owners.test.ts`.
- **Drift guards:** the tripwire (AC-04) must land in the same commit as the prefix additions; `classify: []` is deliberate (D2).

### M4 — Doc-validator & render gate integrity (Phase 4)
- **Domain:** `docs-gates`/`render`.
- **Delivers:** AC-19 → (AC-13 + AC-25, one commit) → AC-26 → AC-11 → AC-27 → AC-16 → AC-14.
- **Depends on:** nothing external; internally AC-11/AC-14 read fields AC-19 preserves; AC-26 consumes AC-13's stripping; AC-06 (M5) consumes AC-19 — M5.5 must follow M4.1.
- **Parallelizable with:** M1 (doc-validators verdict-table edit is disjoint from strip/normalize sections), M2, M3, M5 (except 5.5), M6.
- **Key files:** `src/doc-validators.ts`, `src/render/schemas.ts`, `src/render/render.ts`, `src/render/templates/bdd-scenarios.md.njk`.
- **Test gates:** `tests/doc-validators.test.ts` (M14 pin flip at :543–557, cited), `tests/requirements-bdd-gate.test.ts`, `tests/pipeline-gates.test.ts`, `tests/render.test.ts`, `tests/doc-path-idempotency.test.ts`, `tests/docs-contracts.test.ts` audit, `tests/upstream-review-integration.test.ts` audit.
- **Fixture audits (D7/D8):** out-of-specDir docPaths; 1-digit AC ids.

### M5 — Implementation/TDD loop correctness (Phase 5)
- **Domain:** `implementation` (change tracking, RED oracle, loop liveness, coverage expectations).
- **Delivers:** AC-15 (+D-1) + AC-32 (tracking pair, one commit) → AC-22 (+R7) → AC-03 → AC-06 (last; needs M4.1's AC-19).
- **Depends on:** M4.1 (AC-19) for AC-06 only.
- **Parallelizable with:** M2, M6 (M1 shares no files; M3 shares none).
- **Key files:** `src/tracking.ts`, `src/build-runner/gates.ts`, `src/stages/implementation.ts`.
- **Test gates:** `tests/tracking.test.ts`, `tests/change-tracker-nonregression.test.ts`, `tests/compute-change-gate.test.ts`, `tests/red-oracle.test.ts`, `tests/implementation-convergence-loop.test.ts`, `tests/implementation-red-loop.test.ts`.

### M6 — Process/extension robustness + prompts (Phase 6)
- **Domain:** `process` (pi-spawn, lifecycle), `extension` (run serialization, reflection), `prompts` (fencing).
- **Delivers:** (AC-12 + AC-23, one commit) → AC-24 → AC-17 (+B4, D10) → AC-29 (+D-8) → AC-33 → AC-31 (last — the spec's largest test churn).
- **Depends on:** M1 lands first (AC-17 sequenced after AC-18/34 edits in the same `artifact-convergence.ts`/`spec-convergence.ts` files); M3.6 (extension.ts finally is edited once for the lock release and again for D-8 — sequence or rebase).
- **Parallelizable with:** M4, M5 (disjoint files).
- **Key files:** `src/pi-spawn.ts`, `src/stages/lifecycle.ts`, `src/stages/artifact-convergence.ts`, `src/stages/spec-convergence.ts`, `src/extension.ts`, `src/render/reflection.ts`, `src/render/super-dev-dir.ts`, `src/render/user-notes.ts`, `src/prompts.ts`, `src/retry-feedback.ts`.
- **Test gates:** `tests/pi-spawn.test.ts`, `tests/lifecycle.test.ts`, `tests/artifact-convergence.test.ts`, `tests/spec-convergence.test.ts`, `tests/extension-entry-renderer.test.ts`, `tests/extension-inherit.test.ts`, `tests/extension.escalation.test.ts`, `tests/self-improving.test.ts` audit, `tests/user-notes.test.ts`, `tests/prompts.test.ts`, `tests/prompt-control-contracts.test.ts`, `tests/prompts-tdd-*.test.ts`, `tests/prompts-cargo-verify-discipline.test.ts`.
- **Churn note:** AC-31 regenerates every exact-output prompt pin — land it isolated at the phase's end.

### M7 — Fix-in-pass dispositions & release (Phase 7)
- **Domain:** cross-cutting (process/extension/setup/judge/runlog) + release chore.
- **Delivers:** SD-04, SD-05, SD-07, A-03, A-04, A-05, B3, B5, R6, D-4, D-5 (each with an NFR-6 pinning test; B4/B6/B7/B8/R7/R8/D-1/D-9 already folded into M6.4/M3.4/M1.4/M5.3/M3.2/M5.1/M6.5) + the v0.1.100 release commit.
- **Depends on:** all prior milestones (touches their files).
- **Parallelizable with:** nothing (release tail).
- **Test gates:** module-local pinning tests (`tests/pi-spawn.test.ts`, `tests/session-agent.test.ts`, `tests/nodes.test.ts`, `tests/workflow.test.ts`, `tests/judge.test.ts`, `tests/setup.test.ts`, `tests/runlog.test.ts`, `tests/runlog-invariants.test.ts`) + `tests/version.test.ts` + the `tests/changelog-unreleased-*.test.ts` pattern + full suite + `tsc --noEmit`.

## Dependency DAG (arrows = must land first)

```
M1 ──► M3 ──► M6 ──► M7
 │        │      ▲
 │        └──────┘ (extension.ts finally: M3.6 before M6.5, or rebase)
 ├──► M2 ──────────────► M7
 ├──► M4 ──► M5.5 ─────► M7
 │     ▲
 │     └── M4.1 (AC-19) gates M5.5 (AC-06) only
 └──► M5 (5.1–5.4) ────► M7
```

Parallel tracks from the start: **M1 ‖ M2 ‖ M4 ‖ M5(–5.4)**; M3 after M1; M6 after M1 (+M3.6 sequencing); M7 last.

## Per-milestone red-first order

Each milestone: (1) write the failing scenario tests (dossier traces verbatim), (2) run the milestone's test files to confirm red, (3) land the fixes file-by-file in the listed internal order, (4) run the milestone gates + the touched shared suites (`tests/replan-restart.test.ts`, `tests/doc-validators.test.ts`, `tests/setup.test.ts`) to catch cross-milestone ripple, (5) squash-review for NFR-5 behavior containment (no change beyond the AC contracts; deletions per spec §O only).

## File inventory summary

- **Create:** `tests/setup-env-exclude.test.ts`, `tests/replan-stage-prefix-edges.test.ts` (+ any per-module pinning test files Phase 7 needs).
- **Modify (src):** `helpers.ts`, `setup.ts`, `pipeline.ts`, `resume.ts`, `review-findings.ts`, `convergence-ledger.ts`, `doc-validators.ts`, `tracking.ts`, `prompts.ts`, `retry-feedback.ts`, `nodes.ts`, `workflow.ts`, `extension.ts`, `pi-spawn.ts`, `render/render.ts`, `render/schemas.ts`, `render/user-notes.ts`, `render/reflection.ts`, `render/super-dev-dir.ts`, `render/templates/bdd-scenarios.md.njk`, `stages/artifact-convergence.ts`, `stages/spec-convergence.ts`, `stages/implementation.ts`, `stages/verify.ts`, `stages/lifecycle.ts`, `stages/judge.ts`, `build-runner/gates.ts`, `replan/replan.ts`, `replan/owners.ts` (type only), `package.json`, `CHANGELOG.md`.
- **Delete:** `waitForEvent` + `WaitForEventOptions` in `src/nodes.ts`; the silent in-place fallback in `createOrReuseWorktree`; the three env regexes in `SENSITIVE_RE`; the dead empty-prefix early return in `invalidateResumeCache`; local `stableHash` in `convergence-ledger.ts`; the `activeRun` discard in `extension.ts`; the `/❯/` npm marker and python `/\berror\b/` red fallback in `gates.ts`.
