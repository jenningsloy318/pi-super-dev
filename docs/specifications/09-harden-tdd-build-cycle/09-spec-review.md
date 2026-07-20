# Specification Review: Spec Review — Harden super-dev TDD/Implement/Build Cycle (RED oracle, no-`--lib` parity, scope-aware npm gate, render-layer test parity)

- **Date**: 2026-07-20
- **Author**: super-dev:spec-reviewer

---

## Verdict: REVISIONS NEEDED

Pure-TS bug-fix spec for four gaps in the Stage 9 (tdd-guide→implementer→runBuildGate) cycle. The module/function/line grounding is strong overall (~85%): detectTouchedCargoPackages, runBuildGate, resolveTimeoutMs, resolveIntegrationStems, detectProjectCommands, the cargo inScopePass formula, and all five render-layer functions are exactly where cited, with correct shapes. The degrade-instead-of-throw invariant and MAX_ATTEMPTS=3/Stage 10-11-untouched constraints are honored. However two content defects will cause implementation failure if taken literally: (1) the central premise of Gap 3 is factually false — implementation.ts:70-71 ALREADY passes the route-specialist's languageInstructions as buildTddPrompt's langInstructions arg, so the literal prescribed fix (pass rustDiscipline(setup) as that arg) would CLOBBER specialist instructions, a silent regression; and (2) the runRedCheck cargo branch is ungrounded — resolveIntegrationStems returns stem strings only (no pkg), and runBuildGate runs stems as `cargo test --test <stem>` WITHOUT `-p`, contradicting the spec's `cargo test -p <pkg> --test <stem>` with no defined source for <pkg>. Secondary issues: the `Theme` type the parity helper depends on is not exported from the pi package and its accessor is deferred ("discover first"); the broken/red status boundary heuristics are not crisply measurable; and Gap 2's novelty is overstated since initTheme()-based real-accessor parity testing already exists in three render tests. Verdict REVISIONS NEEDED: the false Gap 3 premise and ungrounded cargo oracle are exactly the class of content defects that produce wrong implementations.

## Findings

### F-01: Gap 3 premise is factually false — implementation.ts already passes langInstructions; literal fix clobbers specialist output

- **Severity**: high
Spec §B/C state 'buildTddPrompt already accepts a langInstructions arg but implementation.ts passes nothing' and prescribe 'Pass rustDiscipline(setup) as the langInstructions arg to buildTddPrompt'. Verified against src/stages/implementation.ts:70-71: `const lang = (specialist.value.languageInstructions as string) ?? "";` then `buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, lang)`. A non-empty value IS passed today (the route-specialist language instructions). Replacing it with `rustDiscipline(setup)` discards the specialist's per-task language instructions — a silent behavior regression for every non-Rust stack and for Rust tasks carrying specialist guidance. Fix direction: CONCATENATE (`lang + (lang?"\n":"") + rustDiscipline(setup)`) or append, not replace. The spec's premise and its one-line fix are both wrong.
### F-02: runRedCheck cargo branch ungrounded — resolveIntegrationStems returns stems only; no (pkg,stem) tuple source; contradicts runBuildGate

- **Severity**: high
Spec §A.2 cargo branch: 'derive stems via resolveIntegrationStems(cwd, testTargets) ... for each resolved (pkg, stem) run cargo test -p <pkg> --test <stem> ... fall back to cargo test -p <pkg> for the touched packages'. Verified src/build-runner.ts:414 resolveIntegrationStems returns `string[]` (stems only, derived from file paths, never a package name) — there is no pkg in its return, so the (pkg,stem) iteration has no defined <pkg> source. Moreover runBuildGate itself runs integration stems as `cargo test --test <stem>` WITHOUT `-p` (per the CR-004/CR-008 comment), so the RED oracle's cargo invocation diverges from and contradicts the very build gate it is modeled on. The 'touched packages' fallback references detectTouchedCargoPackages output that runRedCheck never obtains. Recommend runRedCheck cargo branch mirror runBuildGate exactly (stems via `cargo test --test <stem>`, packages via the same detectTouchedCargoPackages→resolveCargoPackageNames tier) so the two oracles agree.
### F-03: withRealTheme helper signature references a Theme type that is not exported by the pi package

- **Severity**: medium
Spec §D: withRealTheme<T>(fn:(theme:Theme)=>T):T 'exercising the REAL class-based proxy'. grep of @earendil-works/pi-coding-agent type declarations found no exported `Theme` type; the three existing render parity tests (dashboard-result.test.ts:35, dashboard-result-perkind.test.ts:37, regression-guard.test.ts:38) import only `initTheme` and exercise the `getMarkdownTheme()` MODULE GLOBAL, not a returned Theme object. The spec itself defers the accessor ('discover the accessor first'). The helper's `(theme:Theme)` parameter type is therefore ungrounded until that discovery is done; the signature should be left as discovered-accessor-typed or the spec must name the concrete accessor/type to import.
### F-04: Gap 2 novelty overstated — real-accessor (initTheme) parity testing already exists in three render tests

- **Severity**: medium
Spec §D frames the gap as 'the existing test only fakes ClassTheme ... never obtains the real proxy'. Verified initTheme() real-accessor parity is already an established pattern in src/render/dashboard-result.test.ts, dashboard-result-perkind.test.ts, and regression-guard.test.ts (beforeAll(() => initTheme())). The spec's premise that no real-Theme parity exists is inaccurate; the genuine residual gap is narrower (a whole-render-layer SWEEP + a documented convention), not the introduction of real-accessor testing itself. Re-scope the justification to avoid implementing a duplicate of existing coverage.
### F-05: broken/red status boundary heuristics are not crisply measurable

- **Severity**: medium
Spec §A.2 classification rules are stated in natural language without an operational test, e.g. cargo 'red if exit!==0 AND a failure marker ... appears AFTER successful compilation' and 'broken if ... no tests to run with no test execution'. There is no rule for detecting 'after successful compilation' or 'no test execution' from the COMBINED stdout+stderr blob — these require a state marker the spec does not define. Per-status stubbed tests (Phase 2) therefore cannot be authored deterministically against the stated boundary; implementers will invent their own marker logic. Specify the concrete precedence/regex sequence (e.g. 'broken if error[E|could not compile present; else red if exit≠0 & /test result: FAILED\.|FAILED|panicked/ present; else green if exit=0; else unknown') so the red/broken tests are reproducible.
### F-06: ACs and SCENARIOs are referenced inline but not enumerated or cross-mapped in this spec

- **Severity**: medium
Spec cites AC-01..AC-05 inline (no 'Acceptance Criteria' section listing them) and lists SCENARIO-001..022 by ID only under 'BDD Scenario References' with no SCENARIO→AC→phase→task matrix in-document. The artifacts exist in the spec directory (01-requirements.md, 02-bdd-scenarios.md, 07-implementation-plan.md, 08-task-list.md), but the task header marked Plan/Tasks as N/A despite their presence, and this document does not embed or link the traceability. D5 traceability cannot be confirmed from the spec alone; at minimum an AC list with a SCENARIO→AC map should be present so the reviewer/implementation phase can verify every AC has a satisfying spec section and every SCENARIO has a phase.
### F-07: RED-loop cost bound is stated per-attempt, not per-phase; redRePromptHint helper missing from file inventory

- **Severity**: low
Spec §B claims worst-case '≤2 tdd-guide + ≤2 red-check + 1 implementer + 1 build-gate' but this is PER ATTEMPT inside MAX_ATTEMPTS=3; the true per-phase worst case is ~3× (up to 6 tdd-guide + 6 red-check + 3 implementer + 3 build-gate). The per-attempt framing could mislead sizing/review. Separately, the loop pseudocode calls redRePromptHint(status) but that helper is not listed in the 'File inventory → Create/Modify' list; add it to the inventory so it is not missed.
### F-08: runRedCheck reconstructs npm/pytest argv instead of reusing cmds.test — divergence from runBuildGate is unstated

- **Severity**: low
runBuildGate executes tests via the existing `cmds.test` array (e.g. ['pytest','-q'], npm/pm scripts) detected by detectProjectCommands. Spec §A.2 instead has runRedCheck reconstruct argv from cmds.pm / vitest detection / explicit pytest <testTargets>, diverging from how the hard oracle invokes the same toolchain. The rationale (scoped per-file testTargets) is plausible but unstated; either reuse cmds.test where testTargets is empty, or document why the two gates intentionally invoke differently, to avoid drift between the RED oracle and the build gate.

## Dimension Reviews

### D1 Completeness

- **Status**: warn

Error/degrade paths (never-throw, red→unknown→proceed, empty-touched→in-scope) are thoroughly specified. Gap: AC-01..05 and SCENARIO-001..022 are referenced but not enumerated or mapped in-document; traceability lives only in sibling artifacts. Score 3/5.
### D2 Consistency

- **Status**: needs-work

Two substantive inconsistencies: Gap 3 premise ('implementation.ts passes nothing') contradicts code (it passes specialist langInstructions); runRedCheck cargo invocation (`cargo test -p <pkg> --test <stem>`) contradicts runBuildGate (`cargo test --test <stem>`). NFRs (typecheck strict, no new runtime deps) consistent. Score 3/5.
### D3 Feasibility

- **Status**: warn

Core skeleton is feasible and reuses real helpers. Feasibility gap: runRedCheck cargo <pkg> has no defined source given resolveIntegrationStems returns stems only; Theme accessor for withRealTheme is deferred ('discover first'). Score 3/5.
### D4 Testability

- **Status**: warn

Per-phase stubbed-stdout test suites are well enumerated; degrade/never-throw assertions are concrete. Gap: the cargo/npm broken-vs-red boundary rules are not crisply measurable (no operational marker for 'after successful compilation'), making deterministic red/broken test cases hard to author. Score 3/5.
### D5 Traceability

- **Status**: warn

Module→gap→AC→phase narrative is traceable in prose, but no AC list or SCENARIO→AC→phase matrix is embedded; 22 scenarios appear only as IDs. Sibling artifacts exist but are not linked/summarized here. Score 3/5.
### D6 Grounding

- **Status**: warn

~85% verified: detectTouchedCargoPackages(:485), runBuildGate(:932), resolveTimeoutMs(:84), resolveIntegrationStems(:414), detectProjectCommands(:852, mixed/greenfield shape), inScopePass(:1099), and all five render fns (stream-theme.ts:139/206; dashboard.ts:208/295/360) are accurate. Two HIGH grounding defects: false Gap 3 premise and ungrounded cargo (pkg,stem). Below the 90% bar. Score 3/5.
### D7 Complexity

- **Status**: pass

Proportional file inventory; degrades instead of throwing; shared git helper avoids new spawns; cargo branch byte-for-byte unchanged. Minor: per-phase cost bound understated (per-attempt framing) and redRePromptHint omitted from inventory. Score 4/5.
### D8 Ambiguity

- **Status**: warn

Degrade/precedence rules (base-ref ?? env ?? main; never-throw) are explicit. Ambiguity: Theme type/accessor undefined; broken/red heuristics imprecise; runRedCheck argv reconstruction diverges from cmds.test without rationale. Score 3/5.
