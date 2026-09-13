# Deterministic convergence-duty enforcement + spec-track reuse

Status: implemented (this commit — v0.1.99)

## Problem

Two residual failure modes survived the v0.1.98 root-cause fixes:

1. **The reviewer convergence contract is prompt-only.** Run 2026-08-17T08-56
   burned 7 requirements rounds resolving prior findings while raising NEW
   medium/high-advisory blockers each round (4→2→4→3→1→1→1 open). The F2
   prompt contract says "no NEW blocking findings in later rounds unless
   High/Critical", but nothing enforces it deterministically — a reviewer that
   ignores the instruction still kills the run at cap, and the +4 strict-progress
   extension does not fire on a plateau (1→1→1).
2. **Spec-track fragmentation discards prior work.** Slightly different task
   texts allocate different spec tracks — `254-step-e2e-dashboard`,
   `254-step-e2e-test-dashboard`, `254-e2e-dashboard` were all observed — each
   fresh track regenerates requirements nondeterministically (12 vs 20 vs 23
   ACs) and abandons all prior convergence progress.

## Fix G1 — deterministic late-round downgrade (`enforceReviewerConvergenceDuty`)

`src/review-findings.ts` gains `REVIEWER_DUTY_ROUND = 3` and
`enforceReviewerConvergenceDuty(review, round, {stage})`: at round >= 3, a
finding that (a) blocks per `reviewFindingBlocks`, (b) has NO `priorFindingId`
(it is NEW this round, not a verified regression re-flag), and (c) is not
high/critical-class severity, is downgraded in place to advisory
(`blocking = false` + `downgradeReason`). Needs-human findings are included:
late-round non-high needs-human notes are attention requests, not loop-killers.

Both convergence loops call it right after the reviewer's prior-finding
resolutions are applied and BEFORE the approval computation, then:

- `approved = (verdict-approves || downgraded > 0) && !reviewHasBlockingFinding`
  — the contract's "MUST approve when only advisory items remain" clause,
  mirrored deterministically. High/critical or re-flagged blockers still reject.
- When a downgrade-approval happens, the advisory findings are still recorded
  into the convergence ledger (audit trail) before the verified flip.

The duty threshold counts REVIEW passes (not loop iterations — validation-failure
rounds run no reviewer), a `priorFindingId` shield applies only when the id exists
in the ledger (a hallucinated reference cannot dodge the downgrade), and the
high-class severity vocabulary covers the common tracker words (major, must-fix,
P0/P1, S0/S1, sev0/sev1, serious) since reviewer severity is free-form text.
The approval gates use the F-A VERDICT-layer blocking scan
(`reviewHasBlockingVerdictFinding`), so a downgraded non-high needs-human note
actually unblocks approval (its attention request is preserved, but it no longer
pins the verdict through status alone). In the spec loop a downgrade-approval may
override ONLY verdict-wording failures — review-doc shape errors (missing
dimensions/doc) still reject. Duty-enforced advisories are persisted with
`downgradeReason` and are excluded from the verified flip, so the ledger
distinguishes a duty-enforced advisory from a reviewer-verified resolution.

Review passes 1–2 are untouched: a fresh review may surface anything. From review
pass 3 on, only High/Critical correctness defects (or ledger-validated regressions)
can keep a loop open — mechanically, not by prompt compliance.

## Fix G2 — spec-track reuse on task similarity (`findReusableSpec`)

`src/setup.ts` gains deterministic (no LLM) task-matching:

- `taskTokens` (stopword-stripped), `taskSimilarity` (Jaccard),
  `slugTokenContainment` (share of a track's slug tokens present in the new
  task).
- `findReusableSpec(cwd, task)`: enumerates existing tracks exactly like
  `findResumableSpec` (`.worktree/<id>/docs/specifications/<id>` and in-place
  `docs/specifications/<id>`), skips completed tracks (`.complete` marker),
  reads the track's persisted anchor task (`<specDir>/.task`), scores
  `max(Jaccard(task, anchor), containment(slug, task))`, and returns the best
  track at score >= 0.75 (containment with >= 3 slug tokens) / >= 0.6
  (Jaccard, near-identical re-run) / 1.0 (2-token slugs, exact).
- The allocation branch tries reuse BEFORE allocating a new number whenever the
  task does not explicitly reference a spec and no resume id was given. The
  pipeline stage's `slug` option is an LLM-summarized LABEL, never explicit
  fresh-track intent — it only names a FRESH track (the first review round
  flagged the slug-gated ordering as making reuse unreachable in production).
  Reuse is a CONTINUATION: same worktree, same spec dir, and the track's
  knowledge + user-notes are PRESERVED (not cleared) like a resume.
- Only tracks with recorded progress are eligible (non-empty resume cache, no
  `.complete` marker — the same `isResumable` predicate resume uses): a track
  that never started has nothing to continue; a finished track asked-for-again
  is a new iteration. Ties resolve deterministically: score, then recency, then
  lexicographic id.
- The first allocation of a track persists the anchor task to `<specDir>/.task`
  (never overwritten — the anchor stays stable across re-runs).
- The decision is observable: `SetupControl.reusedTrack` and a setup log line
  naming the re-entered track.
- Opt-outs: an explicit spec reference in the task text, `--resume`, or
  `SUPER_DEV_NO_SPEC_REUSE=1` (the kill-switch also accepts a slug for naming
  the forced-fresh track).

The three observed task texts all match one track under these rules
(`step/e2e/dashboard` core tokens), so a re-phrased re-run continues the
existing workstream instead of starting cold.

## Verification

- `tests/convergence-ledger-review-findings.test.ts`: downgrade unit tests
  (round gating, new-vs-reflag, severity classes, needs-human, no-op cases).
- `tests/spec-convergence.test.ts`: loop-level — a round-3 `Changes Requested`
  carrying only NEW medium blockers converges ok with advisories recorded.
- `tests/setup.test.ts`: reuse unit tests (the three observed task variants,
  completed-track skip, dissimilar no-match, anchor persistence, opt-outs).
- `npx tsc --noEmit` + `npm test` green; version 0.1.99.

## Review outcome (2026-08-17)

Two review rounds, both reviewers in parallel each round (same spawn contract as
the pipeline: role file as system prompt, source-read-only, high thinking).

Round 1 — adversarial CONTEST / code-reviewer Changes Requested:
- **G2 dead in production** (both reviewers, blocking): the pipeline stage
  always passes an LLM-summarized slug, and slug-gated reuse never fired.
  Fixed: allocation inverted to reuse-first; the slug only names a fresh track;
  kill-switch `SUPER_DEV_NO_SPEC_REUSE=1` is the slug-independent opt-out.
- Spec-loop downgrade-approval could bypass review-doc shape errors. Fixed:
  the override applies only to verdict-wording failures (`Verdict is …`);
  a missing review doc now emits an explicit shape error (gateSpecReview).
- Slug-containment absorption / knowledge+notes wipe on reuse. Fixed: reuse
  requires `isResumable` (recorded progress), is layout-aware (worktree runs
  reuse worktree tracks only), preserves knowledge and user-notes
  (continuation semantics), tie-breaks deterministically, and surfaces
  `reusedTrack` + an honest log line (docs/knowledge/notes preserved; ledger
  restarts; cache retained on disk).
- Duty keyed on loop round conflated validation-failure iterations with review
  passes. Fixed: `reviewRound` counts reviewer runs.
- Hallucinated `priorFindingId` could dodge the downgrade. Fixed: the shield
  applies only to ledger-known BLOCKING-class rows (a re-flag of a downgraded
  advisory is a fresh opinion that must re-earn blocking via High/Critical).
- `downgradeReason` was dropped from the ledger; downgraded rows were flipped
  to `verified`. Fixed: persisted through record+merge (cleared on a later
  blocking re-flag), excluded from the verified flip.

Round 2 — adversarial CONTEST (1 blocking) / code-reviewer Approved with
Comments: the blocking finding (`reviewFindingBlocksVerdict` kept the old
narrow severity regex, so `P1`/`major`/`serious` needs-human findings silently
approved) is fixed by sharing the one `HIGH_SEVERITY_RE` vocabulary
(boundary-anchored so `majorly cosmetic`/`highly minor`/`P10` do not match),
with table-driven tests. Code-reviewer's cross-layout reuse mismatch is fixed
by layout-aware enumeration.

Known limitations (reviewer-noted, accepted): reuse containment at 0.75 can
absorb a genuinely different task whose wording shares a dead track's generic
slug tokens — bounded by the resumability gate, observable in the setup log
(anchor preview), reversible via kill-switch or explicit `@docs/specifications/
<id>/` reference; a purged resume cache disables automatic continuation (the
explicit reference still works); `reviewRound` restarts per process, so each
resume re-grants the reviewer's free early passes (bounded by the cumulative
3x round cap).
