# Architecture: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 05-architecture  
**Status**: Draft  
**Created**: 2026-07-03  

---

## 1. Module Decomposition

### 1.1 Package File Tree

```
pi-super-dev/
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
├── src/
│   └── extension.ts
├── agents/
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
│       ├── spec.json
│       ├── schemas/
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
│       │   ├── super-dev-prototype-control.schema.json
│       │   ├── super-dev-spec-control.schema.json
│       │   ├── super-dev-spec-review-control.schema.json
│       │   ├── super-dev-implementation-control.schema.json
│       │   ├── super-dev-code-review-control.schema.json
│       │   ├── super-dev-review-merge-control.schema.json
│       │   ├── super-dev-docs-control.schema.json
│       │   ├── super-dev-cleanup-control.schema.json
│       │   └── super-dev-merge-control.schema.json
│       └── helpers/
│           ├── classify-task.mjs
│           ├── route-designer.mjs
│           ├── route-specialist.mjs
│           ├── gate-requirements.mjs
│           ├── gate-bdd.mjs
│           ├── gate-spec-trace.mjs
│           ├── gate-spec-review.mjs
│           ├── gate-build.mjs
│           ├── gate-review.mjs
│           ├── merge-review-verdicts.mjs
│           ├── check-prototype-needed.mjs
│           ├── cleanup.mjs
│           └── implementation-controller.mjs
├── skills/
│   └── super-dev/
│       └── SKILL.md
└── docs/
    └── usage.md
```

### 1.2 Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `src/extension.ts` | Pi extension entry — registers workflow discovery + skill mapping |
| `agents/*.md` | Agent definitions with tool ceilings and system prompts |
| `workflows/super-dev/spec.json` | Declarative artifact-graph DAG (13 stages) |
| `workflows/super-dev/schemas/` | JSON Schema validation for each stage's control output |
| `workflows/super-dev/helpers/` | Deterministic gate/routing logic (no LLM, `.mjs`) |
| `skills/super-dev/SKILL.md` | Skill trigger → `workflow_run` dispatch |

### 1.3 Interface Contracts Between Modules

```
┌─────────────────┐     registers      ┌──────────────────────┐
│  extension.ts   │───────────────────▶│  pi-workflow engine   │
└─────────────────┘                     └──────────┬───────────┘
                                                   │
                                        discovers  │
                                                   ▼
                                        ┌──────────────────────┐
                                        │  spec.json           │
                                        │  (DAG stages)        │
                                        └───┬──────────┬───────┘
                                            │          │
                              references    │          │  references
                                            ▼          ▼
                              ┌──────────────┐   ┌─────────────────┐
                              │  agents/*.md │   │  helpers/*.mjs  │
                              │  (by name)   │   │  (by path)      │
                              └──────────────┘   └─────────────────┘
                                                        │
                                             validates  │
                                                        ▼
                                              ┌─────────────────┐
                                              │  schemas/*.json  │
                                              └─────────────────┘
```

---

## 2. Plugin Registration

### 2.1 package.json

```json
{
  "name": "@jenningsloy318/pi-super-dev",
  "version": "0.1.0",
  "description": "13-stage development pipeline workflow for Pi — requirements, research, design, specification, TDD implementation, code review, documentation, and merge.",
  "private": false,
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension", "workflow", "pi", "super-dev"],
  "exports": {
    ".": "./dist/index.js",
    "./extension": "./src/extension.ts",
    "./package.json": "./package.json"
  },
  "main": "./dist/index.js",
  "files": [
    "dist",
    "src",
    "agents",
    "workflows",
    "skills",
    "docs/usage.md",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "rm -rf dist && tsc -p tsconfig.json --outDir dist --noEmit false",
    "typecheck": "tsc --noEmit"
  },
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./skills/super-dev"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "dependencies": {
    "@agwab/pi-workflow": "^0.1.2"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "^0.78.0",
    "@earendil-works/pi-coding-agent": "*",
    "@types/node": "^24.0.0",
    "typescript": "^5.0.0"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": false }
  }
}
```

### 2.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### 2.3 extension.ts

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entry point for the super-dev workflow plugin.
 *
 * The pi-workflow engine handles workflow discovery from `workflows/` and
 * agent discovery from `agents/`. This extension is intentionally minimal —
 * registration only.
 */
export default function superDevExtension(_pi: ExtensionAPI): void {
  // Workflow spec and agents are auto-discovered by pi-workflow engine
  // from the package's `workflows/` and `agents/` directories.
  // No explicit registration needed beyond the pi.extensions entry.
}
```

---

## 3. Workflow Spec Design (spec.json)

### 3.1 Critical Constraint: No `when` Field

pi-workflow v1 has **no native `when` field** for conditional stage execution. The research confirmed this. Conditional stages must be handled via:

1. **`dynamic` controller** — programmatic skip logic
2. **Loop with immediate exit** — `until` reads upstream control to skip on first round
3. **Support helper that returns a no-op** — downstream sees empty data and handles gracefully

**Decision**: For the super-dev pipeline, conditional stages (Stage 4: debug-only, Stage 6.5: prototype-only) will be wrapped in the `dynamic` controller at Stage 9 OR handled as zero-or-one `loop` stages. Given that the constraints are simple boolean checks on upstream control, the cleanest approach is:

- Use a **top-level `dynamic` stage** as the pipeline orchestrator that handles all conditional branching, stage routing, and iteration loops.
- Model the _inner_ fixed-pattern sub-pipelines (requirements loop, BDD loop, spec-review loop, code-review loop) as operations within the dynamic controller.

### 3.2 Architecture Decision: Single Dynamic Controller

Given the findings:
1. No `when` field (conditional stages impossible declaratively)
2. Loop children cannot be `support` (gate helpers cannot live inside loops)
3. Domain routing requires runtime decisions
4. Stage 9 requires per-phase sequential iteration with git commits

**The spec.json uses a single `dynamic` stage as the primary pipeline orchestrator.**

This is the recommended pattern from the research report (Section 14): the super-dev pipeline's adaptive nature maps best to `dynamic`.

### 3.3 Complete spec.json Structure

```json
{
  "schemaVersion": 1,
  "name": "super-dev",
  "description": "13-stage development pipeline: requirements, BDD, research, debug analysis, code assessment, architecture design, prototype validation, specification, spec review, TDD implementation, code review, documentation, and merge.",
  "defaults": {
    "maxRuntimeMs": 14400000,
    "readOnly": false,
    "tools": ["read", "grep", "find", "ls", "write", "edit", "bash"]
  },
  "input": {
    "task": "",
    "skipWorktree": false,
    "skipStages": []
  },
  "artifactGraph": {
    "stages": [
      {
        "id": "setup",
        "type": "single",
        "agent": "orchestrator",
        "tools": ["read", "grep", "find", "ls", "bash", "write", "edit"],
        "worktreePolicy": "on",
        "output": {
          "controlSchema": "./schemas/super-dev-setup-control.schema.json",
          "analysis": { "required": true },
          "refs": { "required": true }
        },
        "prompt": "Create the development environment for the runtime task. Steps: (1) Create a git worktree unless input.skipWorktree is true — use a branch name derived from the task. (2) Create a spec directory at `<worktree>/docs/specifications/<spec-id>/`. (3) Detect the project language (rust/go/frontend/backend/mixed) and whether it has web UI. (4) Determine the default git branch. Put machine-readable JSON in <control> with worktreePath, specDirectory, defaultBranch, language, isWebUi, specIdentifier. Put setup reasoning in <analysis>."
      },
      {
        "id": "pipeline",
        "type": "dynamic",
        "from": "setup",
        "dynamic": {
          "uses": "./helpers/implementation-controller.mjs",
          "mode": "graph-splice",
          "permissions": { "approval": "auto" },
          "budget": {
            "maxAgents": 200,
            "maxConcurrency": 3,
            "maxRuntimeMs": 12000000
          }
        }
      }
    ]
  }
}
```

### 3.4 Dynamic Controller Pipeline Stages

The `implementation-controller.mjs` orchestrates the following pipeline internally using `ctx.agent()` and `ctx.helper()`:

| Internal Stage | Type | Agent | Condition |
|---|---|---|---|
| classify-task | helper | — | Always |
| requirements (loop, max 3) | agent + helper | requirements-clarifier + gate | Always |
| bdd (loop, max 3) | agent + helper | bdd-scenario-writer + gate | Always |
| research (loop, max 3) | agent + helper | research-agent + check | Always |
| debug | agent | debug-analyzer | taskType === "bug" |
| assessment | agent | code-assessor | Always |
| route-designer | helper | — | Always |
| design | agent | [routed agent] | designerAgent !== null |
| check-prototype | helper | — | design completed |
| prototype (loop, max 3) | agent + helper | prototype-runner + gate | needed === true |
| spec (loop, max 3) | agent + helper | spec-writer + gate | Always |
| spec-review (loop, max 3) | agent + helper | spec-reviewer + gate | Always |
| implementation (per-phase) | agent×3 | tdd-guide → specialist → qa-agent | Per phase from spec |
| code-review (loop, max 3) | agent×2 + helper | code-reviewer + adversarial-reviewer + merge | Always |
| docs | agent | docs-executor | Always |
| cleanup | helper | — | Always |
| merge | agent | orchestrator | cleanup.blocked === false |

### 3.5 Why Not Pure Declarative DAG

The spec originally envisioned a pure declarative artifact graph. However, the pi-workflow v1 engine constraints make this impractical:

1. **No `when` field** — Stages 4, 6, 6.5, 13 are conditional
2. **No `support` children in loops** — Gate validation cannot live inside `loop` child stages (loop children must be `single` or `reduce` only)
3. **Agent routing** — Stage 6 picks from 4 agents; Stage 9 picks from 8+ specialists
4. **Per-phase git commits** — Stage 9 needs sequential git operations between sub-stages

The hybrid approach (declarative `setup` + dynamic `pipeline`) gives us:
- Engine-managed run persistence and resume
- Progress UI via `ctx.phase()`
- Automatic artifact bundling per `ctx.agent()` call
- Full flexibility for conditional/routing/iteration logic

---

## 4. Agent Definitions Strategy

### 4.1 Agents to Port (21 total)

From `super-dev-plugin/agents/`, porting the core pipeline agents:

| Agent | Source File | Tool Ceiling | readOnly |
|---|---|---|---|
| orchestrator | (new, combines setup/merge) | read, grep, find, ls, write, edit, bash | false |
| requirements-clarifier | requirements-clarifier.md | read, grep, find, ls, write, edit | false |
| bdd-scenario-writer | bdd-scenario-writer.md | read, grep, find, ls, write, edit | false |
| research-agent | research-agent.md | read, grep, find, ls, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read | true |
| debug-analyzer | debug-analyzer.md | read, grep, find, ls, bash | true |
| code-assessor | code-assessor.md | read, grep, find, ls | true |
| architecture-designer | architecture-designer.md | read, grep, find, ls, write, edit | false |
| architecture-improver | architecture-improver.md | read, grep, find, ls, write, edit | false |
| ui-ux-designer | ui-ux-designer.md | read, grep, find, ls, write, edit | false |
| product-designer | product-designer.md | read, grep, find, ls, write, edit | false |
| prototype-runner | prototype-runner.md | read, grep, find, ls, write, edit, bash | false |
| spec-writer | spec-writer.md | read, grep, find, ls, write, edit | false |
| spec-reviewer | spec-reviewer.md | read, grep, find, ls | true |
| tdd-guide | tdd-guide.md | read, grep, find, ls, write, edit, bash | false |
| implementer | dev-executor.md | read, grep, find, ls, write, edit, bash | false |
| qa-agent | qa-agent.md | read, grep, find, ls, bash | true |
| code-reviewer | code-reviewer.md | read, grep, find, ls | true |
| adversarial-reviewer | adversarial-reviewer.md | read, grep, find, ls | true |
| docs-executor | docs-executor.md | read, grep, find, ls, write, edit | false |
| handoff-writer | handoff-writer.md | read, grep, find, ls, write, edit | false |
| build-cleaner | build-cleaner.md | read, grep, find, ls, bash | true |

### 4.2 Agent Frontmatter Format (pi-workflow style)

```yaml
---
name: code-assessor
description: Execute concise, specification-aware assessments of architecture, standards, dependencies, and framework patterns.
tools: read, grep, find, ls
readOnly: true
---
```

**Adaptation rules from super-dev-plugin format:**

1. **Remove**: `model: inherit` (pi-workflow inherits by default)
2. **Remove**: `kind`, `max_turns`, `timeout_mins` (not supported)
3. **Replace**: `tools: "*"` → explicit tool list per ceiling category
4. **Keep**: Full system prompt body (the core value of each agent)
5. **Keep**: XML-structured sections (`<security-baseline>`, `<purpose>`, `<process>`, etc.)
6. **Add**: `readOnly` field matching the tool ceiling category
7. **Remove**: `<input>` fields referencing `plugin_root` — replace with instruction to read from `workflow_artifact` and `context.cwd`

### 4.3 What to Trim from System Prompts

- References to `plugin_root` as an input field → replaced by `spec_directory` from setup control
- References to `Skill(skill: "clarify")` or other skills → replaced by instructions to do the work inline
- References to `TeamCreate`/`TeamDelete` → removed entirely
- Gate script invocation instructions → removed (gates are helpers now)
- Cross-references to other agents → replaced by artifact reading instructions
- Token budget management → removed (engine handles)

---

## 5. Helper Design

### 5.1 Helper Interface Contract

All helpers follow the pi-workflow helper API:

```javascript
/**
 * @param {Object} params
 * @param {Record<string, unknown>} params.sources - Upstream stage control data keyed by stage id
 * @param {Record<string, unknown>} [params.options] - From support.options in spec
 * @param {Object} params.context - Runtime context { specPath, cwd, runId }
 * @returns {Promise<{ schema: string, digest: string, value: object }>}
 */
export default async function helper({ sources, options, context }) {
  return {
    schema: "helper-output-v1",
    digest: "One-line summary",
    value: { /* control data */ }
  };
}
```

### 5.2 Gate Helpers

All gate helpers share the same output shape: `{ pass: boolean, errors: string[], gate: string }`.

#### gate-requirements.mjs

| Input | `sources["write-requirements"]` |
|---|---|
| Validates | docPath exists, acCount >= 1, summary present, featureName non-empty |
| Output | `{ pass, errors, gate: "gate-requirements" }` |

#### gate-bdd.mjs

| Input | `sources["write-bdd"]` |
|---|---|
| Validates | docPath exists, scenarioCount >= 1, each scenario has Given/When/Then |
| Output | `{ pass, errors, gate: "gate-bdd" }` |

#### gate-spec-trace.mjs

| Input | `sources["write-spec"]` |
|---|---|
| Validates | specificationPath exists, phaseCount >= 1, phases array non-empty, each phase has tasks |
| Output | `{ pass, errors, gate: "gate-spec-trace" }` |

#### gate-spec-review.mjs

| Input | `sources["review-spec"]` |
|---|---|
| Validates | verdict is "Approved" or "Approved with Comments", all dimension scores >= 3/5 |
| Output | `{ pass, errors, gate: "gate-spec-review" }` |

#### gate-build.mjs

| Input | `sources["qa-check"]` |
|---|---|
| Validates | allTestsPass === true, buildSuccess === true |
| Output | `{ pass, errors, gate: "gate-build" }` |

#### gate-review.mjs

| Input | `sources["merge-verdicts"]` |
|---|---|
| Validates | verdict is "Approved" or "Approved with Comments" |
| Output | `{ pass, errors, gate: "gate-review" }` |

### 5.3 Routing Helpers

#### classify-task.mjs

```
Input:  sources["setup"] → { worktreePath, language, isWebUi }
        options.runtimeTask → user's task string
Output: { taskType: "bug"|"feature"|"refactor",
          uiScope: "none"|"ui-only"|"ui+arch",
          language, isWebUi, skipStages: [] }
```

Logic: Keyword regex matching on the runtime task string.

#### route-designer.mjs

```
Input:  sources["classify-task"] → { taskType, uiScope }
Output: { designerAgent: string|null, reason: string }
```

Logic:
- bug → null (skip design)
- ui+arch → "product-designer"
- ui-only → "ui-ux-designer"
- refactor → "architecture-improver"
- feature → "architecture-designer"

#### route-specialist.mjs

```
Input:  sources["classify-task"] → { language }
        options.phase → current phase metadata
Output: { specialist: string, reason: string }
```

Logic:
- rust → "implementer" (with rust instructions in prompt)
- go → "implementer" (with go instructions)
- frontend → "implementer" (with frontend instructions)
- backend → "implementer" (with backend instructions)
- mixed → "implementer" (generic)

**Note**: We use a single `implementer` agent with phase-specific prompt augmentation rather than separate per-language agents. This simplifies the agent count while the dynamic controller injects language-specific instructions.

#### check-prototype-needed.mjs

```
Input:  sources["design"] → { hasNumericConstants, constants }
Output: { needed: boolean, constants: string[] }
```

### 5.4 Merge Helper

#### merge-review-verdicts.mjs

```
Input:  sources["code-review"] → { verdict, findings }
        sources["adversarial-review"] → { verdict, findings }
Output: { verdict: "Approved"|"Approved with Comments"|"Changes Requested",
          findings: [...merged...], dimensionsCovered: [...] }
```

Logic: Takes the stricter of the two verdicts. Merges findings arrays.

### 5.5 Utility Helpers

#### cleanup.mjs

```
Input:  sources["docs"] → { docsUpdated }
        context.cwd → worktree path
Output: { languagesDetected, directoriesRemoved, sensitiveDataFindings, blocked, summary }
```

Logic: Scans for build artifacts, `.env` files, secrets patterns. Returns `blocked: true` if sensitive data found.

---

## 6. Dynamic Controller Interface

### 6.1 implementation-controller.mjs Signature

```javascript
/**
 * Dynamic controller for the super-dev 13-stage pipeline.
 * Orchestrates stages 2-13 after the setup stage completes.
 *
 * @param {DynamicControllerContext} ctx
 */
export default async function controller(ctx) {
  // ctx.task — runtime task string
  // ctx.sources — { setup: { worktreePath, specDirectory, ... } }
  // ctx.phase(name) — declare current pipeline phase for UI
  // ctx.agent({ id, agent, prompt, tools }) — spawn agent task
  // ctx.helper(name, input) — call a declared helper
  // ctx.parallel([thunks]) — fan-out concurrent operations
  // ctx.budget.check() — verify budget remaining
  // ctx.log(...) — structured logging
}
```

### 6.2 Controller Internal Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  implementation-controller.mjs                                   │
│                                                                  │
│  Phase 1: Classification                                         │
│    ctx.helper("classify-task", { sources, options })             │
│                                                                  │
│  Phase 2: Requirements (loop max 3)                              │
│    repeat:                                                       │
│      result = ctx.agent({ agent: "requirements-clarifier", ...})│
│      gate = ctx.helper("gate-requirements", { sources: ... })   │
│      if gate.pass → break                                        │
│                                                                  │
│  Phase 3: BDD (loop max 3)                                       │
│    repeat:                                                       │
│      result = ctx.agent({ agent: "bdd-scenario-writer", ... })  │
│      gate = ctx.helper("gate-bdd", { sources: ... })            │
│      if gate.pass → break                                        │
│                                                                  │
│  Phase 4: Research (loop max 3)                                  │
│    repeat:                                                       │
│      result = ctx.agent({ agent: "research-agent", ... })       │
│      if result.openIssues.length === 0 → break                  │
│                                                                  │
│  Phase 5: Debug (conditional)                                    │
│    if taskType === "bug":                                        │
│      ctx.agent({ agent: "debug-analyzer", ... })                │
│                                                                  │
│  Phase 6: Assessment                                             │
│    ctx.agent({ agent: "code-assessor", ... })                   │
│                                                                  │
│  Phase 7: Design (routed)                                        │
│    routing = ctx.helper("route-designer", ...)                  │
│    if routing.designerAgent:                                     │
│      ctx.agent({ agent: routing.designerAgent, ... })           │
│                                                                  │
│  Phase 7.5: Prototype (conditional loop max 3)                   │
│    check = ctx.helper("check-prototype-needed", ...)            │
│    if check.needed:                                              │
│      repeat:                                                     │
│        ctx.agent({ agent: "prototype-runner", ... })            │
│        gate check → break on pass                               │
│                                                                  │
│  Phase 8: Specification (loop max 3)                             │
│    repeat:                                                       │
│      ctx.agent({ agent: "spec-writer", ... })                   │
│      gate = ctx.helper("gate-spec-trace", ...)                  │
│      if gate.pass → break                                        │
│                                                                  │
│  Phase 9: Spec Review (loop max 3)                               │
│    repeat:                                                       │
│      ctx.agent({ agent: "spec-reviewer", ... })                 │
│      gate = ctx.helper("gate-spec-review", ...)                 │
│      if gate.pass → break                                        │
│                                                                  │
│  Phase 10: Implementation (per-phase TDD)                        │
│    for each phase in spec.phases:                                │
│      ctx.agent({ agent: "tdd-guide", ... })                     │
│      specialist = ctx.helper("route-specialist", ...)           │
│      ctx.agent({ agent: "implementer", prompt: [specialist] }) │
│      ctx.agent({ agent: "qa-agent", ... })                      │
│      gate = ctx.helper("gate-build", ...)                       │
│      if !gate.pass → retry (max 3) or abort                     │
│      git commit phase                                            │
│                                                                  │
│  Phase 11: Code Review (loop max 3)                              │
│    repeat:                                                       │
│      [codeReview, adversarial] = ctx.parallel([                 │
│        () => ctx.agent({ agent: "code-reviewer", ... }),        │
│        () => ctx.agent({ agent: "adversarial-reviewer", ... })  │
│      ])                                                          │
│      merged = ctx.helper("merge-review-verdicts", ...)          │
│      if merged.verdict === "Approved"* → break                  │
│      ctx.agent({ agent: "implementer", ... }) // fix issues     │
│                                                                  │
│  Phase 12: Documentation                                         │
│    ctx.agent({ agent: "docs-executor", ... })                   │
│                                                                  │
│  Phase 13: Cleanup                                               │
│    cleanup = ctx.helper("cleanup", ...)                         │
│    if !cleanup.blocked:                                          │
│      ctx.agent({ agent: "orchestrator", ... }) // merge         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Replay Invariants

The dynamic controller must support resume:
- Each `ctx.agent()` and `ctx.helper()` call produces a deterministic task ID
- On resume, previously completed operations are replayed from the run store
- The controller re-issues operations in the same order
- State (which phase, which loop iteration) is derivable from completed task IDs

ID scheme: `pipeline.<phase>.<operation>` (e.g., `pipeline.requirements.r01.write`, `pipeline.requirements.r01.gate`)

---

## 7. Control Schema Design

### 7.1 Shared Patterns

All schemas follow these conventions:
- Top-level `"type": "object"` with `"required"` array
- No `$ref`, `$defs`, `definitions`, or `pattern`
- Inner objects typed loosely as `{ "type": "object" }` (pi-workflow convention)
- Arrays typed with `items: { "type": "object" }` or `items: { "type": "string" }`
- Bounds via `minimum`, `minItems`, `minLength`

### 7.2 Gate Verdict Schema (shared)

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

### 7.3 Setup Control Schema

```json
{
  "type": "object",
  "required": ["worktreePath", "specDirectory", "language", "specIdentifier"],
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

### 7.4 Classify Task Control Schema

```json
{
  "type": "object",
  "required": ["taskType", "uiScope", "language"],
  "properties": {
    "taskType": { "type": "string", "enum": ["bug", "feature", "refactor"] },
    "uiScope": { "type": "string", "enum": ["none", "ui-only", "ui+arch"] },
    "language": { "type": "string" },
    "isWebUi": { "type": "boolean" },
    "skipStages": { "type": "array", "items": { "type": "string" } }
  }
}
```

### 7.5 Requirements Control Schema

```json
{
  "type": "object",
  "required": ["docPath", "featureName", "acCount"],
  "properties": {
    "docPath": { "type": "string", "minLength": 1 },
    "featureName": { "type": "string", "minLength": 1 },
    "acCount": { "type": "integer", "minimum": 1 },
    "openQuestions": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

### 7.6 Implementation Control Schema

```json
{
  "type": "object",
  "required": ["phasesCompleted", "totalPhases", "allGreen"],
  "properties": {
    "phasesCompleted": { "type": "integer", "minimum": 0 },
    "totalPhases": { "type": "integer", "minimum": 1 },
    "allGreen": { "type": "boolean" },
    "filesModified": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

### 7.7 Code Review Control Schema

```json
{
  "type": "object",
  "required": ["verdict"],
  "properties": {
    "verdict": { "type": "string", "enum": ["Approved", "Approved with Comments", "Changes Requested"] },
    "findings": { "type": "array", "items": { "type": "object" } },
    "dimensionsCovered": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  }
}
```

### 7.8 Merge Control Schema

```json
{
  "type": "object",
  "required": ["merged"],
  "properties": {
    "commitSha": { "type": "string" },
    "merged": { "type": "boolean" },
    "mergeCommand": { "type": "string" },
    "summary": { "type": "string" }
  }
}
```

### 7.9 Schema per Stage (Complete List)

| Schema File | Used By |
|---|---|
| super-dev-setup-control.schema.json | Stage 1: Setup |
| super-dev-classify-task-control.schema.json | Classify helper output |
| super-dev-requirements-control.schema.json | Requirements writer |
| super-dev-gate-verdict.schema.json | All gate helpers (shared) |
| super-dev-bdd-control.schema.json | BDD writer |
| super-dev-research-control.schema.json | Research agent |
| super-dev-debug-control.schema.json | Debug analyzer |
| super-dev-assessment-control.schema.json | Code assessor |
| super-dev-route-designer-control.schema.json | Route designer helper |
| super-dev-design-control.schema.json | All design agents |
| super-dev-check-prototype-control.schema.json | Check prototype helper |
| super-dev-prototype-control.schema.json | Prototype runner |
| super-dev-spec-control.schema.json | Spec writer |
| super-dev-spec-review-control.schema.json | Spec reviewer |
| super-dev-implementation-control.schema.json | Dynamic controller final |
| super-dev-code-review-control.schema.json | Code reviewer + adversarial |
| super-dev-review-merge-control.schema.json | Merge verdicts helper |
| super-dev-docs-control.schema.json | Docs executor |
| super-dev-cleanup-control.schema.json | Cleanup helper |
| super-dev-merge-control.schema.json | Merge/orchestrator |

---

## 8. Implementation Phases (DAG)

### Phase Dependency Graph

```
Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6 ──▶ Phase 7
  │              │
  │              └──▶ Phase 3 (can start schemas in parallel with agents)
  │
  └──▶ Phase 2 (agents depend on package scaffold)
```

### Phase 1: Foundation (Scaffold)

**Deliverables:**
- `package.json` with pi registration
- `tsconfig.json`
- `src/extension.ts`
- `README.md`
- `LICENSE`
- Empty directory structure (`agents/`, `workflows/super-dev/schemas/`, `workflows/super-dev/helpers/`, `skills/super-dev/`)

**Acceptance**: `npm run typecheck` passes.

**Depends on**: Nothing (root)

---

### Phase 2: Agent Definitions

**Deliverables:**
- 21 agent markdown files in `agents/`
- Each ported from super-dev-plugin with:
  - pi-workflow frontmatter (name, description, tools, readOnly)
  - Trimmed system prompt (remove plugin_root, skill invocations, team management)
  - Preserved core prompt content and XML sections

**Acceptance**: All agents discoverable by pi-workflow engine.

**Depends on**: Phase 1

---

### Phase 3: Control Schemas + Spec Skeleton

**Deliverables:**
- 20 control schema JSON files in `workflows/super-dev/schemas/`
- `workflows/super-dev/spec.json` (skeleton with setup + dynamic stage, no controller yet)

**Acceptance**: `/workflow validate super-dev` passes schema validation (controller missing is acceptable).

**Depends on**: Phase 1

**Parallelizable with**: Phase 2

---

### Phase 4: Gate + Routing Helpers

**Deliverables:**
- `helpers/classify-task.mjs`
- `helpers/route-designer.mjs`
- `helpers/route-specialist.mjs`
- `helpers/check-prototype-needed.mjs`
- `helpers/gate-requirements.mjs`
- `helpers/gate-bdd.mjs`
- `helpers/gate-spec-trace.mjs`
- `helpers/gate-spec-review.mjs`
- `helpers/gate-build.mjs`
- `helpers/gate-review.mjs`
- `helpers/merge-review-verdicts.mjs`
- `helpers/cleanup.mjs`

**Acceptance**: Each helper exports a default async function, returns `{ schema, digest, value }`.

**Depends on**: Phase 1, Phase 3 (schema shapes inform helper outputs)

---

### Phase 5: Dynamic Controller

**Deliverables:**
- `helpers/implementation-controller.mjs` — the core pipeline orchestrator
- Implements the full 13-stage flow using `ctx.agent()`, `ctx.helper()`, `ctx.parallel()`
- Phase declarations for progress UI
- Replay-safe task ID scheme

**Acceptance**: Controller loads without error. Pipeline progresses through Stages 1-3 in test run.

**Depends on**: Phase 2, Phase 3, Phase 4

---

### Phase 6: Skill + Integration

**Deliverables:**
- `skills/super-dev/SKILL.md`
- `docs/usage.md`
- Wire spec.json dynamic stage to controller

**Acceptance**: 
- `/workflow validate super-dev` — no blockers
- `/workflow list` includes `super-dev`
- Skill triggers on "implement X"

**Depends on**: Phase 5

---

### Phase 7: End-to-End Validation

**Deliverables:**
- Fix all validation warnings
- Test run: `/workflow run super-dev "add a hello world endpoint"`
- Verify: Stages 1-5 complete, conditional skips work, loop gates work

**Acceptance**: AC-01 through AC-12 from the spec.

**Depends on**: Phase 6

---

## 9. Data Flow Architecture

### 9.1 Setup → Controller Data Handoff

The `setup` stage produces a `control.json` that the dynamic controller receives via `ctx.sources`:

```
ctx.sources.setup = {
  worktreePath: "/path/to/worktree",
  specDirectory: "/path/to/worktree/docs/specifications/01-feature/",
  defaultBranch: "main",
  language: "frontend",
  isWebUi: true,
  specIdentifier: "01-feature"
}
```

### 9.2 Intra-Controller Data Flow

Within the dynamic controller, data flows via local variables:

```javascript
// Classification feeds all downstream decisions
const classification = await ctx.helper("classify-task", { ... });

// Requirements feed BDD, research, spec
const requirements = await runLoop("requirements", ...);

// BDD feeds research, spec
const bdd = await runLoop("bdd", ...);

// Research feeds assessment, design, spec
const research = await runLoop("research", ...);

// Assessment feeds design, spec
const assessment = await ctx.agent({ agent: "code-assessor", ... });

// Spec feeds implementation (phases list)
const spec = await runLoop("spec", ...);

// Implementation feeds code-review (files modified)
const implementation = await runImplementation(spec.phases);
```

### 9.3 Agent Prompt Injection

Each agent receives upstream context via its prompt, not via `workflow_artifact` reads (since we're in a dynamic controller). The controller builds prompts by injecting:

```javascript
const prompt = `
## Context
- Worktree: ${setup.worktreePath}
- Spec Directory: ${setup.specDirectory}
- Feature: ${requirements.featureName}
- Language: ${classification.language}

## Upstream Artifacts
- Requirements: ${requirements.docPath}
- BDD Scenarios: ${bdd.docPath}
- Research: ${research.docPath}

## Your Task
${stageSpecificInstructions}
`;
```

---

## 10. Key Architecture Decisions

### ADR-1: Single Dynamic Controller vs. Pure DAG

**Decision**: Use a single `dynamic` stage for Stages 2-13.

**Context**: pi-workflow v1 lacks `when` fields and prohibits `support` children in loops. The super-dev pipeline requires conditional stages, agent routing, and writer+gate pairs inside iteration loops.

**Consequences**:
- (+) Full flexibility for conditional logic, routing, iteration
- (+) Resume support via engine's dynamic task replay
- (+) Progress UI via `ctx.phase()`
- (-) Less visual in spec.json (logic lives in controller code)
- (-) Controller is a single complex file (~500 lines)

### ADR-2: Single Implementer Agent with Prompt Augmentation

**Decision**: Use one `implementer` agent instead of per-language specialists.

**Context**: super-dev-plugin has 8 domain-specific developers (rust, go, frontend, backend, ios, android, macos, windows). Porting all 8 adds complexity without proportional value for V1.

**Consequences**:
- (+) Simpler agent set (21 vs 28+)
- (+) Language-specific instructions injected via prompt
- (+) Easier to add new languages later (just update route-specialist helper)
- (-) No hard tool ceiling differentiation between language specialists

### ADR-3: Setup as Declarative Stage, Pipeline as Dynamic

**Decision**: Keep `setup` as a separate declarative `single` stage.

**Context**: Setup has no conditional logic and its output bootstraps the dynamic controller's `ctx.sources`.

**Consequences**:
- (+) Clean separation: infrastructure vs. pipeline logic
- (+) Engine manages worktree creation via `worktreePolicy: "on"`
- (+) If setup fails, no dynamic budget is consumed

### ADR-4: Shared Gate Verdict Schema

**Decision**: All gate helpers share one `super-dev-gate-verdict.schema.json`.

**Context**: Every gate returns `{ pass, errors, gate }`. Having separate schemas would be redundant.

**Consequences**:
- (+) DRY: one schema for 6 gate helpers
- (+) Consistent downstream consumption in controller
- (-) Cannot add gate-specific fields without breaking shared contract (mitigated: use `errors` array for specifics)

---

## 11. Risk Mitigations

| Risk | Mitigation |
|---|---|
| Dynamic controller too complex (~500 LOC) | Factor into sub-functions: `runLoop()`, `runImplementation()`, `runCodeReview()` |
| Resume breaks if controller logic changes | Use stable task IDs; version the controller; test resume paths |
| Agent prompts too long for context | Keep prompts focused; move reference material to files agents can read |
| pi-workflow dynamic API changes | Pin `@agwab/pi-workflow` version; test against specific engine version |
| Gate helpers too strict (false failures) | Start with lenient validation; tighten incrementally |
| Budget exhaustion in long pipelines | Set `maxAgents: 200` with conservative concurrency; monitor via `ctx.budget.check()` |

---

## 12. Validation Checklist

Before considering architecture complete:

- [ ] `npm run typecheck` passes with the scaffold
- [ ] `spec.json` validates against pi-workflow schema (`/workflow validate super-dev`)
- [ ] All 21 agent files have valid frontmatter (name, description, tools)
- [ ] All helpers are valid ESM with default export
- [ ] Dynamic controller loads without import errors
- [ ] Budget is sufficient for a full 13-stage run (estimated: 40-60 agent calls)
- [ ] Task IDs are deterministic and support resume
