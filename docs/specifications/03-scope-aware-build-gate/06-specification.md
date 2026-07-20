# Specification: Scope-Aware Build Gate — Auto-scope cargo gate to touched crates and classify in-scope vs pre-existing out-of-scope failures

- **Date**: 2026-07-20

---

## Summary

TECHNICAL SPECIFICATION.

Problem: The super-dev build-gate (`src/build-runner.ts#runBuildGate`) runs `cargo build && cargo test && cargo clippy --all-targets` WORKSPACE-WIDE. On messy real-world Rust monorepos (evidence: failed run 2026-07-19 on stockfan-server spec 54), pre-existing failures in crates the current branch never touched (e.g. `reports_test.rs`, `stockfan-compute` clippy lints, `job_queries_test.rs`) flip the gate FAIL. The implementation retry loop (`src/stages/implementation.ts`) treats every gate FAIL identically, and after `MAX_ATTEMPTS=3` binary-terminates ALL remaining phases ("terminating early"). Net: Stage 9 aborts on green in-scope code, so Phases 2–6 never run. Two root causes: (a) commit 97fc4df6 only scopes the `test` argv (`build-runner.ts:301` overrides only `cmds.test`), leaving `build` and `clippy`/typecheck workspace-wide; (b) the retry loop has no concept of in-scope vs out-of-scope failures.

Scope: Pure TypeScript change to `src/build-runner.ts` + `src/stages/implementation.ts` (+ co-located tests). No changes to `nodes.ts`, `workflow.ts`, `pipeline.ts`, render templates, or the control-flow engine. No new runtime deps; no new spawned processes beyond existing gate commands plus one `git diff --merge-only`.

Solution (4 capabilities):
1. Auto-detect touched cargo crates via `git -C <cwd> diff --merge-base <baseRef> --name-only` (AC-01) and map `crates/<pkg>/…` → `<pkg>`, deduped, never throwing.
2. Scope ALL THREE gate commands (build + test + clippy) — not just test — by generalizing `scopedCargoTestArgs` into a shared `scopedCargoArgs(subcommand, packages, extraArgs?)` family (AC-02) and overriding `build`/`test`/`typecheck` on the shallow `cmds` copy (AC-03).
3. Classify gate failures as in-scope vs out-of-scope using `crates/<pkg>/` and `-p <pkg>` markers, adding `outOfScopeErrors: string[]` + `inScopePass: boolean` to `BuildGateResult` (AC-04).
4. Treat `gate.pass || gate.inScopePass` as phase-GREEN in the retry loop, logging ignored pre-existing failures, and terminate-early ONLY on genuine in-scope failures (AC-05).

Constraints/precedence: Package-set resolution precedence (highest→lowest): explicit `opts.testPackages`/`opts.packages` (incl. explicit `[]` = force workspace-wide) → `process.env.SUPER_DEV_BUILD_TEST_PACKAGES` → `detectTouchedCargoPackages(cwd)` → workspace-wide. `SUPER_DEV_GATE_BASE_REF` overrides the base ref (default `"main"`). Git-diff is skipped when a higher-precedence source is present. The classifier is conservative: on any ambiguity an error is treated IN-SCOPE (never grants a false green). Backward-compatibility: non-Cargo repos, non-git dirs, no-touched-crates, and unset env vars produce IDENTICAL argvs and an IDENTICAL `runBuildGate` result to today (modulo two additive fields `outOfScopeErrors`/`inScopePass`, which never block when there are zero failures or no scoping is active).

All 7 ACs (AC-01…AC-07) addressed; all 29 scenarios (SCENARIO-001…SCENARIO-029) mapped. Acceptance: `npm run typecheck` (tsc --noEmit, strict) clean and `npm test` (vitest run) green for existing + new tests.

Out of scope (future work, to be noted in 10-implementation-summary.md): Full baseline-diff (#3 — running the gate on `main` and subtracting the failure set). The in-scope classification (#4) covers the common pre-existing-failure case more cheaply; baseline-diff remains a future enhancement for edge cases (e.g. failures with no parseable crate marker).

## Architecture

ARCHITECTURE. Two files change; the module boundary (build-runner as the side-effecting deterministic oracle; implementation.ts as the per-phase retry driver) is preserved.

### Module: src/build-runner.ts

**(1) Touched-crate detection — AC-01.** Add `export function detectTouchedCargoPackages(cwd: string, baseRef?: string): string[]`. Contract: input `cwd` (absolute worktree path) and optional `baseRef` (defaults to `process.env.SUPER_DEV_GATE_BASE_REF` if set else `"main"`). Behaviour: wrap a `spawnSync("git", ["-C", cwd, "diff", "--merge-base", baseRef, "--name-only"], { encoding: "utf8" })` in `try { } catch { return []; }`. On `r.status !== 0`, `r.error`, empty stdout, or any thrown error → `return []`. Otherwise parse stdout lines; for each line, match the FIRST `crates/<pkg>/` segment via regex `/(?:^|\/)crates\/([^/]+)\//` (or split on `/` and detect `crates` segment followed by the package name); map each matching line to `<pkg>`; lines with no `crates/` segment are ignored (non-crate paths, e.g. root `Cargo.toml`, `README`). Dedupe with the existing `dedupePreservingOrder` helper preserving first-seen order. MUST NEVER throw (the entire body is try/caught). Pure wrt argv construction but reads env + spawns git (side-effecting) — same category as the rest of the module.

**(2) Scoped argv family — AC-02.** Add shared `export function scopedCargoArgs(subcommand: "build" | "test" | "clippy", packages: string[], extraArgs?: string[]): string[]` emitting `["cargo", subcommand, ...packages.flatMap(p => ["-p", p]), ...(extraArgs ?? [])]`. Refactor `scopedCargoTestArgs(packages)` into a thin wrapper: `return scopedCargoArgs("test", packages, ["--quiet"])` — IDENTICAL output to today (non-empty → `["cargo","test","-p",p…,"--quiet"]`; empty → `["cargo","test","--quiet"]`), so `verify.ts`/`implementation.ts` callers and existing tests are unchanged. Add `export function scopedCargoBuildArgs(packages: string[]): string[]` → `scopedCargoArgs("build", packages, ["--quiet"])` and `export function scopedCargoClippyArgs(packages: string[]): string[]` → `scopedCargoArgs("clippy", packages, ["--all-targets", "--quiet"])`. Empty-set invariants: all three helpers return byte-identical workspace-wide argv (`["cargo","build","--quiet"]`, `["cargo","test","--quiet"]`, `["cargo","clippy","--all-targets","--quiet"]`) so the no-scoping path is unchanged.

**(3) runBuildGate auto-scoping of all three commands — AC-03.** Replace the current `testPackages` resolution block (lines ~286-301) with a FOUR-tier precedence resolver: (i) `opts.testPackages !== undefined` → `dedupePreservingOrder(opts.testPackages)` (explicit `[]` forces workspace-wide, and the git-diff spawn is SKIPPED); (ii) else if `process.env.SUPER_DEV_BUILD_TEST_PACKAGES` set → `parseTestPackages(...)`; (iii) else if `cmds0.language === "rust"` → `detectTouchedCargoPackages(cwd)`; (iv) else → `[]` (workspace-wide). Note: git-diff MUST NOT run when tier (i) or (ii) supplies a value (no wasted spawn). Then, when `cmds0.language === "rust" && resolvedSet.length > 0`, build a shallow-copy override that replaces ALL THREE of `cmds.build`, `cmds.test`, `cmds.typecheck` (currently only `cmds.test` is replaced at :301): `cmds = { ...cmds0, build: scopedCargoBuildArgs(set), test: scopedCargoTestArgs(set), typecheck: scopedCargoClippyArgs(set) }`. When `set.length === 0` → `cmds = cmds0` byte-identical to today (no override). `detectProjectCommands` stays PURE — scoping is applied only on the shallow copy, preserving the detector regression assertion. The three callers (`verify.ts:87`, `implementation.ts:64`, `stages/index.ts:53`) still pass only `{ signal }` — scoping is derived internally, call signatures unchanged.

**(4) In-scope classification — AC-04.** Extend `BuildGateResult` with two additive fields: `outOfScopeErrors: string[]` and `inScopePass: boolean`. After the `exec` loop collects `errors`, run a pure `function classifyOutOfScopeErrors(errors: string[], scopedSet: string[]): { inScopeErrors: string[]; outOfScopeErrors: string[] }`. Contract: for each error block, extract referenced crate names via (a) `--> <path>` / `--> crates/<pkg>/…` markers using regex `crates\/([^/]+)\//`, and (b) cargo test-failure `-p <pkg>` markers using regex `/(?:^|\s)-p\s+(\S+)/`. An error is OUT-OF-SCOPE iff it references ≥1 crate AND EVERY referenced crate is NOT in `scopedSet`; otherwise (no marker found, or ≥1 referenced crate IS in scope, or `scopedSet` is empty) → IN-SCOPE (conservative; ambiguity never grants false green). Compute `inScopePass = !pass && errors.length > 0 && outOfScopeErrors.length === errors.length` (ALL failures out-of-scope/pre-existing). When `pass === true`, set `inScopePass = true` and `outOfScopeErrors = []` (classification is a no-op — the gate already passed). The classifier MUST NEVER throw (try/catch the whole pass; on any error treat all as in-scope). When no scoping is active (`scopedSet` empty / non-rust), `outOfScopeErrors = []` and `inScopePass` stays false for any failure → current abort semantics preserved exactly.

### Module: src/stages/implementation.ts

**(5) In-scope verdict in retry loop — AC-05.** After `const gate = runBuildGate(setup.worktreePath, { signal: ctx.signal })` (line 64, signature unchanged), compute the phase's GREEN condition as `gate.pass || gate.inScopePass`. When green via `inScopePass`, emit a distinct log line: ``ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`)``. Keep the existing PASS/FAIL log. The `if (!green) { … "failed after N attempts — terminating early"; allGreen=false; break; }` path fires ONLY when NEITHER `pass` nor `inScopePass` holds after `MAX_ATTEMPTS` (genuine in-scope failures). This stops the false-abort while still terminating on real in-scope breakage. (`cratesFromErrors` is a small local helper reusing the `crates/<pkg>/` + `-p <pkg>` extraction, or the out-of-scope crate list is precomputed and stored on the result to avoid re-parsing — implementation detail, prefer storing the resolved scoped crate set on the result for the log.)

### Data flow / invariant preservation
- `detectProjectCommands` purity: unchanged; all overrides applied on shallow copies only.
- Workspace-wide byte-identity: empty scoped set ⇒ argvs and result identical to pre-change (modulo two additive fields that never block).
- Process budget: +1 spawn only in the auto-touched tier (iii) for rust repos with no explicit/env override; all other tiers add zero spawns. No `shell:true` ever; package names are discrete argv elements.
- The three existing callers are call-site-compatible (still `{ signal }`); no signature change propagates.

## Testing Strategy

TESTING STRATEGY. Primary oracle: deterministic unit + integration tests in `src/build-runner.test.ts` (new file) and a focused `implementation` stage test, executed by `npm test` (vitest run) + `npm run typecheck` (tsc --noEmit strict). No new runtime deps; `spawnSync` and `git` are stubbed/mocked so tests are hermetic and fast.

(a) `detectTouchedCargoPackages` (AC-01 → SCENARIO-001/002/003/020/022/023): stub `spawnSync` to return synthetic `git diff --name-only` stdout; assert `crates/data/src/lib.rs` + `crates/api/src/main.rs` → `["data","api"]` (order preserved, deduped); `crates/data/a.rs` + `crates/data/b.rs` → `["data"]` (dedupe); duplicate `crates/data/…` lines → single entry; env `SUPER_DEV_GATE_BASE_REF=develop` flows into the `--merge-base develop` argv; non-crate-only diff (`Cargo.toml`, `README.md`) → `[]`; empty diff / `r.status!==0` / thrown error → `[]`; assert the helper NEVER throws (wrap a throwing stub, expect `[]`). Prefer injecting the spawn function or spying on `child_process.spawnSync` so the assertion reads the actual argv.

(b) Scoped argv family (AC-02 → SCENARIO-004/005): assert `scopedCargoBuildArgs(["data","api"])` == `["cargo","build","-p","data","-p","api","--quiet"]`; `scopedCargoTestArgs(["data"])` == `["cargo","test","-p","data","--quiet"]` (unchanged); `scopedCargoClippyArgs(["data"])` == `["cargo","clippy","-p","data","--all-targets","--quiet"]`; empty-set → byte-identical workspace-wide forms for all three; assert `scopedCargoTestArgs` still returns identical output to the pre-refactor implementation (regression of existing call sites).

(c) runBuildGate auto-scoping (AC-03 → SCENARIO-006/007/008/017): integration test that stubs `spawnSync` (a) to return a touched-`data` git-diff on the first call family and (b) to capture/succeed the build/test/clippy spawns; in a temp `Cargo.toml` worktree with no env and no explicit packages, assert the captured build, test, AND typecheck argvs all carry `-p data`. Precedence tests: explicit `opts.testPackages=["api"]` ⇒ git-diff spawn NEVER happens and `-p api` used; `SUPER_DEV_BUILD_TEST_PACKAGES="api"` set ⇒ `-p api` used; explicit `[]` ⇒ workspace-wide argvs and no git spawn.

(d) In-scope classification (AC-04 → SCENARIO-009/010/011/021/024/028): unit-test the pure classifier with scoped set `{data}`: an error block referencing `crates/data/src/lib.rs` is IN-SCOPE; an error block referencing only `crates/compute/src/lib.rs` is OUT-OF-SCOPE; an error with NO parseable crate marker is IN-SCOPE (conservative); an error referencing both `data` and `compute` is IN-SCOPE (mixed). `inScopePass` true iff ALL errors out-of-scope and `!pass`; `inScopePass` true and `outOfScopeErrors=[]` when `pass`; empty scoped set ⇒ `outOfScopeErrors=[]`, `inScopePass=false` for any failure. Use realistic cargo error strings (`error[E0308]: … --> crates/compute/src/jobs.rs:42:10`, `failures: -p compute --test job_queries_test`).

(e) implementation.ts retry loop (AC-05 → SCENARIO-012/013/014/025/027): test the stage with a stubbed `runBuildGate` returning `{pass:false, inScopePass:true, outOfScopeErrors:[…compute…]}` on attempt 1 → assert phase is GREEN, the IN-SCOPE GREEN log line is emitted, no early termination, and the commit proceeds; a result with `{pass:false, inScopePass:false}` for 3 attempts → assert "terminating early" + `allGreen=false` + loop breaks; a `{pass:true}` result → normal GREEN path.

(f) Backward-compat / non-regression (AC-06 → SCENARIO-015/016/026): non-cargo repo (node/go/python manifests) ⇒ argvs identical, result identical modulo two additive fields; non-git / no-touched-crates / unset env ⇒ workspace-wide argvs; zero failures ⇒ `inScopePass` never blocks.

Gate: `npm run typecheck` must be clean (strict); `npm test` must pass for existing AND new suites. No new runtime dependencies; no network; no real `git`/`cargo` execution in CI (all spawned).

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018
- SCENARIO-019
- SCENARIO-020
- SCENARIO-021
- SCENARIO-022
- SCENARIO-023
- SCENARIO-024
- SCENARIO-025
- SCENARIO-026
- SCENARIO-027
- SCENARIO-028
- SCENARIO-029

## Deviations & Known Limitations (post-implementation)

This section records verified deviations from the original specification and known limitations discovered during code review (`11-code-review.md`, APPROVED) and adversarial review (`12-adversarial-review.md`, CONTEST). None block the feature's primary use case (pre-existing out-of-scope failures in untouched crates); the gate verdict itself is always correct and conservative. Each item links to its source review finding.

### DEF-01 — Baseline-diff (#3) deferred (future work, by design)
- **Source**: This spec, Out-of-scope.
- **Original text**: "Out of scope (future work): Full baseline-diff (#3 — running the gate on `main` and subtracting the failure set)."
- **Implementation**: Not implemented. The in-scope classification (capability 3 / AC-04) covers the common pre-existing-failure case more cheaply.
- **Impact**: Edge cases not covered — failures with no parseable `crates/<pkg>/` or `-p <pkg>` marker, and dependency-cascade failures where an in-scope crate fails because an out-of-scope transitive dependency is broken (AR-03). The classifier conservatively marks these IN-SCOPE (no false green), so the false-abort can persist for them. Baseline-diff remains a future enhancement.

### DEF-02 — In-scope verdict wired into only 1 of 3 gate consumers (AR-01, partial fix)
- **Source**: `12-adversarial-review.md` AR-01 (high).
- **Original intent**: "stops false-failing and false-aborting on messy real-world monorepos."
- **Implementation**: `gate.inScopePass` / `outOfScopeErrors` are consumed ONLY in `src/stages/implementation.ts` (Stage 9.2). `verify.ts`'s gate returns only `{pass, ran, errors}` (drops `inScopePass`), and Stage 10 reviewFix feeds the FULL `errors` array to the implementer.
- **Reason**: The two-file constraint (`src/build-runner.ts` + `src/stages/implementation.ts`) was honored; touching `verify.ts` was out of scope.
- **Impact**: Pre-existing out-of-scope failures that no longer abort implementation still (a) make verify's gate FAIL and (b) are handed verbatim to the implementer during reviewFix as things to fix — actively inducing out-of-scope edits (scope creep). The false-abort relocates from Stage 9.2 to Stage 9/10 rather than disappearing. **Future work**: thread `inScopePass` into `verify.ts` and filter reviewFix's `buildErrors` to the in-scope subset.

### DEF-03 — Classifier depends on crate markers surviving a 12-line tail (AR-02)
- **Source**: `12-adversarial-review.md` AR-02 (high).
- **Original text**: "Classify gate failures as in-scope vs out-of-scope using `crates/<pkg>/` and `-p <pkg>` markers."
- **Implementation**: As specified. The gate retains only the last 12 lines of stderr/stdout.
- **Impact**: A pre-existing failing TEST in an untouched crate commonly produces a tail (`failures:`, `---- name stdout ----`) with NEITHER marker, so it is classified IN-SCOPE and the false-abort persists for that class. The classifier is sound for compile/clippy errors (which always emit `--> crates/<pkg>/...`) but unreliable for test failures. **Future work**: enlarge the retained tail for Rust, or scan full stdout for cargo's `rerun \`cargo test -p <pkg>\`` note.

### DEF-04 — `parseTestPackages` does not strip `crates/` prefix; README example corrected (AR-04)
- **Source**: `12-adversarial-review.md` AR-04 (medium).
- **Original text (README + module docstring)**: `SUPER_DEV_BUILD_TEST_PACKAGES="crates/api,crates/store"`.
- **Implementation**: `parseTestPackages` only trims/dedupes; a leading `crates/` is passed verbatim to cargo, producing an invalid package spec (`-p crates/api`).
- **Reason/Resolution**: The README example was corrected to bare names (`SUPER_DEV_BUILD_TEST_PACKAGES="api,store"`). The `build-runner.ts` module docstring still carries the old `crates/api,crates/store` example and should be updated in a follow-up, or `parseTestPackages` taught to strip an optional `crates/` prefix. The classifier is unaffected (path markers require a trailing slash).

### DEF-05 — Auto-detection only matches `crates/<pkg>/`; default base ref is `main` (AR-05)
- **Source**: `12-adversarial-review.md` AR-05 (medium).
- **Original text**: "map every stdout line matching `crates/<pkg>/…` to `<pkg>`"; "baseRef defaults to `\"main\"`".
- **Implementation**: As specified. `detectTouchedCargoPackages` regex is `/(?:^|\/)crates\/([^/]+)\//`; base-ref precedence is `arg > SUPER_DEV_GATE_BASE_REF > "main"`.
- **Impact**: Workspaces with top-level member dirs (`members = ["api","data"]`), `members=["*"]`, or repos whose default branch is `master`/`trunk`/`develop` (without the env override) silently fall back to workspace-wide with NO log signal. The `SUPER_DEV_GATE_BASE_REF` env var mitigates the branch case; the layout case does not. **Future work**: fall back to `git symbolic-ref refs/remotes/origin/HEAD` / `git config init.defaultBranch`, and emit a one-line log when auto-detection resolves to `[]`.

### DEF-06 — IN-SCOPE GREEN log lists the in-scope crate among "ignored" crates (code-review F-01, observability-only)
- **Source**: `11-code-review.md` F-01 (medium).
- **Original text**: "log: `... ignored (crates: <comma-list>)`" populated from `gate.outOfScopeErrors`.
- **Implementation**: `cratesFromErrors` in `implementation.ts` re-scans the WHOLE error block (label + tail) for `-p <pkg>` markers; it does NOT replicate the classifier's flagRegion-slice label exclusion, so it re-admits the command label's own `-p <pkg>`.
- **Impact**: The log prints e.g. `ignored (crates: data,compute)` for a real out-of-scope failure, listing the IN-SCOPE crate (`data`) as ignored — misleading but observability-only. The gate VERDICT is correct because `classifyOutOfScopeErrors` properly excludes the label. Untested because the stage fixture omits the real label+tail shape. **Future work**: apply the same `indexOf(" FAILED (")` flagRegion slice in `cratesFromErrors`, or export one shared `referencedCrates(block)` helper (DRY with the classifier — F-02).

### DEF-07 — git-diff spawn not AbortSignal/timeout-aware (code-review F-03)
- **Source**: `11-code-review.md` F-03 (low).
- **Original text**: "MUST NEVER throw"; no timeout specified.
- **Implementation**: `detectTouchedCargoPackages` calls `spawnSync("git", [...], { encoding: "utf8" })` with no `timeout` and does not consult `opts.signal`.
- **Impact**: In practice `git diff --merge-base <ref> --name-only` is fast and bounded; negligible real-world risk and explicitly permitted by the spec ("no new spawned processes beyond ... one `git diff --name-only`"). Acceptable as-is. Consider a conservative timeout in a future pass.

### DEF-08 — git diff re-spawned on every gate call (AR-07)
- **Source**: `12-adversarial-review.md` AR-07 (low).
- **Original text**: No caching specified.
- **Implementation**: `runBuildGate` calls `detectTouchedCargoPackages` (→ the git-diff spawn) once per call, up to 3× per phase × N phases, whenever no higher-precedence tier applies.
- **Impact**: The touched-crate set is invariant within a pipeline run, so this is up to ~3×N redundant spawns (pure waste, not a correctness issue). **Future work**: compute once and pass via `opts.testPackages`, or memoize inside the module keyed by `cwd+ref`.
