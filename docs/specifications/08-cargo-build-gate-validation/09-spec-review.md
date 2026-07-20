# Specification Review: Spec Review — Scope-aware Cargo Build Gate (08-cargo-build-gate-validation)

- **Date**: 2026-07-20
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

The specification is architecturally sound, strongly grounded in the actual build-runner.ts module, and traces all 12 ACs to four well-scoped layers (B: untracked union, C: defense-in-depth validation, D: spec-declared gate contract, E: test correction). The core implementation targets are verified: resolveCargoPackageNames@build-runner.ts:327 genuinely contains the two identity fallbacks the spec removes (whole-list @L342, per-element @L347); detectTouchedCargoPackages@:405 runs only `git diff --merge-base`; runBuildGate@:810 has the documented four-tier precedence; all three call sites (verify.ts:87, index.ts:53, implementation.ts:84) and P.buildSpecPrompt@writers.ts:58 are accurate; SpecificationData/RunOptions/services+openQuestions precedents and the scoped-argv helpers all exist; validatePackageNames is correctly absent (new). Grounding score is ~87% (20/23 references verified), which triggers a HIGH finding. Two HIGH grounding defects block a clean APPROVED: (1) the Architecture section names a non-existent test file `build-runner-autospace.test.ts` (actual: `build-runner-autoscope.test.ts`), creating an internal inconsistency with the Testing Strategy; and (2) `partitionErrorsByScope`/`isGreenForScope` are cited as must-stay-green helpers but neither exists anywhere in src/ or tests/. Additional MEDIUM gaps: test-correction scope names only one of ~6 sibling build-runner test files that could encode the same dir==name bug, and the integration-target validator leaves `memberDir` selection ambiguous under multi-package scope. No Critical defects; ACs appear fully covered; verdict APPROVED WITH REVISIONS pending the grounding fixes.

## Findings

### SR-01: Architecture section names a non-existent test file (autospace vs autoscope)

- **Severity**: high
The Architecture / LAYER E paragraph references `tests/build-runner-autospace.test.ts` ('autospace', with an 'n'), but the actual file on disk is `tests/build-runner-autoscope.test.ts` ('autoscope', with a 'c'). The Testing Strategy section uses the correct 'autoscope' spelling, so the spec is internally inconsistent AND grounds to a file an implementer will not find via literal path. Recommendation: correct the Architecture reference to `tests/build-runner-autoscope.test.ts` everywhere.
### SR-02: Hallucinated scope-classification helpers partitionErrorsByScope / isGreenForScope

- **Severity**: high
The Testing Strategy states: 'The scope-classification helpers (`partitionErrorsByScope` / `isGreenForScope`) must continue partitioning correctly.' A grep across both `src/` and `tests/` returns ZERO matches for either symbol. The repo does have `tests/build-runner-inscope-classification.test.ts`, but neither named function exists. An implementer cannot satisfy AC-11 ('confirm partitionErrorsByScope/isGreenForScope still work') against functions that do not exist, and the in-scope verdict comment in implementation.ts:85 references AC-05/SCENARIO-012-014 — suggesting the real helpers may be named differently (or are inline). Recommendation: either cite the actual helper names (verify via grep) or drop this clause and replace with the real in-scope classification surface the gate produces.
### SR-03: Test-correction scope names only one file; sibling build-runner tests may encode the same bug

- **Severity**: medium
LAYER E/AC-09/AC-10 scope all corrections to `build-runner-autoscope.test.ts`, but the repo contains at least five sibling files that plausibly assert on the same dir==name assumption or `-p data`-style argv: `build-runner-package-resolution.test.ts`, `build-runner-packages.test.ts`, `build-runner-package-wiring.test.ts`, `build-runner-scoped-args.test.ts`, and `build-runner-touched-crates.test.ts`. If any of these assert on the old identity fallback (which LAYER C removes) or on pre-union touched-set behavior (which LAYER B changes), the 'npm test fully green' AC-12 acceptance will fail. Recommendation: enumerate which sibling test files are explicitly in-scope for correction vs. guaranteed-unchanged, or add an AC asserting no sibling test encodes the dir==name identity fallback.
### SR-04: Integration-target validation leaves memberDir selection ambiguous under multi-package scope

- **Severity**: medium
LAYER D specifies that a `.rs`-suffixed or path-bearing integration target derives its stem and is validated by a filesystem stat of `<memberDir>/tests/<stem>.rs`. When the scoped package set contains MORE than one member (the common case — e.g. {stockfan-data, stockfan-workflows}), it is unspecified which `memberDir` is stat'd: the first surviving package, the union across all, or a per-target declared package. This ambiguity can cause a target to be silently dropped (miss stat) when the test file lives under a different member than the one chosen. Recommendation: state the selection rule explicitly (e.g. 'union: stat succeeds if ANY scoped member's tests/<stem>.rs exists') and add a SCENARIO covering a multi-package scope with a cross-member integration target.
### SR-05: Minor line-number drift in two citations

- **Severity**: low
SpecificationData is cited at `src/render/schemas.ts:221` but the `export const SpecificationData` declaration begins around line 224; RunOptions is cited at `src/types.ts:243` but `export interface RunOptions` is at line 242. Both are off by 1-3 lines. Low impact (nearby), but for a spec that elsewhere cites exact anchors used as implementation targets, this reduces grounding precision. Recommendation: re-anchor to the exact declaration lines.

## Dimension Reviews

### D1 Completeness

- **Status**: PASS-WITH-NOTES

All 12 ACs are mapped to architecture layers (AC-01→B, AC-02/03→C, AC-04-08→D, AC-09/10→E, AC-11/12→regression) and 38 BDD scenario refs are listed. Error handling (never-throw invariants), NFRs (no new deps, byte-identical for non-cargo/non-git/no-gate repos, perf: cached metadata + single new ls-files spawn) are all specified. Note SR-03: test-correction completeness may be under-enumerated across sibling build-runner test files. Score 4/5.
### D2 Consistency

- **Status**: NEEDS-REVISION

Internal inconsistency: Architecture section calls the test file 'build-runner-autospace.test.ts' while Testing Strategy calls it 'build-runner-autoscope.test.ts' (the real name). Terminology is otherwise uniform (precedence tiers, gate contract fields, spawn-hygiene language consistent throughout). Score 3/5.
### D3 Feasibility

- **Status**: PASS

Architecture fits existing patterns precisely: the proposed changes extend an existing module (build-runner.ts), reuse the existing cargoMetadataCache, CRATE_SEGMENT_RE, dedupePreservingOrder, scopedCargo*Args, and matchPackageBySegment; the new validatePackageNames helper is correctly absent today; the gate contract mirrors the existing services/openQuestions Type.Optional(Type.Object) precedent and the state.spec?.phases defensive-read pattern in implementation.ts. No circular deps, no new runtime deps, discrete-argv spawnSync preserved. Score 5/5.
### D4 Testability

- **Status**: PASS

Acceptance is concrete and measurable: 'npm run typecheck strict-clean' + 'npm test fully green'; byte-identical-output for non-cargo/non-git/no-gate repos; discrete-argv and no-spawn-on-empty-input assertions; metadata-cached-single-spawn and exactly-one-new-ls-files perf assertions; never-throw asserted via forced metadata-fail and unknown-name inputs. Thresholds are numeric/boolean. Score 5/5 (modulo SR-03 enumeration).
### D5 Traceability

- **Status**: PASS

Every AC has an explicit architecture-layer anchor and a SCENARIO range; phases P1-P5 in the prior-stage data map cleanly to layers C/B/D/E/regression and to AC ranges. SCENARIO-001..038 are referenced by ID (the BDD doc itself is external to this spec, which is the expected split). SR-02 weakens one traceability clause (helpers cited do not exist). Score 4/5.
### D6 Grounding

- **Status**: NEEDS-REVISION

Grounding score ~87% (20 of ~23 verifiable references confirmed against code): resolveCargoPackageNames:327 (+ both fallbacks), detectTouchedCargoPackages:405, runBuildGate:810, CRATE_SEGMENT_RE:158, loadCargoMetadata/cargoMetadataCache, matchPackageBySegment, dedupePreservingOrder, all 3 call sites, P.buildSpecPrompt@writers.ts:58, SpecificationData/RunOptions/services+openQuestions precedents, scopedCargo*Args, parseTestPackages, SUPER_DEV_BUILD_TEST_PACKAGES, theme test, validatePackageNames-correctly-absent — all verified. Two HIGH grounding misses (SR-01 misnamed test file, SR-02 hallucinated helpers) + minor line drift (SR-05). Below the 90% threshold → HIGH. Score 2/5.
### D7 Complexity

- **Status**: PASS

Change footprint is proportional to the defect: one core module (build-runner.ts) plus schema/types/prompt extensions; no touches to nodes.ts/workflow.ts/pipeline.ts/render/control-flow. The four-layer decomposition is justified (each layer is independently testable and addresses a distinct defect class from the diagnosis), and the precedence-tier model is the simplest viable extension of the existing four-tier gate. No premature optimization or gold-plating. Score 5/5.
### D8 Ambiguity

- **Status**: NEEDS-REVISION

Schemas are fully defined (TypeBox shapes for gate and RunOptions.gate); the five-tier precedence is explicit; the .rs/token branching rule for integration targets is stated; defaults are stated (omitted gate → byte-identical; empty surviving set → workspace-wide). Ambiguity gap SR-04: multi-package memberDir selection for integration-target stat is unspecified. Score 3/5.
