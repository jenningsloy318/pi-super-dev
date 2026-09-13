# Judge challenge-test missing-evidence exemption (v0.2.11)

Status: implemented (this commit — v0.2.11)

## Incident (run 2026-08-19T14-54-22-165Z, super-dev v0.2.10)

Fifth consecutive death on pi-omisis track 07-staged-execution, PARTIAL 0/12
phases after 1h24m. Phase 1 hit a genuine cross-spec contradiction: spec-01's
`SCENARIO-035` pin (`tests/interface-contracts-ownership.test.ts:618`) freezes
the three '07'-owned schemas as opaque (`accepts(schema, {})` must be true),
while spec-07 phase 1 concretizes them in place as a closed 13-required-field
`Type.Object` that necessarily rejects `{}`. The two tests are jointly
unsatisfiable; full suite 572/573 with the stale pin as the sole failure.

The impl-no-progress judge (scope `stage9.impl-no-progress.phase-01`) produced
the CORRECT diagnosis (confidence 0.92) and the CORRECT route
(`challenge-test`), with an empty evidence list — and `verifyJudgeEvidence`
DISCARDED it: `route "challenge-test" requires at least 1 evidence item`. No
routed outcome → HITL escalation → run terminated.

This is the third run killed by the same meta-defect class:

| run | discarded route | version at the time | fix |
|---|---|---|---|
| 2026-08-17 (STEP ×2) | escalate-now | v0.1.97 | v0.2.4 F4 degrade |
| 2026-08-19T02-01-12-840Z | re-author-tests | v0.2.4 | v0.2.5 J5 (user): re-author-tests + fix-environment exempt |
| 2026-08-19T14-54-22-165Z | **challenge-test** | v0.2.10 | **this fix (v0.2.11)** |

## Root cause

The v0.2.5 J5 exemption set (`DIAGNOSIS_DRIVEN_MISSING_OK`) deliberately
excluded challenge-test with the rationale "it can drop an accepted RED gate".
That rationale was unsound:

1. The already-exempt `re-author-tests` consumer at the same wiring point ALSO
   drops the accepted RED (`acceptedRed = null`) — the "drops a gate" property
   is shared, not distinguishing.
2. challenge-test actuation is MORE bounded than re-author-tests: it is capped
   by `MAX_CHALLENGE_REAUTHORS` (2 per phase) on top of the judge's own
   per-signature budget (INV-3), and the re-authored test must still pass RED
   strength review before it re-enters force.
3. When `acceptedRed` is absent or the cap is spent, a routed challenge-test
   already degrades to HITL with the diagnosis surfaced — a safe floor.
4. The diagnosis is the actionable product in exactly the J5 sense: in the
   incident run it names the culprit file, line, and the joint-unsatisfiability
   derivation verbatim. Discarding it discards correct work.

## Fix F1

### F1a — exemption set

`DIAGNOSIS_DRIVEN_MISSING_OK` gains `challenge-test`. The MISSING-evidence
class only (empty evidence list, every verification failure reading "requires
at least 1 evidence item"); FABRICATED and MALFORMED evidence still discard on
every route, and the confidence + offered-routes gates still apply after the
exemption (a below-confidence or not-offered route escalates).

### F1b — defect-file targeting from the diagnosis

The challenge-test consumer synthesizes its re-author defect as
`evidence[0]?.file ?? acceptedRed.testFiles[0] ?? ""`. Under the exemption
evidence is empty, so the old fallback would misdirect the re-author at the
phase's own RED file even when the diagnosis names an external stale pin (the
incident case). New pure helper `firstCitedTestFile(diagnosis)` in judge.ts:
extract repo file paths (code/test extensions, `:line` suffixes stripped),
prefer the first path that looks like a test (`tests/` dir, `__tests__`,
`.test.`/`.spec.`/`_test.` markers), else the first match; null when none. The
consumer chain becomes
`evidence[0]?.file ?? firstCitedTestFile(verdict.diagnosis) ?? acceptedRed.testFiles[0] ?? ""`.

## Non-goals

- No change to FABRICATED/MALFORMED discard semantics (J5/B4 guards intact).
- No change to the evidence-verification checker itself (INV-2 rule text).
- No new routes; `JUDGE_ROUTES` unchanged.
- No automatic update of stale cross-spec pins — the challenge re-author loop
  (tdd-guide with the judge diagnosis as evidence) is the actuator.

## Verification

- `tests/judge.test.ts`: SCENARIO-005 flips to the new contract (challenge-test
  with NO evidence ROUTES with a documented exemption line in `.judge.jsonl`);
  new negative control (challenge-test with FABRICATED evidence still
  DISCARDS); `firstCitedTestFile` pins extract `tests/interface-contracts-ownership.test.ts`
  from the verbatim incident diagnosis, prefer test-looking paths over earlier
  non-test citations, and return null on path-free text.
- RED-first: stash `src/` → the flipped/new tests fail on pre-fix code.
- Full suite + `npx tsc --noEmit` green; version 0.2.10 → 0.2.11 across
  `src/version.ts`, `package.json`, `package-lock.json`, `tests/version.test.ts`,
  `docs/ARCHITECTURE.md` regenerated, CHANGELOG Unreleased bullet.

## Review outcome

(appended after the dual review)
