# Technical Specification: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 06-specification.md  
**Created**: 2026-07-03  
**Status**: Final  

---

## 1. Module Architecture

### 1.1 Package Layout

```
pi-super-dev/
├── package.json                          # Pi extension registration + npm metadata
├── tsconfig.json                         # ES2022, NodeNext, strict
├── src/
│   └── extension.ts                      # Minimal extension entry point
├── agents/                               # 21 agent markdown definitions
│   ├── orchestrator.md
│   ├── requirements-clarifier.md
│   ├── bdd-scenario-writer.md
│   ├── research-agent.md
│   ├── debug-analyzer.md
│   ├── code-assessor.md
│   ├── architecture-designer.md
│   ├── architecture-improver.md
│   ├── ui-ux-designer.md
│   ├── product-designer.md
│   ├── prototype-runner.md
│   ├── spec-writer.md
│   ├── spec-reviewer.md
│   ├── tdd-guide.md
│   ├── implementer.md
│   ├── qa-agent.md
│   ├── code-reviewer.md
│   ├── adversarial-reviewer.md
│   ├── docs-executor.md
│   ├── handoff-writer.md
│   └── build-cleaner.md
├── workflows/
│   └── super-dev/
│       ├── spec.json                     # Two-stage artifact graph (setup + dynamic pipeline)
│       ├── schemas/                      # 17 control schema JSON files
│       │   ├── super-dev-setup-control.schema.json
│       │   ├── super-dev-classify-task-control.schema.json
│       │   ├── super-dev-requirements-control.schema.json
│       │   ├── super-dev-gate-verdict.schema.json
│       │   ├── super-dev-bdd-control.schema.json
│       │   ├── super-dev-research-control.schema.json
│       │   ├── super-dev-debug-control.schema.json
│       │   ├── super-dev-assessment-control.schema.json
│       │   ├── super-dev-route-designer-control.schema.json
│       │   ├── super-dev-design-control.schema.json
│       │   ├── super-dev-check-prototype-control.schema.json
│       │   ├── super-dev-spec-control.schema.json
│       │   ├── super-dev-spec-review-control.schema.json
│       │   ├── super-dev-implementation-control.schema.json
│       │   ├── super-dev-code-review-control.schema.json
│       │   ├── super-dev-docs-control.schema.json
│       │   └── super-dev-cleanup-control.schema.json
│       └── helpers/                      # 12 support helpers + 1 dynamic controller
│           ├── classify-task.mjs
│           ├── route-designer.mjs
│           ├── route-specialist.mjs
│           ├── check-prototype-needed.mjs
│           ├── gate-requirements.mjs
│           ├── gate-bdd.mjs
│           ├── gate-spec-trace.mjs
│           ├── gate-spec-review.mjs
│           ├── gate-build.mjs
│           ├── gate-review.mjs
│           ├── merge-review-verdicts.mjs
│           ├── cleanup.mjs
│           └── implementation-controller.mjs
├── skills/
│   └── super-dev/
│       └── SKILL.md
├── docs/
│   └── usage.md
├── LICENSE
└── README.md
```

### 1.2 Key Design Decision: Hybrid Setup + Dynamic (ADR-1)

pi-workflow v1 has **no native `when` field** for conditional stage execution and **prohibits `support` children inside `loop` stages**. The super-dev pipeline requires both. Therefore the spec.json uses a **two-stage hybrid**:

1. **`setup`** — Declarative `single` stage that bootstraps the worktree and detects the project
2. **`pipeline`** — A `dynamic` stage whose controller (`implementation-controller.mjs`) orchestrates the remaining 12 pipeline phases programmatically

This gives full flexibility for conditional logic, iteration loops with gate checks, agent routing, and per-phase git commits — while still benefiting from engine-managed run persistence, resume, and progress UI.

Cross-references: ADR-1 in 05-architecture.md; Section 14 of 03-research-report.md.

---

## 2. Module Interfaces

### 2.1 extension.ts

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entry point for the super-dev workflow plugin.
 * Workflow spec and agents are auto-discovered by pi-workflow engine
 * from the package's `workflows/` and `agents/` directories.
 */
export default function superDevExtension(_pi: ExtensionAPI): void {
  // Registration is handled by pi-workflow's auto-discovery.
  // This file exists solely to satisfy the pi.extensions entry.
}
```

**Input**: `ExtensionAPI` from the pi-coding-agent runtime  
**Output**: void (no explicit registrations needed — pi-workflow discovers workflows and agents from the package layout)  
**Validates**: SCENARIO-006, SCENARIO-007 (AC-03)

### 2.2 spec.json Top-Level Structure

```typescript
interface WorkflowSpec {
  schemaVersion: 1;
  name: "super-dev";
  description: string;
  defaults: {
    maxRuntimeMs: 14400000;       // 4 hours
    readOnly: false;
    tools: string[];              // Default tool ceiling
  };
  input: {
    task: string;                 // Runtime task from user
    skipWorktree: boolean;        // Skip worktree creation
    skipStages: string[];         // Stages to skip
  };
  artifactGraph: {
    stages: [SetupStage, PipelineStage];
  };
}
```

**Validates**: SCENARIO-003, SCENARIO-091 (AC-02, FR-02)

### 2.3 Helper Interface Contract

All 12 support helpers conform to this signature:

```typescript
type HelperInput = {
  sources: Record<string, unknown>;   // Upstream stage control data keyed by stage id
  options?: Record<string, unknown>;  // From spec support.options or controller call
  context: {
    specPath: string;                 // Path to spec.json
    cwd: string;                      // Working directory
    runId: string;                    // Current run identifier
  };
};

type HelperOutput = {
  schema: "helper-output-v1";
  digest: string;                     // One-line human-readable summary
  value: Record<string, unknown>;     // Structured control data
};

type Helper = (input: HelperInput) => Promise<HelperOutput>;
```

**Validates**: SCENARIO-019 (AC-06)

### 2.4 Dynamic Controller Interface

```typescript
type DynamicControllerContext = {
  task: string;                       // Runtime task string
  sources: { setup: SetupControl };   // Upstream stage data
  phase(name: string): void;          // Declare current phase for UI
  agent(opts: {
    id: string;
    agent: string;
    prompt: string;
    tools?: string[];
  }): Promise<AgentResult>;
  helper(name: string, input: HelperInput): Promise<HelperOutput>;
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;
  budget: {
    check(): boolean;
    remaining(): { agents: number; concurrency: number };
  };
  log(...args: unknown[]): void;
};

type DynamicController = (ctx: DynamicControllerContext) => Promise<void>;
```

**Validates**: SCENARIO-050 through SCENARIO-057 (AC-10, FR-08)

---

## 3. Stage Specifications

### 3.1 Stage 1: Setup

| Field | Value |
|-------|-------|
| id | `setup` |
| type | `single` |
| agent | `orchestrator` |
| tools | `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit` |
| readOnly | `false` |
| output.controlSchema | `./schemas/super-dev-setup-control.schema.json` |

**Purpose**: Create git worktree, spec directory, detect project language/framework.

**Control Output**:
```json
{
  "worktreePath": "/absolute/path/to/worktree",
  "specDirectory": "/absolute/path/to/worktree/docs/specifications/<spec-id>/",
  "defaultBranch": "main",
  "language": "rust" | "go" | "frontend" | "backend" | "mixed",
  "isWebUi": false,
  "specIdentifier": "01-feature-name"
}
```

**Validates**: SCENARIO-040, SCENARIO-041, SCENARIO-067, SCENARIO-071 (AC-08, AC-12, FR-10)

### 3.2 Stage 2 (Pipeline — Dynamic Controller)

| Field | Value |
|-------|-------|
| id | `pipeline` |
| type | `dynamic` |
| from | `setup` |
| dynamic.uses | `./helpers/implementation-controller.mjs` |
| dynamic.mode | `graph-splice` |
| dynamic.permissions.approval | `auto` |
| dynamic.budget.maxAgents | `200` |
| dynamic.budget.maxConcurrency | `3` |
| dynamic.budget.maxRuntimeMs | `12000000` |

The dynamic controller orchestrates pipeline phases 2-13. Each phase uses stable task IDs for resume support:

```
pipeline.classify-task
pipeline.requirements.r01.write
pipeline.requirements.r01.gate
pipeline.requirements.r02.write
pipeline.requirements.r02.gate
pipeline.bdd.r01.write
...
pipeline.implementation.phase-01.tdd
pipeline.implementation.phase-01.implement
pipeline.implementation.phase-01.qa
pipeline.implementation.phase-01.gate
...
pipeline.code-review.r01.review
pipeline.code-review.r01.adversarial
pipeline.code-review.r01.merge
pipeline.code-review.r01.fix
...
pipeline.docs
pipeline.cleanup
pipeline.merge
```

**Validates**: SCENARIO-042, SCENARIO-054, SCENARIO-082 through SCENARIO-084 (AC-08, AC-10, NFR-07)

---

## 4. Dynamic Controller Internal Stages

The `implementation-controller.mjs` orchestrates the following pipeline within a single `dynamic` stage. Each internal phase maps to the original 13-stage pipeline.

### 4.1 Classify Task (Phase 2A)

```javascript
ctx.phase("Stage 2A — Classify Task");
const classification = await ctx.helper("classify-task", {
  sources: { setup: ctx.sources.setup },
  options: { runtimeTask: ctx.task }
});
// classification.value = { taskType, uiScope, language, isWebUi, skipStages }
```

**Validates**: SCENARIO-023 through SCENARIO-025 (AC-06)

### 4.2 Requirements Loop (Phase 2B, max 3 rounds)

```javascript
ctx.phase("Stage 2B — Requirements");
let reqResult;
for (let round = 1; round <= 3; round++) {
  reqResult = await ctx.agent({
    id: `pipeline.requirements.r${String(round).padStart(2,'0')}.write`,
    agent: "requirements-clarifier",
    prompt: buildRequirementsPrompt(ctx.sources.setup, classification, ctx.task),
  });
  const gate = await ctx.helper("gate-requirements", {
    sources: { "write-requirements": reqResult.control }
  });
  if (gate.value.pass) break;
  if (round === 3) ctx.log("requirements: exhausted after 3 rounds");
}
```

**Validates**: SCENARIO-043 through SCENARIO-045 (AC-09)

### 4.3 BDD Loop (Phase 2C, max 3 rounds)

Same pattern as requirements. Agent: `bdd-scenario-writer`. Gate: `gate-bdd`.

**Validates**: SCENARIO-044 (AC-09)

### 4.4 Research Loop (Phase 3, max 3 rounds)

Same loop pattern. Agent: `research-agent`. Terminates when `openIssues.length === 0`.

**Validates**: SCENARIO-046 (AC-09)

### 4.5 Debug Analysis (Phase 4, conditional)

```javascript
if (classification.value.taskType === "bug") {
  ctx.phase("Stage 4 — Debug Analysis");
  debugResult = await ctx.agent({
    id: "pipeline.debug",
    agent: "debug-analyzer",
    prompt: buildDebugPrompt(...)
  });
}
// Otherwise: debugResult = null (skipped)
```

**Validates**: SCENARIO-058, SCENARIO-059 (AC-11)

### 4.6 Code Assessment (Phase 5)

```javascript
ctx.phase("Stage 5 — Code Assessment");
const assessment = await ctx.agent({
  id: "pipeline.assessment",
  agent: "code-assessor",
  prompt: buildAssessmentPrompt(ctx.sources.setup, research, debugResult)
});
```

### 4.7 Design Routing + Design (Phase 6)

```javascript
ctx.phase("Stage 6 — Design");
const routing = await ctx.helper("route-designer", {
  sources: { "classify-task": classification.value }
});

let designResult = null;
if (routing.value.designerAgent) {
  designResult = await ctx.agent({
    id: "pipeline.design",
    agent: routing.value.designerAgent,
    prompt: buildDesignPrompt(...)
  });
}
```

**Validates**: SCENARIO-026, SCENARIO-027, SCENARIO-060, SCENARIO-061 (AC-06, AC-11)

### 4.8 Prototype Check + Loop (Phase 6.5, conditional)

```javascript
let protoResult = null;
if (designResult) {
  const check = await ctx.helper("check-prototype-needed", {
    sources: { design: designResult.control }
  });
  if (check.value.needed) {
    ctx.phase("Stage 6.5 — Prototype");
    for (let round = 1; round <= 3; round++) {
      protoResult = await ctx.agent({
        id: `pipeline.prototype.r${String(round).padStart(2,'0')}`,
        agent: "prototype-runner",
        prompt: buildPrototypePrompt(...)
      });
      // Gate check on measurement validation
      if (protoResult.control.verdict === "pass") break;
    }
  }
}
```

**Validates**: SCENARIO-030, SCENARIO-031, SCENARIO-062, SCENARIO-063 (AC-06, AC-11)

### 4.9 Specification Loop (Phase 7, max 3 rounds)

Agent: `spec-writer`. Gate: `gate-spec-trace`. Receives all upstream artifacts.

**Validates**: SCENARIO-045 (AC-09)

### 4.10 Spec Review Loop (Phase 8, max 3 rounds)

Agent: `spec-reviewer`. Gate: `gate-spec-review`. Checks verdict and dimension scores.

**Validates**: SCENARIO-045 (AC-09)

### 4.11 Implementation (Phase 9, per-phase TDD)

```javascript
ctx.phase("Stage 9 — Implementation");
const phases = specResult.control.phases;
for (const [idx, phase] of phases.entries()) {
  const phaseId = `phase-${String(idx + 1).padStart(2, '0')}`;
  let attempts = 0;
  let phaseGreen = false;

  while (attempts < 3 && !phaseGreen) {
    attempts++;
    // 1. TDD: write failing tests
    await ctx.agent({
      id: `pipeline.implementation.${phaseId}.tdd.a${attempts}`,
      agent: "tdd-guide",
      prompt: buildTddPrompt(phase, specResult)
    });

    // 2. Route specialist and implement
    const specialist = await ctx.helper("route-specialist", {
      sources: { "classify-task": classification.value },
      options: { phase }
    });
    await ctx.agent({
      id: `pipeline.implementation.${phaseId}.implement.a${attempts}`,
      agent: "implementer",
      prompt: buildImplementPrompt(phase, specialist.value, classification.value.language)
    });

    // 3. QA: verify tests pass
    const qa = await ctx.agent({
      id: `pipeline.implementation.${phaseId}.qa.a${attempts}`,
      agent: "qa-agent",
      prompt: buildQaPrompt(phase)
    });

    // 4. Gate: validate build
    const gate = await ctx.helper("gate-build", {
      sources: { "qa-check": qa.control }
    });
    phaseGreen = gate.value.pass;
  }

  if (!phaseGreen) {
    ctx.log(`Implementation phase ${phaseId} failed after 3 attempts`);
    break; // Early termination
  }
  // 5. Git commit phase changes
  await ctx.agent({
    id: `pipeline.implementation.${phaseId}.commit`,
    agent: "orchestrator",
    prompt: `Commit all changes for implementation phase: ${phase.name}`
  });
}
```

**Validates**: SCENARIO-050 through SCENARIO-057 (AC-10, NFR-08)

### 4.12 Code Review Loop (Phase 10, max 3 rounds)

```javascript
ctx.phase("Stage 10 — Code Review");
for (let round = 1; round <= 3; round++) {
  const rId = String(round).padStart(2, '0');
  // Parallel: code-reviewer + adversarial-reviewer
  const [codeReview, adversarial] = await ctx.parallel([
    () => ctx.agent({
      id: `pipeline.code-review.r${rId}.review`,
      agent: "code-reviewer",
      prompt: buildCodeReviewPrompt(...)
    }),
    () => ctx.agent({
      id: `pipeline.code-review.r${rId}.adversarial`,
      agent: "adversarial-reviewer",
      prompt: buildAdversarialPrompt(...)
    })
  ]);

  // Merge verdicts
  const merged = await ctx.helper("merge-review-verdicts", {
    sources: {
      "code-review": codeReview.control,
      "adversarial-review": adversarial.control
    }
  });

  if (merged.value.verdict === "Approved" || merged.value.verdict === "Approved with Comments") {
    break; // Loop terminates
  }

  // Fix issues
  if (round < 3) {
    await ctx.agent({
      id: `pipeline.code-review.r${rId}.fix`,
      agent: "implementer",
      prompt: buildFixPrompt(merged.value.findings)
    });
  }
}
```

**Validates**: SCENARIO-047, SCENARIO-048, SCENARIO-078 through SCENARIO-081 (AC-09, FR-09)

### 4.13 Documentation (Phase 11)

```javascript
ctx.phase("Stage 11 — Documentation");
await ctx.agent({
  id: "pipeline.docs",
  agent: "docs-executor",
  prompt: buildDocsPrompt(...)
});
```

### 4.14 Cleanup (Phase 12)

```javascript
ctx.phase("Stage 12 — Cleanup");
const cleanupResult = await ctx.helper("cleanup", {
  sources: { docs: docsResult.control },
  context: { cwd: ctx.sources.setup.worktreePath }
});
```

### 4.15 Merge (Phase 13, conditional)

```javascript
if (!cleanupResult.value.blocked) {
  ctx.phase("Stage 13 — Merge");
  await ctx.agent({
    id: "pipeline.merge",
    agent: "orchestrator",
    prompt: buildMergePrompt(ctx.sources.setup)
  });
}
```

**Validates**: SCENARIO-064, SCENARIO-065 (AC-11)

---

## 5. Control Schema Specifications

### 5.1 Schema Design Rules

All schemas:
- Top-level `"type": "object"` with `"required"` array
- Use only: `type`, `required`, `properties`, `items`, `enum`, `const`, bounds (`minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`), `additionalProperties`
- No `$ref`, `$defs`, `definitions`, or `pattern`
- File naming: `super-dev-<stage-id>-control.schema.json`

**Validates**: SCENARIO-013 through SCENARIO-018 (AC-05)

### 5.2 Schema Catalog (17 schemas)

#### super-dev-setup-control.schema.json

```json
{
  "type": "object",
  "required": ["worktreePath", "specDirectory", "language", "specIdentifier"],
  "additionalProperties": false,
  "properties": {
    "worktreePath": { "type": "string", "minLength": 1 },
    "specDirectory": { "type": "string", "minLength": 1 },
    "defaultBranch": { "type": "string" },
    "language": { "type": "string", "enum": ["rust", "go", "frontend", "backend", "mixed"] },
    "isWebUi": { "type": "boolean" },
    "specIdentifier": { "type": "string", "minLength": 1 }
  }
}
```

#### super-dev-classify-task-control.schema.json

```json
{
  "type": "object",
  "required": ["taskType", "uiScope", "language"],
  "additionalProperties": false,
  "properties": {
    "taskType": { "type": "string", "enum": ["bug", "feature", "refactor"] },
    "uiScope": { "type": "string", "enum": ["none", "ui-only", "ui+arch"] },
    "language": { "type": "string" },
    "isWebUi": { "type": "boolean" },
    "skipStages": { "type": "array", "items": { "type": "string" } }
  }
}
```

#### super-dev-requirements-control.schema.json

```json
{
  "type": "object",
  "required": ["docPath", "featureName", "acCount"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "featureName": { "type": "string", "minLength": 1 },
    "acCount": { "type": "integer", "minimum": 1 },
    "openQuestions": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-gate-verdict.schema.json (shared by all 6 gate helpers)

```json
{
  "type": "object",
  "required": ["pass", "gate"],
  "additionalProperties": false,
  "properties": {
    "pass": { "type": "boolean" },
    "gate": { "type": "string", "minLength": 1 },
    "errors": { "type": "array", "items": { "type": "string" } }
  }
}
```

#### super-dev-bdd-control.schema.json

```json
{
  "type": "object",
  "required": ["docPath", "scenarioCount"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "scenarioCount": { "type": "integer", "minimum": 1 },
    "edgeCasesCovered": { "type": "boolean" },
    "coverageScore": { "type": "number", "minimum": 0, "maximum": 1 },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-research-control.schema.json

```json
{
  "type": "object",
  "required": ["docPath"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "options": { "type": "array", "items": { "type": "object" } },
    "openIssues": { "type": "array", "items": { "type": "string" } },
    "iteration": { "type": "integer", "minimum": 1 },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-debug-control.schema.json

```json
{
  "type": "object",
  "required": ["docPath", "hypotheses"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "hypotheses": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
    "rootCause": { "type": "string" },
    "reproductionSteps": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-assessment-control.schema.json

```json
{
  "type": "object",
  "required": ["docPath", "patterns"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "patterns": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
    "filesAssessed": { "type": "integer", "minimum": 0 },
    "recommendations": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-route-designer-control.schema.json

```json
{
  "type": "object",
  "required": ["designerAgent", "reason"],
  "additionalProperties": false,
  "properties": {
    "designerAgent": { "type": ["string", "null"] },
    "reason": { "type": "string", "minLength": 1 }
  }
}
```

#### super-dev-design-control.schema.json

```json
{
  "type": "object",
  "required": ["designer", "modules"],
  "additionalProperties": false,
  "properties": {
    "designer": { "type": "string" },
    "docs": { "type": "array", "items": { "type": "string" } },
    "modules": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
    "hasNumericConstants": { "type": "boolean" },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-check-prototype-control.schema.json

```json
{
  "type": "object",
  "required": ["needed"],
  "additionalProperties": false,
  "properties": {
    "needed": { "type": "boolean" },
    "constants": { "type": "array", "items": { "type": "string" } }
  }
}
```

#### super-dev-spec-control.schema.json

```json
{
  "type": "object",
  "required": ["specificationPath", "phaseCount", "phases"],
  "additionalProperties": false,
  "properties": {
    "specificationPath": { "type": "string", "minLength": 1 },
    "planPath": { "type": "string" },
    "tasksPath": { "type": "string" },
    "phaseCount": { "type": "integer", "minimum": 1 },
    "phases": { "type": "array", "items": { "type": "object" }, "minItems": 1 },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-spec-review-control.schema.json

```json
{
  "type": "object",
  "required": ["verdict"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string" },
    "verdict": { "type": "string", "enum": ["Approved", "Approved with Comments", "Changes Requested"] },
    "findings": { "type": "array", "items": { "type": "object" } },
    "dimensionsScored": { "type": "array", "items": { "type": "object" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-implementation-control.schema.json

```json
{
  "type": "object",
  "required": ["phasesCompleted", "totalPhases", "allGreen"],
  "additionalProperties": false,
  "properties": {
    "phasesCompleted": { "type": "integer", "minimum": 0 },
    "totalPhases": { "type": "integer", "minimum": 1 },
    "allGreen": { "type": "boolean" },
    "filesModified": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-code-review-control.schema.json

```json
{
  "type": "object",
  "required": ["verdict"],
  "additionalProperties": false,
  "properties": {
    "verdict": { "type": "string", "enum": ["Approved", "Approved with Comments", "Changes Requested"] },
    "findings": { "type": "array", "items": { "type": "object" } },
    "dimensionsCovered": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-docs-control.schema.json

```json
{
  "type": "object",
  "required": ["docsUpdated"],
  "additionalProperties": false,
  "properties": {
    "docsUpdated": { "type": "boolean" },
    "specDirFilesReviewed": { "type": "array", "items": { "type": "string" } },
    "deviationsDocumented": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

#### super-dev-cleanup-control.schema.json

```json
{
  "type": "object",
  "required": ["blocked"],
  "additionalProperties": false,
  "properties": {
    "languagesDetected": { "type": "array", "items": { "type": "string" } },
    "directoriesRemoved": { "type": "array", "items": { "type": "string" } },
    "sensitiveDataFindings": { "type": "array", "items": { "type": "string" } },
    "blocked": { "type": "boolean" },
    "summary": { "type": "string" }
  }
}
```

---

## 6. Helper Specifications

### 6.1 Gate Helpers (6)

All gate helpers share the same output contract (validated by `super-dev-gate-verdict.schema.json`):

```typescript
type GateOutput = {
  pass: boolean;
  gate: string;       // Gate identifier (e.g., "gate-requirements")
  errors: string[];   // Empty on pass; human-readable failure descriptions on fail
};
```

#### gate-requirements.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"write-requirements"` |
| Validates | `docPath` exists (non-null, non-empty), `acCount >= 1`, `summary` present, `featureName` non-empty |
| Pass condition | All validations pass |
| **Validates** | SCENARIO-020, SCENARIO-021, SCENARIO-022 |

#### gate-bdd.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"write-bdd"` |
| Validates | `docPath` exists, `scenarioCount >= 1`, `edgeCasesCovered === true` or `coverageScore >= 0.6` |
| Pass condition | All validations pass |
| **Validates** | SCENARIO-032, SCENARIO-088 |

#### gate-spec-trace.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"write-spec"` |
| Validates | `specificationPath` exists, `phaseCount >= 1`, `phases` array non-empty, each phase has name |
| Pass condition | All validations pass |
| **Validates** | SCENARIO-045 |

#### gate-spec-review.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"review-spec"` |
| Validates | `verdict` is "Approved" or "Approved with Comments" |
| Pass condition | Verdict is acceptable |
| **Validates** | SCENARIO-045 |

#### gate-build.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"qa-check"` |
| Validates | `allTestsPass === true`, `buildSuccess === true` |
| Pass condition | Both true |
| **Validates** | SCENARIO-055, SCENARIO-056 |

#### gate-review.mjs

| Aspect | Detail |
|--------|--------|
| Source key | `"merge-verdicts"` |
| Validates | `verdict` is "Approved" or "Approved with Comments" |
| Pass condition | Verdict is acceptable |
| **Validates** | SCENARIO-047, SCENARIO-080 |

### 6.2 Routing Helpers (3)

#### classify-task.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `setup`: `{ worktreePath, language, isWebUi }` |
| Options | `{ runtimeTask: string }` |
| Logic | Regex keyword matching: bug/fix/crash → "bug", refactor/restructure → "refactor", else → "feature". UI scope: `isWebUi` → "ui+arch", else → "none" |
| Output | `{ taskType, uiScope, language, isWebUi, skipStages }` |
| **Validates** | SCENARIO-023, SCENARIO-024, SCENARIO-025 |

#### route-designer.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `classify-task`: `{ taskType, uiScope }` |
| Logic | `bug` → null; `ui+arch` → "product-designer"; `ui-only` → "ui-ux-designer"; `refactor` → "architecture-improver"; `feature` → "architecture-designer" |
| Output | `{ designerAgent: string|null, reason: string }` |
| **Validates** | SCENARIO-026, SCENARIO-027, SCENARIO-089 |

#### route-specialist.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `classify-task`: `{ language }` |
| Options | `{ phase: object }` |
| Logic | Always returns `"implementer"` with language-specific prompt augmentation instructions |
| Output | `{ specialistAgent: "implementer", languageInstructions: string, reason: string }` |
| **Validates** | SCENARIO-028, SCENARIO-029 |

### 6.3 Utility Helpers (3)

#### check-prototype-needed.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `design`: `{ hasNumericConstants, modules }` |
| Logic | Returns `needed: true` if `hasNumericConstants === true` |
| Output | `{ needed: boolean, constants: string[] }` |
| **Validates** | SCENARIO-030, SCENARIO-031 |

#### merge-review-verdicts.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `code-review`: `{ verdict, findings }`, `adversarial-review`: `{ verdict, findings }` |
| Logic | Takes the stricter verdict. "Changes Requested" > "Approved with Comments" > "Approved". Merges findings arrays. |
| Output | `{ verdict, findings, dimensionsCovered }` |
| **Validates** | SCENARIO-079, SCENARIO-080, SCENARIO-081 |

#### cleanup.mjs

| Aspect | Detail |
|--------|--------|
| Sources | `docs`: `{ docsUpdated }` |
| Context | `cwd` = worktree path |
| Logic | Scans for build artifacts, `.env` files, secrets patterns. Returns `blocked: true` if sensitive data found. |
| Output | `{ languagesDetected, directoriesRemoved, sensitiveDataFindings, blocked, summary }` |
| **Validates** | SCENARIO-064 |

---

## 7. Agent Definitions

### 7.1 Frontmatter Format

```yaml
---
name: <kebab-case-id>
description: <one-line role summary>
tools: <comma-separated tool list>
readOnly: <true|false>
---
```

No `model`, `kind`, `max_turns`, or `timeout_mins` fields (Claude Code-specific — not supported by pi-workflow).

**Validates**: SCENARIO-008, SCENARIO-009, SCENARIO-010 (AC-04)

### 7.2 Tool Ceiling Categories

| Category | Tools | readOnly | Agents |
|----------|-------|----------|--------|
| Read-only explorers | `read, grep, find, ls` | true | code-assessor, code-reviewer, adversarial-reviewer, spec-reviewer |
| Researchers | `read, grep, find, ls, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read` | true | research-agent |
| Writers (docs/specs) | `read, grep, find, ls, write, edit` | false | requirements-clarifier, bdd-scenario-writer, architecture-designer, architecture-improver, ui-ux-designer, product-designer, spec-writer, docs-executor, handoff-writer |
| Implementers | `read, grep, find, ls, write, edit, bash` | false | orchestrator, prototype-runner, tdd-guide, implementer |
| QA/Build | `read, grep, find, ls, bash` | true | debug-analyzer, qa-agent, build-cleaner |

**Validates**: SCENARIO-011, SCENARIO-012 (AC-04)

### 7.3 Agent Porting Rules

When adapting from `super-dev-plugin/agents/*.md`:

1. **Remove**: `model: inherit`, `kind: local`, `max_turns`, `timeout_mins`
2. **Replace**: `tools: "*"` → explicit tool list from ceiling category
3. **Add**: `readOnly` field
4. **Keep**: Full system prompt body with XML-structured sections
5. **Remove**: References to `plugin_root` → replaced by instructions to use paths from control data
6. **Remove**: References to `Skill(skill: "...")` invocations
7. **Remove**: `TeamCreate`/`TeamDelete` references
8. **Remove**: Gate script invocation instructions (gates are helpers now)

---

## 8. Error Handling Strategy

### 8.1 Loop Exhaustion

When a loop reaches `maxRounds` (3) without gate pass:
- The controller logs a warning with `ctx.log()`
- Pipeline continues to the next phase (degraded mode)
- The final run report includes the exhausted loop as a warning

**Validates**: SCENARIO-044, SCENARIO-049 (AC-09, NFR-08)

### 8.2 Implementation Phase Failure

When `gate-build` fails after 3 retry attempts for a single phase:
- The implementation loop terminates early
- Completed phases are preserved (already committed)
- Pipeline proceeds to code-review with partial implementation
- The `implementation-control` output reflects `allGreen: false`

**Validates**: SCENARIO-055, SCENARIO-056 (AC-10)

### 8.3 Budget Exhaustion

Before each `ctx.agent()` call, the controller checks `ctx.budget.check()`:
- If budget is exhausted, the controller terminates gracefully
- A summary is logged explaining which phases completed

**Validates**: SCENARIO-057 (NFR-08)

### 8.4 Helper Input Validation

All helpers validate their `sources` parameter:
- If expected source key is missing: return `{ pass: false, errors: ["Missing upstream: <key>"] }`
- If source data is structurally invalid: return `{ pass: false, errors: ["Invalid <field>"] }`
- No unhandled exceptions — all failures are represented in the return value

**Validates**: SCENARIO-032 (AC-06)

### 8.5 Resume After Interruption

The dynamic controller uses deterministic task IDs (`pipeline.<phase>.r<round>.<operation>`):
- On resume, the engine replays completed operations
- The controller must re-issue calls in the same order
- State (current phase, loop round) is reconstructable from completed task IDs

**Validates**: SCENARIO-082, SCENARIO-083, SCENARIO-084 (NFR-07)

---

## 9. Testing Strategy

### 9.1 Static Validation

| What | How | Validates |
|------|-----|-----------|
| TypeScript compilation | `npm run typecheck` | AC-01 (SCENARIO-001) |
| Workflow spec validation | `/workflow validate super-dev` | AC-02 (SCENARIO-003) |
| Agent discovery | `/workflow agents` (visual inspection) | AC-04 (SCENARIO-008) |
| Schema subset compliance | Manual inspection + `/workflow validate` | AC-05 (SCENARIO-013) |

### 9.2 Unit Tests (Helper Functions)

Each helper can be tested in isolation by importing and invoking with mock sources:

```javascript
import classifyTask from "./helpers/classify-task.mjs";

// Test: bug detection
const result = await classifyTask({
  sources: { setup: { worktreePath: "/tmp/wt", language: "rust", isWebUi: false } },
  options: { runtimeTask: "fix the crash in auth module" },
  context: { cwd: "/tmp", runId: "test-001", specPath: "/tmp/spec.json" }
});
assert(result.value.taskType === "bug");
```

**Validates**: SCENARIO-019 through SCENARIO-032 (AC-06), SCENARIO-088, SCENARIO-089, SCENARIO-090 (NFR-06)

### 9.3 Integration Test (Smoke Run)

Execute `/workflow run super-dev "add a hello world endpoint"` and verify:
1. Setup stage produces valid `control.json`
2. Classify-task correctly identifies "feature"
3. Requirements loop begins without scheduling errors
4. No schema validation failures

**Validates**: SCENARIO-040 (AC-08)

### 9.4 Negative Tests

| Scenario | Expected Result |
|----------|-----------------|
| Missing helper file | `/workflow validate` reports blocker (SCENARIO-004) |
| Missing agent file | `/workflow validate` reports blocker (SCENARIO-005) |
| Schema with `$ref` | Validation rejects (SCENARIO-014) |
| Wildcard tools `["*"]` | Validation warns (SCENARIO-009) |
| Malformed JSON schema | `/workflow validate` reports blocker (SCENARIO-018) |

### 9.5 No-Imperative Audit

Grep the entire codebase for prohibited patterns:
- `agentWithRetry` → zero matches (SCENARIO-085)
- `tracking.json` → zero matches (SCENARIO-086)
- `TeamCreate` / `TeamDelete` → zero matches (SCENARIO-087)

---

## 10. Cross-Reference Matrix

| Requirement | Specification Section | BDD Scenarios |
|-------------|----------------------|---------------|
| FR-01 (Plugin Registration) | §2.1, §2.2 | SCENARIO-001 through SCENARIO-007 |
| FR-02 (13-Stage DAG) | §3, §4 | SCENARIO-040, SCENARIO-042, SCENARIO-091 |
| FR-03 (Agent Definitions) | §7 | SCENARIO-008 through SCENARIO-012 |
| FR-04 (Control Schemas) | §5 | SCENARIO-013 through SCENARIO-018 |
| FR-05 (Support Helpers) | §6 | SCENARIO-019 through SCENARIO-032 |
| FR-06 (Loop Stages) | §4.2, §4.3, §4.4, §4.9, §4.10 | SCENARIO-043 through SCENARIO-049 |
| FR-07 (Conditional Stages) | §4.5, §4.7, §4.8, §4.15 | SCENARIO-058 through SCENARIO-066 |
| FR-08 (Dynamic Stage) | §4.11 | SCENARIO-050 through SCENARIO-057 |
| FR-09 (Parallel Code Review) | §4.12 | SCENARIO-078 through SCENARIO-081 |
| FR-10 (Data Flow) | §4 (prompt injection patterns) | SCENARIO-071 through SCENARIO-074 |
| FR-11 (Skill) | SKILL.md definition | SCENARIO-033 through SCENARIO-039 |
| FR-12 (Artifact Bundles) | §3.2 (engine-managed) | SCENARIO-067 through SCENARIO-070 |
| FR-13 (Source Policy) | §4.5, §4.7 (partial source handling) | SCENARIO-075 through SCENARIO-077 |
| NFR-01 (TypeScript) | §2.1 | SCENARIO-001, SCENARIO-002 |
| NFR-03 (No Imperative) | §9.5 | SCENARIO-085 through SCENARIO-087 |
| NFR-05 (Agent Isolation) | §7.3 | SCENARIO-095, SCENARIO-096 |
| NFR-06 (Deterministic Helpers) | §6 | SCENARIO-088 through SCENARIO-090 |
| NFR-07 (Resume) | §8.5 | SCENARIO-082 through SCENARIO-084 |
| NFR-08 (Performance) | §8.1, §8.2, §8.3 | SCENARIO-049, SCENARIO-057 |

---

## 11. Resolved Open Questions

| OQ | Resolution |
|----|------------|
| OQ-01 (Loop `until` syntax) | pi-workflow uses `{ source, path, equals }` object syntax (not JSONPath expressions). Confirmed in research §3. Since we use dynamic controller, loops are in controller code (simple JS `if`). |
| OQ-02 (Conditional stage skip) | No `when` field exists. Resolved by using dynamic controller with `if` conditionals. Skipped stages simply are not called. |
| OQ-03 (Worktree creation) | `worktreePolicy: "on"` in spec.json requests engine-managed worktree. Additionally, setup agent creates/verifies the worktree. |
| OQ-04 (Runtime task input) | `ctx.task` in the dynamic controller context. Also available as `input.task` in the spec's `input` block. |
| OQ-05 (Dynamic controller agent routing) | Confirmed: `ctx.agent()` accepts different `agent` values per call. Each call can specify a different agent. |
