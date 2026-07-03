# Specification: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Status**: Draft  
**Created**: 2026-07-03  

---

## 1. Overview

### 1.1 Purpose

Create a pi-workflow plugin (`@jenningsloy318/pi-super-dev`) that replicates the super-dev 13-stage development pipeline as a declarative pi-workflow spec. The workflow orchestrates requirements gathering, research, design, specification, implementation, code review, documentation, and merge — all through specialized AI agents coordinated by the pi-workflow engine.

### 1.2 Source of Truth

The authoritative reference is `super-dev-plugin/skills/super-dev/SKILL.md` — the Agent Tool orchestration model where the AI acts as team-lead, spawning specialist agents via `Agent(subagent_type=super-dev:<name>)`.

This plugin translates that prompt-driven orchestration into pi-workflow's **declarative artifact-graph spec** format, gaining:
- Engine-managed DAG scheduling (no manual stage transitions)
- Automatic run persistence (`.pi/workflows/<run-id>/`)
- Built-in resume (`/workflow resume`)
- Progress UI (`/workflow` board)
- Structured artifact bundles per stage (`control.json`, `analysis.md`, `refs.json`)

### 1.3 Non-Goals

- We do NOT port `workflows/super-dev.workflow.js` (the Dynamic Workflow variant)
- We do NOT replicate the imperative retry logic (`agentWithRetry` with 10 retries) — pi-workflow engine handles retries
- We do NOT replicate tracking JSON — pi-workflow engine tracks run state automatically
- We do NOT replicate `TeamCreate`/`TeamDelete` or any deprecated team scaffolding

---

## 2. Architecture

### 2.1 System Context

```
┌──────────────────────────────────────────────────────────────┐
│  Pi Coding Agent (runtime host)                               │
│                                                               │
│  ┌────────────────┐    ┌─────────────────────────────────┐   │
│  │  User request   │───▶│  pi-super-dev plugin             │   │
│  │  "implement X"  │    │                                  │   │
│  └────────────────┘    │  ┌─────────────────────────┐    │   │
│                         │  │  skill: super-dev        │    │   │
│                         │  │  (triggers + dispatch)   │    │   │
│                         │  └───────────┬─────────────┘    │   │
│                         │              │                    │   │
│                         │              ▼                    │   │
│                         │  ┌─────────────────────────┐    │   │
│                         │  │  workflow: super-dev      │    │   │
│                         │  │  (spec.json — 13 stages) │    │   │
│                         │  └───────────┬─────────────┘    │   │
│                         │              │                    │   │
│                         └──────────────┼────────────────────┘   │
│                                        │                         │
│                                        ▼                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  pi-workflow engine                                      │   │
│  │  • DAG scheduler                                         │   │
│  │  • Artifact graph runtime                                │   │
│  │  • Agent backend (subagent launcher)                     │   │
│  │  • Loop controller                                       │   │
│  │  • Dynamic controller (for Stage 9)                      │   │
│  │  • Run store (.pi/workflows/<run-id>/)                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Plugin Directory Structure

```
pi-super-dev/
├── package.json                    # npm package with pi extension registration
├── tsconfig.json                   # TypeScript config (ES2022, NodeNext)
├── src/
│   └── extension.ts                # Pi extension entry (minimal — registers workflow)
├── agents/                         # Agent markdown definitions (role + tool ceiling)
│   ├── orchestrator.md             # Setup/general-purpose orchestration agent
│   ├── requirements-clarifier.md   # Stage 2A: gather requirements
│   ├── bdd-scenario-writer.md      # Stage 2B: write BDD scenarios
│   ├── research-agent.md           # Stage 3: research options
│   ├── debug-analyzer.md           # Stage 4: root-cause analysis
│   ├── code-assessor.md            # Stage 5: codebase pattern discovery
│   ├── architecture-designer.md    # Stage 6: new feature architecture
│   ├── architecture-improver.md    # Stage 6: refactor architecture
│   ├── ui-ux-designer.md           # Stage 6: UI/UX design
│   ├── product-designer.md         # Stage 6: composite architecture+UI
│   ├── prototype-runner.md         # Stage 6.5: validate numeric constants
│   ├── spec-writer.md              # Stage 7: specification + plan + tasks
│   ├── spec-reviewer.md            # Stage 8: review specification
│   ├── tdd-guide.md                # Stage 9.1: write failing tests
│   ├── implementer.md              # Stage 9.2: make tests pass (generic)
│   ├── qa-agent.md                 # Stage 9.5: run tests + verify coverage
│   ├── code-reviewer.md            # Stage 10: standard code review
│   ├── adversarial-reviewer.md     # Stage 10: skeptic/architect/minimalist review
│   ├── docs-executor.md            # Stage 11: update documentation
│   ├── handoff-writer.md           # Stage 11: write session handoff
│   └── build-cleaner.md            # Stage 12: cleanup + sensitive data scan
├── workflows/
│   └── super-dev/
│       ├── spec.json               # The 13-stage workflow spec (artifact graph)
│       ├── schemas/                # Control schemas (one per stage output)
│       │   ├── setup-control.schema.json
│       │   ├── requirements-control.schema.json
│       │   ├── bdd-control.schema.json
│       │   ├── research-control.schema.json
│       │   ├── debug-control.schema.json
│       │   ├── assessment-control.schema.json
│       │   ├── design-route-control.schema.json
│       │   ├── design-control.schema.json
│       │   ├── prototype-control.schema.json
│       │   ├── spec-control.schema.json
│       │   ├── spec-review-control.schema.json
│       │   ├── implementation-phase-control.schema.json
│       │   ├── code-review-control.schema.json
│       │   ├── adversarial-review-control.schema.json
│       │   ├── review-merge-control.schema.json
│       │   ├── docs-control.schema.json
│       │   ├── cleanup-control.schema.json
│       │   └── merge-control.schema.json
│       └── helpers/                # Support stage helpers (.mjs)
│           ├── classify-task.mjs           # Determine bug/feature/refactor
│           ├── route-designer.mjs          # Pick designer agent type
│           ├── route-specialist.mjs        # Pick implementation specialist
│           ├── gate-requirements.mjs       # Validate requirements doc format
│           ├── gate-bdd.mjs                # Validate BDD scenarios format
│           ├── gate-spec-trace.mjs         # Validate spec traceability
│           ├── gate-spec-review.mjs        # Validate spec review verdict
│           ├── gate-build.mjs              # Validate build/tests pass
│           ├── gate-review.mjs             # Validate code review verdict
│           ├── merge-review-verdicts.mjs   # Merge code + adversarial verdicts
│           └── check-prototype-needed.mjs  # Determine if prototype stage runs
├── skills/
│   └── super-dev/
│       └── SKILL.md                # Skill: triggers + dispatch to workflow_run
├── docs/
│   └── usage.md                    # User-facing documentation
├── LICENSE
└── README.md
```

### 2.3 Dependency Graph

```
@jenningsloy318/pi-super-dev
├── peerDependencies:
│   └── @earendil-works/pi-coding-agent (Pi runtime)
└── dependencies:
    └── @agwab/pi-workflow (workflow engine + extension)
```

---

## 3. Workflow Spec Design

### 3.1 Stage Graph (DAG)

```
┌────────┐
│ setup  │  (single — create worktree, spec dir, detect project)
└───┬────┘
    │
    ▼
┌──────────────────┐
│ classify-task    │  (support — determine bug/feature/refactor, language, ui-scope)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ requirements     │  (loop — writer + gate, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ bdd              │  (loop — writer + gate, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ research         │  (loop — initial + deep iterations, max 3 rounds)
└───┬──────────────┘
    │
    ├────────────────────────────┐
    ▼                            ▼
┌──────────────────┐   ┌──────────────────┐
│ debug            │   │ assessment       │
│ (single, cond.)  │   │ (single)         │
└───┬──────────────┘   └───┬──────────────┘
    │                       │
    └───────────┬───────────┘
                ▼
┌──────────────────┐
│ route-designer   │  (support — pick architecture/ui/product/improver)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ design           │  (single — routed agent)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ check-prototype  │  (support — does design have numeric constants?)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ prototype        │  (loop — conditional, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ spec             │  (loop — spec-writer + gate-spec-trace, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ spec-review      │  (loop — spec-reviewer + gate-spec-review, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│ implementation   │  (dynamic — per-phase TDD with specialist routing)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ code-review-loop │  (loop — code-reviewer + adversarial + gate, max 3 rounds)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ docs             │  (single — docs-executor)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ cleanup          │  (support — build-cleaner + sensitive data scan)
└───┬──────────────┘
    │
    ▼
┌──────────────────┐
│ merge            │  (single — trailing commit + merge)
└────────────────────┘
```

### 3.2 Stage Definitions

#### Stage 1: Setup (`single`)

- **Agent**: `orchestrator`
- **Tools**: `read`, `grep`, `find`, `ls`, `bash`, `write`, `edit`
- **readOnly**: false
- **Purpose**: Create worktree (unless `input.skipWorktree`), create spec directory, detect project language/framework
- **Control output**: `{ worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier }`

#### Stage 2A: Classify Task (`support`)

- **Helper**: `./helpers/classify-task.mjs`
- **From**: `setup`
- **Purpose**: Determine `taskType` (bug/feature/refactor), `uiScope` (none/ui-only/ui+arch), parse skip flags
- **Control output**: `{ taskType, uiScope, skipStages, language, isWebUi }`

#### Stage 2B: Requirements (`loop`)

- **maxRounds**: 3
- **until**: `$.gate.pass === true`
- **Child stages**:
  1. `write-requirements` (single, agent: `requirements-clarifier`)
  2. `gate-requirements` (support, helper: `./helpers/gate-requirements.mjs`)
- **From**: `classify-task`
- **Control output**: `{ docPath, featureName, acCount, openQuestions, summary }`

#### Stage 2C: BDD (`loop`)

- **maxRounds**: 3
- **until**: `$.gate.pass === true`
- **Child stages**:
  1. `write-bdd` (single, agent: `bdd-scenario-writer`)
  2. `gate-bdd` (support, helper: `./helpers/gate-bdd.mjs`)
- **From**: `requirements`
- **Control output**: `{ docPath, scenarioCount, edgeCasesCovered, coverageScore, summary }`

#### Stage 3: Research (`loop`)

- **maxRounds**: 3
- **until**: `$.openIssues.length === 0`
- **Child stages**:
  1. `research-pass` (single, agent: `research-agent`)
  2. `check-issues` (support — extracts `openIssues` from research output)
- **From**: `bdd`
- **Control output**: `{ docPath, options, openIssues, iteration }`

#### Stage 4: Debug Analysis (`single`, conditional)

- **Agent**: `debug-analyzer`
- **When**: `classify-task.control.taskType === "bug"`
- **From**: `research`
- **Control output**: `{ docPath, hypotheses, rootCause, reproductionSteps, summary }`
- **Note**: If taskType is not "bug", this stage is skipped by the engine (no scheduling)

#### Stage 5: Code Assessment (`single`)

- **Agent**: `code-assessor`
- **From**: `[research, debug]` (debug optional via `sourcePolicy: "partial"`)
- **Tools**: `read`, `grep`, `find`, `ls` (read-only)
- **readOnly**: true
- **Control output**: `{ docPath, patterns, filesAssessed, recommendations, summary }`

#### Stage 6A: Route Designer (`support`)

- **Helper**: `./helpers/route-designer.mjs`
- **From**: `[classify-task, assessment]`
- **Purpose**: Based on `taskType` and `uiScope`, determine which designer agent to use
- **Control output**: `{ designerAgent, reason }`
  - `architecture-designer` for new features
  - `architecture-improver` for refactors
  - `ui-ux-designer` for UI-only
  - `product-designer` for UI+architecture
  - `null` for bug fixes (skip design)

#### Stage 6B: Design (`single`)

- **Agent**: Determined by `route-designer.control.designerAgent`
- **From**: `[route-designer, assessment, research]`
- **When**: `route-designer.control.designerAgent !== null`
- **Tools**: `read`, `grep`, `find`, `ls`, `write`, `edit`
- **Control output**: `{ designer, docs, modules, hasNumericConstants, summary }`

#### Stage 6.5A: Check Prototype Needed (`support`)

- **Helper**: `./helpers/check-prototype-needed.mjs`
- **From**: `design`
- **Control output**: `{ needed, constants }`

#### Stage 6.5B: Prototype (`loop`, conditional)

- **maxRounds**: 3
- **until**: `$.gate.pass === true`
- **When**: `check-prototype.control.needed === true`
- **Child stages**:
  1. `run-prototype` (single, agent: `prototype-runner`)
  2. `gate-prototype` (support, helper — validates measurement report format)
- **From**: `[check-prototype, design]`
- **Control output**: `{ docPath, constantsTested, verdict, failingConstants, summary }`

#### Stage 7: Specification (`loop`)

- **maxRounds**: 3
- **until**: `$.gate.pass === true`
- **Child stages**:
  1. `write-spec` (single, agent: `spec-writer`)
  2. `gate-spec-trace` (support, helper: `./helpers/gate-spec-trace.mjs`)
- **From**: `[prototype, design, assessment, research, bdd, requirements]` (sourcePolicy: partial)
- **Control output**: `{ specificationPath, planPath, tasksPath, phaseCount, phases, summary }`

#### Stage 8: Spec Review (`loop`)

- **maxRounds**: 3
- **until**: `$.gate.pass === true`
- **Child stages**:
  1. `review-spec` (single, agent: `spec-reviewer`)
  2. `gate-spec-review` (support, helper: `./helpers/gate-spec-review.mjs`)
- **From**: `spec`
- **Control output**: `{ docPath, verdict, findings, dimensionsScored, summary }`

#### Stage 9: Implementation (`dynamic`)

- **Controller**: `./helpers/implementation-controller.mjs`
- **From**: `[spec-review, classify-task]`
- **readOnly**: false
- **Dynamic budget**: `{ maxAgents: 100, maxConcurrency: 2 }`
- **Purpose**: Sequential per-phase TDD pipeline. For each implementation phase:
  1. Spawn `tdd-guide` (write failing tests)
  2. Spawn domain specialist (make tests pass) — agent chosen by `route-specialist.mjs`
  3. Spawn `qa-agent` (verify tests pass, check coverage)
  4. Run gate-build helper (validate build + tests green)
  5. Commit phase changes
- **Control output**: `{ phasesCompleted, totalPhases, allGreen, filesModified, summary }`

**Why `dynamic`**: Stage 9 requires:
- Sequential iteration over an unknown number of phases (determined at Stage 7)
- Per-phase agent routing (language → specialist)
- Per-phase commit to git
- Retry logic within each phase if gate-build fails
- Early termination if a phase cannot be fixed

These cannot be expressed in static `foreach` (which doesn't support retry within items or sequential git commits).

#### Stage 10: Code Review (`loop`)

- **maxRounds**: 3
- **until**: `$.merged.verdict === "Approved" || $.merged.verdict === "Approved with Comments"`
- **Child stages**:
  1. `code-review` (single, agent: `code-reviewer`)
  2. `adversarial-review` (single, agent: `adversarial-reviewer`, `after: []` — parallel with code-review)
  3. `merge-verdicts` (support, helper: `./helpers/merge-review-verdicts.mjs`, from: `[code-review, adversarial-review]`)
  4. `fix-issues` (single, agent: `implementer`, when: merged verdict != Approved — spawns only on failure)
- **From**: `implementation`
- **Control output**: `{ verdict, findings, dimensionsCovered, summary }`

#### Stage 11: Documentation (`single`)

- **Agent**: `docs-executor`
- **From**: `code-review-loop`
- **Tools**: `read`, `grep`, `find`, `ls`, `write`, `edit`
- **Control output**: `{ docsUpdated, specDirFilesReviewed, deviationsDocumented, summary }`

#### Stage 12: Cleanup (`support`)

- **Helper**: `./helpers/cleanup.mjs`
- **From**: `docs`
- **Purpose**: Run build-cleaner logic (detect artifacts, scan for sensitive data)
- **Control output**: `{ languagesDetected, directoriesRemoved, sensitiveDataFindings, blocked, summary }`

#### Stage 13: Merge (`single`)

- **Agent**: `orchestrator`
- **From**: `cleanup`
- **Tools**: `read`, `grep`, `find`, `ls`, `bash`
- **When**: `cleanup.control.blocked === false`
- **Purpose**: Trailing commit + merge to default branch (or output merge instructions)
- **Control output**: `{ commitSha, merged, mergeCommand, summary }`

---

## 4. Agent Definitions

### 4.1 Agent Design Principles

From SKILL.md constraints:
- Agents NEVER see each other's full context — they receive only spec_directory paths and read their own inputs
- Every agent operates within `WORKTREE_PATH` (absolute paths only)
- `doc-validator` agent is replaced by `support` helpers (deterministic gate logic, no LLM needed)
- Domain routing (rust/go/frontend/backend/ios/android/macos/windows) handled by support helper + dynamic controller

### 4.2 Tool Ceilings

| Agent Category | Tools | readOnly |
|---|---|---|
| Read-only explorers | `read`, `grep`, `find`, `ls` | true |
| Researchers | `read`, `grep`, `find`, `ls`, `workflow_web_search`, `workflow_web_fetch_source`, `workflow_web_source_read` | true |
| Writers (docs/specs) | `read`, `grep`, `find`, `ls`, `write`, `edit` | false |
| Implementers | `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` | false |
| QA/Build | `read`, `grep`, `find`, `ls`, `bash` | true |

### 4.3 Agent List with Roles

| Agent | Role | Used In |
|---|---|---|
| `orchestrator` | General setup/merge tasks | Stages 1, 13 |
| `requirements-clarifier` | Elicit requirements with ambiguity detection | Stage 2A |
| `bdd-scenario-writer` | Write Given/When/Then scenarios covering all ACs | Stage 2B |
| `research-agent` | Research options with Firecrawl/web sources | Stage 3 |
| `debug-analyzer` | Hypothesis-driven root cause analysis | Stage 4 |
| `code-assessor` | Pattern/idiom discovery, architecture smell detection | Stage 5 |
| `architecture-designer` | Design new module architecture | Stage 6 |
| `architecture-improver` | Deepen/refactor existing architecture | Stage 6 |
| `ui-ux-designer` | UI/UX specification | Stage 6 |
| `product-designer` | Composite architecture + UI design | Stage 6 |
| `prototype-runner` | Validate numeric design constants empirically | Stage 6.5 |
| `spec-writer` | Write specification + implementation plan + task list | Stage 7 |
| `spec-reviewer` | Review spec for completeness, grounding, anti-patterns | Stage 8 |
| `tdd-guide` | Write failing tests from spec/BDD before implementation | Stage 9 |
| `implementer` | Make tests pass (generic fallback) | Stage 9, 10 |
| `qa-agent` | Run tests, verify coverage, report results | Stage 9 |
| `code-reviewer` | Comprehensive code review (correctness, security, perf) | Stage 10 |
| `adversarial-reviewer` | Challenge from skeptic/architect/minimalist lenses | Stage 10 |
| `docs-executor` | Update documentation to match implementation | Stage 11 |
| `handoff-writer` | Generate session handoff document | Stage 11 |
| `build-cleaner` | Detect artifacts, scan sensitive data | Stage 12 |

---

## 5. Support Helpers

### 5.1 Helper Interface

All helpers follow the pi-workflow helper API:

```javascript
// helpers/<name>.mjs
export default async function helper({ sources, options, context }) {
  // sources: { [stageName]: controlJsonValue }
  // options: from spec support.options
  // context: { cwd, runId, specPath }
  
  return {
    schema: "helper-output-v1",
    digest: "One-line summary of what this helper produced",
    value: { /* control data consumed by downstream stages */ }
  };
}
```

### 5.2 Gate Helpers

Gate helpers validate upstream writer output and return `{ pass, errors }`:

```javascript
// helpers/gate-requirements.mjs
export default async function helper({ sources }) {
  const req = sources["write-requirements"];
  const errors = [];
  
  // Validate: has acceptance criteria
  if (!req.acCount || req.acCount < 1) errors.push("Missing acceptance criteria");
  // Validate: has summary
  if (!req.summary) errors.push("Missing summary section");
  // Validate: doc was actually written
  if (!req.docPath) errors.push("No document path returned");
  
  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-requirements" }
  };
}
```

### 5.3 Routing Helpers

```javascript
// helpers/route-designer.mjs
export default async function helper({ sources }) {
  const { taskType, uiScope } = sources["classify-task"];
  
  let designerAgent = null;
  let reason = "";
  
  if (taskType === "bug") {
    reason = "Bug fixes do not redesign — pivot-protocol owns design changes";
  } else if (uiScope === "ui+arch") {
    designerAgent = "product-designer";
    reason = "Both UI and architecture changes needed";
  } else if (uiScope === "ui-only") {
    designerAgent = "ui-ux-designer";
    reason = "UI-only changes";
  } else if (taskType === "refactor") {
    designerAgent = "architecture-improver";
    reason = "Refactoring existing architecture";
  } else {
    designerAgent = "architecture-designer";
    reason = "New feature requires architecture design";
  }
  
  return {
    schema: "helper-output-v1",
    digest: designerAgent ? `Route to ${designerAgent}` : "Skip design (bug fix)",
    value: { designerAgent, reason }
  };
}
```

### 5.4 Classification Helper

```javascript
// helpers/classify-task.mjs
export default async function helper({ sources, options }) {
  const { worktreePath, language, isWebUi } = sources["setup"];
  const task = options?.runtimeTask ?? "";
  
  // Detect task type from keywords
  const bugKeywords = /\b(bug|fix|broken|crash|error|panic|fail|regression)\b/i;
  const refactorKeywords = /\b(refactor|restructure|improve|cleanup|clean up)\b/i;
  
  const taskType = bugKeywords.test(task) ? "bug"
    : refactorKeywords.test(task) ? "refactor"
    : "feature";
  
  // Detect UI scope (simplified — agent in setup stage provides more detail)
  const uiScope = isWebUi ? "ui+arch" : "none";
  
  return {
    schema: "helper-output-v1",
    digest: `Task: ${taskType}, UI: ${uiScope}, Lang: ${language}`,
    value: { taskType, uiScope, language, isWebUi, skipStages: [] }
  };
}
```

---

## 6. Control Schemas

### 6.1 Design Principles

- Keep `<control>` small and machine-readable
- Detailed reasoning goes in `<analysis>`
- Every schema uses the pi-workflow supported subset: `type`, `required`, `properties`, `items`, `enum`, `const`, bounds, `additionalProperties`
- No `$ref`, `$defs`, `definitions`, or `pattern`

### 6.2 Example: Setup Control Schema

```json
{
  "type": "object",
  "required": ["worktreePath", "specDirectory", "language", "specIdentifier"],
  "additionalProperties": false,
  "properties": {
    "worktreePath": { "type": "string" },
    "specDirectory": { "type": "string" },
    "defaultBranch": { "type": "string" },
    "language": { "type": "string", "enum": ["rust", "go", "frontend", "backend", "mixed"] },
    "isWebUi": { "type": "boolean" },
    "specIdentifier": { "type": "string" }
  }
}
```

### 6.3 Example: Gate Verdict Schema (shared by all gates)

```json
{
  "type": "object",
  "required": ["pass", "gate"],
  "additionalProperties": false,
  "properties": {
    "pass": { "type": "boolean" },
    "gate": { "type": "string" },
    "errors": { "type": "array", "items": { "type": "string" } }
  }
}
```

### 6.4 Example: Requirements Control Schema

```json
{
  "type": "object",
  "required": ["docPath", "featureName", "acCount"],
  "additionalProperties": false,
  "properties": {
    "docPath": { "type": "string" },
    "featureName": { "type": "string" },
    "acCount": { "type": "integer", "minimum": 1 },
    "openQuestions": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

---

## 7. Skill Definition

### 7.1 Skill Behavior

The skill is minimal — it triggers on development-related keywords and dispatches to `workflow_run`:

```markdown
---
name: super-dev
description: 13-stage development pipeline for implementing features, fixing bugs, and refactoring. Orchestrates requirements, research, design, specification, implementation, code review, documentation, and merge through specialized AI agents.
---

# Super Dev

Use this skill when the user asks to implement a feature, fix a bug, refactor code, or do systematic multi-stage development work.

## When to use

Triggers: "implement", "build", "fix bug", "refactor", "add feature", "develop this", "help me build", "optimize performance", "resolve deprecation".

Do NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits.

## Action

Use the `workflow_run` tool:

```text
workflow_run({ workflow: "super-dev", task: "<user's full request>" })
```

Preserve the user's language, file references, and constraints in the task.
```

---

## 8. Implementation Plan

### Phase 1: Foundation (Scaffold)
1. Create `package.json` with pi registration
2. Create `tsconfig.json`
3. Create `src/extension.ts` (minimal Pi extension)
4. Create `README.md` and `LICENSE`

### Phase 2: Agents
1. Port 21 agent markdown definitions from super-dev-plugin
2. Adapt tool ceilings from `["*"]` to explicit tool lists
3. Remove Claude Code-specific frontmatter (`model: inherit`, `kind: local`, `max_turns`, `timeout_mins`)
4. Keep system prompt content intact (the core value)

### Phase 3: Control Schemas
1. Create 17 control schema JSON files
2. Validate against pi-workflow's supported JSON Schema subset
3. Ensure downstream `foreach.from` paths match schema properties

### Phase 4: Support Helpers
1. Implement 10 support helpers (`.mjs`)
2. Gate helpers: requirements, bdd, spec-trace, spec-review, build, review
3. Routing helpers: classify-task, route-designer, route-specialist, check-prototype-needed
4. Merge helpers: merge-review-verdicts

### Phase 5: Workflow Spec
1. Create `workflows/super-dev/spec.json` (the main deliverable)
2. Wire all stages with correct `from` dependencies
3. Configure `loop` stages with `maxRounds` and `until` conditions
4. Configure `dynamic` stage for implementation (Stage 9)
5. Set tool ceilings and readOnly flags per stage

### Phase 6: Dynamic Controller (Stage 9)
1. Create `helpers/implementation-controller.mjs`
2. Implement per-phase TDD loop:
   - Read phase list from upstream spec control
   - For each phase: spawn tdd-guide → specialist → qa-agent
   - Route specialist by language
   - Git commit after each successful phase
   - Retry failed phases (max 3)

### Phase 7: Skill + Integration
1. Create `skills/super-dev/SKILL.md`
2. Create `docs/usage.md`
3. Run `/workflow validate super-dev`
4. Fix all validation warnings

---

## 9. Data Flow Between Stages

### 9.1 Artifact Passing

Each stage receives upstream artifacts via `from` declarations. The pi-workflow engine:
1. Makes upstream `control.json` available in the source manifest
2. Agents can read upstream artifacts via `workflow_artifact` tool
3. Support helpers receive upstream control values in `sources` parameter

### 9.2 Key Data Flows

```
setup.control.worktreePath ──────────────────────▶ ALL downstream stages (via prompt)
setup.control.specDirectory ─────────────────────▶ ALL downstream stages (via prompt)
classify-task.control.taskType ──────────────────▶ debug (when condition)
classify-task.control.taskType ──────────────────▶ route-designer (routing)
classify-task.control.language ──────────────────▶ implementation (specialist routing)
requirements.control.docPath ────────────────────▶ bdd, research, spec
requirements.control.featureName ────────────────▶ bdd, design, spec
bdd.control.docPath ─────────────────────────────▶ research, spec
research.control.docPath ────────────────────────▶ assessment, design, spec
assessment.control.docPath ──────────────────────▶ design, spec
design.control.hasNumericConstants ──────────────▶ check-prototype (condition)
spec.control.phases ─────────────────────────────▶ implementation (foreach items)
spec.control.specificationPath ──────────────────▶ spec-review, implementation, code-review
implementation.control.filesModified ────────────▶ code-review (diff scope)
code-review-loop.control.verdict ────────────────▶ docs (proceed only if approved)
```

---

## 10. Differences from super-dev SKILL.md

### 10.1 What Changes

| SKILL.md Feature | pi-super-dev Approach |
|---|---|
| AI IS the team-lead, makes decisions turn-by-turn | Engine schedules the DAG; decisions encoded in spec + helpers |
| `doc-validator` agent runs gate bash scripts | `support` helpers validate control output deterministically |
| Manual tracking JSON maintenance | Automatic via pi-workflow run record |
| `--skip-worktree` flag | `input.skipWorktree` passed via runtime task |
| `--skip=N,N,N` flag | `input.skipStages` + `when` conditions on stages |
| Worktree enforcement (cd prefix) | Setup stage puts `worktreePath` in control; agents receive it in prompts |
| Writer + Validator "paired spawn" | `loop` stages with writer + gate substages |
| Agent termination management | Engine handles task lifecycle |
| Stage transition protocol | Engine handles automatically |
| Lazy-loaded protocol files | Embedded in agent system prompts |

### 10.2 What Stays the Same

- 13-stage pipeline structure and ordering
- Agent roles and system prompt content
- Gate validation logic (same rules, different execution mechanism)
- Domain routing (same language → specialist mapping)
- Iteration caps (max 3 everywhere)
- Worktree isolation pattern
- Sequential implementation phases
- Parallel code-review + adversarial-review
- Conditional stages (debug for bugs only, prototype for numeric constants only)

---

## 11. Acceptance Criteria

1. **AC-01**: `npm run typecheck` passes with no errors
2. **AC-02**: `/workflow validate super-dev` reports no blockers and no unresolved warnings
3. **AC-03**: `/workflow list` includes `super-dev` with correct description
4. **AC-04**: All 21 agent definitions load without error (discoverable via `/workflow agents`)
5. **AC-05**: All 17 control schemas are valid (supported JSON Schema subset)
6. **AC-06**: All 10 support helpers export a default async function with correct signature
7. **AC-07**: The `super-dev` skill triggers on "implement X" and dispatches to `workflow_run`
8. **AC-08**: A test run of `/workflow run super-dev "add a hello world endpoint"` progresses through at least Stages 1-3 without schema/scheduling errors
9. **AC-09**: Loop stages (requirements, bdd, research, spec, spec-review, code-review) stop correctly on gate pass
10. **AC-10**: Dynamic stage (implementation) spawns correct specialist based on detected language
11. **AC-11**: Conditional stages (debug, prototype) are correctly skipped when conditions are not met
12. **AC-12**: The workflow produces artifact bundles (`control.json`, `analysis.md`, `refs.json`) at every stage

---

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| pi-workflow `loop` stage doesn't support writer+gate pattern exactly | Medium | High | Validate with `/workflow validate`; fall back to `dynamic` if needed |
| `when` conditions may not be supported on all stage types | Medium | Medium | Test with `/workflow validate`; use `support` helper that returns empty/skip if not supported |
| Dynamic controller complexity for Stage 9 | High | High | Start with a minimal controller (2-3 phases max); iterate |
| Agent system prompts too large for pi-workflow context | Low | Medium | Trim prompts to essential instructions; move details to `<analysis>` reading |
| `foreach.from` path into loop output may not resolve correctly | Medium | Medium | Test early with a simple loop → foreach chain |
| Gate helpers may need access to the filesystem (not just control data) | Medium | Medium | Support helpers have full Node.js access — they can read files |

---

## 13. Open Questions

1. **Loop `until` syntax**: Does pi-workflow support JSONPath-style conditions like `$.gate.pass === true`, or does it use a different syntax? → Validate with scaffold examples
2. **Conditional stage skip**: How does pi-workflow handle a stage with `when: false`? Does it mark it as skipped in `run.json`? → Test with `/workflow validate`
3. **Dynamic stage agent routing**: Can a dynamic controller specify different agents per `ctx.agent()` call? → Confirmed yes from usage docs
4. **Worktree in write-capable workflows**: Does pi-workflow auto-create a managed worktree, or must the setup stage do it manually? → Check `worktreePolicy` field
5. **Runtime task as input**: How does the runtime task string reach the `classify-task` helper? → Via `options` or `context.task`

---

## 14. References

- `super-dev-plugin/skills/super-dev/SKILL.md` — Source of truth for 13-stage pipeline
- `pi-workflow/docs/usage.md` — pi-workflow spec format, stage types, DAG rules
- `pi-workflow/workflows/README.md` — Bundle layout, helper API, DAG authoring
- `pi-workflow/skills/workflow-guide/SKILL.md` — Authoring rules and validation checklist
- `pi-workflow/workflows/deep-research/spec.json` — Reference implementation (loop + foreach + reduce + support)
- `pi-workflow/workflows/deep-review/spec.json` — Reference implementation (foreach + support pipeline)
- `pi-workflow/skills/workflow-guide/scaffolds/` — Scaffold templates for common topologies
