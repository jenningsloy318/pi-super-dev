# Research Report: pi-workflow Engine & super-dev Pipeline

## 1. pi-workflow spec.json Structure

### Top-level Fields

```json
{
  "schemaVersion": 1,
  "name": "workflow-name",
  "description": "Human-readable description",
  "defaults": {
    "maxRuntimeMs": 14400000,
    "agent": "researcher",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"]
  },
  "input": {
    "depth": "standard"
  },
  "artifactGraph": {
    "stages": [ /* stage objects */ ]
  }
}
```

**Required fields:**
- `schemaVersion`: Must be `1`
- `artifactGraph.stages`: Array of stage objects (the only authoring surface)

**Optional top-level fields:**
- `name`: Workflow identifier
- `description`: Human-readable purpose
- `defaults`: Default settings inherited by all stages
- `input`: Static input parameters accessible via `input.*` in prompts

### Stage Object Shape

```json
{
  "id": "stage-name",
  "type": "single" | "foreach" | "reduce" | "loop" | "dag" | "dynamic",
  "from": "source-stage" | ["stage-a", "stage-b"] | { "source": "plan", "path": "$.items" },
  "after": "stage-name" | ["a", "b"] | [],
  "agent": "agent-name",
  "readOnly": true,
  "tools": ["read", "grep"],
  "maxRuntimeMs": 300000,
  "maxConcurrency": 8,
  "maxItems": 100,
  "injectRuntimeTask": true,
  "sourcePolicy": "partial" | "require-success",
  "sourceProjection": { "include": ["$.digest"], "maxChars": 8000 },
  "inputPolicy": { "requiredReads": ["stage.control"], "enforcement": "fail" },
  "output": {
    "analysis": { "required": true },
    "refs": { "required": true },
    "maxDigestChars": 1200,
    "controlSchema": "./schemas/stage-control.schema.json"
  },
  "prompt": "Stage-specific prompt text"
}
```

---

## 2. Stage Types

### `single`
One focused subagent prompt. Simplest stage type.

```json
{ "id": "plan", "type": "single", "prompt": "Plan the work..." }
```

### `foreach`
Reads an array from an upstream `control.json` via a dot path and materializes one task per item.

```json
{
  "id": "verify-items",
  "type": "foreach",
  "from": { "source": "plan", "path": "$.items" },
  "maxConcurrency": 8,
  "each": { "prompt": "Verify this item: ${item}" }
}
```

- `from.source`: upstream stage id
- `from.path`: JSON path into the upstream `control.json` (e.g., `$.researchQuestions`)
- `each.prompt`: template with `${item}` interpolation
- `maxConcurrency`: parallel task limit
- `injectRuntimeTask`: boolean to include the runtime task in each child prompt

### `reduce`
Fan-in over upstream artifact handles. Used for synthesis/final reports.

```json
{
  "id": "report",
  "type": "reduce",
  "from": ["scan", "review"],
  "sourceProjection": { "include": ["$.digest"] },
  "prompt": "Merge both branch outputs."
}
```

- `from`: string or array of stage ids
- `sourceProjection.include`: inline small paths from upstream `control.json`
- Works with `workflow_artifact` tool for reading full upstream artifacts

### `loop`
Repeats fixed child stages until a condition is met.

```json
{
  "id": "fix-loop",
  "type": "loop",
  "maxRounds": 5,
  "until": { "source": "check", "path": "$.allGreen", "equals": true },
  "progressPath": "$.fixCount",
  "stages": [
    { "id": "implement", "type": "single", "prompt": "Fix the issue..." },
    { "id": "check", "type": "single", "prompt": "Verify the fix..." }
  ],
  "onExhausted": { "id": "escalate", "type": "single", "prompt": "Escalate..." }
}
```

**Required loop fields:** `id`, `maxRounds`, `until`, at least 2 child `stages`

**Child task id format:** `fix-loop.r01.implement`, `fix-loop.r02.check`

**Constraints:**
- Child stages run strictly in listed order
- Nested `loop`, `foreach`, `dag`, and support children are REJECTED in v1
- `until.source` must reference the FINAL loop child stage

### `dag`
Composite container with nested sibling-scoped graphs.

```json
{
  "id": "analysis",
  "type": "dag",
  "from": "merge",
  "outputFrom": "final",
  "stages": [
    { "id": "scan", "type": "single", "after": [], "prompt": "..." },
    { "id": "review", "type": "single", "after": "scan", "prompt": "..." },
    { "id": "final", "type": "reduce", "from": ["scan", "review"], "prompt": "..." }
  ]
}
```

- `outputFrom`: names the child whose output represents the container downstream
- Child `from`/`after` resolve only to siblings inside the same container
- Can contain `single`, `foreach`, `reduce`, support, or nested `dag`

### `dynamic`
Trusted bundle-local controller that adaptively adds tasks at runtime.

```json
{
  "id": "adaptive",
  "type": "dynamic",
  "dynamic": {
    "uses": "./helpers/controller.mjs",
    "mode": "graph-splice",
    "permissions": { "approval": "auto" },
    "budget": { "maxAgents": 1000, "maxConcurrency": 16 }
  }
}
```

### `support` (not a type — declared via `support` object)
Runs local helper code inline. Does NOT use a separate `type` value.

```json
{
  "id": "audit-claims",
  "from": "verify-claims",
  "sourcePolicy": "partial",
  "support": {
    "uses": "./helpers/claim-evidence-gate.mjs",
    "options": { "requireFetchedEvidenceForVerified": true }
  }
}
```

---

## 3. Loop Behavior

### `until` Syntax

```typescript
type LoopUntilLeaf = {
  stage?: string;   // or `source` — must reference final child stage
  source?: string;
  path: string;     // JSON path into child's control.json
  equals?: string | number | boolean | null;
  notEquals?: string | number | boolean | null;
  lengthEquals?: number;
  exists?: boolean;
};

type LoopUntilCondition =
  | LoopUntilLeaf
  | { all: LoopUntilCondition[] }
  | { any: LoopUntilCondition[] };
```

**Combinators:** `{ all: [...] }` and `{ any: [...] }` for complex conditions.

### Stop Conditions
1. `until` evaluates true
2. `maxRounds` exhausted
3. No-progress detection fires (via `progressPath`)
4. Blocking failure prevents scheduling

### `onExhausted`
Optional child stage that runs if `maxRounds` is hit without `until` succeeding.

### Loop Result Statuses
- `completed` — until condition met
- `exhausted` — maxRounds hit
- `stopped_no_progress` — no-progress detection

---

## 4. Dynamic Stages

### Controller API

Controllers are `.mjs` files that export a default function receiving a `ctx` object:

```js
// ctx.agent() — spawn a workflow task
ctx.agent({ id, agent, prompt, tools });

// ctx.helper() — call a declared helper
ctx.helper(name, input);

// ctx.workflow() — invoke a nested workflow
ctx.workflow(name, input);

// ctx.parallel() — fan-out multiple operations
ctx.parallel([() => ctx.agent(...), ...]);

// ctx.budget.remaining() — check headroom
// ctx.budget.check() — returns false when exhausted

// ctx.log(...) — JSONL logging to controller.log
// ctx.ui.confirm — interactive approval (for approval: "ask")
```

### Budget fields
`maxAgents`, `maxConcurrency`, `maxRuntimeMs`, `maxNestedWorkflowDepth`, `maxGraphMutations`, `maxHelperRuns`

### Decision Loop
`dynamic.decisionLoop` keeps adaptive behavior policy-bound in JSON. The planner emits `dynamic-decision-v1` data.

### Replay Invariants
On resume, controllers must re-issue previously recorded operations in the same order. Omitted or out-of-order replay fails closed.

---

## 5. Conditional Stages

**There is NO `when` field in pi-workflow v1.** Conditional execution is NOT natively supported at the spec level.

**Workarounds for conditional behavior:**
1. Use `dynamic` stages with controller logic
2. Use `loop` with `until` that evaluates immediately based on upstream control data
3. Handle conditionals in the orchestrating workflow script (like `super-dev.workflow.js` does)

This is a KEY finding — the super-dev pipeline has many conditional stages (Stage 4 only for bugs, Stage 6.5 only when constants present) that cannot be expressed declaratively in a pi-workflow spec.

---

## 6. `from` Dependencies

### Data + Order Edge
```json
"from": "plan"                              // single source
"from": ["plan", "research"]                // multiple sources
"from": { "source": "plan", "path": "$.items" }  // foreach with path
```

### Order-Only Edge
```json
"after": "plan"           // wait for plan, no data access
"after": ["a", "b"]      // wait for multiple
"after": []              // explicit parallel root (no ordering dependency)
```

### `sourcePolicy`
- `"partial"` — allow partial source success (some sources may fail)
- `"require-success"` — all sources must succeed

### `sourceProjection`
```json
"sourceProjection": {
  "include": ["$.digest", "$.items"],
  "maxChars": 8000
}
```
Inlines small selected paths from upstream `control.json`.

---

## 7. Helper API Signature

```js
export default async function helper({ sources, options, context }) {
  // sources: object keyed by stable source names, each containing upstream control.json values
  // options: from support.options in the spec
  // context: { specPath, ... } runtime context

  return {
    schema: "helper-output-v1",
    digest: "human-readable summary string",
    value: { /* arbitrary control data */ }
  };
}
```

**Key rules:**
- Helper refs must start with `./`, end in `.mjs`, stay inside bundle directory
- Helpers run unsandboxed — trusted code, not constrained by tool allowlists
- Helper result is normalized into a workflow artifact bundle (`control.json`)
- Parent-directory refs (`../`) are rejected

---

## 8. Agent Declarations

### Agent Frontmatter Format (in `agents/*.md`)
```yaml
---
name: researcher
description: Read-only source-backed research agent.
tools: read, grep, find, ls, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read
readOnly: true
---
```

### Agent Discovery Order
1. Project `.pi/agents/`
2. User `~/.pi/agent/agents/`
3. pi-workflow bundled agents (`agents/`)

### Agent Reference in Specs
```json
"defaults": { "agent": "researcher" }
// or per-stage:
{ "id": "scan", "agent": "scout", ... }
```

### Tool Ceiling
Agent frontmatter `tools` is the HARD CEILING. Workflow spec `tools` can only narrow, never widen.

Scope order: agent frontmatter < `defaults.tools` < stage `tools` (most specific wins, but cannot exceed agent ceiling).

---

## 9. Control Schema Format

### Schema Location
```json
"output": {
  "controlSchema": "./schemas/my-stage-control.schema.json"
}
```
Resolved relative to the spec file.

### Supported JSON Schema Subset
- `type`, `required`, `properties`, `items`
- `enum`, `const`
- Length/item/number bounds (`minLength`, `maxLength`, `minItems`, `maxItems`, `minimum`, `maximum`)
- `additionalProperties`
- Simple `allOf`/`anyOf`/`oneOf`

### Unsupported (REJECTED on load)
- `$ref`, `$defs`, `definitions`, `pattern`

### Output Protocol
Agents must return:
```text
<control>{"schema":"stage-control-v1","digest":"..."}</control>
<analysis>Detailed reasoning and evidence discussion.</analysis>
<refs>[]</refs>
```

Engine writes: `control.json`, `analysis.md`, `refs.json`, `raw.md`

---

## 10. Plugin Registration

### package.json
```json
{
  "name": "@agwab/pi-workflow",
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "workflow", "pi"],
  "exports": {
    ".": "./dist/index.js",
    "./extension": "./src/extension.ts",
    "./package.json": "./package.json"
  },
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": [
      "./skills/workflow-guide",
      "./skills/execution-router"
    ]
  }
}
```

### Extension Registration (extension.ts)
The extension registers:
- `/workflow` command with subcommands (list, validate, run, dynamic, status, etc.)
- LLM-callable tools: `workflow_list`, `workflow_run`, `workflow_dynamic`
- Agent discovery via `discoverAgents()`
- Workflow resolution via `resolveWorkflowRef()`

### Installation
```bash
pi install npm:@agwab/pi-workflow
# or local:
pi install /absolute/path/to/pi-workflow
```

---

## 11. Tool Ceiling Syntax

### String form (simple)
```json
{ "tools": ["read", "grep", "find", "ls", "workflow_web_search"] }
```

### Object form (custom/fallback)
```json
{
  "tools": [
    "read",
    {
      "name": "scrapling_fetch",
      "extensions": ["packages/pi-scrapling-access"],
      "classification": "read-only",
      "optional": true,
      "fallbackTools": ["workflow_web_fetch_source"]
    }
  ]
}
```

**Classification:** Built-in tools get built-in classification. Custom tools without explicit `classification` stay blocked for review.

---

## 12. `readOnly` Behavior

```json
"defaults": { "readOnly": true }
// or per-stage:
{ "id": "scan", "readOnly": true, ... }
```

- Safety declaration for capability/worktree classification
- Does NOT isolate the filesystem or make mutation-capable tools safe
- Used to determine if shared workspace is safe vs. needs managed worktree
- Read-only stages use shared workspace; mutation-capable stages get managed worktrees
- Validation warns if `readOnly: true` but mutation-capable tools (e.g., `bash`) are present

---

## 13. super-dev 13-Stage Pipeline Analysis

### Stage Summary

| Stage | Name | Type | Conditional? | Agents |
|-------|------|------|-------------|--------|
| 1 | Setup | Setup/infra | Never skip | (shell commands) |
| 2 | Requirements + BDD | Sequential pairs | Skippable | requirements-clarifier, bdd-scenario-writer, doc-validator×2 |
| 3 | Research | Single + iterations | Skippable | research-agent (1-4 iterations) |
| 4 | Debug Analysis | Single | Bug-only | debug-analyzer |
| 5 | Code Assessment | Single | Skippable | code-assessor |
| 6 | Design | Routed single | Skippable | architecture-designer / architecture-improver / ui-ux-designer / product-designer |
| 6.5 | Prototype | Single | Conditional (constants) | prototype-runner, doc-validator |
| 7 | Specification | Paired | Skippable | spec-writer, doc-validator |
| 8 | Spec Review | Paired + loop | Skippable | spec-reviewer, doc-validator (max 3 iters) |
| 9 | Implementation | Per-phase loop | Skippable | tdd-guide, domain-specialist, impl-summary-writer, visual-verifier, qa-agent, e2e-runner, doc-validator |
| 10 | Code Review | Parallel + loop | Skippable | code-reviewer, adversarial-reviewer, doc-validator×3 (max 3 iters) |
| 11 | Documentation | Sequential | Skippable | docs-executor, doc-validator, handoff-writer, doc-validator |
| 12 | Cleanup | Single | Skippable | build-cleaner |
| 13 | Commit & Merge | Shell | Skippable | (shell commands) |

### Key Patterns Identified

1. **Writer + Validator pairs**: Every document-producing stage is paired with a doc-validator
2. **Iteration loops**: Stages 3, 8, 9, 10 have bounded retry loops (max 3)
3. **Conditional routing**: Stage 4 (bugs only), Stage 6 (4-way routing), Stage 6.5 (constants)
4. **Domain-aware routing**: Stage 9 routes to language-specific specialists
5. **Per-phase pipeline**: Stage 9 loops over N implementation phases sequentially
6. **Parallel fan-out**: Stage 10 runs code-reviewer + adversarial-reviewer concurrently
7. **Gate-driven progression**: Every stage transition requires gate script PASS

---

## 14. Mapping Challenges & Risks

### Critical Gaps Between super-dev and pi-workflow

| Challenge | Description | Mitigation Strategy |
|-----------|-------------|---------------------|
| No `when` field | pi-workflow has no conditional stage execution | Use `dynamic` controller for routing logic |
| Iteration loops with repair | super-dev loops involve fixing code + re-running gates | Use `loop` type with `until` reading gate verdicts |
| Per-phase sequential loop | Stage 9 iterates over N phases (unknown at spec time) | Use `dynamic` stage to generate per-phase subgraphs |
| Domain routing | Stage 6/9 route to different agents based on analysis | Use `dynamic` controller with routing logic |
| Shell operations | Stages 1, 13 run git/shell commands directly | Use `dynamic` controller with `ctx.agent()` bash access |
| Doc-validator pairing | Every writer needs a paired validator | Model as `single` + `support` or sequential pairs within loops |
| Worktree management | super-dev creates/manages git worktrees | Handle in dynamic controller or initial setup stage |

### Recommended Architecture

Given the complexity and conditionality of the super-dev pipeline, the recommended approach is:

**Hybrid: `dynamic` controller with structured decision loop**

The super-dev workflow is fundamentally an *adaptive* pipeline where:
- Stages may be skipped (`--skip`)
- Stages route to different agents (design routing)
- Loop iteration counts are runtime-determined
- Phase counts in Stage 9 are spec-determined (unknown at workflow definition time)

This maps best to a `dynamic` stage with a sophisticated controller that:
1. Plans the stage graph based on inputs/flags
2. Spawns stages sequentially with gate checks
3. Handles iteration loops in controller code
4. Routes to domain specialists programmatically

**Alternative: Fixed DAG with loops for known patterns**

For a simpler V1, we could model the known-fixed portions (Stages 2-8 as a mostly-linear pipeline) declaratively and use `dynamic` only for Stage 9-10 (variable-phase implementation).

---

## 15. Reference: super-dev.workflow.js Pattern

The existing `super-dev.workflow.js` in the super-dev-plugin is a **Dynamic Workflow script** (NOT a pi-workflow `spec.json`). It uses a completely different API:

```js
export const meta = { name, description, whenToUse, phases };

// Runtime globals available:
phase('Stage 1 — Setup');      // Set current phase
agent(prompt, opts);            // Spawn subagent
log(message);                   // Logging
args;                           // Input arguments
```

This is Claude Code's native Dynamic Workflow runtime, NOT pi-workflow's `dynamic` controller API. The two are distinct:
- **Claude Code Dynamic Workflow**: `phase()`, `agent()`, `log()`, `args` globals in a `.workflow.js` file
- **pi-workflow dynamic**: `ctx.agent()`, `ctx.helper()`, `ctx.workflow()`, `ctx.parallel()` in a controller `.mjs`

Our pi-workflow plugin needs to use pi-workflow's spec format and APIs.

---

## 16. Recommendations for Design Stage

1. **Use a `dynamic` controller as the primary orchestrator** — the super-dev pipeline's conditionality and iterative nature maps best to pi-workflow's dynamic stage type.

2. **Model fixed sub-pipelines as nested static stages where possible** — e.g., the requirements→BDD writer/validator pair could be a small fixed DAG inside the controller's generated plan.

3. **Implement gate checking in support helpers** — transform gate script results into control.json verdicts that drive loop `until` conditions.

4. **Define agents with appropriate tool ceilings** — each super-dev specialist maps to a pi-workflow agent definition with frontmatter tools list.

5. **Use `loop` for bounded iterations** — Stages 8 (spec review) and 10 (code review) can be modeled as `loop` stages with `until` reading gate verdicts.

6. **Handle Stage 9's per-phase pipeline with nested dynamic** — the variable number of implementation phases requires dynamic task generation.

7. **Bundle layout should follow pi-workflow conventions:**
   ```
   workflows/super-dev-pipeline/
     spec.json
     schemas/
       gate-verdict.schema.json
       requirements-output.schema.json
       ...
     helpers/
       gate-runner.mjs
       domain-router.mjs
       ...
   ```

8. **Agent definitions** should be in `agents/` at the plugin package level, following the frontmatter format:
   ```yaml
   ---
   name: dev-researcher
   description: Research agent for development pipeline
   tools: read, grep, find, ls, bash, workflow_web_search
   readOnly: false
   ---
   ```

9. **Start with a V1 that models the core happy-path** without all conditionality, then iterate. The V1 could be: plan → research → assess → design → spec → review-loop → implement-loop → code-review-loop → docs → cleanup.

10. **Register as a pi-package** with `"pi": { "extensions": [...], "skills": [...] }` in package.json, following the same pattern as `@agwab/pi-workflow`.
