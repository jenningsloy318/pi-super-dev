# Code Review: Code Review: cargo build-gate validation (Layers B–E)

- **Date**: 2025-11-10
- **Author**: super-dev:code-reviewer
- **Verdict**: Blocked

---

## Verdict: Blocked

Layers B (untracked union) and C (defense-in-depth: drop-unresolved + member-map validation) are correctly implemented and well-tested — detectTouchedCargoPackages now unions `git diff --merge-base` with `git ls-files --others`, resolveCargoPackageNames drops unknown dirs and returns [] on metadata failure, and a new validatePackageNames helper re-checks every candidate before any `-p` is built. The never-throw degrade-to-workspace-wide invariant holds (the exec loop even gained a try/catch), discrete-argv spawnSync is preserved, no new runtime deps, and `npm run typecheck` is strict-clean.

However the task cannot be approved: AC-4's `gate.integration` is implemented with the WRONG semantics (validated as package *names* and appended as `-p` flags, where the spec requires `cargo test --test <stem>` targets), which silently drops the spec's own example e2e path and defeats Layer D's purpose; the entire Layer-D gate-contract path is UNTESTED at the runBuildGate level (AC-5 not met); and `npm test` is RED — 5 backward-compat/nonregression tests break because Layer B's second git spawn was never reflected in their "exactly one git diff" assertions (AC-7 not met). These are Critical blockers. Dimension scores: Correctness 2/5, Security 4/5 (no injection; discrete argv), Performance 4/5 (cached metadata), Concurrency 4/5, Maintainability 3/5, Testability 2/5 (Layer D untested, suite red), Error-Handling 5/5, Observability 3/5, Data-Integrity 4/5.

## Findings

### F1: gate.integration implemented as package names + -p flags, not cargo test --test <stem> targets (AC-4 wrong semantics)

- **Severity**: Critical
- **File**: `src/build-runner.ts`
- **Line**: 924, 965, 977
The spec (AC-04 / Layer D) defines `integration` as "extra test target paths/binaries to also run (e.g. `cargo test --test <name>` or the e2e path)" and AC-04 says "`gate.integration` targets are APPENDED to the test command (e.g. additional `cargo test --test <stem>` invocations ...)". The implementation does the opposite: line 924 validates `gate.integration` as cargo package NAMES (`validatePackageNames(cwd, gate.integration)`), line 965 appends the survivors to `testPackages`, and line 977 feeds the whole set through `scopedCargoTestArgs` so integration entries become `cargo test -p <integration>`. Two consequences: (1) the spec's own canonical example `integration: ["crates/workflows/tests/e2e_screen_us_fallback.rs"]` is a FILE PATH, which is not a member name, so `validatePackageNames` DROPS it → the mandated e2e silently never runs, which is exactly the failure Layer D was meant to fix; (2) if any integration value *did* survive (e.g. a name that coincides with a package), it would be emitted as `cargo test -p <value>`, an invalid target spec. Fix: do NOT route integration through validatePackageNames or the -p set. Resolve each integration entry to a test-binary stem (strip dir/ext, or accept a bare stem) and append a SEPARATE `cargo test --test <stem>` invocation to cmds.test (or an additional exec() call). Validate/normalize stems independently of the package member map.
### F2: npm test is RED: 5 nonregression tests assert exactly one git spawn, but Layer B now always adds a second (git ls-files --others) — AC-7 not met

- **Severity**: Critical
- **File**: `tests/build-runner-nonregression.test.ts`
- **Line**: 220,242,274,390,415
`npm test` currently fails 5 cases in build-runner-nonregression.test.ts (SCENARIO-015 x3, SCENARIO-018, SCENARIO-026) with `expected ... to have a length of 1 but got 2`. They encode the OLD contract ("exactly ONE read-only git diff", "no extra spawns beyond one git diff") but Layer B deliberately adds `git ls-files --others --exclude-standard` to every rust auto-detect path. AC-7 explicitly requires "ALL existing tests pass (npm test) AFTER the test corrections" and AC-8 requires non-cargo/no-gate runs unchanged; the tests were never corrected to expect 2 git spawns. This also means the deliverable's own gate ("vitest green") is not satisfied. Fix: update these assertions to expect 2 git spawns (diff + untracked) on the rust auto-detect path, keep 0 for non-rust, and refresh the SCENARIO-018/026 doc strings that still promise "one git diff".
### F3: Layer D gate-contract path (gate:{packages,workspace,integration}) has ZERO runBuildGate-level test coverage — AC-5 not met

- **Severity**: High
- **File**: `tests/build-runner-package-wiring.test.ts`
- **Line**: 1
AC-05 requires "a new spec-declared gate-contract test: `RunOptions.gate = { packages: [...], integration: [...] }` → gate uses those names (validated) + appends the integration target, ignoring auto-detect." grep across tests/ shows NO test calls `runBuildGate(cwd, { gate: {...} })` (no `gate: {` literal anywhere; runBuildGate calls in build-runner-resolver-validation.test.ts only use `{ testPackages }` or no opts). The new precedence tier (spec.gate → opt → env → auto-detect → workspace-wide), the workspace short-circuit, the validate-then-append flow, and AC-6's "declared names validated against metadata" are all unverified — and given F1, this untested path is in fact broken. Fix: add a hermetic runBuildGate test that (a) supplies gate.packages and asserts the scoped -p argv + that env/auto-detect are ignored; (b) asserts gate.workspace===true yields workspace-wide; (c) asserts an unknown declared package is dropped; (d) asserts integration is appended as a `--test` invocation (once F1 is fixed).
### F4: gate.workspace===true does NOT short-circuit to workspace-wide when integration is non-empty (contradicts documented contract)

- **Severity**: Medium
- **File**: `src/build-runner.ts`
- **Line**: 926, 964-965, 977
Spec AC-04: "`gate.workspace === true` short-circuits to workspace-wide (ignores packages)" and the schema JSDoc repeats "workspace: true short-circuits to workspace-wide (no -p flags)". But when workspace===true, testPackages is set to [] (line 927), then the unconditional append at 964-965 repopulates it with gateIntegration, so `testPackages.length > 0` becomes true and the scoped branch at ~843 builds `cargo test -p <integration>` — neither workspace-wide nor valid. Fix: either skip the integration append when workspace===true, or (once F1 lands) emit integration as separate --test invocations while keeping the build/clippy/test base commands workspace-wide (no -p).
### F5: RunOptions.gate is declared but never populated; stages read state.spec?.gate directly with a cast

- **Severity**: Low
- **File**: `src/stages/implementation.ts`
- **Line**: 84
types.ts adds `gate?: {...}` to RunOptions (good for the documented threading), but implementation.ts:84, verify.ts, and index.ts all bypass it — they read `(state.spec?.gate) as GateOptions | undefined` and pass it straight to runBuildGate opts. The RunOptions.gate field is therefore dead at runtime (no caller ever sets opts.gate on a RunOptions object), and the `as GateOptions` cast hides whether state.spec's inferred type actually includes `gate`. Functionally OK, but the spec's "thread through RunOptions" is nominal rather than real. Fix: either thread gate through the stage's RunOptions/options so the cast is unnecessary, or drop the unused RunOptions.gate field to avoid a misleading API. Also verify state.spec's type (SpecificationData-derived) includes `gate` so the cast can be removed.
### F6: Spec requires a 'clear log line' when declared gate packages are dropped; none is emitted

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 924, 930
Layer D states: "Validate declared `gate.packages` against the `cargo metadata` member map (same resolver); drop unknown ones with a clear log line, never emit invalid `-p`." validatePackageNames silently filters; runBuildGate has no logging path and emits no message about dropped names. In a real run a misspelled declared package (e.g. `stockfan-workflow` vs `stockfan-workflows`) would vanish with no signal, making debugging hard. Fix: capture dropped names (input − validated) and surface them via the existing ctx.log/ran/errors channel or a debug field, at least for the gate.packages/gate.integration paths.
### F7: git ls-files --others lists ALL untracked files, not just those added since base ref (potential scope over-broadening)

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 467
Layer B unions `git ls-files --others --exclude-standard` over the whole working tree. Unlike `git diff --merge-base <ref>`, this lists every never-committed file (scratch files, editor artifacts not matched by .gitignore, vendored drops) and will pull their crate dir into scope. This is the desired behavior for the stockfan case (new e2e is untracked) and is consistent with the spec's intent, but it can widen scope unexpectedly in messy worktrees. Acceptable as-is given the spec, but worth documenting at the call site and/or scoping the untracked list to changed paths when feasible.
