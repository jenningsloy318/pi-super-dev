# Specification Review: Scope-Aware Build Gate — Specification Review

- **Date**: 2026-07-20
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

The specification is well-grounded and implementable as written. ~93% of file/line/API references verify against the actual codebase (runBuildGate at build-runner.ts:282, the cmds.test override at :301, the three callers verify.ts:87 / implementation.ts:64 / stages/index.ts:53 all passing only {signal}, STDERR_TAIL_LINES=12, and the npm typecheck/test scripts all confirmed). Traceability is complete and cross-consistent across 5 docs: all 7 ACs (AC-01…AC-07) are defined in 01-requirements.md and mapped, and all 29 scenarios (SCENARIO-001…029) are covered by the 6 phases with no gaps. The design is minimally invasive (2 files, additive BuildGateResult fields, detectProjectCommands purity preserved on shallow copies, no new runtime deps, +1 spawn only in the auto-touched tier) and feasible. No critical or blocking defects and AC coverage is 100%, so this does not meet the REVISIONS-NEDED bar (no High>3, no 0% dimension, no uncovered AC). It does carry one hallucinated git flag and a few localized consistency/ambiguity defects that should be reconciled before implementation to prevent divergent interpretations — hence APPROVED WITH REVISIONS.

## Findings

### F-01: Hallucinated git flag `--merge-only` in the spec Scope sentence

- **Severity**: High
06-specification.md line 13 (Scope) says the change adds "one `git diff --merge-only`". `git diff --merge-only` is NOT a valid git option. Every authoritative source — the spec's own Architecture §1, Testing (a), AC-01/AC-07 in 01-requirements.md, the BDD doc, debug-analysis, research-report, plan, and task-list — uses the correct `git diff --merge-base <baseRef> --name-only`. An implementer who copies the Scope sentence literally would spawn a failing command; because detectTouchedCargoPackages wraps the spawn in try/catch→[], the failure would silently degrade to workspace-wide scoping, invisibly defeating the entire auto-scope capability (AC-01/AC-03) with no test catching it. Recommend correcting the Scope sentence to `git diff --merge-base <baseRef> --name-only`.
### F-02: `opts.packages` referenced in precedence but never defined

- **Severity**: Medium
The precedence clause (06-specification.md line 21, mirrored from AC-03 in 01-requirements.md:19) lists "explicit `opts.testPackages`/`opts.packages`". But `opts.packages` is never defined: the current runBuildGate opts type only has `testPackages`, Architecture §3 tier (i) resolves ONLY `opts.testPackages !== undefined`, and all three call sites pass `{signal}` only. It is therefore ambiguous whether `opts.packages` is a new opt field to add or vestigial text. Since the binding architecture tier never reads it, an implementer adding it would be gold-plating, while an implementer ignoring it would still satisfy the architecture. Recommend dropping `opts.packages` from the precedence clause, or — if a second explicit channel is genuinely wanted — adding it to the opts type and tier (i) resolution.
### F-03: NFR requires a timeout envelope the implementation spec omits

- **Severity**: Medium
NFR (01-requirements.md:27) states the git-diff helper "must use the existing spawnSync pattern with the resolved timeout envelope, never an unbounded shell." But Architecture §1 (06-specification.md) specifies the spawn as `spawnSync("git", [...], { encoding: "utf8" })` with NO timeout, unlike the existing exec closure which passes `{ cwd, timeout: timeoutMs, encoding: "utf8" }`. A `git diff --name-only` is fast in practice, but the spec contradicts its own NFR. Recommend either adding a bounded `timeout` (e.g. a small fixed cap or the resolved timeoutMs) to the detectTouchedCargoPackages spawnSync, or explicitly NFR-exempting this fast spawn and reconciling the two statements.
### F-04: `inScopePass` formula contradicts its own prose

- **Severity**: Medium
AC-04 (01-requirements.md:20) and Architecture §4 (06-specification.md) both define `inScopePass = !pass && errors.length>0 && outOfScopeErrors.length===errors.length` (which is FALSE when pass===true), yet in the same breath state "When `pass` is true, `inScopePass` is true and classification is a no-op." The two rules are mutually exclusive and an implementer must pick one. It is operationally harmless because the consumer is `gate.pass || gate.inScopePass` (short-circuits when pass), but the contradiction invites divergent implementations and a conflicting unit test. Recommend stating that `inScopePass` is a don't-care/irrelevant when `pass` is true, or providing a single consistent rule.
### F-05: Two non-identical crate-extraction regexes and a dual-option log helper

- **Severity**: Low
Architecture §1 extracts crates via `/(?:^|\/)crates\/([^/]+)\//` (left-anchored at start or slash), while §4's classifier uses `crates\/([^/]+)\/` (no left anchor) and a separate `-p <pkg>` regex `/(?:^|\s)-p\s+(\S+)/`. The unanchored §4 variant can match differently on paths like `foo/crates/x/`. Additionally §5 offers two interchangeable strategies for the IN-SCOPE GREEN log (a local `cratesFromErrors` helper vs storing the resolved set on the result). Neither blocks implementation, but two near-duplicate regexes risk inconsistent classification between detection and logging. Recommend canonicalizing one crate-extraction regex used by both the detector and the classifier, and picking one log-helper strategy.

## Dimension Reviews

### D1 Completeness

- **Status**: Pass

All 7 ACs defined (01-requirements.md) and addressed; all 29 scenarios mapped across 6 phases with no gaps; error handling (never-throw try/catch) and NFRs (no new deps, +1 spawn cap, hermetic tests) specified. One NFR/impl gap: the timeout-envelope NFR is not reflected in the detectTouchedCargoPackages spawnSync spec (F-03).
### D2 Consistency

- **Status**: Warn

Two real defects: hallucinated `--merge-only` flag vs the correct `--merge-base` used everywhere else (F-01), and `opts.packages` named in precedence but never defined (F-02). Terminology is otherwise uniform (scopedCargoArgs family, additive fields, shallow-copy override all consistent across spec/plan/task-list/BDD).
### D3 Feasibility

- **Status**: Pass

Design fits existing patterns precisely: shallow-copy override at build-runner.ts:301 generalizes cleanly to build/test/typecheck; additive BuildGateResult fields are backward-compatible; detectProjectCommands purity preserved; no circular deps; no new runtime deps; spawn budget bounded. Grounded in the actual runBuildGate/implementation.ts code.
### D4 Testability

- **Status**: Pass

ACs are measurable (byte-identical argv assertions, numeric inScopePass/outOfScopeErrors counts, precedence assertions). Testing strategy is concrete and hermetic (stub spawnSync/child_process, temp Cargo.toml worktree). Acceptance gates (npm run typecheck strict + npm test vitest) confirmed present in package.json.
### D5 Traceability

- **Status**: Pass

Unbroken chains: AC-01..07 → spec §1..§5 + Testing → Phase 1..6 → SCENARIO-001..029, cross-consistent across 06-specification, 01-requirements, 02-bdd, 07-plan, and 08-task-list. Every scenario number appears in exactly one AC/phase mapping; coverage count = 29/29.
### D6 Grounding

- **Status**: Pass

~93% of references verified: runBuildGate @ build-runner.ts:282 ✓, cmds.test override @ :301 ✓, callers verify.ts:87 / implementation.ts:64 / stages/index.ts:53 (all {signal} only) ✓, STDERR_TAIL_LINES=12 ✓, scopedCargoTestArgs internal-only ✓, npm scripts ✓. The one miss is the hallucinated `--merge-only` git flag (F-01); above the 90% grounding threshold so not a blocking HIGH on the dimension overall.
### D7 Complexity

- **Status**: Pass

Proportional: 2 source files + co-located tests, additive interface, simplest viable approach (path-prefix scoping + conservative classifier vs the deferred baseline-diff). Minor non-blocking over-offer: two interchangeable log-helper strategies and a near-duplicate regex (F-05).
### D8 Ambiguity

- **Status**: Warn

Two ambiguities to resolve: undefined `opts.packages` in the precedence (F-02) and the `inScopePass` formula-vs-prose contradiction (F-04). API schemas (BuildGateResult additive fields, scoped argv shapes) and state transitions (4-tier precedence, conservative in-scope default) are otherwise explicit with stated defaults.
