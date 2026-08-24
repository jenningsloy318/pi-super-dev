# RED-Loop Timeout Honesty (v0.3.16)

Status: implemented (this commit — v0.3.16)

## Incident

Run `2026-08-23T02-59-20-670Z` (super-dev v0.3.15, pi-omisis, track
`07-staged-execution`, 6-phase spec): Phases 3, 5, and 6 died in RED
generation after 4–6 tries each; Phase 6 alone burned 5 consecutive
20-minute `tdd-guide` timeouts. 15 of 26 `tdd-guide` calls this run timed
out at exactly 1200 s while successful calls clustered at 8.9–19.9 min —
the wall is structurally tight for this agent class (explore + write +
verify + structured_output on a 27–29K-char prompt), but the harness's
reaction to the timeout is what turned slowness into a doom loop.

## Root causes

- **RC-T1 — stale `testFiles` echo.** `implementation.ts` RED-loop head:
  `testFiles = filesRaw == null && testFiles.length ? testFiles : normalize(filesRaw)`.
  When tdd-guide times out (`control=no`), `filesRaw` is null and the
  variable **keeps the previous try's claim**. The run log then prints
  `tdd-guide (try 2) error=timed out after 1200s: test files=tests/screen.test.ts`
  — a lie (the agent produced nothing this try), and the oracle runs
  vitest against a file that try-1's cleanup already deleted, yielding
  `No test files found` → `red-broken: tests did not compile/collect`.
  The retry hint tells the next agent its tests "did not compile" when
  the file does not exist. 7 such poisoned retries across phases 3/4/6.
- **RC-T2 — timeout-coupled file deletion.** Try 1 wrote a good RED file;
  the RED **review** then timed out (480 s, `control=no`); the R2
  fail-closed path correctly refuses to proceed, but the shared
  `review-weak` status then routes through
  `restoreUnacceptedRedChanges`, **deleting the never-adjudicated test
  file**. A review that never ran must not count as a verdict against the
  artifact.
- **RC-T3 — no deadline discipline in the RED prompt.** `buildTddPrompt`
  carries no exploration budget and no write-early instruction. The
  doc-writer "~6 tool calls" discipline is not applied to tdd-guide, so
  the agent explores for 15+ minutes (52 tool calls observed) and hits
  the wall before writing.
- **RC-T4 — timeout-blind retry hints.** The retry hint after a timeout
  death is the misleading `red-broken` text; nothing tells the next try
  that the previous death was a wall-clock timeout, that the disk state
  is X, or that it should skip re-exploration.

## Fixes

- **F1 — `tddTimedOut` clears the claim.** When the tdd agent call ends
  with an error (`tdd.error` set, e.g. `timed out after 1200s`) or
  `control` is null, `testFiles` is reset to `[]` (a timeout is NOT a
  delivery). The `(none)` log line is annotated
  `(agent did not complete — previous claim discarded)` so operators see
  the honest state. The fail-closed RED branch then reports
  `the TDD agent did not complete (…)` instead of running the oracle on
  a ghost file.
- **F2 — review-timeout preserves the file.** `restoreUnacceptedRedChanges`
  is skipped when the `review-weak` reason matches either non-completion
  template — `RED review did not complete` (agent error/timeout) or `RED
  review returned no usable verdict` (malformed control, review round-2
  finding) — no verdict was rendered either way. The file stays on disk; the retry hint already names the
  review infrastructure failure. Real `weak`/contradiction verdicts keep
  today's restore semantics.
- **F3 — RED deadline discipline.** `buildTddPrompt` appends a
  "Deadline survival" block: write the test file to disk EARLY (it is
  the deliverable; a written-but-unverified file survives a timeout,
  prose does not), cap exploration at ~10 tool calls, and never
  re-explore on a retry whose hint says the previous try died at the
  wall clock.
- **F4 — timeout-aware retry hint.** When the previous try died of a
  tdd timeout, the retry hint states it plainly (elapsed wall, whether
  the claimed file exists on disk now) and instructs: write/fix the file
  first, verify second, structured_output last; skip re-exploration of
  material already summarized in this hint.

## Non-goals

- No change to agent wall-clock defaults (the v0.3.14 20-min raise stands;
  per-role timeout tuning is deferred until F1–F4 prove insufficient).
- No change to RED review strength semantics (R2 fail-closed stays).
- No change to judge routing budgets.

## Verification

- Tests in `tests/red-timeout-honesty.test.ts` pin: stale-claim discard
  (F1), file-preservation on review-timeout (F2), prompt discipline text
  (F3), retry-hint content (F4), the honest no-stock-template hint on
  agent-death tries, and the DISK-probing state line (7/8 RED-first on the
  pre-fix tree; the 8th is the RC8 restore no-regression control).
- Full suite `npx vitest run` (2795 passed) + `npx tsc --noEmit` clean.

## Review outcome

Dual systematic review (code-reviewer CHANGES REQUESTED, adversarial
APPROVED WITH COMMENTS); remediated findings: **code F-1 / adv F-2** — the
F4 disk-state line derived from the (cleared) claim so it could never name
an existing file; fixed by probing the disk over claim ∪ last-claimed ∪
red-changed files (`lastClaimedTestFiles` tracker), pinned by a real
temp-worktree test. **adv F-1** — agent-death retries still carried the
misleading stock "tests did not compile" template; the stock hint is now
dropped on tdd-death tries (diagnostics kept). **code F-4** — "returned no
usable verdict" joined the F2/F4 non-completion guard. **code F-2 /
adv F-5** — dead describe-scope `redSeq` removed; the F4 tdd test now
drives the real fail-closed path. **code F-3 / adv F-3** (string-coupled
guard) and **code F-5/adv F-6** (legacy echo on control-bearing omission)
accepted as documented residuals — the templates are harness-authored, not
reviewer free text. **code F-8** — plan-doc wording corrected in place.
**adv F-4 / code F-7** (control-test coverage of the real-verdict restore
path) noted; the existing suite's restore tests carry that contract.
