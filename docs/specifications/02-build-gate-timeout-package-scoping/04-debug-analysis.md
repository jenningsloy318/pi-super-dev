# Debug Analysis: Build-gate false-fails on slow/Rust workspaces: hardcoded 120s timeout + no per-package test scoping

- **Date**: 2025-11-18

---

## Summary

The super-dev pipeline's deterministic build-gate (src/build-runner.ts) false-fails on slow-compiling workspaces — specifically Rust — for two independent harness-side reasons, aborting Stage 9 (implementation) and permanently blocking review/merge on legitimate code. Both defects are confirmed by direct code inspection; the diagnosis from prior failed runs (specs 54 & 55 on stockfan) is correct and the fix is harness-side only (no target-repo mutation).

DEFECT 1 — Timeout too short & not configurable: `DEFAULT_TIMEOUT_MS = 120_000` is a hardcoded literal at build-runner.ts:22. `runBuildGate` resolves `timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` and correctly threads it into `spawnSync(..., { timeout: timeoutMs })` (~line 178). However, all three stage call sites pass only `{ signal: ctx.signal }` (verify.ts ~line 87, implementation.ts ~line 64, index.ts ~line 53), so no timeoutMs override ever arrives — every cargo build/test/clippy command runs under a flat 120s cap. A clean `cargo build + cargo test + cargo clippy --all-targets` in a fresh Rust worktree takes 3–8 min, so each command hits spawnSync ETIMEDOUT → flag flipped false → `pass:false` → Stage 9 aborts after MAX_ATTEMPTS, exactly as observed. No env var resolution exists anywhere in src/ (grep for SUPER_DEV_BUILD is empty).

DEFECT 2 — No per-package scoping: `detectProjectCommands` returns a workspace-wide `test: ["cargo", "test", "--quiet"]` for any Cargo.toml, with no `-p <crate>` path. So the gate includes pre-existing DB-integration tests (e.g. crates/api/tests/reports_test.rs, crates/store/tests/job_queries_test.rs) that require a running DB and fail identically on the base branch. The gate cannot distinguish pre-existing failures from regressions, so it stays permanently red — review can never reach "Approved" and Stage 11/merge is always skipped. There is no opts.testPackages parameter and no SUPER_DEV_BUILD_TEST_PACKAGES env handling.

Both are pure TypeScript harness defects; the fix touches only src/build-runner.ts (+README). The control-flow engine, render templates, and target repo are untouched.

## Hypotheses

- H1 (prob ~85%, VERIFIED): The build-gate timeout is a hardcoded 120_000ms literal with no env override. Prediction: src contains no SUPER_DEV_BUILD_TIMEOUT_MS resolution; spawnSync always caps at 120s. Evidence: build-runner.ts:22 `const DEFAULT_TIMEOUT_MS = 120_000`; `grep SUPER_DEV_BUILD src/` returned empty; call sites pass only {signal}. Falsified if an env-read existed — it does not.
- H2 (prob ~10%, FALSIFIED): The timeout value is fine but spawnSync fails to actually pass `timeout:` (so raising the default wouldn't help). Prediction: the spawnSync options object omits `timeout` or uses a fixed literal. Evidence: the exec closure DOES thread `timeout: timeoutMs` correctly. So raising the default/env WILL take effect — H2 rejected, reinforcing H1 as the operative cause.
- H3 (prob ~90%, VERIFIED): No per-package (`-p`) scoping mechanism exists, so workspace-wide `cargo test` drags in pre-existing DB tests that fail on main. Prediction: detectProjectCommands rust branch always emits `['cargo','test','--quiet']` and there is no opts.testPackages. Evidence: rust branch in detectProjectCommands; no -p construction code; no testPackages in the runBuildGate signature. Falsified if a -p path existed — none found.
- H4 (prob ~5%, FALSIFIED): Scoping exists but is mis-wired/dropped at the call sites (a param is accepted then ignored). Prediction: runBuildGate signature carries a packages param that is never applied to argv. Evidence: runBuildGate signature is `{ timeoutMs?, signal? }` — no packages param at all. So the feature is absent, not mis-wired.

## Root Cause

Two independent, confirmed harness defects in src/build-runner.ts:

(1) TIMEOUT — `const DEFAULT_TIMEOUT_MS = 120_000;` (build-runner.ts:22) is a hardcoded literal, NOT env-configurable, and is too short for a real clean compile. `runBuildGate` resolves `timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` and threads it into `spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8' })` (~line 178) — threading is correct, but all three call sites (src/stages/verify.ts ~87, src/stages/implementation.ts ~64, src/stages/index.ts ~53) pass only `{ signal: ctx.signal }`, so they unconditionally inherit the 120s default. Clean `cargo build + cargo test + cargo clippy --all-targets` in a fresh worktree exceeds 2 min → each command ETIMEDOUTs → `flag[key]=false`, errors populated → `pass:false` → Stage 9 implementation loop aborts after MAX_ATTEMPTS. This is what killed specs 54 & 55 on stockfan (Rust).

(2) SCOPING — `detectProjectCommands` returns `test: ['cargo','test','--quiet']` workspace-wide for any Cargo.toml, with zero `-p <crate>` support and no opts.testPackages parameter. Pre-existing DB-integration tests that require a live DB (e.g. crates/api/tests/reports_test.rs, crates/store/tests/job_queries_test.rs) are therefore always included and fail identically on main. The gate cannot separate baseline failures from regressions, so it is permanently red → review never reaches Approved → Stage 11 merge always skipped.

Both are harness-side. The implementation agents in prior runs already confirmed the code under test was correct and the failures were purely `spawnSync` ETIMEDOUT + pre-existing DB tests, not target-repo defects.

RECOMMENDED FIX (pure TS, src/build-runner.ts + README only):

Fix 1 — Configurable timeout, higher default:
- Replace `const DEFAULT_TIMEOUT_MS = 120_000` with `600_000` (10 min).
- Add `resolveBuildTimeoutMs(explicit?)`: `const raw = parseInt(process.env.SUPER_DEV_BUILD_TIMEOUT_MS ?? '', 10); return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;`. Let an explicit `opts.timeoutMs` still override (preserves short-timeout unit tests).
- Use the resolved value in `timeoutMs = opts.timeoutMs ?? resolveBuildTimeoutMs()` so the env/default flows into every spawnSync timeout with NO call-site change.
- Code comment at the resolution site documenting SUPER_DEV_BUILD_TIMEOUT_MS.

Fix 2 — Per-package scoping (rust-only):
- Add `opts.testPackages?: string[]` to runBuildGate; resolve effective packages as `opts.testPackages ?? parseList(process.env.SUPER_DEV_BUILD_TEST_PACKAGES)` (trim, drop empties, dedupe).
- When non-empty AND cmds.language === 'rust', build argv as `['cargo','test', ...packages.flatMap(p => ['-p', p]), '--quiet']` (one -p per package; --quiet retained).
- Empty/unset OR non-rust → unchanged argv (`['cargo','test','--quiet']`) — backward compatible, existing detectProjectCommands test stays green.

Call sites need NO change (helpers resolve env internally) — all three already pass `{ signal: ctx.signal }` and inherit both new behaviors. README gains a Configuration section documenting both env vars with a Rust example. Target repo is never mutated (no #[ignore], no quarantine) — only argv + timeout change.

## Reproduction Steps

- CONFIRM via code (fastest, deterministic): (a) cat src/build-runner.ts:22 → `const DEFAULT_TIMEOUT_MS = 120_000;` (hardcoded). (b) grep -rn SUPER_DEV_BUILD src/ → empty (no env resolution). (c) confirm exec closure passes `timeout: timeoutMs` to spawnSync (~line 178) — threading is correct, only the source value is wrong. (d) confirm runBuildGate signature `{ timeoutMs?, signal? }` has NO packages param, and detectProjectCommands rust branch emits test:['cargo','test','--quiet'] (workspace-wide).
- REPRODUCE timeout failure against a real Rust worktree (e.g. stockfan): from the worktree root, time `cargo build --quiet && cargo test --quiet && cargo clippy --all-targets --quiet` — observe wall-clock > 120s (typically 3–8 min for a clean build). Then call `runBuildGate(worktreePath, { signal: ctx.signal })` exactly as the stages do: each command hits spawnSync ETIMEDOUT → result.errors populated with 'cargo ... FAILED (killed ...)' / ETIMEDOUT, result.pass === false → Stage 9 aborts after MAX_ATTEMPTS. This mirrors specs 54 & 55.
- REPRODUCE scoping failure: in the same Rust worktree, run `cargo test --quiet` workspace-wide → observe pre-existing DB-integration tests (crates/api/tests/reports_test.rs, crates/store/tests/job_queries_test.rs) fail with a DB-connection error IDENTICALLY on main (no code change). Then run `cargo test -p <non-db-crate> --quiet` → green. This proves the gate conflates baseline failures with regressions and stays permanently red, blocking review→merge.
- DETERMINISTIC unit-level repro (no cargo needed): add to tests/build-runner.test.ts — (a) timeout env parsing: assert resolveBuildTimeoutMs() returns 600_000 when SUPER_DEV_BUILD_TIMEOUT_MS is unset/empty/NaN/0/negative, and honors a valid integer; (b) scoping argv: with SUPER_DEV_BUILD_TEST_PACKAGES='crates/api,crates/store', assert rust test argv === ['cargo','test','-p','crates/api','-p','crates/store','--quiet']; unset/empty → ['cargo','test','--quiet']; (c) opts.testPackages overrides the env var. These assert on argv construction, avoiding real cargo invocation.
- GATE-CHECK the fix: after patching, run `npm run typecheck` (tsc --noEmit, strict) — must pass with 0 errors; run `npm test` (vitest run) — must pass including new unit tests; confirm grep now finds SUPER_DEV_BUILD_TIMEOUT_MS and SUPER_DEV_BUILD_TEST_PACKAGES in src/build-runner.ts and a Configuration section in README.md. Confirm no regression for non-Cargo repos by leaving both env vars unset and re-running the existing go/python/frontend detect tests (argv unchanged).
