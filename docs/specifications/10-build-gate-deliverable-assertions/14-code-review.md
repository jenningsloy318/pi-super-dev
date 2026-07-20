# Code Review: Code Review: Per-Phase Deliverable Assertions for the Build Gate

- **Date**: 2026-07-21
- **Author**: super-dev:code-reviewer
- **Verdict**: Approved

---

## Verdict: Approved

The implementation faithfully realizes the spec's root-cause fix: phase GREEN now requires `(gate.pass || gate.inScopePass) && deliverableCheck.pass`, so a build-green phase that delivers nothing (a never-created test file, an unwired call site, a dead `_ => {}` router arm) is correctly reported as FAIL. Verified on worktree branch `10-build-gate-deliverable-assertions`.

LAYER 1 — `runDeliverableCheck` in `src/build-runner.ts` (lines 1587–1925): sibling of `runRedCheck`/`runBuildGate`, reuses `detectProjectCommands`, `resolveTimeoutMs`, a `readForDeliverable` helper, ONE cached `spawnSync` test-list per cwd (`testListCache` keyed by `resolve(cwd)`), tolerant substring-OR-regex matching (`tolerantMatch`), exhaustive (no short-circuit) evaluation, and a whole-body try/catch honoring the never-throw gate-primitive invariant. Early-returns `{pass:true}` when deliverables is absent (backward compat). All sub-checks produce the exact documented `missing` reason strings.

LAYER 2 — schema/normalizer/prompt: `PhaseDeliverables`/`SpecPhase` added to `schemas.ts` (all fields Optional → backward compatible), `normalizePhases` widened to `NormalizedPhase[]` preserving `deliverables` by reference (round-trips to typed `phase.deliverables`), and `buildSpecPrompt` now instructs declaring deliverables AND-ed with build-green. Clean, minimal diffs.

LAYER 3 — `implementation.ts`: minimal diff — declares `missingDeliverables`, calls `resetDeliverableCheckCache()` + `runDeliverableCheck` after the gate, flips the GREEN condition, and feeds the missing list into the next attempt under `## Deliverables still missing — create/wire these`. MAX_ATTEMPTS (3) loop unchanged.

Evidence: `npx tsc --noEmit` → exit 0 (strict-clean). `npx vitest run` → 68 files / 1173 tests, all green (no regression to runRedCheck, npm-in-scope, cargo gate, themed stream, real-Theme parity, mid-run input). New suites are non-vacuous: the stockfan regression proves AND-semantics both ways (SCENARIO-011/015 + an inScopePass-branch case), and SCENARIO-007/008/009/010 cover no-runner-skip, chmod-000 unreadable (root-skipped), single-cached-spawn, and never-throw.

Two reviewer-driven improvements beyond the spec were already folded in and are correct: a `skipTests` opt (defers the test-lister spawn when the build already failed — the phase fails on the build anyway, so the green verdict is unaffected) and a run-boundary `resetDeliverableCheckCache()` (prevents a stale list from masking a freshly-added test on retry).

No Critical or High issues found. Findings are all Low/Informational. APPROVED.

Dimensions (1–5): Correctness 5, Security 4, Performance 4, Concurrency 5, Maintainability 5, Testability 5, Error Handling 5, Data Integrity 5, Observability 4.

## Findings

### F-01: requireNotContains on a missing/unreadable target file now FAILs — correct, but the implicit 'file must exist' contract is undocumented

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 1893
Spec text only specifies the happy path ('requireNotContains hit → forbidden pattern <pattern> still present in <file>'). The implementation goes further: when the target file is missing it records `missing file: <file>`, and when unreadable it records `unreadable: <file>` (build-runner.ts ~1895–1905). This is the SAFER and correct choice for the documented use case (a file that must still exist but must no longer contain a pattern, e.g. stockfan `screen.rs`), and it correctly prevents the false-green where requireNotContains silently passed on an absent file. However, it also means a deliverable expressed as 'delete file X' would misfire (a deleted file is 'missing file:' → FAIL when the intent was satisfied). Fix: add one line to the spec-prompt elicitation and/or a code comment stating 'requireNotContains implies the file must still EXIST; to assert deletion, use requireFiles/requireContains on a replacement file instead.' No code change required.
### F-02: Malformed (non-array) deliverables fields are silently skipped, relying solely on upstream schema validation

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 1845
`runDeliverableCheck` guards each sub-check with `Array.isArray(...)`; a deliverables object like `{ requireFiles: "x.rs" }` (string instead of array, or a typo like `requireFile`) is silently treated as 'nothing to check' for that sub-check rather than enforced or warned (build-runner.ts ~1845/1865/1893). The intended defense is the typebox `PhaseDeliverables` schema rejecting malformed control upstream, which is the established contract for all fields. This is acceptable, but as defense-in-depth for the false-green class this change targets, consider recording a `missing` reason (e.g. `malformed deliverables.<field>: expected array`) when a deliverables object is present but a declared field is the wrong shape, so a malformed declaration can never silently degrade to pass. Low risk because schema validation is the real gate.
### F-03: Catastrophic-backtracking regex (LLM/spec-supplied) is NOT bounded by resolveTimeoutMs and can stall the gate

- **Severity**: Low
- **File**: `src/build-runner.ts`
- **Line**: 1748
`tolerantMatch` runs `new RegExp(pattern).test(text)` in-process (build-runner.ts ~1748). `resolveTimeoutMs` only bounds the spawned test-lister, NOT these regex evaluations. A pathological pattern (e.g. `(a+)+$`) supplied by the LLM-generated spec against a large source file can backtrack indefinitely and hang runDeliverableCheck's main thread — and the never-throw try/catch does NOT help, because regex backtracking does not throw. Realistic risk is low (patterns are dev/LLM-authored, source files are bounded), but since this is exactly the 'gate that stalls the pipeline' failure class the never-throw invariant exists to prevent, it is worth noting. Mitigation options (pick none/one): cap input length before test, run pattern.compile in a try and reject obviously-pathological patterns, or document the threat-model assumption. No action required to approve.
### F-04: requireTests per-line matching assumes vitest `list --json` is single-line; fragile to future pretty-printed output

- **Severity**: Informational
- **File**: `src/build-runner.ts`
- **Line**: 1917
To avoid false-greens from name substrings appearing in path/comment lines, the requireTests match is performed per-LINE (build-runner.ts ~1917). The code comment explicitly notes vitest `list --json` emits a single-line JSON array 'unaffected' by per-line splitting. This holds today, but if a future vitest version pretty-prints the JSON (multi-line), a test name located on a field-value line would still substring-match (fine), while a name spanning key/value structure would not. Consider falling back to a whole-blob match specifically for the vitest/JSON runner (detected via `resolveTestListerArgv`), or pin/document the vitest-output assumption. Informational — current behavior is correct.
### F-05: TOCTOU window between existsSync and readFileSync in readForDeliverable (single-process, mitigated)

- **Severity**: Informational
- **File**: `src/build-runner.ts`
- **Line**: 1725
`readForDeliverable` calls `existsSync` then `readFileSync` (build-runner.ts ~1725). If the file is deleted between the two calls, the catch returns `{ok:false, exists:true}` → labelled `unreadable: <file>` when the file is actually missing. The phase still FAILS (correct outcome), only the message is slightly inaccurate. This is a local single-process dev tool, not a concurrent server, so the race is theoretical. No action required.
