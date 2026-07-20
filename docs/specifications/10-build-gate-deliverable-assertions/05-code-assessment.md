# Code Assessment: Codebase Assessment — Per-Phase Deliverable Assertions for the Build Gate

- **Date**: 2026-07-20
- **Author**: super-dev:code-assessor

---

## Executive Summary

pi-super-dev is a single-package TypeScript pi extension (a CLI control-flow pipeline, not an HTTP server). The change is pure-TS and confined to four files. The decisive architectural invariant is that every deterministic gate primitive (runBuildGate, runRedCheck) is a synchronous, never-throwing, try/catch-wrapped function in src/build-runner.ts that reuses two shared primitives — detectProjectCommands(cwd) (the only project-detection entry) and resolveTimeoutMs() (the only spawn-timeout envelope) — and spawns subprocesses via node:child_process spawnSync, degrading to a safe sentinel on any ENOENT/timeout/parse error. The deliverable checker should be added as a sibling (runDeliverableCheck) reusing exactly those primitives, then AND-ed into the existing `(gate.pass || gate.inScopePass)` verdict at src/stages/implementation.ts:162, feeding its `missing[]` list back into the implementer prompt through the established attemptErrors→prompt-injection loop (implementation.ts:141-143). The spec-elicitation half is a 2-line change: extend phases in the typebox schema (schemas.ts:228) with an optional `deliverables` object and extend the buildSpecPrompt data-to-return line (prompts.ts:79-84) to instruct declaring it. No new runtime deps; tests use vitest with hermetic temp cwds (mkdtempSync(join(tmpdir(),"sd-…"))). There is no API/UI HTTP server — local verification is `npm run typecheck` + `npm test`, so the services block carries no api/ui entries.

## Patterns

### Never-throwing gate primitive (the load-bearing invariant)

- **Example**: src/build-runner.ts:1478 runRedCheck wraps its ENTIRE body in try/catch and returns 'unknown' on any spawn error/timeout/parse ambiguity; runBuildGate follows the same skeleton (build-runner.ts:1181+)
- **Consistency**: Absolute and project-wide. Every deterministic checker in src/build-runner.ts (runBuildGate, runRedCheck, classifyOutOfScopeErrors, resolveCargoPackageNames) catches all errors and degrades to a safe sentinel rather than throwing. runDeliverableCheck MUST mirror this: unreadable file → record a reason, failed test-list spawn → 'test-list unavailable', never propagate an exception. Guarded by build-runner-nonregression.test.ts.
### Shared project-detection + timeout primitives (single source of truth)

- **Example**: src/build-runner.ts:1101 detectProjectCommands(cwd) → { language, pm, build?, test?, typecheck?, ran }; src/build-runner.ts:84 resolveTimeoutMs(explicit); both reused by runBuildGate (build-runner.ts:1185) and runRedCheck (build-runner.ts:1482-1492)
- **Consistency**: Universal. No gate function re-implements project detection or spawn timeouts. runDeliverableCheck's requireTests runner must call detectProjectCommands to choose the lister (cargo test --list / vitest list / jest --listTests / pytest --collect-only -q) and resolveTimeoutMs for the single cached spawnSync. Pattern is explicitly documented in runRedCheck's JSDoc as 'introducing NO new spawn/git machinery.'
### Synchronous spawnSync subprocess invocation

- **Example**: src/build-runner.ts:1520 const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8' }); if (r.error) return 'unknown';
- **Consistency**: All gate-side subprocess calls (cargo, npm/pnpm/yarn/bun/deno, pytest, go) use node:child_process spawnSync, NOT exec/child_process promises or shell strings. argv is built as a string[] (no shell interpolation). The test-list spawn for requireTests must use the identical spawnSync(argv[0], argv.slice(1), {cwd, timeout, encoding:'utf8'}) shape and check r.error before r.stdout.
### Phase GREEN verdict is a single boolean expression at one site

- **Example**: src/stages/implementation.ts:162 `if (gate.pass || gate.inScopePass) { green = true; ... break; }`
- **Consistency**: The ENTIRE in-scope-vs-out-of-scope GREEN decision lives in this one expression. The AND-semantics fix changes exactly this condition to `(gate.pass || gate.inScopePass) && deliverableCheck.pass`. The break/commit flow below it stays untouched. Guarded by implementation-red-loop.test.ts and phase5-no-regression-gate.test.ts.
### Failure-feeding retry loop via prompt injection (attemptErrors → implParts)

- **Example**: src/stages/implementation.ts:141-143 `if (attemptErrors.length) { implParts.push('## Previous attempt failed the build/test gate — fix these\n' + attemptErrors.map(e=>'- '+e).join('\n')); }`
- **Consistency**: How the stage already tells the next implementer attempt what to fix. runDeliverableCheck.missing[] should be injected the same way under a '## Deliverables still missing — create/wire these' block, and reset each attempt like attemptErrors = gate.errors at implementation.ts:154. MAX_ATTEMPTS=3 (implementation.ts:16) is the bound.
### Best-effort file read helper (model for requireContains/requireNotContains)

- **Example**: src/build-runner.ts readMaybe(cwd,file): `try { return existsSync(join(cwd,file)) ? readFileSync(join(cwd,file),'utf8') : ''; } catch { return ''; }`
- **Consistency**: The project's established idiom for 'read a file if you can, else empty'. requireContains/requireNotExists should reuse readMaybe (or a sibling that returns the text) so unreadable → '' → requireContains miss / requireNotContains trivially-pass. Regex via new RegExp(pattern) with try/catch on invalid patterns.
### Typebox schemas accept optional nested objects on stages

- **Example**: src/render/schemas.ts:228 `phases: Type.Array(Type.Object({ name: Type.String(), description: Type.String() }), {minItems:1})` and the adjacent `gate: Type.Optional(Type.Object({...}))` at schemas.ts:233-237
- **Consistency**: The exact precedent for adding phases[].deliverables: extend the per-element Type.Object with `deliverables: Type.Optional(Type.Object({ requireFiles, requireContains, requireNotContains, requireTests }))`. Optional everywhere preserves backward compatibility (specs without deliverables validate unchanged).
### Stage prompts are pure string-array joins; control contract stated in 'Data to return'

- **Example**: src/prompts.ts:84 buildSpecPrompt's `- phases: array of { name, description } (at least 1, each independently testable)`
- **Consistency**: Every prompt builder (prompts.ts:53,56,61,70,79,88) is `parts.join('\n')` with an explicit '## Data to return' enumerating the control fields. The fix is a one-line edit to that phases bullet plus an explicit deliverables-declaration instruction, matching how `gate (optional, Rust/backend only)` is already elicited on the same prompt line.
### Spec control threaded into the stage via state.spec

- **Example**: src/stages/implementation.ts:153 `state.spec?.gate as GateOptions | undefined`; src/stages/implementation.ts:120 `state.spec` passed to buildTddPrompt
- **Consistency**: The phase's declared deliverables will arrive the same way: read `phase.deliverables` off the phase object iterated at implementation.ts:95-98 (the spec control's phases[].deliverables, validated by the typebox schema). absent → undefined → deliverableCheck trivially passes (backward compat).
### Vitest hermetic tests with mkdtempSync temp cwd + module-level spawnSync mock

- **Example**: tests/red-oracle.test.ts:54-68 imports mkdtempSync from node:fs, tmpdir from node:os, dir = mkdtempSync(join(tmpdir(),'sd-red-')); tests import `from '../src/build-runner.ts'` with the .ts extension (NodeNext)
- **Consistency**: All build-runner tests (build-runner-nonregression.test.ts:87, build-runner-packages.test.ts, etc.) create `mkdtempSync(join(tmpdir(),'sd-<prefix>-'))` temp cwds, write fixture files, and mock node:child_process.spawnSync at module scope for spawn-based assertions. New runDeliverableCheck tests must follow this (temp cwd for requireFiles/existence, spawnSync mock for the requireTests lister).
### Strict TS with .ts import extension (NodeNext) and never-destructure-Theme rule

- **Example**: tsconfig.json strict; tests import `'../src/build-runner.ts'` with extension; tests/stream-theme-class-theme.test.ts + tests/render/real-theme-parity.test.ts guard Theme method-call style
- **Consistency**: npm run typecheck = tsc --noEmit must stay clean; any new import of a sibling src module uses the .ts extension. The Theme-destructuring guard is unrelated to this change but its tests must stay green — don't import/alter stream/theme code.

## Files Assessed

- package.json
- README.md
- tsconfig.json
- src/build-runner.ts
- src/stages/implementation.ts
- src/prompts.ts
- src/render/schemas.ts
- tests/red-oracle.test.ts
- tests/implementation-red-loop.test.ts
- tests/build-runner-nonregression.test.ts

## Recommendations

- Implement runDeliverableCheck(cwd, deliverables, opts?) in src/build-runner.ts as a sibling to runRedCheck: wrap the ENTIRE body in try/catch returning {pass:false, missing:[...], ran:[...]} on any thrown error; reuse detectProjectCommands + resolveTimeoutMs + readMaybe + spawnSync. Cache the per-cwd test-list spawn in a module-level Map<cwd,{ts, text}> (single cargo test --list / vitest list / jest --listTests / pytest --collect-only -q per run). requireTests match is substring OR RegExp — try new RegExp(name); on invalid → substring.
- In src/stages/implementation.ts change ONLY the GREEN condition at line 162 to `(gate.pass || gate.inScopePass) && deliverableCheck.pass`, where deliverableCheck = runDeliverableCheck(setup.worktreePath, phase.deliverables) (absent → {pass:true}). Mirror the exact attemptErrors→implParts injection (lines 141-143) for deliverableCheck.missing under a '## Deliverables still missing — create/wire these' block, set on the same per-attempt loop, and log `Implementation ${phaseId} deliverable-check ${pass?'PASS':'FAIL'} (missing: ${missing.join('; ')||'none'})` next to the existing build-gate log at line 155. Do not alter MAX_ATTEMPTS, the break, or the commit flow.
- In src/render/schemas.ts add to the phases element Type.Object (line 228): deliverables: Type.Optional(Type.Object({ requireFiles: Type.Optional(Type.Array(Type.String())), requireContains/requireNotContains: Type.Optional(Type.Array(Type.Object({file: Type.String(), pattern: Type.String()}))), requireTests: Type.Optional(Type.Array(Type.String())) })). In src/prompts.ts buildSpecPrompt (line 84) change the phases bullet to `{ name, description, deliverables? }` and add an explicit instruction that a phase whose deliverable is NOT compiler-checkable (file creation, call-site wiring X→Y, making new sources reachable, named test) must declare requireFiles / requireContains({file,pattern}) / requireNotContains / requireTests, AND-ed with build-green — without them a phase compiles green while delivering nothing.
- Add a regression test (tests/ e.g. build-runner-deliverable-check.test.ts) using mkdtempSync temp cwd: existing+missing files, present/absent requireContains patterns, forbidden-pattern hit (requireNotContains), present+missing requireTests with spawnSync mocked for the lister, unreadable file (chmod 000 / mocked throw), and no-runner skip. Add a second test that simulates the stockfan Phase-5/6 false-green: a phase declaring requireFiles:[X]+requireContains:[screen.rs→fetch_us_data]+requireNotContains:[screen.rs→fetch_fmp]+requireTests:[T], asserting deliverableCheck.pass===false with deliverables absent even though a stub build-gate would be green, and that the combined `(gate.pass||gate.inScopePass)&&deliverableCheck.pass` verdict is NOT green. Keep npm test (existing 1120 + new) and npm run typecheck green; leave runRedCheck, npm-inscope, themed-stream, mid-run-input, and dashboard tests untouched.
