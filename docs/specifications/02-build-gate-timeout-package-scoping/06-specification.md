# Specification: Build-gate: configurable timeout + per-package test scoping — Technical Specification

- **Date**: 2026-07-19

---

## Summary

Fix two harness-side defects in pi-super-dev's deterministic build-gate (src/build-runner.ts) that cause false FAILs on Rust and other slow-compiling workspaces, aborting Stage 9 (verify) and blocking Stage 11 (merge) on legitimate code. (1) The gate timeout is hardcoded at 120_000ms (line 22) and not configurable; all three stage call sites (verify.ts:87, implementation.ts:64, index.ts:53) pass only `{ signal }`, so every cargo build/test/clippy ETIMEDOUTs on a clean compile. (2) The gate runs `cargo test --quiet` workspace-wide (line 85), sweeping in pre-existing DB-integration tests (crates/api, crates/store) that fail identically on main, so the gate can never reach green. This is a pure-TS, backward-compatible change: raise DEFAULT_TIMEOUT_MS to 600_000, make it env-configurable via SUPER_DEV_BUILD_TIMEOUT_MS, and add rust-only per-package (`-p`) scoping via SUPER_DEV_BUILD_TEST_PACKAGES (and an optional opts.testPackages override). The target repo is NEVER mutated — only the harness argv + timeout change. No control-flow engine or render-template changes; no new runtime dependencies; no call-site edits required (the helper resolves both env vars internally). Covers AC-01..AC-10 and SCENARIO-001..SCENARIO-017.

## Architecture

SCOPE. Single-file behavioral change in src/build-runner.ts (the deterministic build/test/typecheck oracle), plus focused tests in tests/build-runner.test.ts and a new README section. Three stage call sites (verify.ts:87, implementation.ts:64, index.ts:53) are intentionally left UNCHANGED — they all call `runBuildGate(path, { signal: ctx.signal })`, so resolving env vars inside the helper requires zero stage edits (matches the repo's established `process.env.SUPER_DEV_* ?? default` inline pattern seen in workflow.ts:103 and session-agent.ts:295). The control-flow engine (nodes.ts, workflow.ts, pipeline.ts) and render templates are explicitly untouched (constraint).

KEY INVARIANT — DETECTOR STAYS PURE. `detectProjectCommands(cwd)` is a pure manifest detector and MUST NOT be mutated: the existing test at tests/build-runner.test.ts:27 asserts the EXACT rust test argv `expect(c.test).toEqual(["cargo","test","--quiet"])`. All scoping is applied inside `runBuildGate` on a shallow copy of the detected commands, preserving backward compatibility and the regression test. The existing pure/side-effecting split (detector pure, runner side-effecting) is preserved.

FIX 1 — TIMEOUT (AC-01, AC-02, AC-05). (a) Raise the exported `DEFAULT_TIMEOUT_MS` from 120_000 to 600_000 (10 min) — kept exported for forward-compat and unit-testability. (b) Add an exported PURE helper `resolveTimeoutMs(explicit?: number): number` with precedence: (1) if `explicit` is a finite positive number → return it (preserves the existing opts.timeoutMs override for unit tests); (2) else parse `parseInt(process.env.SUPER_DEV_BUILD_TIMEOUT_MS ?? "", 10)`; (3) if that is NaN, <=0, empty, or missing → return DEFAULT_TIMEOUT_MS. (c) In `runBuildGate`, replace `const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS` with `const timeoutMs = resolveTimeoutMs(opts.timeoutMs)`. The value already threads into `spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" })` inside the `exec` closure (~line 173), so no further change is needed there — every build/test/typecheck command inherits the resolved timeout. Because all three call sites omit timeoutMs, they inherit the new 10-min default and env override automatically.

FIX 2 — PER-PACKAGE SCOPING (AC-03, AC-04, AC-06). Add three exported PURE helpers so they are unit-testable without spawning cargo: (a) `parseTestPackages(raw?: string): string[]` — splits the comma-list, trims each entry, filters empties, dedupes preserving first-seen order; ""/undefined → []. (b) `scopedCargoTestArgs(packages: string[]): string[]` — non-empty → `["cargo","test", ...packages.flatMap(p => ["-p", p]), "--quiet"]` (one -p flag per package, --quiet retained); empty → `["cargo","test","--quiet"]` (unchanged). (c) Add an optional `opts.testPackages?: string[]` to `runBuildGate`'s options type (interface widening is safe — narrowing breaks consumers). Inside `runBuildGate`, resolve scope with explicit precedence honoring AC-04: if `opts.testPackages !== undefined` (provided) it takes precedence over the env var (after dedupe, so an explicit `[]` means "force workspace-wide"); otherwise consult `parseTestPackages(process.env.SUPER_DEV_BUILD_TEST_PACKAGES)`. When `cmds.language === "rust"` AND the resolved packages array is non-empty AND `cmds.test` exists, replace `cmds.test` on a shallow copy (`{ ...cmds, test: scopedCargoTestArgs(packages) }`) before the exec loop. When packages are empty/unset, the rust argv is byte-identical to today. Scoping is GUARDED on `language === "rust"` only — go/python/node/mixed stacks produce identical argv regardless of the env var (AC-06), and greenfield repos (no manifest) still return `pass:true, ran:[]`.

SECURITY / SHELL (SCENARIO-014). Package names are never passed through a shell: the argv is always a `string[]` handed to `spawnSync` (no `shell: true`), so there is no interpolation. Package names flow verbatim as discrete argv elements.

NON-MUTATION (SCENARIO-013, AC-09). The fix changes only HOW the harness invokes commands (argv + timeout). No #[ignore] insertion, no test quarantine, no file writes in the workspace under test — confirmed by diff review.

ERROR-REPORTING CONTRACT PRESERVED. The `exec` closure, `STDERR_TAIL_LINES=12`, and the `${label} FAILED (reason):\n<tail>` shape are unchanged; a scoped or longer-running command simply flows through, so stages that consume `buildGate.errors` (e.g. the reviewFix prompt at index.ts:~88) are unaffected.

NO NEW DEPENDENCIES. Only Node built-ins (`node:child_process`, `node:fs`, `node:path`) and existing APIs are used. package.json receives no dependency changes.

CONTRACTS (input/output signatures):
- `resolveTimeoutMs(explicit?: number): number`
- `parseTestPackages(raw?: string): string[]`
- `scopedCargoTestArgs(packages: string[]): string[]`
- `runBuildGate(cwd: string, opts?: { timeoutMs?: number; testPackages?: string[]; signal?: AbortSignal }): BuildGateResult` (BuildGateResult shape unchanged)
- `detectProjectCommands(cwd: string): ProjectCommands` (UNCHANGED)
- `DEFAULT_TIMEOUT_MS: number` (exported, value 600_000)

## Testing Strategy

DETERMINISTIC UNIT TESTS (tests/build-runner.test.ts, vitest, mirroring the existing tmpProj/describe/expect style). Tests assert on ARGV CONSTRUCTION and pure resolver outputs — never spawn real cargo/build, so they are fast and hermetic. Each env-var test saves/restores `process.env` per-test (delete the key, set, assert, restore) to avoid cross-test bleed.

(1) resolveTimeoutMs fallback matrix (AC-01/AC-02): undefined → 600_000; "" → 600_000; "abc"/NaN → 600_000; "0"/"-5" (<=0) → 600_000; "900000" → 900000; explicit opt `resolveTimeoutMs(1234)` → 1234 (overrides env+default); explicit opt with env also set → opt wins. (2) parseTestPackages (AC-03/SCENARIO-007): "crates/api, crates/store" → ["crates/api","crates/store"]; "a, b ,, a ," → ["a","b"] (whitespace trimmed, empties filtered, dupes collapsed, order preserved); "" and undefined → []. (3) scopedCargoTestArgs (AC-03/SCENARIO-006): ["a","b"] → ["cargo","test","-p","a","-p","b","--quiet"]; [] → ["cargo","test","--quiet"]. (4) Precedence (AC-04/SCENARIO-008/009): opts.testPackages=["x"] with env set → uses ["x"] and ignores env; opts.testPackages=[] (provided) → forces workspace-wide (overrides env); opts.testPackages undefined with env="a,b" → scopes to a,b; both absent → exactly ["cargo","test","--quiet"]. (5) Non-rust non-regression (AC-06/SCENARIO-010/011): for go/python/mixed stacks with the env var set, detected build/test/typecheck argv are identical to today; greenfield (no manifest) → pass:true, ran:[] unchanged. (6) Shell-safety (SCENARIO-014): assert the constructed test argv is a `string[]` passed to spawnSync (no shell:true anywhere in the module). (7) Regression guard: the existing `expect(c.test).toEqual(["cargo","test","--quiet"])` detector assertion still passes, proving detectProjectCommands was not mutated.

INTEGRATION / GATE VERIFICATION (AC-08/SCENARIO-016): `npm run typecheck` (tsc --noEmit under strict mode) passes with zero errors; `npm test` (vitest run) passes including the new tests; `git diff package.json` is empty (no new runtime deps). Confirm via grep that the three stage call sites remain `runBuildGate(path, { signal: ctx.signal })` (SCENARIO-012). NON-MUTATION CHECK (SCENARIO-013): review the final diff to confirm only argv + timeout logic changed and no target-repo writes/quarantine exist. DOCUMENTATION (AC-10/SCENARIO-017): JSDoc at the resolution site plus a new README "Configuration" section with Rust-workspace examples.

## Post-Implementation Deviations

This section records deviations from the original spec text identified during/after implementation. Code Review verdict: **Approved** — no spec-blocking deviations; the items below are explicitly out-of-scope follow-ups, not unmet acceptance criteria. All AC-01..AC-10 and SCENARIO-001..017 are satisfied exactly as specified.

### DEV-01 — AbortSignal not threaded into `spawnSync` (out-of-scope follow-up)
- **Severity**: Medium (pre-existing, amplified by this change).
- **Original spec text**: "The value already threads into `spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8" })` inside the `exec` closure (~line 173), so no further change is needed there."
- **Actual behavior**: The `exec` closure checks `opts.signal?.aborted` before and after `spawnSync` returns but does NOT pass the AbortSignal into `spawnSync` itself. Node's `spawnSync` supports a `signal` option (>=16) that would abort/kill the child immediately.
- **Reason**: The constraints explicitly forbid touching the control-flow engine and did not request abort-behavior changes. Raising the default to 10 min (and allowing user overrides of 15+ min) widens the worst-case window where an ignored mid-command abort wastes up to the full budget instead of ~instantly honoring it.
- **Impact**: No correctness or AC impact. A Stage-9 verify with a 10-min timeout + a cancel signal mid-compile keeps the cargo child alive up to the full budget before the post-spawn abort check fires.
- **Recommended follow-up (not in this change)**: pass the signal through — `spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: "utf8", signal: opts.signal })` — preserving the existing before/after checks. Verify `package.json` `engines` Node floor (>=16) first. See CR-01 in `12-code-review.md`.

### DEV-02 — Two dedupe paths (DRY observation, no behavior change)
- **Severity**: Low (maintainability).
- **Original spec text**: `parseTestPackages` is specified as "splits the comma-list, trims each entry, filters empties, dedupes preserving first-seen order".
- **Actual behavior**: A module-level `dedupePreservingOrder()` is used for the `opts.testPackages` branch, while `parseTestPackages()` re-implements the same trim/filter/dedupe-order-preserving logic inline for the env branch.
- **Reason**: Convenience during incremental authoring of the two precedence branches.
- **Impact**: None. Verified behaviorally equivalent by tests (both `"a, a, b"` and `opts ["a","a","b"]` yield `["a","b"]`).
- **Recommended follow-up (optional)**: have `parseTestPackages` call `dedupePreservingOrder`, or have the opts branch reuse `parseTestPackages` by joining. See CR-02.

### DEV-03 — Generic non-rust scoping intentionally deferred
- **Severity**: Info.
- **Original spec text**: "Detect the build system generically where possible, but at minimum support a Cargo `-p <crate>` (or `--package`) scoping mechanism."
- **Actual behavior**: Scoping is guarded on `language === "rust"` only. Go/python/node/mixed stacks produce byte-identical argv regardless of `SUPER_DEV_BUILD_TEST_PACKAGES`.
- **Reason**: The spec's recommendation to keep the fix surgical; the env-var + `opts.testPackages` plumbing is generic enough to extend to npm/pnpm/go later without an API change. Non-rust stacks were not the blocker that killed specs 54/55.
- **Impact**: None for backward compatibility (non-rust repos behave exactly as before per AC-06). Rust is the only slow-compiling workspace class that triggered the false FAILs.
- **Recommended follow-up (optional)**: add `language`-dispatched `scopedTestArgs` helpers (npm `--workspace`, go package list, etc.) reusing the existing precedence plumbing.

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
