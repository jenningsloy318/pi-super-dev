# Code Review: Code Review — Cargo Package Name Resolution for the Scope-Aware Build Gate

- **Date**: 2026-07-20
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation correctly fixes the framework-derived `cargo build -p <dir>` false-fail by resolving REAL cargo package names from `cargo metadata` instead of workspace directory names. All 10 acceptance criteria are met and verified: `resolveCargoPackageNames` (src/build-runner.ts) maps touched directory segments → real package names via a cached `cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml` (discrete argv, no shell), with a per-element identity fallback for unmatched dirs, a whole-list identity fallback + never-throw on any failure, and a process-local per-cwd cache keyed by the SAME absolute path used for `--manifest-path` (cache-key/argv-skew finding addressed). It is wired as the FINAL mapping step inside `detectTouchedCargoPackages` (git-diff + regex + dedupe byte-identical upstream), so the complete touched set — including the e2e crate `crates/workflows/tests/e2e_*.rs` → `stockfan-workflows` — flows through unchanged and the gate now emits `-p stockfan-data -p stockfan-tools -p stockfan-workflows`. The classifier is correctly augmented (`classificationScope`) so cargo's `crates/<dir>/` source-path markers match an in-scope crate even though `testPackages` now carries real names — this prevents a HIGH-severity false-green regression that an uncritical port would have introduced. Prompt discipline (Fix 3) forbids `--lib`-only verification in both `buildImplementPrompt` and `buildQaPrompt`. Typecheck is strict-clean (tsc exit 0) and all 862 tests pass (47 files) including the new package-resolution/wiring/prompt-discipline suites plus the full existing regression suite (touched-crates, autoscope, inscope-classification, scoped-args, packages, nonregression, timeout, docs, stream-theme-class-theme). No new runtime deps; the only new spawned process is the cached `cargo metadata --no-deps`. Two intentional, documented deviations from the spec's literal wording are net improvements and do not violate any AC; one minor dead-code branch is flagged Low. No Critical/High/Medium issues. APPROVED.

Dimension scores: Correctness 5 · Security 5 · Performance 5 · Concurrency 5 · Maintainability 4 · Testability 5 · Error Handling 5 · Data Integrity 5 · Observability 4.

AC checklist: AC-01 ✅ (resolver + cache + never-throw + identity fallback) · AC-02 ✅ (real names emitted end-to-end) · AC-03 ✅ (workflows not dropped — regex captures the segment; verified by wiring test) · AC-04 ✅ (4 unit-test groups present: resolution/fallback/cache/end-to-end -p flags, spawnSync mocked) · AC-05 ✅ (prompts forbid --lib-only, require full `cargo test -p <pkg>` + spec e2e) · AC-06 ✅ (typecheck + npm test green) · AC-07 ✅ (regression + non-cargo/non-git unchanged) · AC-08 ✅ (theme method-binding preserved — stream-theme-class-theme green, no new render) · AC-09 ✅ (no new deps, only cached `cargo metadata --no-deps`) · AC-10 ✅.

## Findings

### F-01: Dead-code branch in matchPackageBySegment exact-root check

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: ~310
In src/build-runner.ts `matchPackageBySegment`, the exact-crate-root detection is `p.manifestDir === \`crates/${seg}\` || p.manifestDir.endsWith(\`/crates/${seg}\`)`. Cargo's `manifest_path` from `cargo metadata` is ALWAYS absolute, so `manifestDir` is always absolute and the first disjunct (`=== 'crates/<seg>'`, a relative path) can NEVER be true — only the `endsWith` branch is reachable. Not a bug (the second branch correctly handles absolute manifest dirs), but it is misleading dead code that suggests relative manifest paths are possible. Failure scenario: a future maintainer 'fixes' the endsWith branch and assumes the `===` branch covers a case it cannot. Suggested fix: drop the unreachable first disjunct and rely solely on `p.manifestDir.endsWith(\`/crates/${seg}\`)`, or add a comment that the first branch is retained defensively for non-absolute manifest paths. Confidence 0.9.
### F-02: Spec deviation (improvement): Rust self-verify discipline is appended CONDITIONALLY on s.language==='rust', not UNCONDITIONALLY as the spec text stated

- **Severity**: Informational
- **File**: `src/prompts.ts`
- **Line**: ~100
The spec (06-specification.md, Fix 3) states the discipline is 'Appended UNCONDITIONALLY to buildImplementPrompt and buildQaPrompt; scoped to Rust via its wording'. The implementation instead gates it via `rustDiscipline(s)` returning the discipline only when `s?.language === 'rust'` (setup-detected repo language). This is a NET IMPROVEMENT — broadcasting `cargo test -p <pkg>` instructions to a Node/Python/Go repo would be noise — and AC-07 is fully met (Rust prompts contain `cargo test -p`, `WITHOUT --lib`, `tests/` integration binaries, and the --lib-only-not-green clause; verified by tests/prompts-cargo-verify-discipline.test.ts, 16 tests green). Flagged only for spec-vs-impl traceability. One edge: if a repo's per-task classification language ever diverges from the setup-detected language, the discipline is driven by the setup language — which the comment documents as the more reliable signal. No action required. Confidence 0.95.
### F-03: Spec deviation (improvement): dedicated 30s cargo-metadata timeout + new SUPER_DEV_CARGO_METADATA_TIMEOUT_MS env var instead of the spec's 'existing resolveTimeoutMs envelope'

- **Severity**: Informational
- **File**: `src/build-runner.ts`
- **Line**: ~165
The spec said `loadCargoMetadata` should run 'under the existing resolveTimeoutMs() envelope' (i.e. the 10-min build timeout). The implementation introduces a dedicated `cargoMetadataTimeoutMs()` (30s default) and a new env var `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS`. This is STRICTLY BETTER: a metadata lookup is a cheap manifest-graph read, so inheriting the 10-min envelope would let a hung/missing cargo block up to 10 minutes before the identity fallback fires, stalling the whole gate. The rationale is documented inline. It does add one config surface not enumerated in the spec, but it is backward-compatible (sensible default, opt-in override) and within the spirit of AC-09 ('only new spawned process is cached cargo metadata --no-deps'). No action required; noted for completeness. Confidence 0.95.
