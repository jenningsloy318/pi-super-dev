# Adversarial Review: Adversarial Review — spec-03-scope-aware-build-gate

- **Date**: 2026-07-21
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: CONTEST

---

The implementation is well-engineered at the unit level: typecheck is clean (tsc --noEmit), all 674 tests pass, the change is backward-compatible (empty-set ⇒ byte-identical workspace-wide argv; additive BuildGateResult fields; classifier never throws and never grants a false green), and the scoped-argv family + precedence + auto-detection + classifier are each independently testable with good coverage. The four-tier precedence and the "explicit [] forces workspace-wide" semantics are correct.

However, the work only partially achieves its stated intent ("stop false-failing and false-aborting on messy real-world monorepos") for three structural reasons that standard review would miss:

(1) ASYMMETRY — the in-scope verdict is wired into exactly ONE of three gate consumers. implementation.ts (Stage 9.2) honors gate.inScopePass, but verify.ts buildGate (Stage 9) returns only {pass, ran, errors} and the Stage 10 reviewFix step feeds the FULL errors array to the implementer with "make these pass." So the same pre-existing out-of-scope clippy/test failures that no longer abort implementation will re-surface in verify's gate and, worse, will actively induce the implementer to edit out-of-scope crates during reviewFix — the literal opposite of scope-awareness. The false-abort relocates rather than disappears.

(2) CLASSIFIER FRAGILITY — out-of-scope detection depends on a `crates/<pkg>/` or `-p <pkg>` marker surviving into the captured 12-line stderr/stdout tail. Test-failure listings (`failures:`, `---- name stdout ----`) and final summaries frequently contain neither marker, so the commonest pre-existing-failure type (a failing test in an untouched crate) is often classified IN-SCOPE and the false-abort persists. It is conservative (no false-green) but defeats the feature for its primary use case.

(3) LAYOUT/REF ASSUMPTIONS — auto-detection only matches a `crates/<pkg>/` directory convention and defaults the base ref to `main`; repos using top-level member dirs, `members=["*"]`, or branches like `master`/`trunk` silently fall back to workspace-wide with no signal, in exactly the failure mode this PR was built to fix.

None of these are production-failure / data-loss / security risks, so the calibrated verdict is CONTEST (quality concerns requiring author response), not REJECT. Recommend: thread inScopePass into verify.ts + filter reviewFix's buildErrors to inScopeErrors; widen marker capture (larger tail or parse full cargo output, incl. the `rerun \`cargo test -p <pkg>\`` note); detect the real default branch or emit a one-line log when the base ref is unresolved.

### AR-01: In-scope verdict applied in only 1 of 3 gate consumers — false-abort relocates to verify/reviewFix

- **Severity**: high
- **Lens**: Architect
gate.inScopePass / outOfScopeErrors are consumed ONLY in src/stages/implementation.ts:85-92. verify.ts buildGateStep (verify.ts:81-90) returns `{ pass: r.pass, ran, errors }` — it drops inScopePass entirely — and `buildGreen` (verify.ts:42-45) keys off `b.pass !== false`. The Stage 10 reviewFix step (verify.ts:101-110) then feeds the FULL `s.buildGate.errors` into the implementer prompt as '## Build/test gate failures (make these pass)'. Net effect: the pre-existing out-of-scope failures that implementation.ts now treats as GREEN still (a) make verify's gate FAIL, and (b) are handed verbatim to the implementer during reviewFix as things to fix — actively inducing edits to out-of-scope crates (scope creep), the opposite of the feature's goal. The change is scoped to two files per the task constraints, but the consequence is that the root cause (blunt gate) is only half-addressed; the abort moves from Stage 9.2 to Stage 9/10. Recommend threading inScopePass into verify.ts's gate result and filtering reviewFix's buildErrors to the in-scope subset (gate has outOfScopeErrors available — surface it).
### AR-02: Out-of-scope classification hinges on crate markers surviving a 12-line tail — fragile for the headline use case

- **Severity**: high
- **Lens**: Skeptic
classifyOutOfScopeErrors (build-runner.ts) extracts `crates/<pkg>/` and `-p <pkg>` markers. But the gate only retains the LAST 12 lines: `const tail = (r.stderr||r.stdout||'').trim().split('\n').slice(-STDERR_TAIL_LINES)...` (STDERR_TAIL_LINES=12). A pre-existing failing TEST in an out-of-scope crate commonly produces a tail like `running N tests\ntest foo::bar ... FAILED\n...\nfailures:\n---- foo::bar stdout ----` with NEITHER a `crates/` path NOR a `-p` marker in those last 12 lines (the panic-location line `crates/compute/tests/x.rs:NN` and cargo's `rerun \`cargo test -p compute\`` note sit earlier in the output). Such a block is classified IN-SCOPE (conservative default), so inScopePass stays false and the false-abort persists — for precisely the failure class the PR targets (reports_test.rs, job_queries_test.rs in the evidence). The classifier is sound for compile/clippy errors (which always emit `--> crates/<pkg>/...`) but unreliable for test failures. Recommend enlarging the retained tail for rust, or scanning full stdout for the rerun `-p <pkg>` note, before relying on inScopePass.
### AR-03: Dependency-cascade can commit in-scope code that did not actually build

- **Severity**: medium
- **Lens**: Skeptic
When the in-scope crate (e.g. `data`) depends on an out-of-scope crate (`compute`) that has a pre-existing compile error, `cargo build -p data` transitively builds `compute`, which fails with `--> crates/compute/...` markers. The classifier marks that error OUT-OF-SCOPE (compute ∉ touched set) ⇒ inScopePass=true ⇒ implementation.ts treats the phase GREEN and commits. But `data` itself never compiled successfully — its dependency broke. The classifier cannot distinguish 'compute failed independently' from 'compute failed as a transitive dep of the in-scope build.' This can let genuinely broken in-scope code ship. Mitigation is non-trivial (would need the #3 baseline-diff explicitly deferred), so at minimum the summary/log should flag when out-of-scope crates appear in the build graph of an in-scope crate.
### AR-04: Documented env example produces a broken cargo argv

- **Severity**: medium
- **Lens**: Skeptic
The module docstring (build-runner.ts, SUPER_DEV_BUILD_TEST_PACKAGES section) gives `Example: SUPER_DEV_BUILD_TEST_PACKAGES="crates/api,crates/store"`. But parseTestPackages only trims/dedupes — it does NOT strip a `crates/` prefix — so this value flows straight into `cargo test -p crates/api --quiet`, which cargo rejects (invalid package spec; `-p` wants a name/glob, not a path). A user following the documented example gets a hard gate failure. Either fix the doc example to `api,store` or have parseTestPackages strip an optional `crates/` prefix. (The classifier is unaffected because pathRe requires a trailing slash and `-p crates/api` has none, so no false-green — but the gate itself breaks.)
### AR-05: Auto-detection only matches `crates/<pkg>/`; other Cargo layouts and a wrong base ref silently no-op

- **Severity**: medium
- **Lens**: Architect
detectTouchedCargoPackages regex is `/(?:^|\/)crates\/([^/]+)\//` — it hardcodes the `crates/<pkg>/` convention. Workspaces with top-level member dirs (`members = ["api","data"]`), `members=["*"]`, or nested layouts produce [] ⇒ workspace-wide ⇒ the feature silently does nothing. Separately, the base ref defaults to `main` and a non-zero git exit (repo on `master`/`trunk`/`develop`, or only `origin/main` present) also yields [] with NO log signal — so the headline benefit vanishes in the exact failure mode (false-abort on a repo whose default branch isn't `main`) this PR was meant to fix. Recommend: (a) fall back to `git symbolic-ref refs/remotes/origin/HEAD` / `git config init.defaultBranch` when `main` is unresolved, and (b) emit one `ctx.log`/console line when auto-detection resolves to [] so operators can tell scoping is inactive.
### AR-06: Duplicated, divergent marker-extraction logic between classifier and implementation.ts

- **Severity**: low
- **Lens**: Architect
implementation.ts:22 cratesFromErrors re-implements the same two marker regexes as classifyOutOfScopeErrors but DIVERGES: it scans the WHOLE error block (including the `cargo test -p data ... FAILED` label, which always carries the scoped packages) and uses `(?:^|\s)-p` instead of the classifier's `(?<!\w)-p`. Consequence: the 'crates: ...' suffix in the IN-SCOPE GREEN log will always echo the in-scope scoped packages from the label, not the actual out-of-scope failure crates — misleading. Two implementations of one contract is a drift hazard. Extract a single shared helper (or have runBuildGate return the resolved failure-crate list) and reuse it.
### AR-07: git diff re-spawned on every gate call; touched set is invariant within a run

- **Severity**: low
- **Lens**: Minimalist
implementation.ts calls runBuildGate up to 3× per phase × N phases; each call, when no higher precedence tier applies, re-runs detectTouchedCargoPackages → `git -C <cwd> diff --merge-base main --name-only`. The touched-crate set cannot change during a single pipeline run, so this is up to ~3×N redundant process spawns (plus their git I/O on large diffs). Compute once (e.g. resolve in the stage and pass via opts.testPackages, or memoize inside the module keyed by cwd+ref) and reuse. Not a correctness issue — pure waste.
### AR-08: scopedCargoArgs exported for only two internal call sites

- **Severity**: low
- **Lens**: Minimalist
scopedCargoArgs is exported (public module surface) yet is consumed only by scopedCargoBuildArgs/scopedCargoTestArgs/scopedCargoClippyArgs inside the same file. No external caller needs it. Could be unexported (module-private) to keep the public API minimal and prevent accidental dependence on the raw core. Minor; the type-narrowing CargoSubcommand union is a nice touch.
