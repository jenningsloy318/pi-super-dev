# Pivot Protocol (reference — design intent)

> **STATUS — largely DEFERRED.** This documents the *full* pivot protocol from
> the original plugin (born from a real postmortem: three ad-hoc spec pivots in
> one branch, ~6 hours, no audit trail). pi-super-dev currently implements only
> the **front half**: stagnation detection (Gap 4.6) breaks the verify-loop
> early when the same findings recur, and (planned, Tier-2 4.6′-lite) surfaces a
> diagnostic. The **back half** — automated research-in-pivot-mode, spec redraft
> with `-rN` suffix, historical banners, AC reconciliation, resume-from-design
> — is **NOT wired**. It will grow out of the stagnation + escalation hooks once
> `learned.md` shows the failure mode is frequent enough to justify automating.
>
> This document exists so contributors and the reflection agent understand the
> intended end-state and the boundary of what's currently automated.

## When pivot applies (and when it doesn't)

Pivot is **NOT** for ordinary bugs (code doesn't match spec → fix code). Pivot
is for the situation where the spec is internally consistent but:

- Real input doesn't match the assumed shape; the algorithm produces wrong
  results on real data.
- A foundational assumption is false (framework doesn't behave as documented,
  environment doesn't honor an API).
- An architectural decision has unfixable downsides in implementation
  (performance, accessibility, layout).

**Heuristic:** if iteration 2 produces the *same class* of failure as iteration
1, AND fixing it requires changing the spec's design constants / algorithm /
architecture (not just `src/*`), pivot.

## Full protocol (target design)

1. **Pause iteration.** Halt the in-progress loop; mark the phase pivot-pending.
2. **Capture diagnostic artifacts** that demonstrate the *spec* is wrong (not
   the implementation): failing test output, review findings noting
   "implementation faithful to spec, but spec is wrong because X".
3. **Research alternative approach** — a research pass with the failing
   assumption as input; output a pivot research report.
4. **User confirmation (mandatory).** Cost decisions are not the agent's. Three
   options: adopt alternative / accept current spec + document as known
   limitations / abandon.
5. **Spec redraft** — revised spec (`-rN` suffix) documenting *why* the original
   was wrong, replacing the failing mechanism, adjusting ACs (mark old ones
   `SUPERSEDED`, add new ones), re-running spec review.
6. **Historical banner** on the original spec docs so future maintainers
   immediately see which spec is authoritative.
7. **Re-derive implementation plan + task list** from the revised spec.
8. **Resume** implementation from phase 1 of the revised plan.
9. **Plan-vs-actual reconciliation** in the handoff: ACs met-as-planned vs.
   met-by-alternative-mechanism vs. superseded.

## What pi-super-dev does today

- **Stagnation detection** (`src/stages/verify.ts`, Gap 4.6): the verify-loop
  records the merged review-findings signature each round; if the same
  non-empty set recurs twice consecutively, it breaks early with a log line.
  This is step 1 (pause) + a signal that pivot *may* be warranted.
- **Planned escalation UI (Tier-2 4.6′-lite):** when stagnation fires and the
  run is interactive (`ctx.hasUI`) with `escalation: "interactive"` set, surface
  the three-option choice to the user. In TUI/select mode this is the
  user-confirmation step (4). Headless runs fall back to an informative
  diagnostic written to the run summary + a `stagnation-report.md`.

## Anti-patterns (still apply)

- **Silent spec edit** — editing the spec in place without a revision artifact.
  No audit trail of *why*.
- **Pivoting without diagnostic artifacts** — if you can't show evidence the
  spec (not the implementation) is wrong, keep iterating.
- **Pivoting more than twice in one spec** — escalate to the user and pause;
  the problem is bigger than a design choice.
- **Skipping user confirmation** — cost/schedule trade-offs are the user's call.

## See also

- `iteration-loops.md` — the ordinary loop that this protocol branches from.
- `verification-gates.md` — the gate system whose exhaustion can trigger pivot.
