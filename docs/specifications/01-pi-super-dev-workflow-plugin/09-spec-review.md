# Specification Review: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 09-spec-review.md  
**Reviewer**: spec-reviewer  
**Date**: 2026-07-03  
**Status**: APPROVED WITH COMMENTS  

---

## Per-Dimension Scores

### 1. Completeness — 4/5

**Justification**: The specification covers all 12 acceptance criteria (AC-01 through AC-12), all 13 functional requirements (FR-01 through FR-13), and all 8 non-functional requirements (NFR-01 through NFR-08). The cross-reference matrix in Section 10 explicitly maps every requirement to specification sections and BDD scenarios.

**Findings**:
- All ACs mapped to spec sections with explicit "Validates" annotations throughout.
- FR-05 states "10 support helpers" but the spec correctly implements 12 (6 gates + 3 routing + 3 utilities including `cleanup.mjs`). The requirements had an arithmetic error; the spec's count is correct and justified.
- FR-08 specifies `maxAgents: 100, maxConcurrency: 2` but the spec uses `maxAgents: 200, maxConcurrency: 3`. This deviation is justified (architecture estimates 40-60 agent calls per run; with retries the 100 limit would be too tight) but should be formally noted.
- AC-10 expects per-language specialist agents (`rust-developer`, `frontend-developer`) but the spec uses a single `implementer` agent with language-specific prompt augmentation (ADR-2). The functional outcome is equivalent but the literal AC text is not met. See Dimension 2 for traceability impact.

**Score rationale**: Minor deviations exist but are all justified by architectural decisions with documented rationale. No requirement is unaddressed.

---

### 2. Traceability — 4/5

**Justification**: All 96 BDD scenarios (SCENARIO-001 through SCENARIO-096) are cross-referenced in the specification's Section 10 matrix. The traceability table in the BDD document maps all ACs to their scenarios.

**Findings**:
- SCENARIO-028, SCENARIO-029, SCENARIO-050, SCENARIO-051, SCENARIO-052, SCENARIO-053: These scenarios reference per-language specialist agents (`rust-developer`, `frontend-developer`, `golang-developer`, `backend-developer`). The spec's ADR-2 collapses these into a single `implementer` agent with prompt augmentation. The scenarios are *functionally* addressed (the correct specialist behavior occurs) but the agent name in the scenario does not match. The spec should note this as a deliberate departure.
- SCENARIO-046 references `until` condition as JSONPath `"$.openIssues.length === 0"` — the spec resolves this correctly by using plain JavaScript `if` statements inside the dynamic controller (OQ-01 resolved).
- SCENARIO-091 expects "exactly 13 top-level stages" in the spec.json — the actual spec.json has 2 stages (setup + dynamic pipeline). The 13 stages exist as internal pipeline phases within the controller. Functionally equivalent but literally different from the scenario's expectation of the spec.json structure.
- SCENARIO-092 checks for loop-type stages in spec.json — since loops are implemented in the dynamic controller (not as declarative spec.json stages), this scenario tests controller logic rather than spec.json parsing. Traceable but implementation differs from what the scenario literally describes.

**Score rationale**: All scenarios are functionally addressed. A handful have literal mismatches due to the hybrid architecture (dynamic controller vs. pure DAG), which is a justified, well-documented architectural decision. No scenario is untestable.

---

### 3. Grounding — 5/5

**Justification**: The spec explicitly references research findings and resolves all 5 Open Questions (OQ-01 through OQ-05) with confirmed resolutions in Section 11. Architectural decisions cite research report sections.

**Findings**:
- "No `when` field" limitation — confirmed by research, justified hybrid approach
- `worktreePolicy: "on"` — confirmed available (OQ-03)
- `ctx.task`, `ctx.agent()`, `ctx.helper()`, `ctx.parallel()` — confirmed dynamic controller API
- Helper signature `{ sources, options, context } => { schema, digest, value }` — matches pi-workflow helper contract
- `schemaVersion: 1` — standard pi-workflow version
- `dynamic.mode: "graph-splice"` — referenced from pi-workflow documentation
- JSON Schema subset restrictions (no `$ref`, `$defs`, `pattern`) — confirmed from pi-workflow constraints
- All agent names verified against `super-dev-plugin/agents/` source directory
- `ExtensionAPI` type from `@earendil-works/pi-coding-agent` — verified as the pi extension interface

**Score rationale**: Every referenced API, pattern, and library usage is grounded in research findings or confirmed from source code. No hallucinated references found.

---

### 4. Feasibility — 5/5

**Justification**: The hybrid architecture (declarative setup + dynamic pipeline) is the most pragmatic approach given pi-workflow v1's limitations. Each component is implementable with documented APIs.

**Findings**:
- Dynamic controller pattern confirmed feasible for conditional stages, loops, and routing
- Helper functions are simple deterministic logic (regex matching, field validation, comparison) — no external dependencies
- Agent definitions are straightforward markdown files with frontmatter — no complex registration
- Schema files are static JSON — no generation or transformation needed
- The controller's estimated 400-600 LOC is complex but manageable with utility functions (runLoop, buildPrompt)
- Budget (200 agents, 3 concurrent) gives ~3.5x headroom over estimated usage (40-60 agents per run)
- Resume mechanism (deterministic task IDs) is a standard pattern for dynamic controllers
- All dependencies (`@agwab/pi-workflow`, `@earendil-works/pi-coding-agent`) are available

**Score rationale**: No technical blockers identified. The approach is proven by existing pi-workflow plugins (deep-research, deep-review) that use similar patterns.

---

### 5. Testability — 4/5

**Justification**: Every requirement has a clear test strategy. Static validation, unit testing (helpers), integration testing (smoke run), negative testing, and compliance auditing are all documented.

**Findings**:
- Helper unit tests: excellent — each helper can be imported and invoked with mock data (Section 9.2 gives concrete example)
- Static validation: TypeScript typecheck, workflow validate — binary pass/fail
- Smoke test: well-defined progression check (stages 1-3)
- Negative tests: 5 failure cases documented (missing helper, missing agent, $ref in schema, wildcard tools, malformed JSON)
- Prohibition audit: grep-based, automatable

**Minor gap**: No test runner or test directory structure is prescribed. The spec says helpers "can be tested" but doesn't specify whether a test suite should be part of the deliverable. This is acceptable for V1 (manual validation is sufficient for a plugin) but noted.

**Score rationale**: All requirements are testable with clear, concrete strategies. The minor gap of no formal test framework doesn't block validation.

---

### 6. Consistency — 4/5

**Justification**: The spec, implementation plan, and task list are well-aligned. Phase numbering, file counts, and acceptance gates match across documents.

**Findings**:
- Agents: 21 across all documents ✓
- Schemas: 17 in spec and task list ✓ (Architecture file tree shows 20 — see below)
- Helpers: 12 in spec and task list ✓
- Phase DAG: Plan matches task list dependencies ✓
- Acceptance gates in plan align with task list acceptance tests ✓

**Discrepancies**:
1. **Budget numbers**: Requirements FR-08 says `maxAgents: 100, maxConcurrency: 2`. Spec/Architecture use `200/3`. The spec should formally note this deviation.
2. **Architecture file tree**: Lists 20 schemas (includes prototype-control, review-merge-control, merge-control) while spec and task list specify 17. The architecture over-counted. Since spec is authoritative and matches requirements, this is a documentation inconsistency in the architecture doc only.
3. **Helper count**: Requirements say 10, architecture says 12+1, spec says 12+1. The requirements miscounted; spec is correct.

**Score rationale**: The primary review targets (06-specification.md, 07-implementation-plan.md, 08-task-list.md) are mutually consistent. Minor inconsistencies exist with the requirements and architecture documents but are all justified or represent upstream errors.

---

### 7. Complexity — 5/5

**Justification**: The design demonstrates good engineering judgment with no YAGNI violations, premature optimization, or untestable requirements.

**Findings**:
- **YAGNI compliant**: ADR-2 (single implementer vs 8 specialists) is an explicit simplification for V1. Language support is extensible via the route-specialist helper without adding agents.
- **No premature optimization**: Budget is generous, loop caps are simple (max 3), no caching/indexing complexity.
- **All requirements testable**: Each AC has at least one concrete validation method.
- **Error paths covered**: Loop exhaustion, phase failure, budget exhaustion, missing sources, resume interruption — all documented in Section 8.
- **No over-engineering**: The spec avoids unnecessary abstractions. Helpers are plain functions. The controller is a single file with utility functions. No framework-within-a-framework.
- **No deprecated patterns**: NFR-03 explicitly prohibits `agentWithRetry`, `tracking.json`, `TeamCreate/Delete`.

**Score rationale**: Clean design with appropriate scope. No anti-patterns detected.

---

### 8. Risk Coverage — 5/5

**Justification**: All risks identified in the architecture document are addressed with specific mitigations in the spec. Open questions are fully resolved.

**Findings**:
- Controller complexity risk → Mitigated by sub-functions (runLoop, buildPrompt) and incremental implementation (tasks 5.1-5.7)
- Resume reliability risk → Mitigated by deterministic task IDs with documented scheme
- Agent prompt length risk → Mitigated by prompt injection pattern (paths, not content)
- API version risk → Mitigated by pinning `@agwab/pi-workflow` version
- Gate strictness risk → Mitigated by starting lenient (simple field presence checks)
- Budget exhaustion risk → Mitigated by `ctx.budget.check()` before each spawn + generous 200 limit
- All 5 Open Questions (OQ-01 through OQ-05) have documented resolutions in spec Section 11

**Score rationale**: Comprehensive risk identification and mitigation. No unaddressed risks.

---

### 9. Ambiguity — 5/5

**Justification**: No ambiguous requirements detected. All spec sections use precise language with clear acceptance conditions.

**Findings**:
- Every acceptance criterion has a binary pass/fail definition
- Numerical thresholds (budget limits, loop caps, agent counts) are explicitly stated
- No "should", "may", or "as appropriate" qualifiers in normative text
- All edge cases (loop exhaustion, budget depletion, resume interruption) have defined behavior

**Score rationale**: The specification language is unambiguous throughout. No interpretation disputes are likely during implementation.

---

## Score Summary

| Dimension | Score | Notes |
|-----------|-------|-------|
| 1. Completeness | 4/5 | Budget deviation and ADR-2 impact on AC-10 |
| 2. Traceability | 4/5 | 6 scenarios have literal agent-name mismatch (functionally equivalent) |
| 3. Grounding | 5/5 | All references verified |
| 4. Feasibility | 5/5 | No blockers |
| 5. Testability | 4/5 | Minor gap: no test framework prescribed |
| 6. Consistency | 4/5 | Budget and schema count discrepancies with upstream docs |
| 7. Complexity | 5/5 | Clean design |
| 8. Risk Coverage | 5/5 | All risks mitigated |
| 9. Ambiguity | 5/5 | No ambiguous requirements |

**Average**: 4.5/5

---

## Specific Findings

### Issues (Should Fix)

1. **Budget deviation undocumented**: The spec uses `maxAgents: 200, maxConcurrency: 3` vs requirements' `100/2`. Add a note in spec Section 3.2 or create an ADR formally acknowledging this deviation with justification.

2. **AC-10 literal mismatch**: The spec satisfies AC-10's intent (language-specific implementation) but not its letter (spawns "implementer" not "rust-developer"). Add a note in the cross-reference matrix (Section 10) under FR-08 entry explaining that AC-10 is satisfied via ADR-2's prompt augmentation approach.

### Suggestions (Nice to Have)

3. **BDD scenarios 028-029, 050-053**: Consider updating these in `02-bdd-scenarios.md` to reflect the single-implementer decision (changing "rust-developer" to "implementer with rust-specific instructions").

4. **Architecture schema count**: The architecture document's file tree (§1.1) lists 20 schemas while the spec specifies 17. Consider updating the architecture to match the spec's authoritative count.

5. **Test framework note**: Consider adding a brief section to the implementation plan noting that helper testing will use direct Node.js execution with assertions (no test framework required for V1). This clarifies the testing approach without adding scope.

---

## Overall Verdict

### APPROVED WITH COMMENTS

The specification is comprehensive, well-grounded, and implementable. All acceptance criteria are covered (100%), all BDD scenarios are functionally traceable, and all risks are mitigated. The two "Should Fix" items are documentation clarifications rather than design flaws — the actual technical decisions are sound and justified.

**Required before implementation**:
- Item 1: Add budget deviation note (one paragraph)
- Item 2: Add AC-10 traceability note (one sentence in cross-reference matrix)

These are minor documentation additions that do not require re-review.
