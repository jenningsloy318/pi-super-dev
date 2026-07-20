# Adversarial Review: Adversarial Review: cargo build-gate scope-aware fix (spec-08, Layers B–E)

- **Date**: 2026-07-20
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

The bulk of this change is correct: Layer B (untracked-file union via `git ls-files --others --exclude-standard`) and Layer C (drop-unresolved dirs, [] on metadata failure, `validatePackageNames` re-check) are implemented cleanly, never-throw, and are covered by `build-runner-package-wiring` + `build-runner-resolver-validation`. The `detectTouchedCargoPackages`/`resolveCargoPackageNames`/`validatePackageNames` trio is well-factored with a single cached `cargo metadata` spawn and safe degrade-to-[] semantics.

However, Layer D — explicitly described as "the real fix for backend server → run integration tests" and the headline deliverable of this task — is functionally broken end-to-end in two independent ways and has no tests that would have caught either:

1. `gate.integration` is validated through `validatePackageNames`, which checks cargo *package-name* membership, but `integration` holds *test-target file paths* (e.g. `crates/workflows/tests/e2e_screen_us_fallback.rs`). Every integration target is therefore silently DROPPED, and even survivors would be emitted as invalid `-p <path>` flags. There is no machinery for the `cargo test --test <name>` invocations the contract describes.
2. The spec-generation prompt was never updated. Nothing instructs the specification agent to declare `gate`, so `state.spec?.gate` will be undefined in essentially every real run and the entire top-precedence tier never fires — a textbook "implemented-but-not-wired-in" helper.

Both are acceptance criteria (AC-04, AC-06, AC-09) that are unmet. I score this CONTEST rather than REJECT only because the calibration reserves REJECT for production/data-loss/security exposure, and this is a dev-tool build gate — but the mandated stockfan e2e would silently never run, so if "the integration test must actually execute" is treated as the hard contract, this tips to REJECT. Net: the diff ships a correct B+C on top of an inert D; D needs another pass before merge.

### ADV-01: gate.integration is validated as cargo package names but holds file paths — every target is silently dropped

- **Severity**: high
- **Lens**: Skeptic
`runBuildGate` does `gateIntegration = validatePackageNames(cwd, gate.integration)`. `validatePackageNames` (build-runner.ts:383-419) builds `known = new Set(meta.packages.map(p=>p.name))` and keeps only names in `known`. But per the task spec and the schemas.ts example, `integration` holds TEST-TARGET PATHS like `crates/workflows/tests/e2e_screen_us_fallback.rs`. A path is never a package name, so the filter returns `[]` for every realistic input — `gateIntegration` is always empty. Net: AC-04/AC-06's integration feature is dead in practice; the stockfan e2e acceptance criterion (AC-06) silently no-ops. Recommend: integration is NOT a package list — do not run it through the package validator. Either resolve paths→test-target stems separately and emit additional `cargo test --test <stem>` commands (the spec's stated intent), or drop the field until that machinery exists rather than shipping a silently-dropping validator.
### ADV-02: Surviving integration targets would be emitted as invalid `-p <path>` flags, not as `cargo test --test` invocations

- **Severity**: high
- **Lens**: Architect
Even ignoring ADV-01, after the (always-empty) gateIntegration is appended to `testPackages`, that list feeds `scopedCargoBuildArgs`/`scopedCargoTestArgs`/`scopedCargoClippyArgs` (975-978) which produce `-p <each>`. So an integration path like `crates/workflows/tests/e2e_x.rs` would become `cargo build -p crates/workflows/tests/e2e_x.rs` — invalid cargo, AND applied to build/clippy, not just test. The spec contract is 'additional `cargo test --test <stem>` invocations ... on top of the scoped packages.' There is no code path in `runBuildGate` that emits an EXTRA command — the three cmds (build/test/clippy) are fixed. The implementation fundamentally mismatches the documented contract. Recommend adding a separate extra-cmd emission for integration targets scoped to the test subcommand only.
### ADV-03: The spec-generation prompt was never updated — nothing tells the LLM to declare `gate`, so Layer D is dead code in real runs

- **Severity**: high
- **Lens**: Architect
AC-04 explicitly requires 'spec prompt instructs agents to declare it for backend features.' The schema field (`schemas.ts:233`) and `GateOptions` exist, the three call sites thread `state.spec?.gate as GateOptions` (index.ts:53, verify.ts:87, implementation.ts), but a grep of src/stages + src/prompts.ts + src/render for any declare/instruct/backend/integration text touching `gate` returns NOTHING. The specification writer (`ln` in writers.ts) has no gate instruction in its prompt. Therefore `state.spec?.gate` is undefined for virtually every real run and the new top-precedence tier (spec → env → auto-detect → workspace) NEVER executes in production. This is exactly the 'implemented-but-not-wired-in helper that survives every review' pattern from learned.md (score:62). The wiring is complete; the producer is absent. Recommend: add a concrete instruction to the specification prompt naming when to emit `gate` (backend/integration features), the exact shape, and that names must match `cargo metadata` members.
### ADV-04: No test passes opts.gate to runBuildGate — the required gate-contract test (AC-09) is missing; precedence + workspace short-circuit untested

- **Severity**: high
- **Lens**: Skeptic
Layer E / AC-09 requires 'a new spec-declared gate-contract test: RunOptions.gate = {packages, integration} → gate uses those names + appends integration.' Grep of tests/ for `runBuildGate(.*gate:` / `gate: {` / `gate.packages` returns zero hits. The 'runBuildGate validator wiring (AC-03)' describe block exercises env/opt/auto-detect sources only — never the `opts.gate` tier. Result: the headline precedence (AC-05), the `workspace:true` short-circuit (AC-04), and the integration append are all UNTESTED, which is precisely why ADV-01/ADV-02 reached merge. Recommend: add a test that (a) passes `gate.packages` and asserts the scoped argvs, (b) `gate.workspace:true` → byte-identical workspace-wide, (c) `gate.packages` with an unknown name → dropped → widened, (d) `gate.integration` → extra `cargo test --test` (once ADV-02 is fixed).
### ADV-05: GateOptions conflates package-names and integration-paths into one validated string[] flow — type system gives no signal they diverge

- **Severity**: medium
- **Lens**: Architect
`GateOptions.packages` and `GateOptions.integration` are both `string[]`, and both currently flow through `validatePackageNames` keyed on package-name membership. This is the structural cause of ADV-01: the type system cannot distinguish 'a cargo package name' from 'a test-target path', so the wrong validator was applied with no compiler help. Recommend modeling them distinctly (e.g. an `IntegrationTarget` discriminated shape, or a separate `validateIntegrationTargets` that maps path→`--test <stem>`) so the divergence is enforced by types, not by hope.
### ADV-06: Redundant re-validation and triplicated try/catch→[] boilerplate; final validatePackageNames re-checks already-validated gate output

- **Severity**: low
- **Lens**: Minimalist
`validatePackageNames` is called 3x in `runBuildGate` (gate.integration 924, gate.packages 930, final re-check 959). When the gate tier is the source, testPackages is ALREADY validated-package-name output, so the unconditional final re-check (957-960) is idempotent-but-redundant on that path (a wasted Set-membership pass against cached metadata). More broadly, `resolveCargoPackageNames`/`validatePackageNames`/`detectTouchedCargoPackages` each repeat a near-identical filter→try→catch([]) scaffold with long JSDoc restating the 'never throws' invariant. Minor; consider guarding the final re-check with the source tier or extracting the shared normalize+never-throw envelope so the invariant is stated once.
### ADV-07: matchPackageBySegment nested-first fallback is order-dependent on cargo metadata package ordering; no test pins the multi-nested case

- **Severity**: low
- **Lens**: Skeptic
UNCERTAIN. `matchPackageBySegment` prefers an exact crate root (`crates/<seg>`) and otherwise keeps the FIRST nested match for determinism. That is reasonable, but 'first' is defined by `cargo metadata`'s package array order, which is stable today but not contractually guaranteed. If two nested members share a top segment with no exact root (e.g. `crates/data/a` and `crates/data/b` both touched as 'data'), the chosen package is implicit. No test covers the multi-nested-per-segment case (the package-wiring fixture only has one member per segment). Low risk for the stockfan shape (dir==segment, single crate each), but worth a deterministic tie-break test or a documented invariant. Flagged UNCERTAIN because the current behavior may be intentional.
