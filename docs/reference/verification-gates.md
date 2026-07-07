# Verification Gates (reference)

> **Provenance:** Adapted from the original `super-dev-plugin` reference. This
> document describes the *design intent* of the gate system and maps it to
> pi-super-dev's actual implementation. It is reference for contributors and for
> the reflection agent — the live source of truth is `src/helpers.ts`,
> `src/doc-validators.ts`, and the `gate()` nodes in `src/stages/index.ts`.

## Principle

Gates are the deterministic checkpoints that turn "the agent said it's done"
into "it is actually done." Two kinds:

1. **Content gates** — validate the rendered `.md` artifact itself (not the
   agent's self-reported control JSON). Implemented as pure functions in
   `src/doc-validators.ts` (`requirementsContentErrors`, `bddContentErrors`,
   `specContentErrors`, `specReviewContentErrors`, …).
2. **Metadata gates** — assert structural facts (build success, test pass,
   review verdict). These are the vacuous-pass-prone ones: a model can report
   green without running anything.

## How gates execute in pi-super-dev

Gates run via the `gate()` control-flow node (`src/nodes.ts`):

```
gate({ validate, feedbackKey, attempts: 4 }, task(writer))
```

- `validate` is a predicate that calls a helper (`runHelper("gate-…", …)`).
- On failure, the gate stores the validator's **structured errors** under
  `state.__feedback[stageKey]`, which `workflow.ts` prepends to the next
  attempt's prompt. This is *feedback-driven convergence*: the writer fixes the
  specific failures instead of resampling (the fix for the old "gate failed 3×"
  anti-pattern).
- Non-fatal exhaustion: after `attempts` rounds the pipeline proceeds with the
  issue documented, rather than aborting.

## Gate map

| Stage transition | Gate | Implementation | Checks |
|------------------|------|----------------|--------|
| requirements → bdd | `gate-requirements` | `gateRequirements` helper | ACs present (≥2), NFRs, summary |
| bdd → research | `gate-bdd` | `gateBdd` helper | SCENARIO-ids, Given/When/Then, AC traceability |
| research complete | (inline predicate) | `researchComplete` in `stages/index.ts` | Report exists + all open issues resolved |
| spec → spec-review | `gate-spec-trace` | `gate-spec-trace` helper | Spec references BDD scenarios, testing strategy |
| spec-review | **signal, not a gate** | `specReviewWriter` task | A "Changes Requested" verdict flows forward as judgment, not a block |
| implementation (per phase) | **build** | `runBuildGate` (`src/build-runner.ts`) | Build + test + typecheck **actually run** (deterministic hard oracle) |
| verify-loop exit | review + tests + build | `approvedAndGreen` + stagnation | Merged verdict Approved ∧ tests green ∧ build green, OR stagnation break |
| pre-merge | build | `preMergeBuildStage` | Merge skipped if the build gate actually failed |

## Key difference from the original

The original ran build via a separate `gate-build.sh` invoked by a `doc-validator`
agent. **pi-super-dev runs build/test/typecheck deterministically in-process**
(`runBuildGate`, Gap A) instead of trusting a QA agent's self-reported
`buildSuccess`/`allTestsPass`. This closed the vacuous-pass risk at the
implementation and merge gates.

## Not implemented (deferred)

- `implementation-complete` gate (all phases marked complete in a tracking
  JSON) — pi-super-dev trusts the per-phase `runBuildGate` green signal instead.
- `docs-drift` gate — the render pipeline produces docs deterministically, so
  existence is implicit; TODO-scanning is not gated.
