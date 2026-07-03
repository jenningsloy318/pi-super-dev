# Requirements: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 01-requirements.md  
**Created**: 2026-07-03  

---

## Summary

This document defines the requirements for `@jenningsloy318/pi-super-dev`, a pi-workflow plugin that replicates the super-dev 13-stage development pipeline as a declarative pi-workflow spec. The plugin orchestrates requirements gathering, research, design, specification, TDD implementation, code review, documentation, and merge through 21 specialized AI agents coordinated by the pi-workflow engine's DAG scheduler.

The plugin translates the prompt-driven orchestration model (where the AI acts as team-lead spawning specialist agents) into pi-workflow's declarative artifact-graph format, gaining engine-managed scheduling, automatic run persistence, built-in resume, progress UI, and structured artifact bundles.

---

## Functional Requirements

### FR-01: Plugin Registration and Discovery

- The plugin MUST register as a pi-workflow extension via `src/extension.ts` and `package.json`
- The plugin MUST declare `@agwab/pi-workflow` as a dependency and `@earendil-works/pi-coding-agent` as a peerDependency
- The plugin MUST be discoverable via `/workflow list` with the name `super-dev`
- The plugin MUST compile with TypeScript (ES2022, NodeNext module resolution)

### FR-02: 13-Stage Pipeline Architecture

The workflow spec (`workflows/super-dev/spec.json`) MUST define these 13 stages in correct DAG order:

| # | Stage | Type | Key Dependencies |
|---|---|---|---|
| 1 | setup | single | (entry) |
| 2A | classify-task | support | setup |
| 2B | requirements | loop | classify-task |
| 2C | bdd | loop | requirements |
| 3 | research | loop | bdd |
| 4 | debug | single (conditional) | research |
| 5 | assessment | single | research, debug (partial) |
| 6A | route-designer | support | classify-task, assessment |
| 6B | design | single (conditional) | route-designer, assessment, research |
| 6.5A | check-prototype | support | design |
| 6.5B | prototype | loop (conditional) | check-prototype, design |
| 7 | spec | loop | prototype, design, assessment, research, bdd, requirements (partial) |
| 8 | spec-review | loop | spec |
| 9 | implementation | dynamic | spec-review, classify-task |
| 10 | code-review-loop | loop | implementation |
| 11 | docs | single | code-review-loop |
| 12 | cleanup | support | docs |
| 13 | merge | single (conditional) | cleanup |

### FR-03: Agent Definitions

- The plugin MUST define 21 agent markdown files under `agents/`
- Each agent MUST have explicit tool ceilings (not `["*"]`)
- Each agent MUST specify `readOnly` flag appropriate to its role
- Agent tool ceilings MUST follow these categories:
  - Read-only explorers: `read`, `grep`, `find`, `ls`
  - Researchers: `read`, `grep`, `find`, `ls`, `workflow_web_search`, `workflow_web_fetch_source`, `workflow_web_source_read`
  - Writers (docs/specs): `read`, `grep`, `find`, `ls`, `write`, `edit`
  - Implementers: `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`
  - QA/Build: `read`, `grep`, `find`, `ls`, `bash`
- Agents MUST NOT include Claude Code-specific frontmatter (`model: inherit`, `kind: local`, `max_turns`, `timeout_mins`)
- Agent system prompt content (roles, instructions) MUST be preserved from source material

### FR-04: Control Schemas

- The plugin MUST define 17 control schema JSON files under `workflows/super-dev/schemas/`
- Schemas MUST use only the pi-workflow supported JSON Schema subset: `type`, `required`, `properties`, `items`, `enum`, `const`, bounds, `additionalProperties`
- Schemas MUST NOT use `$ref`, `$defs`, `definitions`, or `pattern`
- Each stage MUST produce a `control.json` output conforming to its schema
- Gate schemas MUST share the common gate verdict structure: `{ pass: boolean, gate: string, errors: string[] }`

### FR-05: Support Helpers

- The plugin MUST implement 10 support helpers as `.mjs` files under `workflows/super-dev/helpers/`
- All helpers MUST export a default async function with signature: `({ sources, options, context }) => { schema, digest, value }`
- **Gate helpers** (6): `gate-requirements.mjs`, `gate-bdd.mjs`, `gate-spec-trace.mjs`, `gate-spec-review.mjs`, `gate-build.mjs`, `gate-review.mjs`
- **Routing helpers** (3): `classify-task.mjs`, `route-designer.mjs`, `route-specialist.mjs`
- **Utility helpers** (2): `merge-review-verdicts.mjs`, `check-prototype-needed.mjs`
- Gate helpers MUST validate upstream writer output and return `{ pass, errors }` structure
- Routing helpers MUST deterministically select agents based on task classification

### FR-06: Loop Stages

- Loop stages MUST support `maxRounds` (capped at 3 for all loops)
- Loop stages MUST support `until` condition for early termination on gate pass
- Loop stages MUST contain writer + gate child stage pairs
- The following stages MUST be loops: requirements, bdd, research, prototype, spec, spec-review, code-review-loop

### FR-07: Conditional Stages

- Stage 4 (debug) MUST execute only when `classify-task.control.taskType === "bug"`
- Stage 6B (design) MUST execute only when `route-designer.control.designerAgent !== null`
- Stage 6.5B (prototype) MUST execute only when `check-prototype.control.needed === true`
- Stage 13 (merge) MUST execute only when `cleanup.control.blocked === false`
- Skipped conditional stages MUST be marked as skipped in run state (not errored)

### FR-08: Dynamic Stage (Implementation)

- Stage 9 MUST use the `dynamic` stage type with a controller (`implementation-controller.mjs`)
- The controller MUST iterate over implementation phases sequentially
- For each phase, the controller MUST:
  1. Spawn `tdd-guide` agent (write failing tests)
  2. Spawn domain specialist agent (selected by `route-specialist.mjs` based on language)
  3. Spawn `qa-agent` (verify tests pass, check coverage)
  4. Run `gate-build` helper (validate build + tests green)
  5. Commit phase changes to git
- Dynamic budget MUST be `{ maxAgents: 100, maxConcurrency: 2 }`
- Failed phases MUST retry (max 3 attempts) before early termination

### FR-09: Parallel Execution in Code Review

- Stage 10 MUST run `code-reviewer` and `adversarial-reviewer` in parallel
- Results from both reviewers MUST be merged via `merge-review-verdicts.mjs`
- Fix-issues agent MUST spawn only when merged verdict is not "Approved" or "Approved with Comments"

### FR-10: Data Flow Between Stages

- Each stage MUST receive upstream artifacts via `from` declarations
- The pi-workflow engine MUST make upstream `control.json` available in the source manifest
- Key data flows MUST be correctly wired:
  - `setup.control.worktreePath` → all downstream stages
  - `setup.control.specDirectory` → all downstream stages
  - `classify-task.control.taskType` → debug (when condition), route-designer (routing)
  - `classify-task.control.language` → implementation (specialist routing)
  - `spec.control.phases` → implementation (per-phase iteration)
  - `spec.control.specificationPath` → spec-review, implementation, code-review

### FR-11: Skill Definition

- The plugin MUST define a skill at `skills/super-dev/SKILL.md`
- The skill MUST trigger on keywords: "implement", "build", "fix bug", "refactor", "add feature", "develop this", "help me build", "optimize performance", "resolve deprecation"
- The skill MUST NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits
- The skill MUST dispatch to `workflow_run({ workflow: "super-dev", task: "<user's full request>" })`
- The user's language, file references, and constraints MUST be preserved in the task

### FR-12: Artifact Bundles

- Every stage MUST produce artifact bundles containing at minimum `control.json` and `analysis.md`
- Reference data MUST be stored in `refs.json` where applicable
- Artifacts MUST be persisted in `.pi/workflows/<run-id>/` directory structure

### FR-13: Source Policy

- Stage 5 (assessment) MUST use `sourcePolicy: "partial"` for the debug dependency (allowing skip when debug is skipped)
- Stage 7 (spec) MUST use `sourcePolicy: "partial"` to accommodate optional upstream stages
- Partial sources MUST NOT cause scheduling errors when upstream conditional stages are skipped

---

## Non-Functional Requirements

### NFR-01: TypeScript Compilation

- `npm run typecheck` MUST pass with zero errors
- Target: ES2022 with NodeNext module resolution
- Strict mode enabled

### NFR-02: pi-workflow Engine Compatibility

- The workflow spec MUST validate without blockers via `/workflow validate super-dev`
- The plugin MUST be compatible with the pi-workflow engine's DAG scheduler, artifact graph runtime, agent backend, loop controller, and dynamic controller
- No deprecated or unsupported pi-workflow features may be used

### NFR-03: No Imperative Orchestration

- The plugin MUST NOT replicate `agentWithRetry` retry logic — pi-workflow engine handles retries
- The plugin MUST NOT maintain tracking JSON — pi-workflow engine tracks run state
- The plugin MUST NOT replicate `TeamCreate`/`TeamDelete` scaffolding
- The plugin MUST NOT port `workflows/super-dev.workflow.js` (Dynamic Workflow variant)

### NFR-04: Schema Compliance

- All control schemas MUST use only pi-workflow's supported JSON Schema subset
- No external `$ref` resolution is permitted
- Schema validation MUST be deterministic (no LLM-based validation in gate helpers)

### NFR-05: Agent Isolation

- Agents MUST NOT see each other's full context
- Agents receive only `spec_directory` paths and read their own inputs
- All file paths in agent prompts MUST be absolute (within `worktreePath`)

### NFR-06: Deterministic Helpers

- All support helpers MUST be deterministic (same inputs → same outputs)
- Gate validation logic MUST NOT require LLM invocation
- Routing decisions MUST be based on explicit criteria from upstream control data

### NFR-07: Resume Capability

- Interrupted workflow runs MUST be resumable via `/workflow resume`
- Stage state MUST be persisted after each stage completes
- Completed stages MUST NOT re-execute on resume

### NFR-08: Performance Constraints

- Dynamic stage budget: max 100 agents total, max 2 concurrent
- All loop stages: max 3 rounds before forced termination
- No infinite loops permitted in any stage configuration

---

## Acceptance Criteria

### AC-01: TypeScript Type Check

**Given** the plugin source code is complete  
**When** `npm run typecheck` is executed  
**Then** it passes with zero errors

### AC-02: Workflow Validation

**Given** the workflow spec and all supporting files exist  
**When** `/workflow validate super-dev` is executed  
**Then** it reports no blockers and no unresolved warnings

### AC-03: Workflow Discovery

**Given** the plugin is installed  
**When** `/workflow list` is executed  
**Then** the output includes `super-dev` with its description ("13-stage development pipeline...")

### AC-04: Agent Loading

**Given** all 21 agent markdown files exist under `agents/`  
**When** agent discovery runs (e.g., `/workflow agents`)  
**Then** all 21 agents load without error and are listed with correct names

### AC-05: Schema Validity

**Given** all 17 control schema JSON files exist under `workflows/super-dev/schemas/`  
**When** each schema is validated against pi-workflow's supported JSON Schema subset  
**Then** all schemas pass validation (no `$ref`, `$defs`, `definitions`, `pattern` used)

### AC-06: Helper Export Signatures

**Given** all 10 support helpers exist under `workflows/super-dev/helpers/`  
**When** each helper module is imported  
**Then** each exports a default async function that accepts `{ sources, options, context }` and returns `{ schema, digest, value }`

### AC-07: Skill Dispatch

**Given** the plugin is installed and active  
**When** a user says "implement X" (or other trigger keywords)  
**Then** the skill triggers and dispatches to `workflow_run({ workflow: "super-dev", task: "..." })`

### AC-08: End-to-End Smoke Test

**Given** a fresh project directory  
**When** `/workflow run super-dev "add a hello world endpoint"` is executed  
**Then** the run progresses through at least Stages 1-3 (setup, classify-task, requirements) without schema or scheduling errors

### AC-09: Loop Termination

**Given** a loop stage (requirements, bdd, research, spec, spec-review, code-review)  
**When** the gate helper returns `{ pass: true }`  
**Then** the loop terminates immediately without executing remaining rounds

**Given** a loop stage  
**When** `maxRounds` (3) is reached without gate pass  
**Then** the loop terminates with a failure/warning state

### AC-10: Dynamic Specialist Routing

**Given** Stage 9 (implementation) is executing  
**When** the detected language is "rust"  
**Then** the dynamic controller spawns `rust-developer` as the implementation specialist

**Given** Stage 9 (implementation) is executing  
**When** the detected language is "frontend"  
**Then** the dynamic controller spawns `frontend-developer` as the implementation specialist

### AC-11: Conditional Stage Skipping

**Given** `classify-task.control.taskType` is "feature" (not "bug")  
**When** the DAG scheduler reaches Stage 4 (debug)  
**Then** Stage 4 is skipped (not scheduled) and downstream stages proceed normally

**Given** `route-designer.control.designerAgent` is `null`  
**When** the DAG scheduler reaches Stage 6B (design)  
**Then** Stage 6B is skipped and downstream stages proceed normally

**Given** `check-prototype.control.needed` is `false`  
**When** the DAG scheduler reaches Stage 6.5B (prototype)  
**Then** Stage 6.5B is skipped and downstream stages proceed normally

### AC-12: Artifact Bundle Production

**Given** any stage completes successfully  
**When** the run directory is inspected at `.pi/workflows/<run-id>/`  
**Then** the stage has produced at minimum a `control.json` file and an `analysis.md` file

---

## Open Questions

### OQ-01: Loop `until` Syntax

Does pi-workflow support JSONPath-style conditions like `$.gate.pass === true`, or does it use a different syntax (e.g., JavaScript expressions, jmespath)? This affects all 6 loop stage definitions.

**Impact**: High — all loop stages depend on correct `until` syntax  
**Resolution**: Validate with scaffold examples from `pi-workflow/skills/workflow-guide/scaffolds/`

### OQ-02: Conditional Stage Skip Mechanism

How does pi-workflow handle a stage with `when: false` at runtime? Specifically:
- Is it marked as "skipped" in `run.json`?
- Does it produce any control output (empty object, null)?
- How do downstream stages with `sourcePolicy: "partial"` resolve missing sources?

**Impact**: High — affects debug, design, prototype, and merge stages  
**Resolution**: Test with `/workflow validate` using a minimal conditional stage

### OQ-03: Worktree Creation Responsibility

Does pi-workflow auto-create a managed worktree (via `worktreePolicy` field), or must the setup stage do it manually via bash commands?

**Impact**: Medium — affects setup stage implementation  
**Resolution**: Check pi-workflow docs for `worktreePolicy` field support

### OQ-04: Runtime Task Input

How does the user's runtime task string reach the `classify-task` helper? Possible mechanisms:
- Via `options` parameter in the helper call
- Via `context.task` in the helper context
- Via a special `input` stage artifact

**Impact**: Medium — affects classify-task helper implementation  
**Resolution**: Check pi-workflow helper API documentation

### OQ-05: Dynamic Controller Agent Routing

Can a dynamic controller specify different agent types per `ctx.agent()` call within a single dynamic stage? (Confirmed yes from usage docs, but needs validation in practice)

**Impact**: High — Stage 9 depends on per-phase specialist routing  
**Resolution**: Already confirmed in pi-workflow usage docs; validate with test run

---

## Constraints

1. **No Dynamic Workflow port**: Must NOT port `workflows/super-dev.workflow.js` — this is a declarative spec, not imperative JS
2. **No deprecated team scaffolding**: Must NOT use `TeamCreate`/`TeamDelete`
3. **No tracking JSON**: Engine manages state — no manual `tracking.json` files
4. **No imperative retry logic**: Engine handles retries — no `agentWithRetry` patterns
5. **pi-workflow schema subset only**: No `$ref`, `$defs`, `definitions`, `pattern` in control schemas
6. **Agent context isolation**: Agents never see each other's full context

---

## Dependencies

| Dependency | Type | Purpose |
|---|---|---|
| `@agwab/pi-workflow` | runtime | Workflow engine, DAG scheduler, stage types |
| `@earendil-works/pi-coding-agent` | peer | Pi runtime host |
| `super-dev-plugin/skills/super-dev/SKILL.md` | reference | Source of truth for pipeline behavior |
| `pi-workflow/docs/usage.md` | reference | Spec format, stage types, DAG rules |
| `pi-workflow/workflows/deep-research/spec.json` | reference | Loop + foreach + reduce + support patterns |
| `pi-workflow/workflows/deep-review/spec.json` | reference | Foreach + support pipeline patterns |

---

## Implementation Phases

| Phase | Scope | Key Deliverables |
|---|---|---|
| 1 | Foundation | `package.json`, `tsconfig.json`, `src/extension.ts`, `README.md` |
| 2 | Agents | 21 agent markdown definitions |
| 3 | Schemas | 17 control schema JSON files |
| 4 | Helpers | 10 support helper `.mjs` files |
| 5 | Workflow Spec | `workflows/super-dev/spec.json` (main deliverable) |
| 6 | Dynamic Controller | `implementation-controller.mjs` (Stage 9) |
| 7 | Skill + Integration | `SKILL.md`, `usage.md`, validation pass |
