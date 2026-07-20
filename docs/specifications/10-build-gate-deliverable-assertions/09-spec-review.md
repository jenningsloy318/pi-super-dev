# Specification Review: Spec Review: Per-Phase Deliverable Assertions for the Build Gate

- **Date**: 2026-07-21
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Well-grounded, minimal-diff specification that adds a never-throwing runDeliverableCheck primitive AND-ed with build-green to close the proven stockfan false-green. Grounding is strong (~95%): every referenced source function (runRedCheck, runBuildGate, detectProjectCommands, resolveTimeoutMs, readMaybe), the implementation.ts call/condition sites (lines 81, 142, 153/154, 162, MAX_ATTEMPTS=3), SpecificationData phases schema (schemas.ts:228), STAGE_MODELS["spec"], normalizePhases (doc-validators.ts:98), and buildSpecPrompt phases bullet (prompts.ts:84) were all verified against the actual codebase, as were both theme-test guards and the nonregression test. All 7 ACs and 25 SCENARIOs are densely mapped to phases/files. No critical/high-severity content defects and no unbroken traceability chains. One genuine MEDIUM internal contradiction (the readMaybe reuse mandate vs. the required "unreadable" classification — readMaybe structurally cannot make that distinction) plus a few LOW ambiguities/inaccuracies. Recommending targeted revisions before implementation; no re-spec needed.

## Findings

### F-01: readMaybe reuse mandate contradicts the required `unreadable: <path>` classification

- **Severity**: medium
The Architecture section mandates reusing `readMaybe(cwd, file)` for the requireContains/requireNotContains sub-checks, and the Cross-Cutting Invariants call it out as a single source of truth. But the LAYER 1(b) sub-check spec AND test case (g)/SCENARIO-008 require distinguishing an unreadable file (e.g. chmod 000) from a genuinely-empty/non-existent one and emitting `unreadable: <path>`. Verified readMaybe body (src/build-runner.ts:1072) is `try { return existsSync(...) ? readFileSync(...,'utf8') : '' } catch { return '' }` — it collapses BOTH non-existent AND any read throw into '', so it is structurally incapable of producing the `unreadable` token. These two requirements are mutually exclusive as written. Recommendation: relax the reuse mandate so runDeliverableCheck uses a local existsSync + readFileSync-with-typed-catch for these two sub-checks (ENOENT/empty → treat as empty; non-empty throw → `unreadable: <path>`), or drop the unreadable-vs-empty distinction. As specified, the implementer cannot satisfy both.
### F-02: Dual-failure path (build FAIL + deliverables FAIL) under-specified for missing-list injection

- **Severity**: low
LAYER 3 specifies the missing list is injected into the next attempt only 'When build-green but deliverables FAIL'. But the described wiring always calls runDeliverableCheck immediately after the gate regardless of gate result, so on a build FAILURE with concurrent deliverable failure the spec does not state whether deliverableCheck.missing is also appended alongside attemptErrors=gate.errors. Recommendation: add one sentence clarifying the dual-failure injection rule (e.g. 'missing is injected only when build-green; on build-fail only gate.errors is injected') so the implementer does not have to guess.
### F-03: Cited line numbers are off by one in two places

- **Severity**: low
LAYER 3 cites 'const gate = runBuildGate(...) (implementation.ts:154)' — actual location is line 153 (attemptErrors = gate.errors is 154). It also cites the 'Previous attempt failed the build/test gate' block at 'implementation.ts:141-143' — actual location is line 142. Not load-bearing for a doc (and edits will shift lines anyway) but correct for clean traceability.
### F-04: AC-01..AC-07 are referenced but not enumerated inline

- **Severity**: low
The seven acceptance criteria are only reconstructable from 'Covers AC-XX' annotations distributed across the three phases. Within the supplied 06-specification.md (Plan/Tasks marked N/A) there is no explicit Acceptance Criteria section listing AC-01..AC-07 with their measurable conditions. This is acceptable IF 01-requirements.md owns them, but for self-contained reviewability the spec should either inline the AC list or explicitly defer to the requirements doc by name.
### F-05: '1120 pre-existing tests' numeric claim is unverifiable from the spec

- **Severity**: low
The FULL-SUITE GATE (AC-07) asserts 'all 1120 pre-existing tests plus the new suites'. An approximate grep of tests/ found ~798 test-function declarations (pattern-dependent, so not authoritative), making the 1120 figure unverifiable and not load-bearing. Recommendation: soften to 'all pre-existing tests remain green' or verify the exact count before freezing the test-strategy text.

## Dimension Reviews

### D1 Completeness

- **Status**: PASS

All four sub-checks (requireFiles/requireContains/requireNotContains/requireTests) specified with exact missing-reason strings; error/timeout/no-runner paths covered; backward-compat and never-throw NFRs explicit; full-suite gate NFR (AC-07) concrete. Only gap: AC list not inlined (F-04).
### D2 Consistency

- **Status**: PASS-WITH-REVISION

Names/terminology uniform across Architecture, Layers, and Testing Strategy. One internal contradiction: readMaybe reuse mandate vs. required `unreadable` classification (F-01).
### D3 Feasibility

- **Status**: PASS

All reused primitives verified present and exported (runRedCheck@1478, runBuildGate@1181, detectProjectCommands@1101, resolveTimeoutMs@84, readMaybe@1072). Schema/normalizer/prompt changes are pure TS with no runtime effect until Layer 3. Wiring is a one-condition edit at an exact verified site (implementation.ts:162). Minor caveat captured in F-01.
### D4 Testability

- **Status**: PASS

ACs measurable: exact missing-reason strings, ran-token format, 'mock fires at most once' (numeric), PASS/FAIL verdict composition. Hermetic pattern (mkdtempSync, spawnSync mock) matches established suite.
### D5 Traceability

- **Status**: PASS-WITH-REVISION

Dense, consistent AC↔SCENARIO↔phase↔file mapping across all 3 layers and 25 scenarios. Line refs off-by-one (F-03); AC definitions deferred to external doc (F-04).
### D6 Grounding (CRITICAL)

- **Status**: PASS (~95%)

Every referenced function, file, schema site, condition line, and test file was verified against the codebase: implementation.ts lines 81/142/153/154/162 + MAX_ATTEMPTS=3; schemas.ts:228 phases Type.Object({name,description}); STAGE_MODELS['spec']@243; doc-validators normalizePhases@98; prompts buildSpecPrompt@84 phases bullet; tests/build-runner-nonregression.test.ts, tests/stream-theme-class-theme.test.ts, tests/render/real-theme-parity.test.ts all exist. No hallucinated references.
### D7 Complexity

- **Status**: PASS

Scope is honestly minimal: 4 source files + normalizer widening + 1 new test file, no new runtime deps, no control-flow/review/backend-selection changes. Sibling-primitive placement reuses single sources of truth. No YAGNI/gold-plating detected.
### D8 Ambiguity

- **Status**: PASS-WITH-REVISION

Tolerant substring-OR-regex matching documented; ran tokens exemplified; regex examples (SCENARIO-016 with_retry\(\|\| fetch_fmp) valid. Gaps: unreadable-detection mechanism under-specified given readMaybe contract (F-01); dual-failure injection path unspecified (F-02).
