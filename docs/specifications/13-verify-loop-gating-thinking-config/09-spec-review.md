# Specification Review: Specification Review: Verify-Loop Gating & Per-Agent Thinking Configuration

- **Date**: 2026-07-24
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

The specification describes two well-scoped, decoupled changes to the pi-super-dev TypeScript pipeline: (1) hardening the Stage 10 review loop and Stage 11 integration loop in src/stages/verify.ts (GAPs A–D), and (2) per-agent thinking configuration across src/pi-spawn.ts, src/session-agent.ts, src/workflow.ts, and src/types.ts. Internal grounding is excellent: every referenced predicate and node was verified against the actual codebase — reviewApproved, buildGreen, findingsSignature, reviewLoopUntil (with __reviewSignatures/__stagnated), reviewLoopNode = loop({until, times:3}, sequence([reviewStep, fixStepReview, buildGateStep])), the custom integrationLoopNode, testsGreen, and s.apiTest.failures/s.uiTest.failures (used at verify.ts:213–214) all exist as described. SpawnAgentOptions, buildSpawnArgs, isCodeWritingAgent, AgentCall, SessionAgentOptions, and createAgentSession/runAgentViaSession are all present. The testing strategy is concrete, numeric, and mapped gap-by-gap. Two issues warrant revision: the external '--thinking' CLI flag and session.setThinkingLevel could not be found in the installed pi runtime (the session path is defended with try/catch, but the subprocess argv path is not), and the BDD scenarios file contains more scenarios (~37 references) than the 29 the spec enumerates, leaving a potential coverage gap. No critical defects; the loop-gating design (Area 1) is fully grounded and testable.

## Findings

### F1: External '--thinking' CLI flag not verified in installed pi runtime; subprocess path lacks fallback

- **Severity**: high
Area 2 specifies buildSpawnArgs appends '--thinking <level>' to the argv for the subprocess backend, and runAgentViaSession calls session.setThinkingLevel(resolved). Neither the '--thinking' flag nor setThinkingLevel could be located in node_modules/@earendil-works/pi-coding-agent. The session backend is defended (try/catch, 'older runtimes may lack the method'), but the subprocess argv path is NOT: if the installed pi CLI rejects unknown flags, every subprocess spawn would fail, breaking the pipeline broadly. Recommendation: verify the flag is supported by the pinned pi version, or feature-gate the argv append (only add '--thinking' when the CLI advertises support / behind an env/capability check) so unknown-flag runtimes degrade gracefully like the session path does.
### F2: BDD scenario coverage gap: spec lists SCENARIO-001..029 but the BDD file contains more scenarios

- **Severity**: medium
The specification's 'BDD Scenario References' section enumerates exactly SCENARIO-001 through SCENARIO-029 (29 items), but 02-bdd-scenarios.md contains roughly 37 SCENARIO- references. Scenarios numbered above 029 (and any others beyond the listed set) are not referenced by the spec, and the spec does not map any scenario to the behavior that satisfies it — the references are a bare list with no coverage matrix. Recommendation: reconcile the scenario list with the BDD file (add references for any uncovered scenarios or justify exclusions) and add an explicit AC/SCENARIO→spec-section coverage mapping.
### F3: GAP A early-break return status ('ok' vs 'failed') left ambiguous

- **Severity**: low
GAP A states that on test-failure stagnation the integrationLoopNode should 'break the retry loop early (return {status:"ok"} or {status:"failed"} non-fatally — never throw)'. The condition determining which status is returned is not specified. Since integrationLoopNode currently exits on testsGreen && reviewApproved and the downstream merge gate reads reviewApproved, an undefined status on stagnation could mask a red integration state. Recommendation: specify the exact status returned on test stagnation and confirm it does not falsely signal a green merge gate.
### F4: GAP D adds an extra LLM reviewStep at Stage 10 exhaustion in an already time-heavy loop

- **Severity**: low
GAP D runs one final reviewStep on max-rounds exhaustion. It is correctly budget-checked (ctx.budget.check()) and non-fatal, which is the right safeguard. However, prior-run lessons note the verify/review loop is consistently the dominant time cost. This extra review call only fires on exhaustion (bounded, acceptable), but the spec should confirm the final reviewStep reuses the existing budget/timeout envelope and cannot itself trigger further fix rounds. Recommendation: explicitly state the final reviewStep performs no fix and is skipped when the budget is already exhausted.

## Dimension Reviews

### Completeness

- **Status**: concerns

All four GAPs (A–D) and both thinking-config backends are fully described with error/non-fatal handling and NFRs (strict typecheck, 1387 existing tests green). Gap: the BDD scenario list (29) is smaller than the BDD file's scenario set (~37) and no explicit AC/SCENARIO→section coverage matrix is provided.
### Correctness

- **Status**: pass

Grounding is strong. Every internal reference verified against the codebase: reviewApproved/buildGreen/findingsSignature/reviewLoopUntil/reviewLoopNode/integrationLoopNode/testsGreen in verify.ts, s.apiTest.failures & s.uiTest.failures (verify.ts:213–214), plus buildSpawnArgs/isCodeWritingAgent/SpawnAgentOptions, AgentCall, SessionAgentOptions/createAgentSession/runAgentViaSession. Grounding score ~92% (only the proposed --thinking flag/setThinkingLevel are unverified, and those are new external dependencies).
### Consistency

- **Status**: pass

Naming and structure match the actual code exactly (reviewLoopUntil, __reviewSignatures, __stagnated, times:3 cap, sequence composition). Proposed new symbols (__testSignatures, __testStagnated, __reviewCounts, __testCounts, thinkingForAgent) mirror existing conventions coherently.
### Testability

- **Status**: pass

Excellent. Testing strategy is concrete and per-GAP with measurable assertions: synthetic PipelineState + stub StageContext, numeric thresholds (≤12 failures, 3-round cap, 5→3→1 converging must NOT trigger, 5→5/5→6 must trigger), reviewStep-invoked-once assertions, env set/restore for precedence, and try/catch tolerance for missing setThinkingLevel.
### Feasibility

- **Status**: concerns

Area 1 (loop gating) is fully feasible — all machinery exists and edits are confined to verify.ts. Area 2 depends on a pi '--thinking' CLI flag and session.setThinkingLevel that were not found in the installed runtime; the session path is defended but the subprocess argv path is not (see F1).
### Security

- **Status**: pass

No new attack surface. The only external input is the SUPER_DEV_THINKING env var constrained to a fixed ThinkingLevel union; no secrets, network, or filesystem trust boundaries are added.
### Performance

- **Status**: pass

New loop-exit paths are non-fatal and budget-checked. GAP D adds one bounded reviewStep only on exhaustion (F4, low). Stagnation/oscillation detectors should reduce wasted rounds overall, which is favorable given the historically dominant verify-loop cost.
### Maintainability

- **Status**: pass

Changes are localized (Area 1 → verify.ts only; Area 2 → 4 disjoint files), mirror existing signature/history patterns and comment style, and keep all new paths non-fatal. The two-phase split matches the disjoint file sets and reduces regression risk.
