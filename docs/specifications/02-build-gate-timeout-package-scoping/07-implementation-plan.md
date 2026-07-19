# Implementation Plan: Build-gate: configurable timeout + per-package test scoping — Technical Specification

- **Date**: 2026-07-19

---

## Phase 1: Phase 1 — Configurable build-gate timeout (Fix 1)

Make the gate timeout env-configurable with a 10-minute default. Raise exported DEFAULT_TIMEOUT_MS to 600_000; add exported pure resolveTimeoutMs(explicit?) honoring process.env.SUPER_DEV_BUILD_TIMEOUT_MS (parseInt base 10; NaN/<=0/empty/missing → DEFAULT_TIMEOUT_MS; explicit positive opt overrides env+default); wire runBuildGate to use resolveTimeoutMs(opts.timeoutMs) so the value already threads into spawnSync({timeout}) inside the exec closure. Zero stage call-site edits (all three pass only { signal }). Independently testable: vitest unit tests on the resolveTimeoutMs fallback matrix + explicit-override, with per-test process.env save/restore. Covers AC-01, AC-02, AC-05 (partial), AC-08 (timeout subset).
## Phase 2: Phase 2 — Per-package / scoped test invocation (Fix 2)

Add rust-only -p scoping so the gate can reach green without mutating the target repo. Add exported pure helpers parseTestPackages(raw?) (comma-split, trim, filter empties, dedupe preserving order) and scopedCargoTestArgs(packages) (non-empty → ['cargo','test','-p',p1,'-p',p2,'--quiet']; empty → ['cargo','test','--quiet']). Add optional opts.testPackages?: string[] to runBuildGate with precedence: provided opt (incl. explicit [] = force workspace-wide) > env SUPER_DEV_BUILD_TEST_PACKAGES > workspace-wide; apply only when language==='rust' and packages non-empty, on a SHALLOW COPY of cmds (detector stays pure/unchanged). Independently testable: pure argv-construction + precedence assertions, no real cargo. Depends on Phase 1 because both edit the same runBuildGate resolution block (helper functions themselves are independently authorable). Covers AC-03, AC-04, AC-06, SCENARIO-014.
## Phase 3: Phase 3 — Documentation, contracts, and full quality gate

Document both env vars and run the complete quality gate. Add a JSDoc comment at the DEFAULT_TIMEOUT_MS / resolution site documenting SUPER_DEV_BUILD_TIMEOUT_MS and SUPER_DEV_BUILD_TEST_PACKAGES with fallback semantics; add a new README.md 'Configuration' section with Rust-workspace examples (timeout override; package scoping). Run npm run typecheck (strict, zero errors) and npm test (green incl. new tests); confirm package.json diff is empty (no new deps) and the three stage call sites are unchanged via grep. Independently testable: README/config grep + typecheck + full test suite green. Covers AC-09 (non-mutation diff review), AC-10, SCENARIO-013/016/017.
