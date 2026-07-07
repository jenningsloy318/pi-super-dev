# Iteration Loops (reference)

> **Provenance:** Adapted from the original `super-dev-plugin` reference.
> Maps the plugin's "implementation-iteration-loop" to pi-super-dev's two
> concrete loops: the **per-phase implementation loop** and the **verify-loop**.

## Two loops, one principle

The high-performing pattern (cited from SWE-bench agent / SWE-agent research) is
a *tight, feedback-driven loop where observable results are the convergence
signal*. pi-super-dev expresses this directly in the control-flow node algebra
(`src/nodes.ts`): `loop({ until, times }, body)`.

### Per-phase implementation loop (Stage 9 — `src/stages/implementation.ts`)

```
for each phase, up to 3 attempts:
  tdd-guide → implementer → runBuildGate(deterministic)
  on FAIL: feed real build/test errors into the next implementer attempt
  on PASS: commit on green, advance
```

- The convergence signal is `runBuildGate` (build + test + typecheck actually
  run), **not** an agent's self-report.
- Real errors from attempt N are prepended to attempt N+1's prompt so the
  implementer targets the specific failures.

### Verify-loop (Stage 10 — `src/stages/verify.ts`)

```
loop({ until: approved ∧ testsGreen ∧ buildGreen (or stagnant), times: 4 },
  [ review(code+adversarial in parallel → merge verdict)
  , if approved: bringup → apiTest → uiTest → teardown
  , fix(review findings + test failures + build errors)
  , buildGate ])
```

- Both reviewers run in parallel and converge into one merged verdict
  (`merge-review-verdicts` helper).
- Services come up only after review approves; tests self-skip without ready
  services; teardown always runs (`tryCatch`).
- The fix step receives review findings AND test failures AND build errors.

## STOP — freeze discipline

In the original, the team-lead was forbidden from editing files directly during
the loop (it bypasses TDD discipline and review traceability). pi-super-dev
enforces this **structurally**: the pipeline only ever spawns specialist agents
(implementer / tdd-guide / api-tester / ui-tester) to make changes — the
orchestration layer never edits. There is no "team-lead edits" code path.

## Exit criteria

- Per-phase: `runBuildGate` passes (or 3 attempts exhausted → terminate phase
  early, non-fatal).
- Verify-loop: merged verdict `Approved` (with or without comments) ∧ tests
  green ∧ build green. **No partial approvals** — all findings must be resolved
  or the loop exhausts (non-fatal) / breaks on stagnation.

## Pivot branch — when iteration is the wrong tool

If iteration is producing the *same* class of failure because the **spec's
design** (not the implementation) is wrong, more iteration cannot help.

**Currently implemented (Gap 4.6):** the verify-loop detects **stagnation** —
the same non-empty review-findings signature recurring on two consecutive
rounds — and breaks early with a log line, instead of burning all 4 rounds.

**Deferred (full pivot protocol):** the automatic "pause → research in pivot
mode → user-confirmed spec redraft → resume from design" machinery. See
`pivot-protocol.md` for the design intent. Today, stagnation surfaces as a
diagnostic (and, when the Tier-2 escalation UI lands, a user-facing choice); the
spec-redraft loop is manual until `learned.md` evidence justifies automating it.
