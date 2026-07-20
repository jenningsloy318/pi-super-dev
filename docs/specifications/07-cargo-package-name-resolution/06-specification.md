# Specification: Cargo Package Name Resolution for the Scope-Aware Build Gate

- **Date**: 2026-07-20

---

## Summary

Fix the scope-aware cargo build-gate in this TypeScript pi-extension so it resolves REAL cargo package names from `cargo metadata` instead of workspace DIRECTORY names. Today `detectTouchedCargoPackages` (src/build-runner.ts) runs `git diff --name-only`, maps each `crates/<seg>/` path to its directory segment, and returns those segments verbatim. `scopedCargoArgs` then emits `-p <dir>`. On any prefixed-crate workspace (stockfan: dirs `data/tools/workflows` → packages `stockfan-data/stockfan-tools/stockfan-workflows`) the gate runs `cargo build -p data -p tools --quiet`, cargo rejects it with `package ID specification 'data' did not match any packages` (exit 101), and the run false-fails before compiling anything — the repair loop cannot fix a framework-derived command. The fix adds `resolveCargoPackageNames(cwd, touchedDirs)` (spawns cached `cargo metadata --format-version 1 --no-deps --manifest-path <cwd>/Cargo.toml`, maps each touched dir to the workspace package whose `manifest_path` parent's first `crates/<seg>/` segment matches, never throws, identity-falls-back to directory names, memoized per-cwd), wires it as the FINAL mapping step inside `detectTouchedCargoPackages`, guarantees the complete touched set (e2e crate `crates/workflows/tests/e2e_*.rs` → `stockfan-workflows` is included), and strengthens `buildImplementPrompt` + `buildQaPrompt` (src/prompts.ts) to forbid `--lib`-only self-verification and require full `cargo test -p <pkg>` + spec-mandated e2e. Pure TS change: only src/build-runner.ts, src/prompts.ts, and new/updated tests. nodes.ts/workflow.ts/pipeline.ts/render/theme are untouched. Backward compatible: dir==name workspaces, non-cargo repos, and non-git dirs are byte-identical to today (metadata tier runs only when `language==='rust'` and a non-empty scope resolves). No new runtime deps; the only new spawned process is cached `cargo metadata --no-deps`.

## Architecture

The change is localized to two source files and a new test file, structured as a four-phase DAG where Phase 3 (prompt discipline) is fully parallelizable with Phases 1–2 (resolver + wiring) because it touches no shared code.

INPUTS / CONTRACTS (all signatures frozen):
- `resolveCargoPackageNames(cwd: string, touchedDirs: string[]): string[]` (NEW, exported from src/build-runner.ts). Pure-mapping over a cached side-effect. Given touched DIRECTORY segments (e.g. `["data","tools","workflows"]`), returns REAL package names (e.g. `["stockfan-data","stockfan-tools","stockfan-workflows"]`), deduped, first-seen order preserved.
- `loadCargoMetadata(cwd: string): CargoMetadataResult` (NEW, private). Side-effecting spawn, memoized. `CargoMetadataResult = { ok: true; packages: Array<{ name: string; manifestDir: string }> } | { ok: false }`.
- `cargoMetadataCache: Map<string, CargoMetadataResult>` (NEW, module-level, process-local). Keyed by absolute `cwd`. Stores either the parsed package list OR a `{ ok:false }` failure sentinel so a failing/missing `cargo` is not re-spawned within one run. Never persisted (process exit clears it) → no stale results across runs (SCENARIO-006).
- `detectTouchedCargoPackages(cwd: string, baseRef?: string): string[]` (MODIFIED). Signature unchanged. Internally unchanged: `git -C <cwd> diff --merge-base <ref> --name-only` discrete-argv spawn (no `shell:true`), regex `/(?:^|\/)crates\/([^/]+)\//` (first `crates/<seg>/` segment wins), `dedupePreservingOrder`. ONLY addition: the deduped directory segments are passed through `resolveCargoPackageNames(cwd, dirs)` as the FINAL step before return.
- `scopedCargoArgs`, `scopedCargoBuildArgs`, `scopedCargoTestArgs`, `scopedCargoClippyArgs`, `classifyOutOfScopeErrors`, `runBuildGate` (UNCHANGED). `runBuildGate`'s FOUR-tier precedence (opts.testPackages > SUPER_DEV_BUILD_TEST_PACKAGES > detectTouchedCargoPackages > workspace-wide) is untouched — because the resolver is wired INSIDE `detectTouchedCargoPackages`, real names flow through every tier unchanged.

FIX 1 — METADATA RESOLUTION + CACHE (Phase 1):
`loadCargoMetadata(cwd)` spawns `spawnSync("cargo", ["metadata","--format-version","1","--no-deps","--manifest-path", join(cwd,"Cargo.toml")], { encoding:"utf8", timeout: resolveTimeoutMs() })` — discrete argv, no `shell:true`, same timeout envelope as the rest of the module (AC-10: only new spawn is this one). The `--manifest-path` points at the WORKSPACE-ROOT `Cargo.toml`; cargo returns ALL workspace members in `packages[]`, each carrying its individual `manifest_path`. The helper maps each to `{ name: pkg.name, manifestDir: dirname(pkg.manifest_path) }` and caches it. The whole body is wrapped in a defensive try/catch: spawn error (`r.error`), non-zero exit, timeout, missing `cargo`, JSON parse failure, or unexpected shape → cache `{ ok:false }` and return it. NEVER throws (AC-02, SCENARIO-003).

`resolveCargoPackageNames(cwd, touchedDirs)` reads `loadCargoMetadata(cwd)`. If `ok:false` → return `dedupePreservingOrder(touchedDirs)` (identity fallback, AC-02). If `ok:true` → for each touched segment `d`, apply the SAME `crates/<seg>/` regex to each package's `manifestDir` and select the package whose first `crates/<seg>/` segment EQUALS `d`. This matching rule is what makes manifest-in-subdir work (SCENARIO-002): a package whose `Cargo.toml` lives at `crates/data/inner/Cargo.toml` has `manifestDir = ".../crates/data/inner"` whose first `crates/<seg>/` segment is `data`, so it matches touched segment `data` and resolves to its real `name`. Per-element identity fallback: a touched segment with no matching package degrades to its own directory name (SCENARIO-004). Result is deduped, first-seen order preserved. The fallback chain + never-throw contract is documented in a JSDoc comment (AC-02).

FIX 1 WIRING + FIX 2 — COMPLETE TOUCHED SET (Phase 2):
Inside `detectTouchedCargoPackages`, the existing `dedupePreservingOrder(pkgs)` call now feeds `resolveCargoPackageNames(cwd, deduped)` and that result is returned. Because the resolver is identity for dir==name and identity-on-failure, non-cargo/non-git/dir==name paths are byte-identical to today (AC-08). The existing regex already captures the `workflows` segment for `crates/workflows/tests/e2e_*.rs`, so Fix 2 is verified (not rewritten): confirm extraction includes data, tools, AND workflows, then the resolver maps `workflows` → `stockfan-workflows` so spec-mandated e2e runs via `cargo test -p stockfan-workflows` (AC-05, SCENARIO-009). End-to-end, `scopedCargoBuildArgs(["stockfan-data","stockfan-tools","stockfan-workflows"])` → `["cargo","build","-p","stockfan-data","-p","stockfan-tools","-p","stockfan-workflows","--quiet"]` (AC-04, SCENARIO-007).

FIX 3 — PROMPT SELF-VERIFY DISCIPLINE (Phase 3, parallelizable):
The authoritative prompt text lives in src/prompts.ts. `buildImplementPrompt`'s "## Instructions" array and `buildQaPrompt`'s "## Instructions" array each get an appended, language-scoped instruction: "When verifying a Rust crate, run `cargo test -p <pkg>` WITHOUT `--lib` so the integration binaries under `tests/` execute, PLUS any spec-mandated e2e/integration target. Do NOT declare green on `--lib`-only evidence — `--lib` skips the `tests/` integration binaries." This is prompt-TEXT only; src/stages/implementation.ts and src/stages/verify.ts consume these builders unchanged, so there is no control-flow, nodes, workflow, or pipeline change (AC-07, SCENARIO-010/011). The phrasing is generic ("when Rust") so non-rust stacks are unaffected.

REGRESSION GUARDRAILS:
- The metadata tier runs ONLY when `runBuildGate`'s tier-3 path executes (rust repo, no higher-tier override) — identical to today's `detectTouchedCargoPackages` invocation site. Non-rust stacks never spawn `cargo metadata`.
- Theme method-binding preserved (AC-09, SCENARIO-015/024): no new rendering is introduced; if any were, it MUST use method-style `theme.fg(...)` or a wrapper `const fg=(c,t)=>theme.fg(c,t)` — NEVER `const fg = theme.fg` (detaches `this`, throws "reading 'fgColors'"). tests/stream-theme-class-theme.test.ts stays green.

FILE INVENTORY:
- MODIFY: src/build-runner.ts — add `CargoMetadataResult` type, `cargoMetadataCache`, `loadCargoMetadata`, `resolveCargoPackageNames`; wire final mapping into `detectTouchedCargoPackages`.
- MODIFY: src/prompts.ts — append rust self-verify discipline to `buildImplementPrompt` and `buildQaPrompt`.
- CREATE: test/build-runner-package-resolution.test.ts — hermetic unit tests (AC-06) with `node:child_process.spawnSync` mocked.
- NO CHANGE: src/stages/implementation.ts, src/stages/verify.ts (consume prompts unchanged), nodes.ts, workflow.ts, pipeline.ts, src/render/*, theme, package.json (no new deps).

DATA FLOW (single gate run): git diff → `crates/<dir>/` segments → dedupe → `resolveCargoPackageNames` (cache check → `cargo metadata` if cold → manifestDir-segment match → per-element identity fallback) → real package names → `scopedCargo{Build,Test,Clippy}Args` → `runBuildGate` exec → `classifyOutOfScopeErrors` (now classifies against REAL names, so in-scope partitioning is correct).

## Testing Strategy

HERMETIC UNIT TESTS (AC-06, SCENARIO-016) in a NEW file test/build-runner-package-resolution.test.ts, with `node:child_process.spawnSync` mocked via `vi.mock`/module replacement so no real `cargo`/`git` is spawned:

(a) DIR→NAME RESOLUTION: stub `spawnSync` to return a `cargo metadata` JSON whose `packages[]` carry prefixed names (`stockfan-data`, `stockfan-tools`, `stockfan-workflows`) AND one manifest-in-subdir package (`crates/data/inner/Cargo.toml`). Assert `resolveCargoPackageNames(cwd, ["data","tools","workflows","inner"])` returns `["stockfan-data","stockfan-tools","stockfan-workflows", <inner-pkg-name>]` (AC-01, SCENARIO-001/002/017).
(b) FAILURE FALLBACK: make the mock throw / return `status:101` / emulate timeout (`error` with `killed`/`signal`) / return malformed JSON. For each, assert `resolveCargoPackageNames` returns the input directory names verbatim (identity), and NEVER throws (AC-02, SCENARIO-003/004/018/019). Also assert a touched dir with no matching package falls back to its own name.
(c) CACHE HIT: assert the spawn mock is invoked EXACTLY ONCE across two `resolveCargoPackageNames` calls for the same cwd (record call count on the mock) (AC-03, SCENARIO-005/020).
(d) END-TO-END -p FLAGS: build a workspace where dir≠name and assert `scopedCargoBuildArgs`/`scopedCargoTestArgs`/`scopedCargoClippyArgs` over the resolved set yield `["cargo","build","-p","stockfan-data","-p","stockfan-tools","-p","stockfan-workflows","--quiet"]` and the matching test/clippy argv (AC-04, SCENARIO-007/021/022).
(e) COMPLETE TOUCHED SET: feed a diff containing `crates/workflows/tests/e2e_smoke.rs` and assert `stockfan-workflows` appears in the resolved scope (AC-05, SCENARIO-009).
(f) PROMPT DISCIPLINE: assert `buildImplementPrompt(...)` and `buildQaPrompt(...)` output strings CONTAIN the substrings `cargo test -p`, `WITHOUT --lib` / `no --lib`, `tests/` integration binaries, and `--lib`-only … not … green (AC-07, SCENARIO-010/011).

REGRESSION SUITE (AC-08, SCENARIO-012/013/023) — run the EXISTING suite unchanged and assert all green: build-runner-touched-crates, build-runner-autoscope, build-runner-inscope-classification, build-runner-scoped-args, build-runner-packages, build-runner-nonregression, build-runner-timeout, build-runner-docs, build-runner.test.ts. The key backward-compat invariants to assert inside/alongside these: (1) a dir==name workspace resolves identically (metadata is an identity no-op); (2) non-cargo repos (go/python/node/mixed) and non-git dirs are byte-identical (the metadata spawn is SKIPPED because `detectTouchedCargoPackages` returns `[]` for non-crate / non-git paths before any metadata call, and `runBuildGate` only enters the rust scoping tier when `language==='rust'`); (3) `classifyOutOfScopeErrors` now partitions against REAL names (a `stockfan-data` failure is in-scope when `stockfan-data` is scoped, where previously the `data` directory name never matched the real failure name).

THEME GUARDRAIL (AC-09, SCENARIO-015/024): run tests/stream-theme-class-theme.test.ts; confirm no new rendering was added and any hypothetical rendering uses method-style `theme.fg(...)` (never destructured).

GATE VERIFICATION (AC-10, SCENARIO-014): `npm run typecheck` (strict-clean) and `npm test` (existing + new) both green; `grep` package.json to confirm no new runtime dependency was added; confirm the only new spawned process in build-runner.ts is the cached `cargo metadata --no-deps --manifest-path ...`.

MANUAL SANITY (not a test, evidence-only): on a real prefixed-crate workspace, `detectTouchedCargoPackages` now prints `stockfan-data stockfan-tools stockfan-workflows` and `cargo build -p stockfan-data -p stockfan-tools -p stockfan-workflows --quiet` compiles instead of exiting 101.

OUT OF SCOPE for testing: changing the scoped-vs-workspace-wide gate STRATEGY, baseline-diff scoping, any render/theme token, control-flow in nodes/workflow/pipeline.

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
