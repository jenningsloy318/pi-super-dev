# Specification Review: Spec Review — Cargo Package Name Resolution for the Scope-Aware Build Gate

- **Date**: 2026-07-20
- **Author**: super-dev:spec-reviewer

---

## Verdict: REVISIONS NEEDED

The spec is technically sharp and well-grounded for the resolver core (Phase 1–2): every cited symbol in src/build-runner.ts — detectTouchedCargoPackages, the `/(?:^|\/)crates\/([^/]+)\//` regex, dedupePreservingOrder, resolveTimeoutMs, scopedCargo{Args,Build,Test,Clippy}Args, classifyOutOfScopeErrors, runBuildGate, and the SUPER_DEV_BUILD_TEST_PACKAGES four-tier precedence — is verified present and matches the described contract. The `cargo metadata --no-deps` design is sound (workspace members are always in packages[]; --no-deps only excludes non-workspace deps), the discrete-argv no-shell spawn is consistent with module conventions, and AC-01..AC-10 plus SCENARIO-001..024 are all mapped. However, two grounding defects block approval as-written. (1) CRITICAL: the spec's Fix 3 appends rust self-verify discipline to buildQaPrompt and asserts "src/stages/implementation.ts and src/stages/verify.ts consume these builders unchanged" — but grep confirms buildQaPrompt has ZERO call sites in src/ or tests/ (verify.ts imports buildCodeReviewPrompt/buildAdversarialReview/buildFixPrompt/buildApiTestPrompt/buildUiTestPrompt, never buildQaPrompt). Appending to it is a no-op; the QA/verify agent — exactly where the "no --lib-only green" rule matters most — never receives the instruction. The string-containment test (Testing Strategy item f) would pass while delivering false confidence, matching the repo's known "implemented-and-unit-tested-but-NOT-wired-in" failure mode (learned.md score:62). (2) HIGH: the spec says CREATE test/build-runner-package-resolution.test.ts, but the repo has NO test/ directory — vitest.config.ts globs only tests/** and src/**. A literal implementation creates a file vitest never discovers, so AC-06/AC-10 can false-green. Both are bounded, recoverable reroutes/renames; the resolver architecture itself is APPROVED-quality.

## Findings

### F-01: buildQaPrompt is dead code (0 call sites) — Fix 3 QA-path discipline will never reach an agent

- **Severity**: critical
Architecture (Fix 3) and FILE INVENTORY claim: "buildImplementPrompt's and buildQaPrompt's '## Instructions' array each get an appended instruction" and "src/stages/implementation.ts and src/stages/verify.ts consume these builders unchanged." Grounding check: grep -rn buildQaPrompt across src/ and tests/ returns ONLY its definition at src/prompts.ts:97 — no importer. src/stages/verify.ts:15 imports buildCodeReviewPrompt, buildAdversarialPrompt, buildFixPrompt, buildApiTestPrompt, buildUiTestPrompt (NOT buildQaPrompt); src/stages/implementation.ts:10 imports buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt (NOT buildQaPrompt). Consequence: appending rust verify discipline to buildQaPrompt has zero runtime effect; the verify/QA agent never sees "do NOT declare green on --lib-only evidence." AC-07 / SCENARIO-010/011 are only half-satisfiable (implementer path works via buildImplementPrompt; QA path is hollow). Testing Strategy item (f) asserts the substring exists in buildQaPrompt output — that test passes while proving nothing about agent behavior. This is the exact "tested-but-not-wired-in" anti-pattern in learned.md (score:62). Recommendation: reroute the QA-path discipline to a prompt verify.ts actually consumes (buildFixPrompt is the implementer-driven fix entry; buildCodeReviewPrompt is the reviewer entry) OR delete buildQaPrompt and restate AC-07 as implementer-path-only. Do not leave the spec claiming buildQaPrompt is live.
### F-02: New test path test/ does not exist — vitest will not discover the file (AC-06/AC-10 false-green risk)

- **Severity**: high
FILE INVENTORY: "CREATE: test/build-runner-package-resolution.test.ts" and Testing Strategy repeatedly references test/build-runner-package-resolution.test.ts. Grounding check: find . -type d -name test (excluding node_modules) returns nothing; the repo uses tests/ (plural). vitest.config.ts: include: ["tests/**/*.test.ts", "src/**/*.test.ts"]. A file created at test/... is outside both globs and will NOT run under `npm test`. If the implementer follows the spec literally, AC-06's hermetic unit tests never execute yet `npm test` stays green (AC-10) — false confidence in the resolver. Recommendation: change every occurrence to tests/build-runner-package-resolution.test.ts to match the established convention.
### F-03: "Language-scoped" prompt append bypasses the existing languageInstructions mechanism and isn't actually scoped

- **Severity**: medium
Fix 3 calls the appended instruction "language-scoped," but buildQaPrompt(s,c,phase) has no language parameter and buildImplementPrompt already receives rust-specific text via specialist.languageInstructions (src/prompts.ts:94; sourced from loadLangProfile in src/helpers.ts:78). The spec instead hardcodes rust text into the generic builder, so it is emitted in EVERY prompt regardless of classified language; only the runtime phrasing ("when verifying a Rust crate") gates behavior. This couples rust knowledge into the wrong layer and duplicates the lang-profile channel. Recommendation: either route the discipline through the rust lang-profile (loadLangProfile) so it is truly language-scoped and reaches buildImplementPrompt via the existing li block, or drop the "language-scoped" wording and explicitly state the text is unconditionally present but runtime-conditional.
### F-04: cargoMetadataCache key normalization unspecified — risks redundant spawns and weakens AC-03 "exactly once"

- **Severity**: medium
Architecture states cargoMetadataCache is "Keyed by absolute cwd." But neither loadCargoMetadata nor resolveCargoPackageNames is specified to canonicalize the key (e.g., path.resolve(cwd) or fs.realpathSync). detectTouchedCargoPackages receives cwd as-is from runBuildGate(opts.cwd); if a caller passes a relative path, a trailing slash, or a symlink variant, cache keys diverge and cargo metadata is re-spawned — directly weakening AC-03 / SCENARIO-005 ("spawn invoked EXACTLY ONCE") and the no-re-spawn-on-failure sentinel guarantee. Recommendation: mandate key normalization (resolve(cwd)) in the loadCargoMetadata contract and add a cache-key-normalization assertion to test (c).
### F-05: Regression-suite reference to "build-runner.test.ts" is ambiguous — two such files exist

- **Severity**: low
Testing Strategy / regression suite lists "build-runner.test.ts" alongside the build-runner-* files. Grounding check: TWO files match — src/build-runner.test.ts AND tests/build-runner.test.ts (both covered by vitest's include globs). The spec does not disambiguate which must stay green. Low impact (both will run regardless), but for a backward-compat assertion that hinges on byte-identical behavior the target should be explicit. Recommendation: name both paths explicitly in the regression list.

## Dimension Reviews

### D1 Completeness

- **Status**: pass

All 10 ACs (AC-01..AC-10 verified in 01-requirements.md) are addressed; SCENARIO-001..024 each mapped to a phase/spec section; error paths (never-throw, identity fallback, {ok:false} sentinel) and NFRs (no new deps, cached spawn) explicit. No uncovered AC.
### D2 Consistency

- **Status**: pass

Symbol names, signatures, regex, env var (SUPER_DEV_BUILD_TEST_PACKAGES), and tier precedence match across Summary/Architecture/Testing/Phases. scopedCargo* argv construction verified against src/build-runner.ts.
### D3 Feasibility

- **Status**: pass

cargo metadata --no-deps correctly returns workspace members in packages[]; discrete-argv spawnSync (no shell:true) matches module convention; identity fallback makes the resolver a safe drop-in. Architecture fits existing patterns.
### D4 Testability

- **Status**: pass-with-concerns

Hermetic spawnSync-mock strategy is concrete and numeric ("exactly once," substring assertions). Concern: cache-key normalization (F-04) and the buildQaPrompt string test (F-01) can both produce green-but-hollow results.
### D5 Traceability

- **Status**: fail

AC-07→SCENARIO-010/011 traceability chain is BROKEN on the QA path: buildQaPrompt is never consumed by any stage (F-01), so the spec's claim that verify.ts consumes the builder is false. implementer-path traceability is intact.
### D6 Grounding

- **Status**: fail

Score ≈ 18/20 verified (~90%) but the 2 misses are material: buildQaPrompt dead-code wiring claim (F-01) and test/ vs tests/ path (F-02). All build-runner.ts symbols, env vars, regex, regression files, and stream-theme-class-theme.test.ts verified present.
### D7 Complexity

- **Status**: pass-with-concerns

File inventory is minimal and proportional (2 source files + 1 test). Concern (F-03): hardcoding rust text into generic prompt builders duplicates the existing loadLangProfile/languageInstructions channel rather than reusing it.
### D8 Ambiguity

- **Status**: pass-with-concerns

Type contracts (CargoMetadataResult), fallback chain, and matching rule are explicit. Concerns: cache-key normalization unspecified (F-04); "language-scoped" mis-describes an unconditional append (F-03); "build-runner.test.ts" target ambiguous (F-05).
