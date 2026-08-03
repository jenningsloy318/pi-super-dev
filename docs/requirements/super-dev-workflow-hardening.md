# Super-dev Workflow Hardening Requirements

## Context

Since 2026-08-01, repeated `super-dev` runs exposed a pattern of workflow-level failures that are larger than any one implementation bug. The failures span the implementation/TDD stage, deliverable gates, review convergence, integration/retry loops, and run-summary/escalation behavior.

This document captures the second-round investigation and turns it into requirements for a systematic hardening pass. It intentionally treats `super-dev` as an agent/evaluation harness: specialist agents may propose code and structured outputs, but the harness must own state transitions, isolation, provenance, deterministic grading, and escalation semantics.

## Local evidence

Scanned run logs under:

```text
/Users/I336589/.pi/agent/super-dev/runs/
```

Total run directories scanned: **22**.

Issue-pattern hits across those runs:

| Issue family | Distinct runs / observed impact | Raw hits |
|---|---:|---:|
| RED oracle never confirmed failing tests | 8 runs | 47 warnings |
| RED oracle reported tests already green | 8 runs | 187 green red-oracle lines |
| Agent produced no control / no structured output | 9 runs | 47 hits |
| Corrective re-prompt due missing structured keys | 8 runs | 46 hits |
| `claimed-not-changed` gate failures | 5 runs | 57 hits |
| Deliverable missing pattern failures | 8 runs | 58 hits |
| Review-loop stagnation | 3 runs | 3 major incidents |
| Workflow cancelled early | 3 runs | 3 incidents |
| `attempt 1/5` then early-stop symptoms | 5 runs | 5 incidents |
| `proxy.ts` false missing-file issue | 1 run | fixed by `requireNotContains` semantics |
| exact `export const POST = h.POST` brittle pattern issue | 1 run | fixed by semantic pattern relaxation |

Runs with explicit RED-not-confirmed warnings:

```text
2026-08-01T05-46-39-633Z  11 warnings
2026-08-01T14-03-05-784Z   6 warnings
2026-08-01T15-25-41-272Z   6 warnings
2026-08-01T17-53-16-962Z   2 warnings
2026-08-02T04-47-27-855Z  14 warnings
2026-08-02T10-59-05-995Z   2 warnings
2026-08-02T11-05-30-532Z   5 warnings
2026-08-02T13-21-40-363Z   1 warning
```

The latest run:

```text
/Users/I336589/.pi/agent/super-dev/runs/2026-08-02T13-21-40-363Z/run.log
```

showed:

```text
Implementation phase-01 red-oracle: green
Implementation phase-01 red-oracle: green
Implementation phase-01 red-oracle: green
Implementation phase-01 red-oracle: green
Implementation phase-01 red-oracle: green
Implementation phase-01 red-oracle WARNING: not confirmed-red after 4 retries (status: green) — proceeding
```

Inspection of the worktree showed the RED/TDD agent created both test and production source during the RED phase:

```text
frontend/src/lib/__tests__/usage-analytics.test.ts
frontend/src/lib/usage-analytics.ts
```

So tests were green because the test-writer had already implemented the behavior. This invalidates the RED phase.

## External research basis

- Anthropic, **Demystifying evals for AI agents**: agent evaluations should distinguish task, trial, grader, transcript/trace, outcome, and evaluation harness. Coding-agent evals should prefer deterministic graders where possible: tests, static analysis, outcome verification, and sometimes transcript/tool-use checks. Code-based graders are fast/objective but can be brittle when they check incidental syntax rather than outcomes.
- ThoughtWorks, **The hidden pearls of TDD**: TDD gives AI agents clear exit criteria and helps prevent uncontrolled, bloated, hallucinated implementation. Tests act as executable guardrails.
- TDD red/green/refactor literature: the RED step requires a failing test before implementation; a test that passes immediately does not demonstrate new behavioral coverage.
- CI/quality-gate practice: flaky/broken checks should remain visible and actionable, but pipeline gates must distinguish hard invariants from advisory/quarantined findings. False positives erode trust in the pipeline.

## First-principles diagnosis

A robust super-dev workflow must enforce these invariants itself:

1. **Agent output is untrusted until verified.** Structured control JSON is useful, but not authoritative.
2. **State transitions belong to the harness, not to specialists.** Agents may write files and propose evidence; the workflow decides whether RED, GREEN, REVIEW, INTEGRATION, DOCS, or MERGE is valid.
3. **Tests must prove behavior, not merely exist.** A RED test that passes immediately is not evidence of new coverage unless the feature was already implemented before the phase.
4. **Deterministic gates must check semantic outcomes, not incidental syntax.** Regex gates are useful but must avoid arbitrary variable names, comment-only matches, negative assertions implying existence, and runtime/cache artifacts.
5. **Review must read fresh post-fix state.** A stale pre-fix review must not block merge after a fix.
6. **Integration loops must not be vacuously green.** A skipped or unavailable service/test must be represented explicitly, not accidentally counted as success.
7. **Escalation should happen after objective verification is exhausted.** Do not ask for guidance before a final re-review/retest of fixed code.

## Fourth-round agent/routing audit

A follow-up audit of the stage code and agent launch paths found that `super-dev` does use its own checked-in specialist prompt files under `agents/` for every workflow-owned specialist. The confusing log lines that looked like other agents were primarily runtime/tooling context from the host pi process: model/provider/status chrome, ambient extension discovery, MCP availability, and generic SDK session behavior.

Current workflow-to-agent ownership:

| Workflow area | Super-dev specialist prompts |
|---|---|
| Requirements and BDD | `requirements-clarifier`, `bdd-scenario-writer` |
| External research | `research-agent` |
| Debug/code assessment | `debug-analyzer`, `code-assessor` |
| Specification and review | `spec-writer`, `spec-reviewer` |
| Prototype/design execution | `prototype-runner` |
| Implementation | `tdd-guide`, `implementer`, `orchestrator` |
| Code/adversarial review | `code-reviewer`, `adversarial-reviewer` |
| Integration testing | `api-tester`, `ui-tester` |
| Documentation/merge/reflection | `docs-executor`, `orchestrator`, `reflection` |

Two backend details matter for interpretation:

- **Subprocess backend** runs `pi --mode json -p --no-session --no-skills --no-extensions --no-context-files --no-prompt-templates --exclude-tools super_dev --system-prompt agents/<name>.md ...`. Browser and web-research agents are intentionally forced through this backend, but they receive browser/web/MCP tools only through explicit `-e` role-extension paths.
- **Session backend** runs in-process through `createAgentSession`. It mirrors the subprocess identity boundary by using the super-dev prompt as the session system prompt and disabling ambient extensions, skills, prompt templates, themes, and AGENTS.md/CLAUDE.md context files. The inline safety extension still loads explicitly, and `super_dev` remains excluded from the active tool set as defense in depth.

Conclusion: the current role set is broadly appropriate (specialized writer/reviewer/tester/fixer roles plus deterministic orchestration), but the harness must keep agent identity and gate responsibility explicit. Specialist prompts are advisory capabilities; deterministic gates, evidence ledgers, state transitions, and final status classification remain workflow-owned.

## Requirements

### R1 — RED phase isolation

The Stage 9 RED/TDD phase MUST isolate test-authoring from implementation-authoring.

- Before invoking the TDD agent, record a git baseline for the phase.
- After the TDD agent returns, compute the RED-phase diff.
- The RED-phase diff MUST be tests-only by default.
- Allowed RED paths include:
  - `**/*.test.*`
  - `**/*.spec.*`
  - `tests/**`
  - `__tests__/**`
  - approved fixtures/mocks/snapshots when they are under test directories.
- Production/source files are forbidden during RED unless explicitly declared as test fixtures.
- If RED modifies production files, the phase MUST NOT proceed to implementation as normal.

### R2 — RED oracle must be a gate, not a warning

If RED status remains `green` after the retry budget, Stage 9 MUST stop the phase as `red-not-confirmed` instead of proceeding with a warning.

Permitted exceptions:

- `unknown` may still proceed only when no deterministic runner exists, no test targets are available, or the environment cannot classify the result.
- `already-satisfied` may proceed/skip only when deterministic deliverable checks prove the phase was already implemented before RED changes.

### R3 — Broken RED tests are repairable, not implementable

If RED status is `broken`, the TDD agent may be re-prompted to repair tests. The implementation agent MUST NOT be asked to make broken tests green until the test suite compiles/collects and fails for behavior.

### R4 — RED status taxonomy

Replace the coarse `red | green | broken | unknown` decision with a phase evidence record that can represent:

- `red-behavior-failure` — tests compile/collect and fail as expected.
- `green-weak-test` — tests pass immediately and deliverables are not already satisfied.
- `green-already-satisfied` — tests pass because the implementation was already present before the RED phase.
- `broken-test` — tests fail to compile/collect or reference nonexistent APIs in an impossible way.
- `unknown-no-runner` — no deterministic test runner exists.
- `unknown-unclassified` — runner output cannot be classified.
- `polluted-red` — RED phase modified production files.

### R5 — Baseline/provenance evidence ledger

Each implementation phase MUST persist a machine-readable evidence record in the spec directory, e.g. `implementation-evidence.jsonl`, containing:

```json
{
  "phaseId": "phase-01",
  "attempt": 1,
  "baseline": "git tree/commit or diff fingerprint",
  "red": {
    "status": "red-behavior-failure",
    "testFiles": [],
    "changedFiles": [],
    "forbiddenFiles": [],
    "command": "...",
    "failureExcerpt": "..."
  },
  "green": {
    "changedFiles": [],
    "buildGate": "pass|fail",
    "deliverables": "pass|fail"
  }
}
```

Review, documentation, and merge summaries SHOULD use this evidence rather than trusting free-form agent claims.

### R6 — Deliverable gates remain semantic

Maintain and extend recent fixes:

- Internal runtime/cache artifacts such as `.resume-cache.jsonl` must not count as implementation claims.
- `requireNotContains` is a pure negative assertion; missing files do not fail unless existence is separately required.
- `requireContains` for code must match comment-stripped code.
- Generated alias patterns such as `h.POST` must not require exact arbitrary local variable names.
- Future deliverable patterns should prefer semantic anchors over formatting/syntax examples.

### R7 — Review loop convergence must be fresh-state based

The review/fix loop MUST perform a final safety re-review after a fix if the loop would otherwise exit on stagnation or max-round budget.

- Stale pre-fix findings must not block merge.
- `CONTEST` with only medium/low findings is advisory (`Approved with Comments`), while `REJECT` and high/critical findings remain blocking.
- Escalation is allowed only after final re-review still fails.

### R8 — Integration loop convergence must distinguish unavailable, skipped, failed, and passed

Stage 11 MUST track integration expected roles and actual outcomes explicitly:

- `passed`
- `failed`
- `skipped-not-applicable`
- `skipped-service-unavailable`
- `unknown-runner-unavailable`

A missing expected service or test runner must not be counted as green unless the spec/classification says integration is not applicable.

### R9 — Structured output resilience

Session-backed doc/review/implementation agents that fail to call structured output should receive one same-session corrective prompt. Empty implementation change arrays are valid. Missing required non-empty fields remain invalid.

### R10 — Full workflow should complete, but not hide invariant failure

The workflow should proceed through docs/cleanup where safe, but final status must honestly distinguish:

- successful mergeable implementation,
- implementation passed but review/integration blocked,
- hard invariant violation such as RED pollution or unconfirmed RED,
- accepted limitation.

## Acceptance criteria

- **AC-01 RED isolation:** A TDD agent that writes a production file during RED is detected as `polluted-red`; implementation does not proceed as if RED was valid.
- **AC-02 RED hard gate:** If tests are still green after the RED retry budget and deliverables were not already satisfied at baseline, Stage 9 records `red-not-confirmed` and does not call the implementer for that phase.
- **AC-03 RED already satisfied:** If tests are green and deliverables were already satisfied before RED, the phase is marked already satisfied/skipped with evidence.
- **AC-04 Broken tests:** Compile/collection failures re-prompt the TDD agent and are not handed to the implementer as normal green work.
- **AC-05 Unknown runner:** Greenfield/no-runner cases remain non-stalling and explicitly record `unknown-no-runner`.
- **AC-06 Review final refresh:** A stale repeated review finding after a fix triggers final re-review before escalation; if approved, the stagnation marker is cleared.
- **AC-07 Adversarial calibration:** `CONTEST` with only medium/low findings does not block merge; `REJECT` or high/critical findings still block.
- **AC-08 Integration explicitness:** Integration status distinguishes unavailable/skipped/failed/passed and cannot be vacuously green.
- **AC-09 Evidence ledger:** Stage 9 emits structured per-phase evidence that can be inspected after a run.
- **AC-10 Regression log corpus:** Add tests based on representative failures from the Aug 1–2 run logs.

## Implementation strategy

1. Add a small diff-classification utility for RED-phase changed files.
2. Add implementation evidence recording helpers.
3. Update Stage 9 to snapshot baseline, verify tests-only RED changes, and hard-stop on unconfirmed green RED except for proven already-satisfied/unknown-no-runner cases.
4. Update tests that currently assert “green RED proceeds with warning”; that behavior is now the bug.
5. Preserve recently fixed review-loop behavior and add integration-loop explicit status tests.
6. Run targeted tests, then broader workflow tests.
