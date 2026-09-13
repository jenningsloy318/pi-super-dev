# Ledger Persistence + Completion Audit — v0.3.3

Status: implemented (this commit — v0.3.3)

Grounding: the cumora agent-team lesson (state that outlives the loop —
a team's shared context must survive member restarts) + Codex's
treat-completion-as-a-claim-to-verify close-out + the observed reality
that the convergence ledger (roster + findings + duty downgrades + class
sweeps) is a per-run in-memory object: a resume or restart replays
cache-hit rounds but the LEDGER restarts empty, so round-1 feedback loses
every unresolved finding the prior run recorded — the exact state the
v0.1.98 replan circuit had to reinvent via pendingReplanRequests files.

## L1 — persisted convergence ledger (flagship)

- New helpers in convergence-ledger.ts:
  `persistConvergenceLedger(state)` writes
  `specDir/.convergence-ledger.json` ({version, taskHash (sha256 of task
  text), persistedAt, findings}); every mutation entry point
  (recordConvergenceFindings, markConvergenceFindingsAddressedFromResponses,
  markConvergenceFindingsVerified, recordReviewFindingsFromControl)
  best-effort-persists after mutating (never throws).
- `priorFindingsForInjection(specDir, taskText)` loads the file, returns
  [] when absent/corrupt/taskHash-mismatched (a DIFFERENT task on the same
  track never inherits the old task's findings), else the unresolved
  BLOCKING findings (status open|addressed|needs-human, blocking,
  no downgradeReason) capped at 8.
- Injection at round 1 in BOTH convergence loops, next to the existing
  replan injection (same seam, same machinery): recordConvergenceFindings
  merges them by fingerprint (idempotent across restarts) and the
  round-1 writer feedback gains one line per finding
  (`[prior-run finding <id>] title`). This is what a resume/restart
  replays instead of an empty ledger.
- `.convergence-ledger.json` joins HARNESS_BOOKKEEPING_FILES (dirty-tree
  exemption) and the common-dir git-exclude additions (never snapshotted
  by git add -A) — same treatment as .run-lock.

## V2 — deterministic completion audit (honest close-out)

- New src/completion-audit.ts `writeCompletionAudit(state, status)`:
  writes `specDir/completion-audit.md` — status, phases done/total,
  review verdict, build/integration/merge-verify outcomes, deferred
  findings count, accepted limitations, and the ledger residue: every
  still-unresolved finding (id, title, ownerStage, status, blocking).
  When status is success AND unresolved BLOCKING findings exist, the
  audit records an AUDIT ANOMALY section (a gate hole — success claims
  must be verifiable) — deterministic, no LLM, no new loop.
- workflow.ts calls it right after status derivation, in try/catch,
  for EVERY outcome (partial/failed audits are more valuable than
  success audits).

## Non-goals

No event-sourced full reconstruction from run events (the persisted
ledger IS the source of truth; reconstructStageOutcomes already covers
topic projections); no cross-task learning (taskHash guard); no changes
to reviewer/judge loops; no new gates (the audit records, it does not
block — the anomaly section makes the hole visible).

## Verification plan

RED-first (`git stash src/`): L1 round-trip + injection + dedupe +
taskHash-guard + downgrade/non-blocking-skip tests, V2 audit-content and
anomaly tests fail pre-fix; controls (no ledger file → no injection;
audit absent specDir → no throw) green on post-fix tree. Full suite +
tsc. Version 0.3.2 → 0.3.3 with CHANGELOG + arch regen. Dual
code-reviewer + adversarial-reviewer, remediate, commit.


## Review outcome (dual systematic review)

Both CHANGES REQUESTED; every finding remediated.

Self-audit (fixed before verdicts landed): setRetryFeedback REPLACES the
key's array, so the prior-run and replan round-1 injections must merge
into ONE call (both loops restructured); the injected record now carries
the ORIGINAL ownerStage so upstream-owned prior findings keep
ownerPrecedes routing.

Convergent P1s — audit read `state.merge.verified`, a field the pipeline
never writes (the real control carries `merged` + `verification` from
mergeVerifyTask): fixed, with the merge line now distinguishing
ancestry-confirmed merges from self-reported ones; and the hash("")
keying: a missing `.task` anchor now disables BOTH persist and injection
(null anchor), killing the /tmp-spec-fixture cross-contamination class
and the empty-hash collision.

P2s — the injection cap permanently erased findings beyond 8 on restart:
ALL unresolved rows are now recorded in the fresh ledger (fingerprint
merge), only the FEEDBACK lines are capped (6, so replan directives
always fit the missing slice, with the omission announcement); the
git-exclude claim was FALSE (an earlier batch assertion aborted before
the setup.ts edit landed) — now actually landed and re-verified; the
audit's partial-phase line read a nonexistent `name` field (real:
`id`). P3s — shared `unresolvedBlockingConvergenceFindings` predicate
(audit + anomaly no longer duplicate); atomic temp+rename persist;
`completion-audit.md` registered harness bookkeeping (never swept into
track commits by a resumed run's `git add -A`); deliberate dispositions:
the audit is an operator-facing per-run record written at summary time
(not a shipped artifact), addressed-claim injection keeps ledger
semantics (non-blocking writer claim, reviewer verifies), and injected
rows take the current stage's detectedAtStage exactly like the replan
seam they mirror. Suite 2631 passing, tsc strict-clean.
