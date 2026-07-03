# Implementation Plan: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 07-implementation-plan.md  
**Created**: 2026-07-03  
**Status**: Final  

---

## Phase Dependency DAG

```
Phase 1 (Foundation)
    │
    ├───────────────────────┐
    │                       │
    ▼                       ▼
Phase 2 (Agents)       Phase 3 (Schemas + Spec Skeleton)
    │                       │
    └───────────┬───────────┘
                │
                ▼
        Phase 4 (Helpers)
                │
                ▼
        Phase 5 (Dynamic Controller)
                │
                ▼
        Phase 6 (Skill + Integration)
                │
                ▼
        Phase 7 (Validation + Smoke Test)
```

---

## Phase 1: Foundation

**Description**: Create the package scaffold — `package.json`, `tsconfig.json`, `extension.ts`, directory structure, `README.md`, and `LICENSE`. This phase establishes the compilable skeleton that all subsequent phases build upon.

**Depends on**: Nothing (root phase)  
**Parallelizable with**: None  
**Estimated Complexity**: Small

### Deliverables

| Deliverable | Purpose |
|-------------|---------|
| `package.json` | npm package with `pi.extensions` and `pi.skills` registration |
| `tsconfig.json` | ES2022, NodeNext, strict mode |
| `src/extension.ts` | Minimal pi extension entry (auto-discovery only) |
| `README.md` | Package overview, installation, usage |
| `LICENSE` | MIT license |
| Directory structure | `agents/`, `workflows/super-dev/schemas/`, `workflows/super-dev/helpers/`, `skills/super-dev/`, `docs/` |

### Acceptance Gate

- `npm run typecheck` exits 0 with zero errors
- `package.json` contains `"pi": { "extensions": [...], "skills": [...] }`
- Directory structure matches architecture spec

---

## Phase 2: Agent Definitions

**Description**: Port 21 agent markdown files from `super-dev-plugin/agents/` to pi-workflow format. Adapt frontmatter (remove Claude Code-specific fields, add explicit tool ceilings and `readOnly`), preserve system prompt bodies.

**Depends on**: Phase 1  
**Parallelizable with**: Phase 3  
**Estimated Complexity**: Medium

### Deliverables

21 agent files in `agents/`:

| Agent | Source | Ceiling Category |
|-------|--------|-----------------|
| orchestrator.md | New (combines setup/merge) | Implementers |
| requirements-clarifier.md | requirements-clarifier.md | Writers |
| bdd-scenario-writer.md | bdd-scenario-writer.md | Writers |
| research-agent.md | research-agent.md | Researchers |
| debug-analyzer.md | debug-analyzer.md | QA/Build |
| code-assessor.md | code-assessor.md | Read-only |
| architecture-designer.md | architecture-designer.md | Writers |
| architecture-improver.md | architecture-improver.md | Writers |
| ui-ux-designer.md | ui-ux-designer.md | Writers |
| product-designer.md | product-designer.md | Writers |
| prototype-runner.md | prototype-runner.md | Implementers |
| spec-writer.md | spec-writer.md | Writers |
| spec-reviewer.md | spec-reviewer.md | Read-only |
| tdd-guide.md | tdd-guide.md | Implementers |
| implementer.md | dev-executor.md | Implementers |
| qa-agent.md | qa-agent.md | QA/Build |
| code-reviewer.md | code-reviewer.md | Read-only |
| adversarial-reviewer.md | adversarial-reviewer.md | Read-only |
| docs-executor.md | docs-executor.md | Writers |
| handoff-writer.md | handoff-writer.md | Writers |
| build-cleaner.md | build-cleaner.md | QA/Build |

### Porting Rules

1. Remove: `model: inherit`, `kind`, `max_turns`, `timeout_mins`
2. Replace: `tools: "*"` → explicit list per category
3. Add: `readOnly` field
4. Keep: All system prompt content (XML sections, instructions, constraints)
5. Remove: `plugin_root` references, `Skill(...)` invocations, `TeamCreate`/`TeamDelete`

### Acceptance Gate

- All 21 files exist with valid YAML frontmatter
- No prohibited fields (`model`, `kind`, `max_turns`, `timeout_mins`)
- No wildcard tools (`["*"]`)
- `npm run typecheck` still passes (agents don't affect TS)

---

## Phase 3: Control Schemas + Spec Skeleton

**Description**: Create 17 control schema JSON files and the initial `spec.json` with the two-stage structure (setup + dynamic pipeline placeholder).

**Depends on**: Phase 1  
**Parallelizable with**: Phase 2  
**Estimated Complexity**: Medium

### Deliverables

17 schema files in `workflows/super-dev/schemas/`:

| Schema | Validates Output Of |
|--------|---------------------|
| super-dev-setup-control.schema.json | Setup stage |
| super-dev-classify-task-control.schema.json | classify-task helper |
| super-dev-requirements-control.schema.json | requirements-clarifier agent |
| super-dev-gate-verdict.schema.json | All gate helpers (shared) |
| super-dev-bdd-control.schema.json | bdd-scenario-writer agent |
| super-dev-research-control.schema.json | research-agent |
| super-dev-debug-control.schema.json | debug-analyzer agent |
| super-dev-assessment-control.schema.json | code-assessor agent |
| super-dev-route-designer-control.schema.json | route-designer helper |
| super-dev-design-control.schema.json | All design agents |
| super-dev-check-prototype-control.schema.json | check-prototype helper |
| super-dev-spec-control.schema.json | spec-writer agent |
| super-dev-spec-review-control.schema.json | spec-reviewer agent |
| super-dev-implementation-control.schema.json | Implementation dynamic output |
| super-dev-code-review-control.schema.json | code-reviewer / adversarial-reviewer |
| super-dev-docs-control.schema.json | docs-executor agent |
| super-dev-cleanup-control.schema.json | cleanup helper |

Plus: `workflows/super-dev/spec.json` skeleton with:
- `schemaVersion: 1`
- `name: "super-dev"`
- `description`
- `defaults` (tools, readOnly, maxRuntimeMs)
- `input` (task, skipWorktree, skipStages)
- `artifactGraph.stages`: setup stage + dynamic pipeline stage (controller path placeholder)

### Acceptance Gate

- All 17 schema files are valid JSON
- No `$ref`, `$defs`, `definitions`, or `pattern` in any schema
- `spec.json` is valid JSON with correct top-level structure
- `/workflow validate super-dev` passes schema validation (may warn about missing controller file)

---

## Phase 4: Gate + Routing Helpers

**Description**: Implement all 12 support helpers as ESM `.mjs` files. Each exports a default async function with the pi-workflow helper signature.

**Depends on**: Phase 1, Phase 3 (schema shapes inform helper outputs)  
**Parallelizable with**: None (depends on Phase 3 completing)  
**Estimated Complexity**: Medium

### Deliverables

12 helper files in `workflows/super-dev/helpers/`:

| Helper | Type | Logic |
|--------|------|-------|
| classify-task.mjs | Routing | Regex keyword matching for task type |
| route-designer.mjs | Routing | Decision tree based on taskType + uiScope |
| route-specialist.mjs | Routing | Language → implementer prompt augmentation |
| check-prototype-needed.mjs | Utility | Check hasNumericConstants flag |
| gate-requirements.mjs | Gate | Validate docPath, acCount, summary |
| gate-bdd.mjs | Gate | Validate docPath, scenarioCount, coverage |
| gate-spec-trace.mjs | Gate | Validate specificationPath, phases |
| gate-spec-review.mjs | Gate | Validate verdict acceptance |
| gate-build.mjs | Gate | Validate allTestsPass + buildSuccess |
| gate-review.mjs | Gate | Validate code review verdict |
| merge-review-verdicts.mjs | Utility | Merge code + adversarial verdicts (stricter wins) |
| cleanup.mjs | Utility | Scan for artifacts + secrets, return blocked flag |

### Acceptance Gate

- All 12 files are valid ESM with `export default async function`
- Each accepts `{ sources, options, context }` and returns `{ schema, digest, value }`
- Gate helpers return `{ pass: boolean, errors: string[], gate: string }`
- Routing helpers are deterministic (same input → same output)
- No external API calls or LLM invocations in any helper

---

## Phase 5: Dynamic Controller

**Description**: Implement `implementation-controller.mjs` — the core pipeline orchestrator. This is the largest and most critical single file. It implements the full 13-stage flow (phases 2-13) using `ctx.agent()`, `ctx.helper()`, and `ctx.parallel()`.

**Depends on**: Phase 2 (needs agent names), Phase 3 (needs schema shapes), Phase 4 (calls helpers)  
**Parallelizable with**: None  
**Estimated Complexity**: Large

### Deliverables

| Deliverable | Description |
|-------------|-------------|
| `helpers/implementation-controller.mjs` | ~400-600 LOC dynamic controller |

### Controller Structure

```javascript
export default async function controller(ctx) {
  // Utility: runLoop(phase, agent, gateHelper, promptBuilder, maxRounds=3)
  // Utility: buildPrompt(template, context)
  
  // Phase 2A: Classify Task
  // Phase 2B: Requirements Loop
  // Phase 2C: BDD Loop
  // Phase 3: Research Loop
  // Phase 4: Debug (conditional)
  // Phase 5: Assessment
  // Phase 6: Design Routing + Execution
  // Phase 6.5: Prototype (conditional)
  // Phase 7: Spec Loop
  // Phase 8: Spec Review Loop
  // Phase 9: Implementation (per-phase TDD)
  // Phase 10: Code Review Loop (parallel reviewers)
  // Phase 11: Documentation
  // Phase 12: Cleanup
  // Phase 13: Merge (conditional)
}
```

### Key Implementation Details

1. **Task ID scheme**: `pipeline.<phase>.<round>.<operation>` for replay safety
2. **Loop utility**: Shared `runLoop()` function handles the repeat-until-pass pattern
3. **Prompt building**: Each agent receives context via prompt injection (upstream paths, feature name, language)
4. **Budget monitoring**: Check `ctx.budget.check()` before each agent spawn
5. **Error resilience**: Catch per-phase errors; log and continue where possible

### Acceptance Gate

- Controller file loads without import errors
- `/workflow validate super-dev` passes with no blockers
- A test run progresses through at least Setup + Classify + Requirements start

---

## Phase 6: Skill + Integration

**Description**: Create the SKILL.md trigger, write user documentation, wire the spec.json to reference the controller correctly, and ensure end-to-end discoverability.

**Depends on**: Phase 5  
**Parallelizable with**: None  
**Estimated Complexity**: Small

### Deliverables

| Deliverable | Description |
|-------------|-------------|
| `skills/super-dev/SKILL.md` | Skill trigger → `workflow_run` dispatch |
| `docs/usage.md` | User-facing documentation |
| Final `spec.json` | Controller path verified and correct |

### Acceptance Gate

- `/workflow list` shows `super-dev` with description
- Skill triggers on "implement X", "fix bug in Y", "refactor Z"
- Skill does NOT trigger on "what does this function do?" or "find all usages"
- `/workflow validate super-dev` reports no blockers and no unresolved warnings

---

## Phase 7: End-to-End Validation

**Description**: Run the full validation suite and a smoke test. Fix any remaining issues found during integration testing.

**Depends on**: Phase 6  
**Parallelizable with**: None  
**Estimated Complexity**: Medium

### Deliverables

| Deliverable | Description |
|-------------|-------------|
| Passing `npm run typecheck` | AC-01 |
| Passing `/workflow validate super-dev` | AC-02 |
| Successful smoke run (Stages 1-3) | AC-08 |
| Bug fixes from validation findings | All ACs |

### Validation Checklist

- [ ] `npm run typecheck` — zero errors (AC-01)
- [ ] `/workflow validate super-dev` — no blockers (AC-02)
- [ ] `/workflow list` — includes `super-dev` (AC-03)
- [ ] All 21 agents load without error (AC-04)
- [ ] All 17 schemas pass subset validation (AC-05)
- [ ] All 12 helpers export correct signature (AC-06)
- [ ] Skill triggers correctly (AC-07)
- [ ] Smoke test passes stages 1-3 (AC-08)
- [ ] No `agentWithRetry`, `tracking.json`, `TeamCreate` in source (NFR-03)
- [ ] No `$ref`, `$defs`, `definitions`, `pattern` in schemas (NFR-04)
- [ ] Grep audit: no wildcard tools, no prohibited frontmatter (FR-03)

### Acceptance Gate

- ALL acceptance criteria AC-01 through AC-08 pass
- All NFR compliance checks pass
- No blocking validation warnings remain
