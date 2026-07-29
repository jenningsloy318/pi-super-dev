# Specification Review: Spec Review — HITL Escalation (pause-ask-continue) for pi-super-dev (08-specification.md)

- **Date**: 2026-07-28
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Fagan-style inspection of 08-specification.md (the technical-spec / impl-plan / task-list for HITL escalation). The spec is exceptionally well-grounded: every cited file, line, and function was verified against the actual codebase and holds — gate() throws FatalAbort at src/nodes.ts:436 (function at :395); stagnation stamp at src/stages/verify.ts:167 (reviewLoopUntil at :157) and recordTestStagnation at :322 (body ~:329); the userSteerProvider seam is real at types.ts:318 / extension.ts:509-521 / workflow.ts:148 drain; the safety.ts denylist entries 'git reset --hard' (:35) and 'git clean -fd' (:39) exist exactly as cited; and rollbackWorktreeTo / src/escalation.ts / src/render/escalation-report.ts are correctly marked as AUTHORED/absent. The architecture is additive, feasible (mirrors an existing proven seam, zero workflow.ts edit confirmed), testable (concrete vitest files with numeric thresholds), and low-complexity (reuses appendUserNotes/userNotesForAgent). Grounding score ~95%. No Critical or >3 High findings. Six Medium/Low defects remain: (1) the stated reason the denylist is bypassed is imprecise — the real reason is that checkBashCommand only runs inside a child-session tool_call hook, not on host-process spawnSync; (2) rollbackWorktreeTo lacks a path-safety acceptance criterion/test (only "non-git dir no-throw" is tested, not "main checkout refused"); (3) no in-document AC→section / Scenario→section coverage matrix (AC-01..12 / SCENARIO-001..025 are claimed and ID-listed but not mapped); plus a typo, an unverified createMemoizingAgent caching claim, and an uncited GateOptions.fatal field. Verdict: APPROVED WITH REVISIONS — refinements, not blockers.

## Findings

### F-01: Safety-bypass rationale is imprecise — denylist is bypassed via host-process spawnSync, not because 'argv-discrete beats shell-string regex'

- **Severity**: medium
Architecture §4 states rollbackWorktreeTo uses 'discrete-argv spawnSync … so it sidesteps the safety.ts denylist (:35/:39 match shell strings only)'. Grounding check: DANGEROUS patterns at safety.ts:35/39 DO match shell command strings, but that is not why they are bypassed. checkBashCommand (safety.ts:81) is only ever invoked from createSafetyExtensionFactory's child-session `tool_call` hook (the pi.on('tool_call') for toolName==='bash'). rollbackWorktreeTo runs spawnSync in the HOST process, so it never passes through that hook at all — argv form is irrelevant. Recommendation: restate the mechanism accurately ('runs in the host process, which the safety hook does not instrument') so the impl does not silently rely on a false assumption; a future refactor that also gates host spawnSync would break the current wording without anyone noticing.
### F-02: rollbackWorktreeTo lacks a path-safety acceptance criterion — 'never main checkout' is asserted as a property but never tested

- **Severity**: medium
The spec repeatedly guarantees rollbackWorktreeTo is 'worktree-scoped only (never main checkout)'. Testing Strategy (b) only asserts: dirty temp repo → {ok:true}; non-git dir → {ok:false} no-throw; argv form (no shell:true). There is NO AC or test that the function refuses/no-ops when the resolved target is the main checkout (e.g., cwd not under .worktree/, or path equal to repo root). Since this function runs destructive git ops (reset --hard + clean -fd) outside any safety gate (see F-01), a path guard is the only remaining barrier to wiping the main checkout. Recommendation: add an explicit AC + test: rollbackWorktreeTo returns {ok:false} (or no-ops) when the target path is not recognized as a worktree.
### F-03: No in-document coverage matrix — AC-01..12 / SCENARIO-001..025 are ID-listed but not mapped to spec sections

- **Severity**: medium
Summary and BDD Scenario References claim 'Covers AC-01..AC-12 and SCENARIO-001..025' and 25 scenario IDs are enumerated, but the document contains no AC→spec-section or Scenario→spec-section table. As a standalone spec artifact the traceability chain (AC → section that satisfies it; Scenario → task) is unprovable inside this doc — the reviewer must cross-read 01-requirements.md / 02-bdd-scenarios.md to confirm each AC is satisfied. Recommendation: add a compact coverage table (one row per AC and per Scenario) pointing to the paragraph/section that delivers it. This is the standard D5 expectation and closes the gap without changing the design.
### F-04: Typo: ESCCALATION_RETRY_CAP in Testing Strategy (e)

- **Severity**: low
Testing Strategy (e) reads 'runEscalation stops calling escalate after ESCCALATION_RETRY_CAP'. Architecture §4 and the rest of the doc use ESCALATION_RETRY_CAP. Inconsistent identifier — will cause a copy-paste compile/reference error in the test if taken literally. Recommendation: fix to ESCALATION_RETRY_CAP.
### F-05: createMemoizingAgent 'uncached re-run' claim is unverified

- **Severity**: low
Architecture §3 justifies the retry path re-running uncached with 'since createMemoizingAgent only caches completed calls'. This is plausible but no grounding is shown for the cache key / completion semantics. If a memo entry is recorded for a stalled or partially-completed attempt, the retry could yield stale guidance and defeat the pause-ask-continue loop. Recommendation: add a one-line verification of createMemoizingAgent's cache-key/completion behavior, or specify an explicit cache-busting key (e.g., include state.__escalationRetries) in the retry call.
### F-06: Gate failure severity derivation relies on GateOptions.fatal but field is not cited

- **Severity**: low
Architecture §3 derives gate-exhaustion severity as {severity: opts.fatal?'hard':'soft'}. Grounding confirms GateOptions does carry a fatal flag (nodes.ts:372 comment: 'When true, EXHAUSTION throws a FatalAbort'). The spec is correct but should cite the field name explicitly so the impl does not guess at the option shape (e.g., opts.fatal vs opts.gate?.fatal). Minor.

## Dimension Reviews

### D1 Completeness

- **Status**: needs-work

Error handling thoroughly specified (no-throw everywhere, report always written, bounded spend). NFRs covered (additive/no-regression, headless safety, ESM+strict TS). Gaps: missing rollback path-validation AC (F-02) and no in-doc coverage matrix (F-03).
### D2 Consistency

- **Status**: pass

Type/decision names uniform across sections (Escalate / EscalationDecision / EscalationFailure / __escalationRetries / __acceptedLimitations). One identifier typo ESCCALATION_RETRY_CAP (F-04). Terminology stable.
### D3 Feasibility

- **Status**: pass

Architecture mirrors the verified, proven userSteerProvider seam (types.ts:318 → extension.ts:509-521 → workflow.ts:148 drain); zero workflow.ts edit confirmed by reading makeContext. createMemoizingAgent caching claim is the only lightly-grounded feasibility assumption (F-05). No circular deps.
### D4 Testability

- **Status**: pass

Concrete vitest files enumerated with specific assertions and injected fakes (no LLM/agent spawns). Numeric thresholds present (300s timeout, ESCALATION_RETRY_CAP=2). One missing test: rollbackWorktreeTo refusing a non-worktree path (F-02).
### D5 Traceability

- **Status**: needs-work

AC-01..12 and SCENARIO-001..025 are referenced and ID-listed but not mapped to spec sections within this document (F-03). Plan→task-list and phase decomposition are coherent (4 phases). Chain is provably unbroken only by cross-reading the requirements/bdd docs.
### D6 Grounding

- **Status**: pass

~95%. All cited files/lines/functions verified: gate() nodes.ts:395 with FatalAbort throw :436; verify.ts:167/__stagnated and :322-329 recordTestStagnation; workflow.ts:148 userSteerProvider drain; types.ts:196 StageContext.options and :318 userSteerProvider; extension.ts:509 runPipelineTask + :521 userSteerProvider; safety.ts:35/39 denylist entries; rollbackWorktreeTo / escalation.ts / escalation-report.ts correctly marked absent. One reasoning inaccuracy on the bypass mechanism (F-01).
### D7 Complexity

- **Status**: pass

Strictly additive. Minimal new surface (one helper rollbackWorktreeTo, one module escalation.ts, one writer escalation-report.ts). Reuses appendUserNotes/userNotesForAgent (verified at src/render/user-notes.ts:40/60) so retry guidance needs no new plumbing. Simplest viable approach.
### D8 Ambiguity

- **Status**: needs-work

EscalationDecision|undefined contract clear; retry/accept/revise/abandon state transitions explicit; accept-limitation-omitted-for-hard rule stated. Gaps: rollbackWorktreeTo input contract for a non-worktree path unspecified (F-02); GateOptions.fatal field uncited (F-06).
