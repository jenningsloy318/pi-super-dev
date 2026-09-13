# Stage 10/11 Resume Fidelity — Replayed Rounds Must Not Arm Terminal Exits (v0.3.10)

Status: implemented (this commit — v0.3.10)

## Incident

Run `2026-08-21T07-20-57-254Z` (super-dev v0.3.4, pi-omisis, spec
04-dimension-contract — ultimately SUCCESSFUL after manual surgery) required
the user to hand-delete the six `pipeline.verify.*` rows from
`.resume-cache.jsonl` before resume could proceed. The run had died at
Stage 10 with two consecutive identical reviewer verdicts; on resume, the
memoized replay reconstructed those two failures as cache hits, and Stage 10's
stagnation detector — reading in-memory signature histories — counted the
REPLAYED rounds as the "2 consecutive identical rounds" and broke the loop
BEFORE any fresh agent call. Escalation 3 of that run is this defect.

## Root cause

F3 (v0.1.98) granted the four WRITER convergence loops resume fidelity:
`countStageRounds` reads the persisted occurrence count at loop entry and
`effectiveCap = min(prior + cap, 3×cap)` — "replayed rounds do not consume
the fresh budget." Stage 10 (`reviewLoopUntil`) and Stage 11
(`integrationLoopNode`/`recordTestStagnation`) never received the
equivalent: their terminal detectors (`detectStagnation`'s 2-consecutive-
identical rule and the dead-state `roundsCompleted > 0` guard) arm on
whatever the in-memory histories contain — and on resume those histories are
rebuilt FROM the replayed failures. History becomes terminal evidence.

## Research grounding (full-text reads)

- **Event sourcing / rehydration (Azure Architecture Center, read in full):**
  replay reconstructs state "before any new action occurs" — the command
  handler's decisions run AFTER rehydration, against the reconstructed
  state; the replay itself never decides anything.
- **Temporal side effects:** a side effect executes once and is recorded;
  on replay the recorded value is returned WITHOUT re-execution — replay is
  pure reconstruction; new commands come only after the replay point.
- **AWS Durable Execution:** steps return cached results on replay;
  loop-control code outside steps may re-run but may only re-derive the
  same control flow — a cached step result is a record, not a new
  occurrence.
- **LangGraph time travel:** resuming from a checkpoint skips nodes prior
  to it and re-executes subsequent nodes — the checkpoint is the explicit
  boundary between reconstructed history and fresh work.

**Unified principle: history is evidence for state, not evidence for
termination.** A terminal exit (stagnation break → HITL escalation, dead-
state break) may only be armed by observations minted AFTER the replay
boundary (fresh, cache-miss agent outputs).

## Fix design (V1, as remediated in review round 2)

0. **The wired node is the primary surface.** Round 1 of the dual review
   caught that the pipeline's actual Stage 10 is `verificationConvergenceNode`
   (stages/index.ts), whose stagnation choke point is
   `recordVerificationStagnation` (three call sites) — while
   `reviewLoopUntil`/`reviewStageNode`/`integrationLoopNode` are
   compatibility exports. The guard therefore lives as the FIRST line of
   `recordVerificationStagnation` (via `verificationReplayArms`, exported):
   a replay-derived ATTEMPT neither pushes into the arming fingerprint
   history nor arms the stop. No baseline offset on this path — attempt 1
   IS a review outcome. The resume marker is read from
   `ctx.options.resumeSpecIdentifier` (the production-populated field) with
   a field-level fallback to `state.options` for direct unit tests.

1. **Replay-arm budget** (legacy `reviewLoopUntil` path — same contract):
   at the first observation, if the run is an actual resume
   (`ctx.options.resumeSpecIdentifier` — the same signal pipeline.ts uses to
   preload the cache; a merely reused track with stale cache rows is NOT
   excluded) and the kill-switch `SUPER_DEV_NO_VERIFY_REPLAY_GUARD` is
   unset, read the persisted occurrence count via `countStageRounds` over
   the Stage 10 review call family (`pipeline.verify.code-review` /
   `.adversarial` / `.tests-review`, max) and set `replayArms = priorRounds
   + 1` — the +1 covers the pre-loop baseline observation (the state before
   any review outcome; never a review outcome in either fresh or resumed
   runs).
2. **Observation classification** (`isReplayDerivedObservation`): every
   `reviewLoopUntil` call increments `__verifyUntilCalls`; the observation
   is replay-derived iff `callIndex ≤ replayArms`. Replay-derived
   observations increment the reporting counter (`__reviewRoundsTotal`)
   but do NOT push into the arming histories (`__reviewSignatures` /
   `__reviewCounts`) — exactly the writer loops' contract phrased for
   exits: **replayed rounds do not arm stagnation or dead-state breaks**.
   Fresh observations behave exactly as before.
3. **Dead-state guard**: the pre-push ARMING-history length
   (`roundsCompleted = sigHist.length`, fresh-only post-V1) — the break
   still requires one completed FRESH round. Identical to the old guard on
   fresh runs; on resume replayed rounds are excluded by construction; and
   after a guidance reset the history is empty so one completed
   post-reset round is required exactly as pre-V1 (round-2: VR-4/R2-4 —
   the earlier freshBodyRounds formula evaluated to 1 at the post-reset
   boundary and was removed).
4. **Stage 11 parity** (`recordTestStagnation`): same classification with
   the integration call family (`pipeline.integration.api-test` /
   `.ui-test`, max) and no baseline offset (the first observation IS a
   test outcome). Replay-derived observations skip the `__testSignatures`
   push.
5. **Conservative approximations (documented):** max-over-family means a
   crash that landed mid-round (one reviewer recorded, another not) can
   over-exclude by at most one observation — the SAFE direction (delays
   arming); min would under-exclude (arm on partially replayed evidence).
   The guidance-retry reset clears the arming histories but NOT the
   observation counters, so post-reset rounds stay classified fresh
   (occurrences continue past the recorded count by construction).
6. **Kill-switch**: `SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1` restores the old
   behavior (replayArms = 0) per the repo's automatic-behavior convention.

### Non-goals

- No change to the memoizer, the cache format, or the writer loops.
- No change to stagnation semantics on fresh runs (parity pinned by
  controls): two consecutive identical FRESH observations still arm.
- No invalidation/deletion of cache rows (the alternative "drop the failed
  stage's rows" hammer from the original 7-fix plan stays rejected).
- No change to `finalSafetyReReview`, the escalation surface, or the
  judge — they only see `__stagnated`, which now requires fresh evidence.

## Verification plan (RED-first)

New `tests/verify-resume-fidelity.test.ts`:

- **T1 (the incident)** — resume + cache holding 2 recorded identical
  Changes-Requested review rounds: the baseline + two replayed observations
  do NOT arm; the 4th (first fresh) does not arm alone; the 5th (second
  fresh, identical) arms stagnation. Pre-fix: stagnation fires at
  observation 2 (baseline + first replayed round are already an identical
  pair under the old code).
- **W1–W4 (the wired node)** — `recordVerificationStagnation` behavioral
  pins: replayed attempts 1–2 neither push nor arm; the 3rd (first fresh)
  pushes round A without arming; the 4th arms on recurring-vs-A. Parity
  (no resume marker ⇒ attempt 2 arms), kill-switch, and the ctx.options
  gate source each pinned separately.
- **T2 (dead-state)** — resume + absent build gate + empty findings:
  replayed observations cannot dead-state break; the first fresh
  post-body-round observation can.
- **T3 (fresh-run parity control)** — no resume: seeded two identical
  rounds + third identical still stagnates (passes pre- and post-fix).
- **T4 (guidance-retry counters)** — after stagnation + the
  reviewStageNode reset, subsequent identical observations re-arm (counters
  are not reset; no re-exclusion).
- **T5 (kill-switch)** — `SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1` restores
  arming on replayed observations.
- **T6 (stale-cache safety)** — cache rows present but NOT a resume
  (reused track): observations arm from the first repeated pair (no
  exclusion from stale rows).
- **T7 (Stage 11 wiring)** — the integration family classification and a
  source pin that `recordTestStagnation` consults it.

Full suite + `tsc --noEmit` + dual systematic review (code-reviewer,
adversarial-reviewer) per the per-version discipline.


## Review round 1 record (both reviewers Changes Requested) — remediated

- **VR-1 / ARCH-1 (blocker/high): fix targeted compatibility-only nodes.**
  Confirmed in code (stages/index.ts wires `verificationConvergenceNode`).
  Remediated: the guard now lives in `recordVerificationStagnation` (the
  wired choke point), with W1–W4 behavioral pins. The legacy
  `reviewLoopUntil`/integration guards are kept deliberately — same
  contract on every surface that exists.
- **VR-2 / SKEP-1 (blocker/high): resume gate read `state.options`, which
  production never populates.** Confirmed: stages receive
  `ctx.options: RunOptions`. Remediated: field-level read
  `ctx.options?.resumeSpecIdentifier ?? state.options?.resumeSpecIdentifier`
  (the fallback serves direct unit tests only). W4 pins the gate source.
- **VR-3 (low, legacy path only): epilogue occurrence inflation.** The
  legacy `reviewStageNode`'s `finalSafetyReReview` mints the same verify
  call ids outside the loop, so a crash between the epilogue and process
  exit can leave one extra recorded occurrence; on resume the first "fresh"
  observation may then be a replayed epilogue outcome — arming one round
  early in that corner. The WIRED node has no post-loop epilogue (its loop
  is the whole node), so the corner does not exist on the production path.
  Accepted as a documented legacy-only ±1 corner.
- **VR-4 (low): post-guidance-reset dead-state.** Math: stagnation arming
  requires 2 fresh observations, so all `replayObs` are consumed before any
  reset; at post-reset until#1, `callIndex = replayObs + 1` and
  `freshBodyRounds = callIndex − 1 − (arms−1) = 0` — the guard holds. The
  dead-state break still needs one completed post-reset round. (Derived;
  T4 pins the sibling stagnation path.)
- **TEST-1: Stage 11 behavioral coverage** — T7 exercises the classifier
  including its `histLen` term via carried `__testSignatures`; the wired
  path has no Stage 11 legacy node (the convergence node owns integration
  freshness), so the source pin remains the wiring proof.
- **TEST-3 / T4 dead scaffolding** removed; **DESIGN-1** classifier
  doc-comment now states its side effects; **DOC-1 / VR-6 / TEST-2** plan
  truth pass (this section).
- **INFO-1 (rounds now fresh-only)** accepted: `__stagnated.rounds` counts
  arming rounds; on resumed runs that is the fresh count by design.

Final: 12 tests in the file; RED-first with the final file: 8 fix-specific
failures pre-fix (T1, T2, T7, T7b, W1–W4 — the W tests exercise new
machinery), 4 controls pass. Suite 169 files / 2736 tests green; tsc clean.


## Review round 2 record (code: changes-requested, adv: CONTEST) — blockers CLOSED, residuals remediated

Both reviewers independently verified the round-1 blockers closed on the
wired path (stages/index.ts:162 → verificationConvergenceNode; guard at
recordVerificationStagnation verify.ts:403-410 covering all three call
sites; field-level ctx.options gate). Residuals:

- **MED-1 / R2-1 (medium, both): stale arms memo across route-back
  re-entry** — the wired node restarts `attempt` at 1 on re-entry while the
  memo survives, so re-entry attempts were misclassified as replayed
  (over-suppression). Remediated: the guard's attempt number is now the
  CUMULATIVE `__verificationAttempts` ledger length (not reset at node
  entry), `max(record.attempt, ledger.length)`; W5 pins the re-entry shape.
- **LOW-1 / R2-4: VR-4 math was false** — post-reset freshBodyRounds
  evaluated to 1, allowing a dead-state break on the first post-reset
  observation without a completed post-reset round. Remediated by removing
  the formula (guard reverted to the pre-push arming-history length, which
  is 0 after a reset); T2 realigned to the honest expectation (dead-state
  at the 5th observation).
- **R2-2: T7's histLen term unpinned** — now pinned (empty history ⇒
  replay-derived; 2-entry history ⇒ fresh, same counters).
- **LOW-2 / R2-3: design-section drift** — freshBodyRounds text replaced
  with the shipped guard; this record completes the truth pass.
- **R2-5 (triplicated guard families)** — accepted design: the wired choke
  point is primary; the legacy reviewLoopUntil/integration guards are kept
  deliberately so every existing surface carries the same contract
  (interface-stability exports), each with its own kill-switch-free shared
  env switch.
- **R2-6 (1-in-4 suite flake, 1 failed / 2735)** — not reproduced in this
  tree (three consecutive full runs 2736 passed); consistent with the known
  pre-existing environment-dependent git-identity test observed since
  v0.2.5 verification. No action.

Final: 13 tests in the file; RED-first with the final file: 9 fix-specific
failures pre-fix (T1, T2, T7, T7b, W1–W5), 4 controls pass. Suite 169
files / 2737 tests green; tsc clean.
