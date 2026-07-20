# Code Assessment: Codebase Assessment: scope-aware cargo build-gate fix (Layers B–E)

- **Date**: 2025-01-15
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a strict-TS pi-extension (a control-flow pipeline library, NOT a runnable server) whose build/test/typecheck gate lives in `src/build-runner.ts`. Spec-07 already shipped `resolveCargoPackageNames` + `detectTouchedCargoPackages` (cached `cargo metadata`, git-diff crate extraction). The remaining work (B: untracked-file union, C: drop-invalid defense-in-depth, D: spec-declared `gate` contract, E: test corrections) must mirror three load-bearing conventions: (1) every git/cargo helper is wrapped in try/catch and degrades to `[]`/`{ok:false}` — NEVER throws; (2) argv are always discrete-element `spawnSync` arrays with no `shell:true`; (3) stage output schemas are typebox `Type.Object({...})` models in `src/render/schemas.ts`, state fields are typed `ControlObj` in `PipelineState`, and `RunOptions` is the single threading surface into `runBuildGate`. There is NO API or UI server — verification is `npm run typecheck` (tsc --noEmit) + `npm test` (vitest run). Layer D's new `gate` field adds a FIFTH (top) precedence tier to the existing four-tier chain in `runBuildGate`. Layer E's test file (`tests/build-runner-autoscope.test.ts`) currently encodes the original bug (`-p data` on a dir==name mock) and mocks `spawnSync` per-call — it must grow a `cargo metadata` JSON route and an `ls-files --others` git route.

## Patterns

### Never-throw degradation (side-effecting helpers → `[]` / `{ok:false}`)

- **Example**: src/build-runner.ts: detectTouchedCargoPackages try/catch → return [] ; loadCargoMetadata → cache+return {ok:false} on any error/timeout/empty/bad-JSON
- **Consistency**: Strict & pervasive. Every git/cargo spawn in build-runner.ts is fully try/caught and degrades silently. Layer B's new `git ls-files` route, Layer C's resolver change (drop-unresolved, metadata-fail → []), and the new final validator MUST follow this exactly — the acceptance criteria forbid throwing from any of them.
### Discrete-argv spawnSync, never `shell:true`

- **Example**: src/build-runner.ts loadCargoMetadata: spawnSync("cargo", ["metadata","--format-version","1","--no-deps","--manifest-path", join(absCwd,"Cargo.toml")], {encoding:"utf8", timeout:...}) — package/path data never reaches a shell
- **Consistency**: Universal in this module. Layer B's `git -C <cwd> ls-files --others --exclude-standard` and any `cargo test --test <stem>` integration invocations (Layer D) must be discrete-element argv arrays with `{encoding:"utf8"}`.
### Module-level cached metadata, keyed by `resolve(cwd)`

- **Example**: src/build-runner.ts: const cargoMetadataCache = new Map<string,CargoMetadataResult>(); loadCargoMetadata keys on absCwd = resolve(cwd); SCENARIO-018 caches failures to avoid re-spawn
- **Consistency**: Layer C's validation and Layer D's declared-package validation should reuse `loadCargoMetadata(cwd)` (it is NOT exported — validation must live inside build-runner.ts or be a new private helper sharing that cache), NOT spawn cargo again. Per-cwd caching is the established contract.
### Typebox stage schemas + `Type.Optional(...)` for optional fields

- **Example**: src/render/schemas.ts:221 SpecificationData = Type.Object({...}); CodeAssessmentData uses services: Type.Optional(Type.Object({...})) and openQuestions: Type.Optional(Type.Array(Type.String()))
- **Consistency**: Layer D: add `gate: Type.Optional(Type.Object({ packages: Type.Optional(Type.Array(Type.String())), workspace: Type.Optional(Type.Boolean()), integration: Type.Optional(Type.Array(Type.String())) }))` to SpecificationData, mirroring the existing `services`/`openQuestions` optional-object/array precedent.
### Precedence-chain JSDoc + if/else-if implementation in `runBuildGate`

- **Example**: src/build-runner.ts runBuildGate: opts.testPackages !== undefined → env SUPER_DEV_BUILD_TEST_PACKAGES → detectTouchedCargoPackages (rust only) → [] ; each tier documented in the module-level JSDoc at top of file
- **Consistency**: Layer D inserts spec-declared `gate.packages` as a NEW TOP tier (spec → env → auto-detect → workspace-wide). `gate.workspace===true` must short-circuit before tiers below. Keep the same if/else-if shape and extend the JSDoc block.
### RunOptions is the single call-site threading surface; call sites pass only `{signal}`

- **Example**: src/stages/verify.ts:87 runBuildGate(setupOf(s).worktreePath,{signal:ctx.signal}); src/stages/index.ts:53 runBuildGate(setup.worktreePath,{signal:ctx.signal}); src/stages/implementation.ts:84 runBuildGate(setup.worktreePath,{signal:ctx.signal})
- **Consistency**: Layer D: add `gate?: {packages?;workspace?;integration?}` to RunOptions in src/types.ts, then read `state.spec?.gate` (note spec is `ControlObj` — read defensively) at all three call sites and pass it through. Keep `{signal}` intact alongside it.
### Spec prompt builder lives behind the `P.*` prompt module, wired from writers.ts

- **Example**: src/stages/writers.ts:58 buildPrompt:(state,ctx)=>P.buildSpecPrompt(S(state), state.classify??null, ctx.task, state.requirements??null, ... state.design??null)
- **Consistency**: Layer D: the instruction telling the agent to declare `gate` for backend features is added in the `buildSpecPrompt` builder (the `P` module), NOT in writers.ts itself. writers.ts only composes args.
### Test harness: mock `node:child_process.spawnSync`, real temp `Cargo.toml`, save/restore env

- **Example**: tests/build-runner-autoscope.test.ts: vi.mock("node:child_process"); routeSpawn() routes git→stdout, cargo→capture+succeed; rustTmp() writes a real Cargo.toml; withEnv() saves/restores SUPER_DEV_* vars
- **Consistency**: Layer E MUST extend routeSpawn to (a) route a `cargo metadata` call → return prefixed-workspace JSON, and (b) route a second git argv (`ls-files --others`) for the untracked case. Existing helper style (cargoCalls ref, cargoArgvFor, callsFor) should be reused, not replaced.

## Files Assessed

- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/build-runner.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/types.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/render/schemas.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/stages/writers.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/stages/verify.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/stages/implementation.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/src/stages/index.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/tests/build-runner-autoscope.test.ts
- /home/jenningsl/development/personal/jenningsloy318/pi-super-dev/package.json

## Recommendations

- Mirror the existing git helper exactly for Layer B: add `spawnSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], {encoding:"utf8"})` in `detectTouchedCargoPackages`, CONCATENATE its stdout with the `--merge-base` stdout, then run the same `CRATE_SEGMENT_RE` over the union. Keep the try/catch→`[]` contract so either git call failing contributes nothing. Update SCENARIO-001/020 prose in JSDoc to mention the untracked union.
- Layer C: (a) change `resolveCargoPackageNames` so an unmatched segment is DROPPED (push nothing) instead of pushing `d`; (b) change the metadata-`{ok:false}` branch to `return []` (NOT identity fallback) so the gate widens to workspace-wide; (c) add a private `validatePackageNames(cwd, names)` reusing `loadCargoMetadata` and call it inside `runBuildGate` before building `-p` flags — drop unknowns with a single ctx.log/console line, never throw. This converts the opaque cargo error into a silent widening.
- Layer D: add `gate` to `SpecificationData` (typebox Optional, mirroring `services`/`openQuestions`), read it in verify.ts/index.ts/implementation.ts as `state.spec?.gate` (defensive — spec is `ControlObj`), thread via a new optional `gate?` on `RunOptions`, and insert it as the NEW TOP precedence tier above `opts.testPackages`. Precedence: `gate.workspace===true` → workspace-wide (short-circuit); else `gate.packages` (validated, dropped if unknown) → `opts.testPackages`/`SUPER_DEV_BUILD_TEST_PACKAGES` → `detectTouchedCargoPackages` (B+C) → `[]`. `gate.integration` targets append extra `cargo test --test <stem>` exec calls inside the existing `exec` loop.
- Layer E: rewrite build-runner-autoscope.test.ts fixtures to a prefixed workspace (`crates/data`→`stockfan-data`, `crates/tools`→`stockfan-tools`, `crates/workflows`→`stockfan-workflows`) by routing a `cargo metadata` call in routeSpawn to return JSON `{packages:[{name:"stockfan-data",manifest_path:"<tmp>/crates/data/Cargo.toml"},...]}`. Assert `-p stockfan-*` (NOT `-p data`). Add: (1) untracked case where git `ls-files --others` returns `crates/workflows/tests/e2e_*.rs`; (2) drop-unresolved case (a touched dir with no member → not emitted; all-drop → workspace-wide argv); (3) new spec-gate test passing `gate:{packages:["stockfan-data","stockfan-workflows"], integration:["crates/workflows/tests/e2e_x.rs"]}` via RunOptions → validated names + appended `cargo test --test e2e_x` (or path), ignoring auto-detect and spawning no git. Note routeSpawn must now distinguish `git diff` from `git ls-files` by argv inspection, not just `cmd==="git"`.
