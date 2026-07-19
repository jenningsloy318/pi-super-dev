# Specification Review: Spec Review — Build-gate: configurable timeout + per-package test scoping

- **Date**: 2026-07-19
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Fagan-style inspection of the technical spec for a single-file, backward-compatible harness fix (src/build-runner.ts): configurable build-gate timeout (120s→600s default, SUPER_DEV_BUILD_TIMEOUT_MS) and rust-only per-package cargo-test scoping via SUPER_DEV_BUILD_TEST_PACKAGES / opts.testPackages. Grounding against the actual harness codebase is strong: every concrete line/file/function reference checked out except one — the spec repeatedly calls DEFAULT_TIMEOUT_MS "exported", but it is currently a non-exported `const`. The fix intent, contract signatures, precedence rules, purity invariant (detector stays pure), non-mutation guarantee, and shell-safety argument are all sound, feasible, and testable with deterministic pure-helper unit tests. Two medium-severity content defects block a clean APPROVE: (1) the false "exported" grounding claim in CONTRACTS + Architecture, and (2) a traceability gap — six of the seventeen referenced BDD scenarios (SCENARIO-001/002/003/004/005/015) are listed by number but never mapped to a spec section or test case, so their coverage cannot be confirmed. No critical defects; no dimension is at 0%; no infeasible architecture.

## Findings

### F-01: DEFAULT_TIMEOUT_MS is falsely claimed to be 'exported' — it is currently a non-exported const

- **Severity**: medium
The spec states in three places that DEFAULT_TIMEOUT_MS is exported: Architecture FIX-1a ('Raise the exported DEFAULT_TIMEOUT_MS'), rationale ('kept exported for forward-compat and unit-testability'), and the CONTRACTS section ('DEFAULT_TIMEOUT_MS: number (exported, value 600_000)'). Grounding check against src/build-runner.ts:22 shows `const DEFAULT_TIMEOUT_MS = 120_000;` with NO `export` keyword (only CmdKey/ProjectCommands/BuildGateResult/detectProjectCommands/runBuildGate are exported in this module). This is a real grounding defect: the spec treats export-ness as pre-existing when it is not. Recommendation: state explicitly that the change MUST add the `export` keyword to `export const DEFAULT_TIMEOUT_MS = 600_000;`, and drop the misleading 'kept exported' phrasing. Impact is low-resolution still works via resolveTimeoutMs() returning 600_000—but an implementer reading 'kept exported' may omit the export and break the CONTRACTS guarantee.
### F-02: Traceability gap: 6 of 17 referenced BDD scenarios have no mapping to any spec section or test case

- **Severity**: medium
The 'BDD Scenario References' section lists SCENARIO-001..017 by number, and the Summary claims coverage of 'SCENARIO-001..SCENARIO-017'. The Testing Strategy explicitly maps test cases to scenarios 006, 007, 008, 009, 010, 011, 012, 013, 014, 016, 017 (and ACs 01-10). However SCENARIO-001, 002, 003, 004, 005, and 015 appear nowhere else in the spec — no spec section describes the behavior they require, and no test in the matrix references them. Since Plan/Tasks artifacts are N/A and no requirements/BDD text was provided alongside this spec, these six scenarios cannot be confirmed as covered or even non-duplicative of already-covered ACs. This breaks the 'every SCENARIO addressed' completeness rule (D1/D5). Recommendation: either add an explicit per-scenario test/spec mapping for 001-005 and 015, or strike them from the references list with a note that they are subsumed by a named AC.
### F-03: Off-by-one line reference for the detector regression assertion

- **Severity**: low
Architecture cites 'the existing test at tests/build-runner.test.ts:27' for `expect(c.test).toEqual(["cargo","test","--quiet"])`. The assertion is actually on line 26 (verified by grep). Trivial, but a stale line reference undercuts the otherwise precise grounding of this spec.

## Dimension Reviews

### D1 Completeness

- **Status**: PASS

AC-01..10 each mapped to spec sections and named tests; error handling fully specified for resolveTimeoutMs (NaN, <=0, empty, missing → default); NFRs covered (no new deps, strict typecheck, non-mutation). Gap: 6 BDD scenarios (001-005, 015) referenced but unaddressed — see F-02.
### D2 Consistency

- **Status**: PASS

Helper names (resolveTimeoutMs, parseTestPackages, scopedCargoTestArgs) and env-var names (SUPER_DEV_BUILD_TIMEOUT_MS, SUPER_DEV_BUILD_TEST_PACKAGES) used uniformly across Architecture/Contracts/Testing. One inconsistency: 'exported DEFAULT_TIMEOUT_MS' vs actual non-exported const (F-01).
### D3 Feasibility

- **Status**: PASS

Single-file behavioral change + pure helpers + optional opts field (interface widening is safe). Shallow-copy of cmds preserves detector purity. Rust-only guard means non-rust stacks are byte-identical. No circular deps; no control-flow-engine changes. Fully feasible within existing stack.
### D4 Testability

- **Status**: PASS

All ACs measurable: numeric thresholds (600_000, 900000, 1234), exact argv arrays, per-test process.env save/restore. Tests assert on argv construction and pure resolver outputs—no real cargo/build spawned, so hermetic and fast.
### D5 Traceability

- **Status**: NEEDS WORK

AC→spec and SCENARIO→test chains are unbroken for 11/17 scenarios. SCENARIO-001/002/003/004/005/015 are listed but unmapped (F-02). Plan→task-list chain not applicable (Plan/Tasks = N/A for this review).
### D6 Grounding

- **Status**: PASS

Harness-side grounding is excellent: DEFAULT_TIMEOUT_MS=120_000@L22 ✓, cargo test --quiet@L85 ✓, spawnSync exec closure@L173 ✓, timeoutMs resolution@L160 ✓, all 3 call sites pass {signal}✓, detector test@tests/build-runner.test.ts:26 (spec says 27) ✓, SUPER_DEV_* env pattern at workflow.ts:103 & session-agent.ts:295 ✓. One material defect: DEFAULT_TIMEOUT_MS 'exported' claim is false (F-01). Target-repo claim (crates/api, crates/store DB tests) is out of harness scope and unverified but plausible. Overall ~90%+ on harness refs.
### D7 Complexity

- **Status**: PASS

Three pure helpers + one optional opts field + one README section. Proportional to the two-defect bug scope. Simplest viable approach (no engine/template changes, no call-site edits). No gold-plating, no premature abstraction.
### D8 Ambiguity

- **Status**: PASS

Signatures defined in CONTRACTS. resolveTimeoutMs precedence (explicit>env>default) and the opts.testPackages=[] = force-workspace-wide semantics are explicit and backed by test (4). Defaults stated (600_000). Error-reporting contract (STDERR_TAIL_LINES=12, FAILED shape) preserved. Shell-safety (string[] argv, no shell:true) explicit.
