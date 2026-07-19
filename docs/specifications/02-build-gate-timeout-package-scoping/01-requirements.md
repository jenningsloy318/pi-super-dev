# Requirements: Build-gate: configurable timeout + per-package test scoping (fix false failures on Rust/slow workspaces)

- **Date**: 2025-11-20
- **Author**: super-dev:requirements-clarifier
- **Type**: bug-fix
- **Priority**: critical
- **Status**: draft

---

## Executive Summary

The deterministic build-gate (src/build-runner.ts) false-fails on Rust and other slow-compiling workspaces due to two harness-only defects: (1) the build/test/typecheck timeout is hardcoded to 120s — too short for a clean `cargo build+test+clippy` and not configurable, so commands ETIMEDOUT and abort Stage 9; and (2) the gate runs `cargo test --quiet` workspace-wide, including pre-existing DB-integration tests that fail on main, so the gate stays permanently red and review/merge can never reach "Approved". This fix makes the timeout env-configurable with a higher sane default and adds Cargo `-p <crate>` test scoping (param + env var), while leaving non-Cargo repos and repos with no env vars behaving exactly as before. The fix is harness-side only — it never mutates or auto-quarantines tests in the target repo.

## Acceptance Criteria

- **AC-01**: A new env var SUPER_DEV_BUILD_TIMEOUT_MS is honored by runBuildGate. It is parsed defensively via parseInt: missing, empty, NaN, or <=0 values fall back to a sane default of 600_000ms (10 min). The resolved value threads into every spawnSync call inside the exec closure (the `timeout:` option), so all build/test/typecheck commands inherit it.
- **AC-02**: The exported default timeout constant is raised from 120_000 to 600_000 and is used as the fallback when SUPER_DEV_BUILD_TIMEOUT_MS is unset/invalid. If an explicit opts.timeoutMs is passed to runBuildGate, it still overrides the env/default (preserves unit-testability with short timeouts).
- **AC-03**: A new env var SUPER_DEV_BUILD_TEST_PACKAGES accepts a comma-separated list of packages (e.g. 'crates/api,crates/store'). It is parsed defensively: trimmed, empties filtered, deduped. When non-empty AND language==='rust', the cargo test argv becomes `cargo test -p pkg1 -p pkg2 --quiet` (one -p flag per package, --quiet retained). When empty/unset, the test argv is unchanged (`cargo test --quiet`) — current workspace-wide behavior is preserved.
- **AC-04**: runBuildGate accepts an optional `opts.testPackages?: string[]` parameter that, when provided, takes precedence over the env var and produces the same `cargo test -p ...` scoping for rust. When omitted, the env var is consulted; when both are absent, behavior is workspace-wide. This gives call sites an explicit override without requiring env setup.
- **AC-05**: The three existing stage call sites (src/stages/verify.ts:~87 buildGateStep, src/stages/implementation.ts:~64 implementation loop, src/stages/index.ts:~53 preMergeBuildStage) require NO change to inherit the new higher default timeout and env-driven scoping (the helper resolves both from env internally). They continue to call runBuildGate(path, { signal }) exactly as today. (Verified: all three pass only `{ signal: ctx.signal }`.)
- **AC-06**: Non-Cargo repos are unaffected: the -p scoping logic applies only to language==='rust'. For go/python/node/mixed stacks, an empty or non-rust case produces identical argv to today regardless of SUPER_DEV_BUILD_TEST_PACKAGES. Repos with no manifest (greenfield) still get `pass:true, ran:[]`.
- **AC-07**: Focused unit tests are added to tests/build-runner.test.ts covering: (a) timeout env-parsing fallback — missing/NaN/0/negative all → 600_000 default; valid value → honored; (b) -p scoping command construction — SUPER_DEV_BUILD_TEST_PACKAGES produces `cargo test -p a -p b --quiet`; empty/unset → `cargo test --quiet`; (c) opt.testPackages overrides env. Tests are deterministic and avoid real cargo invocation where possible (assert on argv construction, not execution).
- **AC-08**: `npm run typecheck` (tsc --noEmit) passes with zero errors under strict mode, and `npm test` (vitest run) passes including the new tests. No new runtime dependencies are added to package.json.
- **AC-09**: The target repo is never mutated: the fix only changes how the harness INVOKES the build/test commands (argv + timeout). No #[ignore] insertion, no test quarantine, no file modification in the workspace under test.
- **AC-10**: Both env vars are documented in a code comment at the DEFAULT_TIMEOUT_MS / resolution site in build-runner.ts, AND a new 'Configuration' section is added to README.md (no such section exists today) documenting SUPER_DEV_BUILD_TIMEOUT_MS and SUPER_DEV_BUILD_TEST_PACKAGES with examples for a Rust workspace.

## Non-Functional Requirements

- Backward compatibility: repos with no Cargo.toml and no env vars set must behave byte-for-byte identically to today except the default timeout rising from 120s to 600s. The 600s default is chosen because clean cargo builds of medium workspaces routinely take 3-8 min; it must not regress fast-repo iteration (each command still fails fast on real errors, only the ceiling rises).
- Performance: each build/test/typecheck command is still bounded by the timeout (per-command, via spawnSync), so total gate time is at most 3× timeout, not unbounded. The env lookup happens once per runBuildGate call (cheap).
- Defensive parsing: all env reads use Number.parseInt with explicit NaN/<=0 guards and string split+trim+filter to be robust against malformed user-supplied env values (e.g. 'SUPER_DEV_BUILD_TIMEOUT_MS=abc', trailing commas, whitespace).
- Security: no shell interpolation — argv is always built as a string[] passed to spawnSync(argv[0], argv.slice(1), ...), so package names from the env var are never passed through a shell. Package names are still trusted input (set by the operator running the pipeline), not untrusted user input.
- Scope discipline: change is confined to src/build-runner.ts (+ new tests + README). The control-flow engine (nodes.ts, workflow.ts, pipeline.ts), render templates, and the three stage call sites' existing signatures are untouched.
- No mutation of target repo state — the gate observes only (spawns + reads exit code/stderr), never writes to the workspace under test.

## Open Questions

- Should generic workspace scoping for non-rust stacks (npm test --workspace <pkg>, pnpm --filter, go test ./pkg/...) be implemented now or deferred? The task requires Cargo at minimum; recommend deferring others to a follow-up to keep this fix surgical and low-risk. The env var + opt.testPackages plumbing is generic enough to extend later without API change.
- --quiet placement: confirm `cargo test -p a -p b --quiet` (quiet as trailing flag) is acceptable vs `cargo test --quiet -p a -p b`. Cargo accepts both; trailing keeps the existing `--quiet` append pattern in detectProjectCommands intact and is the minimal diff. Recommend trailing.
- Should SUPER_DEV_BUILD_TIMEOUT_MS also cap a per-command vs total-budget semantics? Today spawnSync applies the timeout per-command (build, test, typecheck each get the full budget). Confirm per-command is the intended model (matches current behavior; recommend keeping it).
