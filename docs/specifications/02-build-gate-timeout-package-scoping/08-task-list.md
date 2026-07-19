# Task List: Build-gate: configurable timeout + per-package test scoping — Technical Specification

- **Date**: 2026-07-19
- **Status**: ✅ ALL PHASES COMPLETE — Code Review **Approved** (Stage 12), all ACs satisfied, gate green.

---

## Completion summary

- **Phases completed**: 3/3
- **Quality gate**: `npm run typecheck` clean (tsc strict, exit 0); `npm test` green (vitest run, incl. 63 new focused tests across `build-runner-timeout/packages/docs` suites).
- **Backward compatibility**: `git diff main -- package.json` empty (no new runtime deps); all three stage call sites unchanged (`verify.ts:87`, `implementation.ts:64`, `index.ts:53` all still `runBuildGate(path, { signal: ctx.signal })`).
- **Non-mutation**: only argv + timeout logic in `src/build-runner.ts` changed; no target-repo writes/quarantine/`#[ignore]`.

---

- [x] **Phase 1 — Configurable build-gate timeout (Fix 1)**: raised exported `DEFAULT_TIMEOUT_MS` from 120_000 → 600_000. Files: `src/build-runner.ts`. AC-02, SCENARIO-003.
- [x] **Phase 1 — Configurable build-gate timeout (Fix 1)**: added exported PURE helper `resolveTimeoutMs(explicit?)` honoring `SUPER_DEV_BUILD_TIMEOUT_MS` (parseInt base 10; NaN/`<=0`/empty/missing → `DEFAULT_TIMEOUT_MS`; explicit positive opt overrides env+default). Files: `src/build-runner.ts`. AC-01, SCENARIO-001/002.
- [x] **Phase 1 — Configurable build-gate timeout (Fix 1)**: `runBuildGate` now resolves timeout via `resolveTimeoutMs(opts.timeoutMs)`; value threads into `spawnSync({ timeout })` inside the `exec` closure. Files: `src/build-runner.ts`. AC-01, SCENARIO-005.
- [x] **Phase 1 — Configurable build-gate timeout (Fix 1)**: vitest unit tests added in `tests/build-runner-timeout.test.ts` for the `resolveTimeoutMs` fallback matrix + explicit-override (per-test `process.env` save/restore). AC-07 (timeout subset), SCENARIO-015.
- [x] **Phase 1 — Configurable build-gate timeout (Fix 1)**: verified zero stage call-site edits via grep. Files: none (verification). AC-05, SCENARIO-012.
- [x] **Phase 2 — Per-package / scoped test invocation (Fix 2)**: added exported PURE helper `parseTestPackages(raw?)` (comma-split, trim, filter empties, dedupe order-preserving). Files: `src/build-runner.ts`. AC-03, SCENARIO-007.
- [x] **Phase 2 — Per-package / scoped test invocation (Fix 2)**: added exported PURE helper `scopedCargoTestArgs(packages)` (non-empty → `["cargo","test","-p",a,"-p",b,"--quiet"]`; empty → unchanged). Files: `src/build-runner.ts`. AC-03, SCENARIO-006.
- [x] **Phase 2 — Per-package / scoped test invocation (Fix 2)**: widened `runBuildGate` opts with optional `testPackages?: string[]`; precedence (provided incl. explicit `[]` = force workspace-wide) > env > workspace-wide; applied only when `language === "rust"` && non-empty && `cmds.test`, on a shallow copy (detector stays pure). Files: `src/build-runner.ts`. AC-04, SCENARIO-008/009.
- [x] **Phase 2 — Per-package / scoped test invocation (Fix 2)**: unit tests added in `tests/build-runner-packages.test.ts`: `parseTestPackages`, `scopedCargoTestArgs`, precedence, non-rust non-regression, shell-safety (SCENARIO-014). AC-07, SCENARIO-010/014/015.
- [x] **Phase 2 — Per-package / scoped test invocation (Fix 2)**: regression guard — existing `expect(c.test).toEqual(["cargo","test","--quiet"])` still passes (detector not mutated). AC-06, SCENARIO-011.
- [x] **Phase 3 — Documentation, contracts, and full quality gate**: JSDoc comment added at the `DEFAULT_TIMEOUT_MS` / resolution site documenting both env vars. Files: `src/build-runner.ts`. AC-10, SCENARIO-017.
- [x] **Phase 3 — Documentation, contracts, and full quality gate**: new README "Configuration" section documenting both env vars with Rust-workspace examples. Files: `README.md`. AC-10, SCENARIO-017.
- [x] **Phase 3 — Documentation, contracts, and full quality gate**: `npm run typecheck` clean; `npm test` green; `git diff package.json` empty; grep confirms three call sites unchanged. AC-08, SCENARIO-016.
- [x] **Phase 3 — Documentation, contracts, and full quality gate**: non-mutation diff review (SCENARIO-013) — final diff changes ONLY argv + timeout logic + tests + README; no `#[ignore]`, no quarantine, no workspace file writes. AC-09, SCENARIO-013.
