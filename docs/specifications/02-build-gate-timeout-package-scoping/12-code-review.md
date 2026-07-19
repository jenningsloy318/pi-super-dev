# Code Review: Build-gate: configurable timeout + per-package test scoping — Code Review

- **Date**: 2026-07-19
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation faithfully realizes the spec's two harness-side fixes in src/build-runner.ts and is fully verified green. (1) Timeout: DEFAULT_TIMEOUT_MS raised to 600_000; exported pure resolveTimeoutMs(explicit?) implements the precedence explicit-finite-positive opt > SUPER_DEV_BUILD_TIMEOUT_MS (parseInt base-10, NaN/<=0/empty/missing fall through) > default, and the resolved value threads into spawnSync({ timeout: timeoutMs }) inside the exec closure (build/test/typecheck/clippy). (2) Scoping: pure parseTestPackages (split/trim/filter-empty/dedupe-order-preserving) + scopedCargoTestArgs (one -p per package, --quiet retained, empty = byte-identical to today) are applied inside runBuildGate on a SHALLOW COPY only when language==='rust' && packages non-empty && cmds.test exists, so detectProjectCommands stays pure. Precedence is exactly as specified: provided opts.testPackages (incl. explicit [] = force workspace-wide) > env > workspace-wide. All 10 acceptance criteria are met: env vars honored (AC-01/02), scoped cargo test (AC-03/04), three call sites unchanged yet inherit new behavior (AC-05 — confirmed verify.ts:87, implementation.ts:64, index.ts:53 all pass { signal: ctx.signal }), non-rust non-regression (AC-06/SCENARIO-010/011), no target-repo mutation (AC-09), and both env vars documented in JSDoc + README 'Configuration' section (AC-10). npm run typecheck is clean; npm test passes 496/496 including 63 new focused unit tests across build-runner-timeout/packages/docs suites covering the fallback matrix, explicit-override, precedence, non-rust non-regression, detector-purity regression guard, and shell-safety (SCENARIO-014). git diff package.json is empty (no new deps). Security: package names are emitted as discrete argv elements to spawnSync with no shell:true anywhere, so no injection surface. The only findings are one pre-existing/amplified concurrency observation (Medium, explicitly out of spec scope) and one trivial maintainability note. This is a correct, complete, backward-compatible fix; no blockers.

## Findings

### CR-01: AbortSignal is not passed to spawnSync — the higher 10-min default widens the worst-case window for an ignored mid-command abort

- **Severity**: Medium
- **File**: `src/build-runner.ts`
- **Line**: ~222
PRE-EXISTING, AMPLIFIED BY THIS CHANGE — NOT A BLOCKER, all ACs remain met. The exec closure only checks opts.signal?.aborted before and AFTER spawnSync returns; it never passes the signal into the spawn. spawnSync accepts a `signal: AbortSignal` option (Node 16+ / undici) that aborts and kills the child immediately. Previously, with the 2-min default, a build that ignored an in-flight abort wasted at most ~2 min; now that the default is 10 min (and user overrides can be 15+ min), a legitimately-aborted long cargo build will run to its full timeout before the post-spawn abort check fires. The spec/constraints did not ask to fix abort behavior and explicitly forbid touching the control-flow engine, so this is an out-of-scope improvement, not a defect introduced by the diff. Failure scenario: Stage 9 verify with a 10-min timeout + a user/cancel signal mid-compile keeps the cargo child alive up to the full budget instead of ~instantly honoring the abort. Suggested follow-up (low-risk, one line, preserves the before/after checks): pass the signal through — `spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8', signal: opts.signal })` — and let spawnSync's own abort return { error } / signal, which the existing r.error branch already reports as 'aborted'. Verify Node version floor in package.json engines supports AbortSignal-on-spawnSync (Node >=16) before landing.
### CR-02: Two dedupe paths exist — module-level dedupePreservingOrder duplicates logic inside parseTestPackages

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: ~78 / ~103
dedupePreservingOrder() is defined for the opts.testPackages branch, while parseTestPackages() re-implements the same trim/filter/dedupe-order-preserving logic inline for the env branch. They are behaviorally equivalent (verified by tests: 'a, a, b' and opts ['a','a','b'] both yield ['a','b']), so this is purely a DRY nit. Suggested cleanup: have parseTestPackages call dedupePreservingOrder on its filtered list, or have the opts branch reuse parseTestPackages by joining — but either is optional. No correctness impact.
### CR-03: No direct assertion that the resolved timeout reaches spawnSync (only indirect coverage)

- **Severity**: Info
- **File**: `tests/build-runner-timeout.test.ts`
The new timeout tests assert resolveTimeoutMs() outputs and the packages tests assert runBuildGate's argv via result.ran, but nothing directly proves spawnSync received { timeout: <resolved> }. The data path is a single visual line (const timeoutMs = resolveTimeoutMs(opts.timeoutMs) → spawnSync({ timeout: timeoutMs })) and is correct on inspection, so this is informational. If desired, a future test could stub/spy spawnSync (vi.spyOn(child_process,'spawnSync')) to assert the options.timeout equals the resolved value for an env override — but the spec's testing strategy did not require it and the current indirect coverage is adequate.
