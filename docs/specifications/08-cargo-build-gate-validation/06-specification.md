# Specification: Scope-aware Cargo Build Gate: Untracked Inclusion, Defense-in-Depth Validation, and Spec-Declared Gate Contract

- **Date**: 2026-07-20

---

## Summary

Complete the scope-aware cargo build-gate fix that spec-07 (already merged, DO NOT redo) started. Spec-07 shipped only Bug A — resolving touched crate dirs to package names via cached `cargo metadata`. This task delivers the three remaining defect layers the diagnosis requires plus a test correction: (B) include UNTRACKED files in the touched surface by unioning `git ls-files --others --exclude-standard` with `git diff --merge-base` so mandated e2e crates are never silently dropped; (C) defense-in-depth validation that NEVER emits an invalid `-p` — the resolver DROPS unresolved dirs (removing the current per-element + whole-list identity fallbacks that produced the invalid `-p data` which crashed the stockfan gate), metadata failure returns `[]` to widen safely to workspace-wide, and a final validator re-checks every candidate name against the member map before any `-p` flag is built regardless of source; (D) an OPTIONAL spec-declared `gate` contract `{ packages?, workspace?, integration? }` that lets the specification stage declare its exact test surface for backend/integration features instead of the framework lossily inferring it from a file diff, threaded from SpecificationData through RunOptions into `runBuildGate` as a new top precedence tier; and (E) correction of the test suite that still encodes the original dir==name bug. All four layers preserve the never-throw degrade-to-workspace-wide invariant, use discrete-argv `spawnSync` (no shell), add no new runtime deps, and are byte-identical to today for non-cargo / non-git / no-gate-contract repos. Verified by `npm run typecheck` (strict-clean) and `npm test` (vitest, all green).

## Architecture

The deterministic build gate lives in `src/build-runner.ts` and is consumed by three call sites — `src/stages/verify.ts:87`, `src/stages/index.ts:53`, `src/stages/implementation.ts:84` — each importing `runBuildGate` (aliased as `n`) and currently calling it as `n(setup.worktreePath, { signal: ctx.signal })`. The gate resolves a scoped cargo package set, then runs `cargo build/test/clippy -p <name>` per surviving name, or workspace-wide when the set is empty. This change layers four fixes onto that single module plus the specification schema/types/prompt, without touching nodes.ts, workflow.ts, pipeline.ts, render templates, or the control-flow layer.

LAYER B — untracked union (AC-01): `detectTouchedCargoPackages(cwd, baseRef?)` at build-runner.ts:405 currently runs only `git -C <cwd> diff --merge-base <ref> --name-only`. It gains a second discrete-argv spawn — `spawnSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], {encoding:"utf8"})` — and CONCATENATES both stdouts before the existing module-level `CRATE_SEGMENT_RE` (`/(?:^|\/)crates\/([^/]+)\//`) runs over the union. Either git command failing (non-git dir, unresolvable ref, spawn error, non-zero exit) contributes nothing rather than throwing, so the union degrades gracefully. This is the ONLY new spawned process; it reuses the existing timeout envelope and adds no runtime deps. Per-cwd caching of `cargo metadata` is unchanged (SCENARIO-037).

LAYER C — defense-in-depth validation (AC-02, AC-03): `resolveCargoPackageNames(cwd, touchedDirs)` at build-runner.ts:327 currently has TWO identity fallbacks that together caused the stockfan crash: a whole-list fallback `return dedupePreservingOrder(strDirs)` when `loadCargoMetadata` returns `{ok:false}`, and a per-element fallback `out.push(matched ? matched.name : d)`. Both are removed. New semantics: when metadata is unavailable the function returns `[]` (so the gate widens to workspace-wide, never guessing names); in the per-element loop, a dir that does not match any `cargo metadata --no-deps` member is DROPPED (push nothing). This converts the opaque cargo error (`package ID specification 'data' did not match any packages … similar name: dtoa`) into a silent widening. Additionally, a private `validatePackageNames(cwd, names)` helper reuses the cached `loadCargoMetadata` to return the subset of candidate names that are known workspace members; `runBuildGate` (or its scoped-argv builder) routes EVERY chosen candidate set — regardless of source — through this validator before constructing any `-p <name>` flag, dropping unknowns with a single log line and widening to workspace-wide if the surviving set is empty. The validation set is workspace-members-only by design (`--no-deps`; path-dependencies are intentionally not gate targets). Never throws from the resolver, validator, or gate.

LAYER D — spec-declared gate contract (AC-04 through AC-08): The specification-stage OUTPUT schema `SpecificationData` in `src/render/schemas.ts:221` gains an OPTIONAL `gate: Type.Optional(Type.Object({ packages: Type.Optional(Type.Array(Type.String())), workspace: Type.Optional(Type.Boolean()), integration: Type.Optional(Type.Array(Type.String())) }))`, mirroring the existing `services`/`openQuestions` optional-object precedent. When omitted (non-backend/trivial specs, or repos with no contract) behavior is byte-identical to today. The specification prompt builder `P.buildSpecPrompt` (composed at `src/stages/writers.ts:58`) is extended to INSTRUCT the agent to declare `gate` for backend/integration features — naming the cargo packages whose tests must pass, whether workspace-wide is required, and any e2e/integration target paths — while permitting omission for trivial specs. `RunOptions` in `src/types.ts:243` gains `gate?: { packages?: string[]; workspace?: boolean; integration?: string[] }` (note: this is the RunOptions interface, NOT the control-flow `gate` node). The three call sites read `state.spec?.gate` defensively (spec is a `ControlObj`) and pass it through `RunOptions.gate` alongside the existing `{signal}`. Precedence in `runBuildGate` becomes, HIGHEST→lowest: (1) `gate.workspace === true` → workspace-wide SHORT-CIRCUIT (ignores packages); (2) spec-declared `gate.packages` → validated; (3) `SUPER_DEV_BUILD_TEST_PACKAGES` env → validated; (4) corrected auto-detect (`detectTouchedCargoPackages` with layers B+C); (5) `[]` → workspace-wide. When any declared package set is empty after validation (all unknown) → degrade to workspace-wide. `gate.integration` targets are APPENDED on top of whatever scope was chosen: a target ending in `.rs` or containing a path separator derives its stem (basename minus `.rs`) and emits `cargo test --test <stem>` under the scoped packages, validated by a filesystem stat of `<memberDir>/tests/<stem>.rs` (no new spawn) with misses dropped and logged; a bare token is used as-is. This never surfaces cargo's `test target 'x' not found` error.

LAYER E — test correction (AC-09, AC-10): `tests/build-runner-autoscope.test.ts` currently encodes the original bug (asserting `-p data` on a dir==name mock). Its `routeSpawn` router is extended to (a) route a `cargo metadata` call to a prefixed-workspace JSON fixture (`crates/data`→`stockfan-data`, `crates/tools`→`stockfan-tools`, `crates/workflows`→`stockfan-workflows`) and (b) distinguish `git diff` from `git ls-files` by argv inspection. Existing assertions are corrected to expect `-p stockfan-*`. New cases: an untracked-only `crates/workflows/tests/e2e_*.rs` change (via `ls-files --others`) still yields `stockfan-workflows`; a touched dir resolving to no member is dropped (all-drop → workspace-wide argv); and a spec-declared `RunOptions.gate = { packages: ["stockfan-data","stockfan-workflows"], integration: ["crates/workflows/tests/e2e_x.rs"] }` drives validated names + appended `cargo test --test e2e_x`, ignoring auto-detect and spawning no git.

CRITICAL INVARIANTS: never throw from git helpers, metadata resolver, validator, or gate — always degrade (drop invalid → widen to workspace-wide). All spawns are discrete-argv `spawnSync` arrays with `{encoding:"utf8"}`, no `shell:true`, so package/path data never reaches a shell. `cargo metadata --no-deps` stays cached per-absolute-cwd (existing `cargoMetadataCache` Map); the empty-input guard is preserved so metadata spawns only when there is something to resolve. The pi `Theme` is a CLASS — any prompt/render change touching theme MUST call method-style (`theme.fg(...)`), never destructure; guarded by `tests/stream-theme-class-theme.test.ts`.

## Testing Strategy

Verification is `npm run typecheck` (tsc --noEmit, strict-clean) and `npm test` (vitest run); there is no API or UI server. The primary unit-test surface is `tests/build-runner-autoscope.test.ts`, which mocks `node:child_process.spawnSync` via `vi.mock` and routes calls through a `routeSpawn` router. The router is extended to: (1) route a `cargo metadata` invocation to a prefixed-workspace JSON fixture with `packages:[{name:"stockfan-data",manifest_path:"<tmp>/crates/data/Cargo.toml"}, ...]` and real temp `Cargo.toml` files written by the existing `rustTmp()` helper; (2) distinguish `git diff --merge-base` from `git ls-files --others --exclude-standard` by argv inspection rather than just `cmd==="git"`; and (3) capture cargo build/test/clippy argvs via the existing `cargoCalls`/`cargoArgvFor`/`callsFor` helpers. Env vars are saved/restored via the existing `withEnv()` helper.

Corrected & new test cases: (a) the existing assertions are flipped to expect `cargo build/test/clippy -p stockfan-data -p stockfan-tools -p stockfan-workflows` (NOT `-p data`); (b) an untracked-only case where `ls-files --others` returns `crates/workflows/tests/e2e_screen_us_fallback.rs` still surfaces `stockfan-workflows`; (c) a drop-unresolved case where a touched dir resolves to no member is omitted from `-p` and all-drop collapses to a workspace-wide argv; (d) a spec-declared-gate-contract test passing `RunOptions.gate = {packages:["stockfan-data","stockfan-workflows"], integration:["crates/workflows/tests/e2e_x.rs"]}` produces validated `-p` names plus an appended `cargo test --test e2e_x`, ignoring auto-detect and spawning no git; (e) precedence assertions covering spec>env>auto and a `gate.workspace===true` short-circuit; (f) an end-to-end stockfan-shape test (AC-10) confirming all three captured argvs carry the three prefixed packages with the workflows crate included via the untracked union.

Regression & guard testing: non-cargo repos, non-git directories, and repos with no `gate` contract must produce output byte-identical to today (the DEFAULT gate strategy stays auto-detect; only `gate.workspace===true` or a failed resolution widens to workspace). The scope-classification helpers (`partitionErrorsByScope` / `isGreenForScope`) must continue partitioning correctly. The theme method-binding regression test `tests/stream-theme-class-theme.test.ts` must remain green. Defense-in-depth never-throw behavior is asserted by forcing metadata-fail and unknown-name inputs and confirming `[]`/workspace-wide output with no thrown error. Spawn hygiene is asserted by confirming argv are discrete arrays and that metadata is not spawned on empty input. Performance invariants: metadata cached per-cwd (single spawn across repeated resolutions) and exactly one new `ls-files` spawn reusing the existing timeout envelope. Acceptance is met when `npm run typecheck` is strict-clean and `npm test` is fully green (existing-corrected + new tests).

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
- SCENARIO-030
- SCENARIO-031
- SCENARIO-032
- SCENARIO-033
- SCENARIO-034
- SCENARIO-035
- SCENARIO-036
- SCENARIO-037
- SCENARIO-038
