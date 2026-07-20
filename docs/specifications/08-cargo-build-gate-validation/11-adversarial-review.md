# Adversarial Review: Adversarial Review: 08-cargo-build-gate-validation (Layers B/C/D/E)

- **Date**: 2026-07-20
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: REJECT

---

Two of the four required deliverable layers are entirely unimplemented, including the motivating bug fix and the layer the task explicitly calls "the real fix." What shipped (Layer C defense-in-depth + Layer E test corrections) is high quality: `validatePackageNames` reuses the cached metadata, both identity fallbacks were removed from `resolveCargoPackageNames`, `runBuildGate` re-validates every candidate before building `-p` flags, the spawnSync loop is now try/caught (never throws), typecheck is strict-clean, and the corrected `build-runner-package-wiring.test.ts` correctly asserts `-p stockfan-*` rather than the buggy `-p data`. BUT: (1) Layer B — the `git ls-files --others --exclude-standard` union — does not exist anywhere; `detectTouchedCargoPackages` still runs only `git diff --merge-base --name-only`, so the stockfan untracked e2e (`crates/workflows/tests/e2e_screen_us_fallback.rs`) is STILL dropped from scope, leaving the build gate blind to exactly the regression it was created to catch. (2) Layer D — the spec-declared `gate: { packages?, workspace?, integration? }` contract — is absent from `src/types.ts` (RunOptions has no `gate` field), `src/render/schemas.ts` (SpecificationData unchanged), all `src/stages/*.ts`, and `runBuildGate`'s precedence tier (still just opts→env→auto-detect→workspace, with no spec-gate tier). This means AC-01, AC-03/04/05/06/08/09/10/12 are unmet. The targeted tests pass only because the untested behaviors were never written — a textbook false-green gap. Reject because the gate oracle is still wrong for the precise production scenario (untracked e2e) it was scoped to fix; a broken build would emit a false GREEN.

### AR-01: Layer B (untracked-file union) is not implemented — the motivating bug persists

- **Severity**: blocker
- **Lens**: Skeptic
spec-08's stated root cause is that `git diff --name-only` is invisible to untracked files, so the untracked `crates/workflows/tests/e2e_screen_us_fallback.rs` was dropped and the mandated e2e never ran. The fix requires unioning `git -C <cwd> diff --merge-base <ref> --name-only` with `git -C <cwd> ls-files --others --exclude-standard` before extracting `crates/<seg>/`. grep across src/ + tests/ for `ls-files|--others|exclude-standard` returns ZERO matches. `detectTouchedCargoPackages` (src/build-runner.ts:467-485) still spawns only `git diff --merge-base ref --name-only`. Consequence: an untracked-only change under `crates/workflows/` yields an empty scope → workspace-wide or skipped → AC-01 and AC-06 unmet; the stockfan regression is NOT fixed. This is a production-correctness failure: the 'HARD test oracle' gate can emit a false GREEN on the exact scenario it targets.
### AR-02: Layer D (spec-declared gate contract) is entirely absent across schema, RunOptions, stages, and the gate

- **Severity**: blocker
- **Lens**: Architect
The task names Layer D 'the real fix for backend→run integration tests.' None of it exists: (a) RunOptions (src/types.ts:243-262) has NO `gate` field — confirmed by reading the interface body; (b) src/render/schemas.ts SpecificationData has no `gate` (grep returns nothing); (c) no stage prompt (src/stages/*.ts) instructs the specification agent to declare `gate`; (d) implementation.ts/verify.ts/index.ts do not read `state.spec?.gate`; (e) runBuildGate's precedence (src/build-runner.ts:~876) is still `opts.testPackages → SUPER_DEV_BUILD_TEST_PACKAGES → auto-detect → []`, with no spec-gate tier, no `gate.workspace===true` short-circuit, and no `gate.integration` appending. AC-03 (spec→env→auto-detect precedence), AC-04, AC-05, AC-06, AC-08, AC-09, AC-10, AC-12 are all unmet. The phase plan P3-gate-contract was planned but appears never executed.
### AR-03: Missing acceptance tests: no untracked-file case, no spec-gate-contract case, no precedence test

- **Severity**: high
- **Lens**: Skeptic
AC-05 requires (i) an untracked-file case where the ONLY change in crates/workflows/ is an untracked e2e via `git ls-files --others` → `stockfan-workflows` still appears, and (ii) a spec-declared-gate-contract test driving scope via RunOptions.gate. Neither exists. The closest test (tests/build-runner-package-wiring.test.ts:221) calls `resolveCargoPackageNames("/repo", ["workflows"])` directly — it tests the RESOLVER on a pre-extracted segment, NOT that `detectTouchedCargoPackages` picks up an untracked file. So the union behavior is neither implemented nor tested. Because the two touched test files are green, a superficial 'npm test passed' check would falsely conclude completeness; the green result is an artifact of omitted coverage, not correctness.
### AR-04: AC-11 (full `npm test`) unverified — only 2 of ~13 build-runner test files were run

- **Severity**: medium
- **Lens**: Skeptic
`detectTouchedCargoPackages` had its return semantics changed from RESOLVED package names to raw DIRECTORY segments (src/build-runner.ts:480-485, comment: 'Returns raw DIRECTORY segments'). While build-runner-touched-crates.test.ts asserts segments (consistent), any other consumer that relied on the prior resolved-name output (post spec-07) would now get segments. Review only executed `build-runner-resolver-validation` + `build-runner-package-wiring`; the remaining ~11 build-runner files, the theme-binding test, and the full suite were NOT run. AC-11 explicitly requires ALL existing tests pass; this is unverified and at risk given the public-function contract change.
### AR-05: Public API contract drift: detectTouchedCargoPackages silently changed return semantics

- **Severity**: medium
- **Lens**: Architect
Previously (spec-07) this exported function resolved segments to real cargo package names internally. It now returns raw directory segments and pushes resolution into `runBuildGate`. The comment acknowledges this, but the function NAME (`...Packages`) and its JSDoc summary ('De-duplicated touched crate names') now mislead: callers get `data` not `stockfan-data`. An external/imported caller assuming resolved names would silently build a wrong `-p`. Recommend either renaming or adding a sharp JSDoc note that the output is segments, and auditing all importers. This is a latent footgun even though the in-repo tests happen to expect segments.
### AR-06: Entire deliverable is uncommitted in the working tree

- **Severity**: low
- **Lens**: Minimalist
`git status` shows ` M src/build-runner.ts`, ` M tests/build-runner-package-wiring.test.ts`, untracked `tests/build-runner-resolver-validation.test.ts` and `docs/specifications/08-.../` — all uncommitted. No commit captured this work, so nothing is reviewable/mergeable as-is and there is no atomic record of which layers landed. Not a code defect, but it blocks AC delivery (merge) and makes the 'Phases Completed' claim unverifiable from git history.
