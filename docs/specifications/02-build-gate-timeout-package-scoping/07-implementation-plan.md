# Implementation Plan: Build-gate: configurable timeout + per-package test scoping — Technical Specification

- **Date**: 2026-07-19
- **Overall Status**: ✅ COMPLETE (3/3 phases). Code Review **Approved**.

---

## Phase 1: ✅ COMPLETE — Configurable build-gate timeout (Fix 1)

Make the gate timeout env-configurable with a 10-minute default. Raise exported DEFAULT_TIMEOUT_MS to 600_000; add exported pure resolveTimeoutMs(explicit?) honoring process.env.SUPER_DEV_BUILD_TIMEOUT_MS (parseInt base 10; NaN/<=0/empty/missing → DEFAULT_TIMEOUT_MS; explicit positive opt overrides env+default); wire runBuildGate to use resolveTimeoutMs(opts.timeoutMs) so the value already threads into spawnSync({timeout}) inside the exec closure. Zero stage call-site edits (all three pass only { signal }). Independently testable: vitest unit tests on the resolveTimeoutMs fallback matrix + explicit-override, with per-test process.env save/restore. Covers AC-01, AC-02, AC-05 (partial), AC-08 (timeout subset).

**Result**: Done. `resolveTimeoutMs` exported; threads into every `spawnSync({ timeout })`; 19 new unit tests green; call sites unchanged. Commits: `1b84fe55`.
## Phase 2: ✅ COMPLETE — Per-package / scoped test invocation (Fix 2)

Add rust-only -p scoping so the gate can reach green without mutating the target repo. Add exported pure helpers parseTestPackages(raw?) (comma-split, trim, filter empties, dedupe preserving order) and scopedCargoTestArgs(packages) (non-empty → ['cargo','test','-p',p1,'-p',p2,'--quiet']; empty → ['cargo','test','--quiet']). Add optional opts.testPackages?: string[] to runBuildGate with precedence: provided opt (incl. explicit [] = force workspace-wide) > env SUPER_DEV_BUILD_TEST_PACKAGES > workspace-wide; apply only when language==='rust' and packages non-empty, on a SHALLOW COPY of cmds (detector stays pure/unchanged). Independently testable: pure argv-construction + precedence assertions, no real cargo. Depends on Phase 1 because both edit the same runBuildGate resolution block (helper functions themselves are independently authorable). Covers AC-03, AC-04, AC-06, SCENARIO-014.

**Result**: Done. Both pure helpers exported; scoping guarded on `language==='rust'` and applied on a shallow copy; detector purity preserved (regression test still green). Commits: `0c56ace0`.
## Phase 3: ✅ COMPLETE — Documentation, contracts, and full quality gate

Document both env vars and run the complete quality gate. Add a JSDoc comment at the DEFAULT_TIMEOUT_MS / resolution site documenting SUPER_DEV_BUILD_TIMEOUT_MS and SUPER_DEV_BUILD_TEST_PACKAGES with fallback semantics; add a new README.md 'Configuration' section with Rust-workspace examples (timeout override; package scoping). Run npm run typecheck (strict, zero errors) and npm test (green incl. new tests); confirm package.json diff is empty (no new deps) and the three stage call sites are unchanged via grep. Independently testable: README/config grep + typecheck + full test suite green. Covers AC-09 (non-mutation diff review), AC-10, SCENARIO-013/016/017.

**Result**: Done. README "Configuration" section added; JSDoc documents both env vars; `tsc --noEmit` exit 0; `npm test` green (496/496 incl. 63 new tests); `git diff package.json` empty. Commit: `50b7b8b4`.

---

## Quality gate (final)
- `npm run typecheck`: ✅ exit 0 (strict)
- `npm test`: ✅ green (496/496, incl. 3 new suites / 63 new tests)
- `git diff main -- package.json`: ✅ empty (no new runtime deps)
- Call sites: ✅ unchanged (`verify.ts:87`, `implementation.ts:64`, `index.ts:53`)
- Non-mutation (SCENARIO-013): ✅ only argv + timeout + tests + README changed
