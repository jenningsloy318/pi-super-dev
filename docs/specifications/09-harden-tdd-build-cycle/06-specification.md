# Specification: Technical Specification — Harden super-dev TDD/Implement/Build Cycle (RED oracle, no-`--lib` parity, scope-aware npm gate, render-layer test parity)

- **Date**: 2026-07-20

---

## Summary

Pure-TypeScript bug-fix to pi-super-dev closing four proven gaps in the Stage 9 (tdd-guide → implementer → runBuildGate hard oracle) cycle. (Gap 1, CRITICAL) The TDD "red" phase is currently never verified — `src/stages/implementation.ts:70` calls the `tdd-guide` agent and DISCARDS the result, so "TDD" is really "T+D". We add a deterministic, never-throwing `runRedCheck(cwd, testTargets, opts)` oracle (status `red|green|broken|unknown`) modeled on the existing `runBuildGate` skeleton, reusing `detectProjectCommands`, `resolveTimeoutMs`, `resolveIntegrationStems`, and the cached cargo metadata; `implementation.ts` wires a bounded re-prompt loop (re-prompt tdd-guide on `green`/`broken`, ≤ `MAX_RED_RETRIES=2` within the existing attempt; proceed on `red`/`unknown`; loud warning on cap exhaustion). (Gap 3) `buildTddPrompt` already accepts a `langInstructions` arg but `implementation.ts` passes nothing, so the RED phase can miss `tests/` integration binaries — we pass the existing shared `rustDiscipline(setup)` (single `RUST_SELF_VERIFY_DISCIPLINE` source string) so both RED and implement prompts forbid `--lib`-only and require full `cargo test -p <pkg>` + `--test <stem>` integration targets. (Gap 4) The cargo `inScopePass`/`outOfScopeErrors` concept is cargo-only, so pre-existing npm/vitest/jest failures in untouched files block the gate; we extract a shared `touchedFilePaths(cwd, baseRef)` git helper (the existing `diff --merge-base` + `ls-files --others` union currently embedded in `detectTouchedCargoPackages` — no new git spawns), parse failing test-file paths from vitest `❯ <path>` / jest `FAIL <path>` markers, and classify in/out-of-scope for npm-family runners exactly like cargo, degrading conservatively to in-scope on any ambiguity. (Gap 2) The fgColors "real runtime shape vs. mock" bug class passed every gate because unit tests used a mock Theme while the real Theme is a class with `this.fgColors`; we deliver `tests/helpers/real-theme.ts` (`withRealTheme<T>(fn:(theme:Theme)=>T):T` exercising the REAL class-based proxy via `initTheme()`, method-style only — never destructured), a `tests/render/real-theme-parity.test.ts` whole-render-layer regression (themeLine, commandBackground, buildResultComponent, packDashboardLines, createDashboardWidgetFactory output), and `docs/testing-parity.md` codifying the convention. Every new gate/oracle/git helper degrades instead of throwing (red→unknown→proceed; parse ambiguity→conservative in-scope; git/spawn error→empty touched set→in-scope); greenfield repos and no-failure repos behave exactly as before; cargo `inScopePass` is byte-for-byte unchanged; `MAX_ATTEMPTS=3`, Stage 10 review, and Stage 11 integration are untouched; no new runtime deps. A fully-mechanical "no framework mocks" graph-based gate is explicitly future work (documented, not delivered). Verification: `npm run typecheck` strict-clean + `npm test` ALL green (existing scoped-args/touched-crates/autoscope/inscope-classification/resolver-validation/nonregression/package-wiring suites updated where signatures change, plus new red-oracle/parity/npm-inscope/implementation-red-loop suites).

## Architecture

The change is confined to four source modules + the test layer of pi-super-dev. It preserves the dominant NEVER-THROW/degrade-to-safe-default invariant, reuses the existing typed interfaces (`ProjectCommands`, `BuildGateResult`, `GateOptions`), and adds three new typed boundaries. There is no long-running server — verification is `npm test` (vitest run) + `npm run typecheck` (tsc --noEmit).

## Module-by-module technical decisions

### A. `src/build-runner.ts` — three additions + one refactor

1. **Shared git helper (refactor + extraction, Gap 4 foundation).** `detectTouchedCargoPackages(cwd, baseRef?)` (build-runner.ts:485) currently spawns `git -C <cwd> diff --merge-base <ref> --name-only` AND `git -C <cwd> ls-files --others --exclude-standard`, concatenates stdouts, then maps `CRATE_SEGMENT_RE` over the lines and `dedupePreservingOrder`s. EXTRACT the raw path union into a new exported function:
   `export function touchedFilePaths(cwd: string, baseRef?: string): string[]` — returns the dedupePreservingOrder union of both git stdouts as RAW file paths (no crate filtering). Base-ref precedence: `baseRef ?? process.env.SUPER_DEV_GATE_BASE_REF ?? "main"`. Whole body in try/catch → `[]`. Then refactor `detectTouchedCargoPackages` to map `CRATE_SEGMENT_RE` over `touchedFilePaths(cwd, baseRef)` (zero behavior change — keeps the 9 touched-crates/autoscope/nonregression tests green; keeps the "bounded git spawns" invariant: still exactly two git processes). This is the single source of the touched-file set for both cargo and npm in-scope classification.

2. **RED oracle (Gap 1a, AC-01).** Add `export type RedStatus = "red" | "green" | "broken" | "unknown"` and `export interface RedCheckOptions { timeoutMs?: number; signal?: AbortSignal; }` (shares the {timeoutMs?, signal?} shape of `GateOptions`). Implement `export function runRedCheck(cwd: string, testTargets: string[], opts?: RedCheckOptions): RedStatus` modeled on the `runBuildGate` skeleton (build-runner.ts:932):
   - `const cmds = detectProjectCommands(cwd);` (returns `{language, ran[], pm?, ...}`; greenfield/no-manifest → `{language:'mixed', ran:[]}`).
   - If `cmds` has no test runner OR `testTargets.length === 0` → return `"unknown"` (no spawn — greenfield cannot stall the pipeline).
   - Build scoped argv per `cmds.language`, mirroring `runBuildGate`'s branching:
     - `rust` → derive stems via `resolveIntegrationStems(cwd, testTargets)` (build-runner.ts:414; skips unresolvable); for each resolved `(pkg, stem)` run `cargo test -p <pkg> --test <stem>` (NO `--lib`); if no stems resolve, fall back to `cargo test -p <pkg>` for the touched packages.
     - `frontend`/`backend` (npm) → if `cmds.pm`/vitest detected: `vitest run <testTargets>` (or `npm test -- <testTargets>` / `pnpm test -- <testTargets>` via `cmds.pm`).
     - `python` → `pytest <testTargets>`.
   - Execute via the existing envelope: `spawnSync(argv[0], argv.slice(1), { cwd, timeout: resolveTimeoutMs(opts?.timeoutMs), encoding: "utf8" })` (resolveTimeoutMs reads `SUPER_DEV_BUILD_TIMEOUT_MS`).
   - Classify the COMBINED stdout+stderr+exit code into exactly one status using per-language heuristics:
     - **cargo**: `"broken"` if output contains `error[E`, `could not compile`, or `no tests to run` with no test execution; `"red"` if exit!==0 AND a failure marker (`test result: FAILED.`, `FAILED`, `panicked`) appears AFTER successful compilation; `"green"` if exit===0 (all passed); `"unknown"` on ambiguous shape.
     - **npm/vitest/jest**: `"broken"` on collection/parse errors (`SyntaxError`, `failed to load`, `No test files found` without a run); `"red"` if exit!==0 with a failing-test marker (`❯`, `FAIL`, `Tests:\s+\d+ failed`); `"green"` if exit===0; `"unknown"` on ambiguity.
     - **pytest**: `"red"` if `failed`/`error` in summary with exit!==0; `"green"` if exit===0; `"broken"` on collection error (`ERROR collecting`); `"unknown"` on ambiguity.
   - **The ENTIRE body is wrapped in try/catch**: any spawn error, timeout, or parse ambiguity → return `"unknown"` (or a conservative status) — NEVER throw. This is the load-bearing invariant mirrored from every existing helper.

3. **npm in-scope classifier (Gap 4, AC-04).** Add `export function parseFailingNpmTestFiles(combinedOutput: string): string[]` matching vitest `❯\s*(<path>)` and jest `^FAIL\s+(<path>)` markers; returns deduped paths or `[]` on no match (never throws). In `runBuildGate`, after a FAILED npm/vitest/jest test step: `const touched = touchedFilePaths(cwd, opts?.gate?.baseRef ?? process.env.SUPER_DEV_GATE_BASE_REF);` then `const failing = parseFailingNpmTestFiles(combined);` classify each failing file OUT-of-scope if NOT in `touched`; partition into `outOfScopeErrors` (out-of-scope) vs `errors` (in-scope); set `result.inScopePass = result.pass || (failing.length>0 && failing.every(f => !touched.has(f)))` and populate `result.outOfScopeErrors` — EXACTLY mirroring the cargo path at build-runner.ts:1098-1100 and reusing the existing `BuildGateResult` fields verbatim. On any parse ambiguity, empty `touched`, or unresolvable path → treat as IN-SCOPE (conservative; grants no false green). The cargo branch is untouched byte-for-byte (still uses `detectTouchedCargoPackages` + `classifyOutOfScopeErrors`). Because `implementation.ts:93` already treats `gate.pass || gate.inScopePass` as green, NO stage change is required for the npm path.

### B. `src/stages/implementation.ts` — RED enforcement loop (Gap 1b, AC-02) + prompt wiring (Gap 3, AC-03)
- Import `runRedCheck` and `type RedStatus` (alongside existing `runBuildGate, type GateOptions` at implementation.ts:14); add `const MAX_RED_RETRIES = 2;` (module-level, mirrors `MAX_ATTEMPTS = 3`, no new config surface).
- Capture the tdd-guide agent result (currently DISCARDED at implementation.ts:70): `const tdd = await ctx.agent({...tdd-guide...});` and read `const testFiles = (tdd.control as { testFiles?: string[] } | null)?.testFiles ?? [];`.
- Pass `rustDiscipline(setup)` as the `langInstructions` arg to `buildTddPrompt(...)` so the RED-phase prompt carries the no-`--lib` discipline (Gap 3 — buildTddPrompt already accepts the param; the shared `RUST_SELF_VERIFY_DISCIPLINE` const is the single source of truth). Requires `rustDiscipline` to be exported from prompts.ts if not already.
- Bounded RED loop inside the existing `attempt` loop (does NOT change `MAX_ATTEMPTS=3` or the `gate.pass || gate.inScopePass` commit condition at :93):
  ```
  let redStatus: RedStatus = runRedCheck(worktreePath, testFiles, { signal: ctx.signal });
  let retries = 0;
  ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
  while ((redStatus === "green" || redStatus === "broken") && retries < MAX_RED_RETRIES) {
    retries++;
    const retry = await ctx.agent({ id: `...tdd.red${retries}...`, agent:"tdd-guide", prompt: buildTddPrompt(..., rustDiscipline(setup)) + redRePromptHint(redStatus) });
    const nextFiles = (retry.control as { testFiles?: string[] } | null)?.testFiles ?? testFiles;
    redStatus = runRedCheck(worktreePath, nextFiles, { signal: ctx.signal });
    ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${nextFiles.join(",") || "n/a"})`);
  }
  if (redStatus === "green" || redStatus === "broken") ctx.log(`Implementation ${phaseId} red-oracle WARNING: not confirmed-red after ${MAX_RED_RETRIES} retries — proceeding`);
  // proceed to implementer (red OR unknown OR cap-exhausted)
  ```
  The hint helper `redRePromptHint(status)` returns: for `green` — "Your tests passed already; write tests that GENUINELY fail against the unimplemented behavior"; for `broken` — "Your tests did not compile/collect; fix the test so it runs and fails".
- Augment the implementer prompt: when `redStatus === "red"`, append "The TDD tests are CONFIRMED-red; your goal is to make them green." When `redStatus === "unknown"` or cap-exhausted, append a note that red status could not be confirmed.
- NEVER stall: `unknown` proceeds immediately (no re-prompt); cap exhaustion proceeds with a loud warning. Worst-case cost per phase is bounded: `≤2 tdd-guide + ≤2 red-check + 1 implementer + 1 build-gate`.

### C. `src/prompts.ts` — confirm shared source string (AC-03)
- No text change to `RUST_SELF_VERIFY_DISCIPLINE` (prompts.ts:99) or `rustDiscipline(s)` (prompts.ts:105). The fix is in implementation.ts (pass `rustDiscipline(setup)` as `langInstructions`). Verify both `buildTddPrompt` and `buildImplementPrompt` reference the SAME const (single source of truth). Export `rustDiscipline` if implementation.ts needs it.

### D. Render layer + tests (Gap 2, AC-05)
- `tests/helpers/real-theme.ts`: `withRealTheme<T>(fn: (theme: Theme) => T): T` — calls `initTheme()` (idempotent), obtains the REAL pi Theme proxy from `@earendil-works/pi-coding-agent` (discover the accessor first — the existing `tests/stream-theme-class-theme.test.ts` only FAKE-builds a ClassTheme + seeds the markdown global, it never obtains the real proxy), passes it to `fn`. NEVER destructures theme methods (`this.fgColors` crash guard); callers use method-style `theme.fg(...)`.
- `tests/render/real-theme-parity.test.ts`: runs `themeLine`, `commandBackground` (stream-theme.ts:139,206), `buildResultComponent`, `packDashboardLines`, `createDashboardWidgetFactory` output (dashboard.ts:360,208,295) through `withRealTheme`; asserts no-throw + non-empty ANSI output. Generalizes `tests/stream-theme-class-theme.test.ts` into a whole-render-layer regression.
- `docs/testing-parity.md`: documents that any module wrapping a framework type behind a structural interface MUST have ≥1 parity test via `withRealTheme`/`initTheme`; mock-only coverage of a class-based dependency is a known false-green; a graph-based "no framework mocks" gate is future work.

## File inventory
- **Modify:** `src/build-runner.ts` (add `touchedFilePaths`, `RedStatus`, `RedCheckOptions`, `runRedCheck`, `parseFailingNpmTestFiles`; refactor `detectTouchedCargoPackages`; extend `runBuildGate` npm branch), `src/stages/implementation.ts` (RED loop + import + prompt wiring), `src/prompts.ts` (export `rustDiscipline` if needed), existing `src/build-runner.test.ts` where signatures affect it.
- **Create:** `tests/helpers/real-theme.ts`, `tests/render/real-theme-parity.test.ts`, `docs/testing-parity.md`, plus new suites `tests/red-oracle.test.ts`, `tests/npm-inscope.test.ts`, `tests/implementation-red-loop.test.ts` (or colocated in existing test files per repo convention).
- **Delete:** none. No config edits needed (vitest globs `tests/**` + `src/**`; tsconfig `include:["src","tests"]`).

## Cross-cutting constraints honored
- NEVER destructure pi Theme methods (class with `this.fgColors`); keep `tests/stream-theme-class-theme.test.ts` green.
- NEVER throw from any new gate/oracle/git helper.
- Backward compatible: greenfield → `unknown` → proceed; cargo `inScopePass` unchanged; `MAX_ATTEMPTS=3`, Stage 10/11 structure, `nodes.ts`/`workflow.ts`/`pipeline.ts` untouched; no new runtime deps; no new git spawns beyond the existing diff+untracked union (shared helper).

## Testing Strategy

Verification is `npm run typecheck` (tsc --noEmit, strict, no `any` leaks) + `npm test` (vitest run). The repo is a library — no API/UI server. Every phase ships its own independently-runnable test suite; the final phase is the full-suite + regression gate. Test conventions mirror the existing suite: `vi.mock('node:child_process', () => ({ spawnSync:(cmd,argv)=>{...} }))` with a module-level mock-state object reset per test (src/build-runner.test.ts:39-40).

**Per-phase testable units (each phase independently green):**
- **Phase 1 (touchedFilePaths):** new unit tests — committed-diff paths, untracked-only paths, both-union dedup ordering, spawn error → `[]`, empty repo → `[]`, base-ref precedence. Regression: existing touched-crates/autoscope/nonregression suites stay green (zero behavior change from the refactor).
- **Phase 2 (runRedCheck):** new `tests/red-oracle.test.ts` — `vi.mock` spawnSync stub returning fixed stdout/exit per case → assert `red` (cargo `test result: FAILED.` + exit≠0; vitest `❯` failing + exit≠0), `green` (exit 0), `broken` (cargo `error[E`/`could not compile`; vitest `SyntaxError`/collection error), `unknown` (no manifest / empty testTargets / spawn error / parse ambiguity). Assert NEVER throws (wrap a throwing spawnSync → expect `unknown`).
- **Phase 3 (RED loop):** `tests/implementation-red-loop.test.ts` — `vi.mock` runRedCheck returning green→green→red (assert ≤`MAX_RED_RETRIES` re-prompts), green-after-cap (assert loud warning + proceed), unknown (assert immediate proceed, zero re-prompts), red (assert zero re-prompts + implementer prompt contains "CONFIRMED-red"). Assert `MAX_ATTEMPTS=3` outer loop and `gate.pass||gate.inScopePass` commit condition unchanged.
- **Phase 4 (no-`--lib` parity):** prompt snapshot test — assert the tdd prompt for a `rust` setup contains the no-`--lib` clause + `cargo test --test <stem>` instruction, and a non-rust setup omits it; assert buildTddPrompt and buildImplementPrompt share the identical `RUST_SELF_VERIFY_DISCIPLINE` substring.
- **Phase 5 (npm in-scope):** `tests/npm-inscope.test.ts` — stubbed failing vitest stdout (`❯ src/untouched.test.ts`) + stubbed git diff → assert `outOfScopeErrors` populated + `inScopePass=true`; a touched-file failure → `inScopePass=false` (blocks); unparseable output → conservative in-scope; `touchedFilePaths` spawn error → in-scope; cargo branch unchanged (existing inscope-classification suite still green byte-for-byte).
- **Phase 6 (render parity):** `tests/render/real-theme-parity.test.ts` — `withRealTheme` exercising themeLine/commandBackground/buildResultComponent/packDashboardLines/createDashboardWidgetFactory output → no-throw + ANSI (escape `\x1b`/`\u001b`) output; `tests/stream-theme-class-theme.test.ts` stays green.

**Final gate (Phase 7):** full `npm run typecheck` strict-clean + full `npm test` ALL green — existing build-runner suite (scoped-args, touched-crates, autoscope, inscope-classification, resolver-validation, nonregression, package-wiring, timeout, backward-compat-regression) updated wherever a helper-signature change affects it, plus all new suites. Regression sweep: dashboard widget, themed stream, scope-aware cargo gate, mid-run input injection, Markdown §3 artifacts unchanged; `nodes.ts`/`workflow.ts`/`pipeline.ts` untouched; `MAX_ATTEMPTS=3`; no new runtime deps. For THIS TS repo the gate is `npm test` + `npm run typecheck` (no cargo workspace).

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
