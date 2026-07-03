# Code Assessment: pi-super-dev Workflow Plugin

## Executive Summary

This assessment analyzes two codebases to establish the patterns our new pi-workflow plugin must follow:

1. **pi-workflow** (`@agwab/pi-workflow`) — The workflow engine that hosts workflow plugins
2. **super-dev-plugin** — The existing Claude Code plugin whose 13-stage pipeline we replicate

The new plugin will be a **pi-workflow-compatible workflow spec** (spec.json + agents + helpers + schemas) that encodes the super-dev 13-stage pipeline as an artifact-graph DAG, executed by pi-workflow's engine rather than the Dynamic Workflow runtime (`Workflow` tool) that super-dev currently uses.

---

## 1. pi-workflow Plugin Architecture

### 1.1 Package Registration Pattern

**package.json `pi` field** (source: `pi-workflow/package.json`):
```json
{
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./skills/workflow-guide", "./skills/execution-router"]
  }
}
```

Key observations:
- `pi.extensions` array points to TypeScript extension entry points
- `pi.skills` array points to skill directories
- Keywords include `"pi-package"`, `"pi-extension"`, `"workflow"`, `"pi"`
- Type is `"module"` (ESM)
- Exports `./extension` pointing to `src/extension.ts`
- peerDependency on `@earendil-works/pi-coding-agent`
- Dependencies: `@agwab/pi-subagent`, `pi-web-access`
- `bundleDependencies` used for runtime deps

### 1.2 Extension Registration (extension.ts)

The extension exports a default function receiving `ExtensionAPI`:
```typescript
export default function workflowExtension(pi: ExtensionAPI): void {
  // Register event handlers (session_start)
  // Register tools (workflow_list, workflow_run, workflow_dynamic)
  // Register commands (/workflow)
}
```

Key APIs used:
- `pi.on("session_start", ...)` — lifecycle hooks
- `pi.registerTool({...})` — tool registration with name, label, description, promptSnippet, promptGuidelines, parameters, execute
- `pi.registerCommand(name, { description, getArgumentCompletions, handler })` — slash command

### 1.3 Workflow Spec Discovery

From `workflow-specs.ts`:
- Workflows are discovered from `workflows/` directories:
  - Package-bundled: `<package-root>/workflows/<name>/spec.json`
  - Project-local: `<cwd>/.pi/workflows/<name>/spec.json` (inferred pattern)
- Resolution by name (directory name) or by spec file path
- `spec.json` is the entry point

---

## 2. Workflow Spec Format (spec.json)

### 2.1 Top-Level Structure

```json
{
  "schemaVersion": 1,
  "name": "workflow-name",
  "description": "Human-readable description",
  "defaults": {
    "maxRuntimeMs": 14400000,
    "agent": "researcher",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls", ...]
  },
  "input": { "depth": "standard" },
  "artifactGraph": {
    "stages": [...]
  }
}
```

### 2.2 Stage Types

| Type | Description | Example |
|------|-------------|---------|
| `"single"` | Single agent task | `plan`, `triage` |
| `"foreach"` | Fan-out over array from upstream | `research-questions`, `verify-claims` |
| `"reduce"` | Aggregate multiple upstream outputs | `normalize-claims`, `final-audit` |
| `"dag"` | Nested container with sibling-scoped sub-stages | `impact-analysis` |
| (support) | Deterministic helper, no agent | `audit-claims`, `normalize-input-packet` |

### 2.3 Stage Object Fields

```json
{
  "id": "stage-id",
  "type": "single|foreach|reduce|dag",
  "from": "upstream-id" | ["upstream-1", "upstream-2"] | { "source": "id", "path": "$.jsonPath" },
  "after": [],
  "sourcePolicy": "partial",
  "maxConcurrency": 12,
  "injectRuntimeTask": true,
  "inputPolicy": { "requiredReads": [...], "enforcement": "fail" },
  "output": {
    "analysis": { "required": true },
    "refs": { "required": true },
    "maxDigestChars": 1200,
    "controlSchema": "./schemas/stage-control.schema.json"
  },
  "prompt": "Inline prompt text with ${item} interpolation",
  "each": { "prompt": "..." },
  "support": { "uses": "./helpers/helper.mjs", "options": { ... } }
}
```

### 2.4 Data Flow (`from` declarations)

- **String**: `"from": "plan"` — depends on stage `plan`
- **Array**: `"from": ["plan", "research-questions"]` — depends on multiple
- **Object (foreach source)**: `"from": { "source": "normalize-claims", "path": "$.claimInventory.verificationCandidates" }` — iterate over JSON path within upstream control output
- **`outputFrom`** (dag containers): specifies which child stage's output represents the container's output

### 2.5 `sourcePolicy`

- `"partial"` — stage can start even if not all upstream stages succeeded (graceful degradation)
- Default (absent) — all upstream stages must succeed

---

## 3. Agent Markdown Format

### 3.1 pi-workflow Agent Format

```markdown
---
name: researcher
description: Read-only source-backed research agent.
tools: read, grep, find, ls, workflow_web_search, ...
readOnly: true
---

# researcher

You are `researcher`, a compact research subagent...

## Scope
...

## Tools
...

## Research Rules
...
```

Frontmatter fields:
- `name` (required): agent identifier
- `description` (required): one-line summary
- `tools`: comma-separated tool list
- `readOnly`: boolean

### 3.2 super-dev-plugin Agent Format

```markdown
---
name: code-assessor
description: Execute concise, specification-aware assessments...
model: inherit
---

<security-baseline>...</security-baseline>
<purpose>...</purpose>
<principles>...</principles>
<input>
  <field name="plugin_root" required="true">...</field>
  <field name="spec_directory" required="true">...</field>
</input>
<process>...</process>
<constraints>...</constraints>
<checklist>...</checklist>
```

Frontmatter fields:
- `name` (required): agent identifier
- `description` (required): one-line summary
- `model`: always `"inherit"` (use parent's model)
- Additional (optional): `kind`, `tools` (as array or `"*"`), `max_turns`, `timeout_mins`

Body uses XML-structured sections: `<security-baseline>`, `<purpose>`, `<principles>`, `<input>`, `<process>`, `<constraints>`, `<checklist>`, `<collaboration>`, `<reference>`, `<gotchas>`, `<tools>`.

### 3.3 Agent Count in super-dev-plugin

**41 agent files** covering:
- Orchestrators: team-lead, team-lead-workflow
- Requirements: requirements-clarifier, bdd-scenario-writer
- Research: research-agent, search-agent, investigator
- Design: architecture-designer, architecture-improver, ui-ux-designer, product-designer
- Specification: spec-writer, spec-reviewer
- Implementation: dev-executor, frontend-developer, backend-developer, rust-developer, golang-developer, ios-developer, android-developer, macos-app-developer, windows-app-developer
- Quality: tdd-guide, qa-agent, e2e-runner, code-reviewer, adversarial-reviewer, security-reviewer
- Documentation: docs-executor, doc-updater, doc-validator, handoff-writer, impl-summary-writer
- Utility: build-cleaner, build-error-resolver, debug-analyzer, code-assessor, planner, refactor-cleaner, prototype-runner, visual-verifier

---

## 4. Helper Format

### 4.1 Signature

```javascript
export default async function helperName({ sources, options, context }) {
  // sources: { [stageId]: controlData }
  // options: from spec.json support.options
  // context: runtime context (cwd, etc.)
  return {
    schema: "helper-output-v1",
    digest: "one-line summary",
    ...controlData
  };
}
```

### 4.2 Key Patterns

- Pure `.mjs` files (ESM)
- Access upstream stage outputs via `sources` parameter
- Return structured data consumed by downstream stages
- May use Node.js `fs/promises`, `path` — file system access for rendering
- Deterministic: no LLM calls, no network access
- Used for:
  - Data compaction/normalization (`normalize-input-packet.mjs`)
  - Evidence auditing/gating (`claim-evidence-gate.mjs`)
  - Final rendering to markdown (`render-executive.mjs`, `render-review-report.mjs`)
  - Finding deduplication (`finding-pipeline.mjs`)

### 4.3 Source Lookup Pattern

```javascript
function findSource(sources, stageId) {
  for (const [specId, source] of Object.entries(sources ?? {})) {
    if (specId === stageId || specId.startsWith(`${stageId}.`)) return source;
  }
  return null;
}
```

---

## 5. Control Schema Format

### 5.1 Structure

JSON Schema subset files (`.schema.json`) in `schemas/` directory:

```json
{
  "type": "object",
  "required": ["field1", "field2"],
  "properties": {
    "field1": { "type": "string", "minLength": 1 },
    "field2": { "type": "array", "items": { "type": "object" }, "minItems": 1 }
  }
}
```

### 5.2 Conventions

- Top-level is always `"type": "object"`
- `required` array lists mandatory fields
- No `$ref` or external references
- Loose inner validation (items as `{ "type": "object" }` without deep property definitions)
- Bounds via `minItems`, `maxItems`, `minLength`
- File naming: `<workflow-name>-<stage-id>-control.schema.json`

---

## 6. super-dev Workflow Script Pattern

### 6.1 Entry Point

The `super-dev.workflow.js` is a Dynamic Workflow script:
```javascript
export const meta = {
  name: 'super-dev-workflow',
  description: '...',
  whenToUse: '...',
  phases: [
    { title: 'Stage 1 — Setup' },
    { title: 'Stage 2 — Requirements + BDD' },
    ...
  ],
};
```

### 6.2 Runtime API Used

- `phase(title)` — declare a workflow phase
- `agent(prompt, { label, phase, agentType, schema })` — spawn subagent with structured output
- `log(message)` — workflow logging
- `args` — input arguments object
- `budget` — token budget management

### 6.3 JSON Schemas (Inline)

All output schemas are declared inline as JavaScript objects (e.g., `REQUIREMENTS_OUTPUT`, `BDD_OUTPUT`, `GATE_VERDICT`). Each requires `additionalProperties: false` and strong typing.

### 6.4 13-Stage Pipeline Flow

```
Stage 1  → Setup (worktree, preflight, path discovery)
Stage 2  → Requirements + BDD (writer + validator pairs)
Stage 3  → Research (iterative deep-dives, max 3)
Stage 4  → Debug Analysis (bugs only)
Stage 5  → Code Assessment
Stage 6  → Design routing (architecture/ui-ux/product)
Stage 6.5 → Prototype (conditional: numeric constants)
Stage 7  → Specification (spec-writer + gate)
Stage 8  → Spec Review (iteration loop, max 3)
Stage 9  → TDD Implementation (per-phase: tdd→dev→summary→visual→qa→e2e)
Stage 10 → Code Review + Adversarial (iteration loop, max 3, pivot trigger)
Stage 11 → Documentation (docs-executor → handoff-writer)
Stage 12 → Cleanup (build-cleaner, sensitive data scan)
Stage 13 → Commit + Merge
```

---

## 7. Mapping super-dev to pi-workflow Artifact Graph

### 7.1 Architecture Decision

The super-dev pipeline is **imperative** (JS with loops, conditionals, state) while pi-workflow specs are **declarative** (DAG of stages with typed data flow). Key adaptations needed:

| super-dev Feature | pi-workflow Equivalent |
|---|---|
| `phase()` + sequential `agent()` | Stages with `from` edges |
| Iteration loops (max 3) | Not directly supported — must encode as fixed-depth stages or use dynamic workflow |
| Conditional stages (bug-only, UI-only) | Potentially use `sourcePolicy: "partial"` or input routing |
| Domain-specialist routing (rust/go/frontend) | Single generic `dev-executor` stage or `foreach` over detected domains |
| Gate scripts (exit-code validation) | Support helpers that enforce pass/fail |
| Retry wrapper (`agentWithRetry`) | Engine-level retry (not helper concern) |

### 7.2 Recommended Hybrid Approach

Given the imperative complexity (iteration loops, conditional branching, domain routing), the plugin should use **pi-workflow's Dynamic Workflow support** via a `.workflow.js` script (like deep-research's support helpers but at the top level), not a pure `spec.json` artifact graph.

However, for maximum compatibility with pi-workflow's tooling (`/workflow list`, `/workflow run`, `/workflow status`), the plugin should still provide:
- A `spec.json` with metadata and the linear DAG outline
- Agent `.md` files for each specialist
- Control schemas for structured outputs
- Support helpers for deterministic gates

---

## 8. Dependencies & TypeScript Config

### 8.1 Required Dependencies

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "dependencies": {
    "@agwab/pi-subagent": "^0.3.6"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "^0.78.0",
    "@types/node": "^24.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 8.2 TypeScript Configuration

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

---

## 9. Pattern Library

### 9.1 Reusable Patterns Identified

| Pattern | Source | Usage |
|---|---|---|
| Agent frontmatter (pi-workflow style) | `pi-workflow/agents/*.md` | Compact: name, description, tools, readOnly |
| Agent frontmatter (super-dev style) | `super-dev-plugin/agents/*.md` | Rich: name, description, model:inherit + XML body |
| Helper source lookup | `normalize-input-packet.mjs` | `findSource(sources, stageId)` |
| Bounded array push | `normalize-input-packet.mjs` | `pushBounded(target, overflow, items, limit, kind)` |
| Support helper signature | All helpers | `export default async function({sources, options, context})` |
| Control schema (loose) | All `schemas/*.json` | Top-level object, required array, minimal inner typing |
| Foreach from JSON path | `deep-research/spec.json` | `"from": {"source":"stage","path":"$.array"}` |
| DAG container | `impact-review/spec.json` | `"type":"dag","outputFrom":"child-stage"` |
| Partial source policy | Multiple specs | `"sourcePolicy":"partial"` for graceful degradation |
| Gate-as-helper | `claim-evidence-gate.mjs` | Deterministic validation in support node |
| Rendering helper | `render-executive.mjs` | Final markdown generation from control data |

### 9.2 Naming Conventions

- Workflow directory: `workflows/<name>/`
- Spec file: `workflows/<name>/spec.json`
- Schemas: `workflows/<name>/schemas/<workflow-name>-<stage-id>-control.schema.json`
- Helpers: `workflows/<name>/helpers/<descriptive-name>.mjs`
- Agents: `agents/<name>.md` (kebab-case)

---

## 10. Recommendations for Implementation

### 10.1 Plugin Structure

```
pi-super-dev/
├── package.json          # pi-workflow plugin metadata
├── tsconfig.json         # TypeScript config (match pi-workflow patterns)
├── src/
│   └── extension.ts      # Plugin registration (minimal — workflows self-register)
├── agents/               # Agent markdown files (ported from super-dev-plugin)
│   ├── requirements-clarifier.md
│   ├── bdd-scenario-writer.md
│   ├── research-agent.md
│   ├── code-assessor.md
│   ├── architecture-designer.md
│   ├── spec-writer.md
│   ├── spec-reviewer.md
│   ├── tdd-guide.md
│   ├── dev-executor.md
│   ├── code-reviewer.md
│   ├── adversarial-reviewer.md
│   ├── docs-executor.md
│   ├── handoff-writer.md
│   ├── build-cleaner.md
│   └── doc-validator.md
├── workflows/
│   └── super-dev/
│       ├── spec.json           # Artifact graph DAG
│       ├── schemas/            # Control schemas per stage
│       │   ├── super-dev-requirements-control.schema.json
│       │   ├── super-dev-bdd-control.schema.json
│       │   ├── super-dev-research-control.schema.json
│       │   └── ...
│       └── helpers/            # Gate validators, renderers
│           ├── gate-requirements.mjs
│           ├── gate-bdd.mjs
│           ├── gate-build.mjs
│           ├── gate-spec-trace.mjs
│           ├── gate-review.mjs
│           └── render-summary.mjs
└── skills/
    └── super-dev-workflow/     # Skill that triggers the workflow
        └── SKILL.md
```

### 10.2 Critical Design Decisions

1. **Iteration loops**: Encode as fixed-depth linear stages (e.g., `spec-review-1`, `spec-review-2`, `spec-review-3`) with `sourcePolicy: "partial"` on later iterations, or use a single `reduce` stage with a self-referencing loop prompt.

2. **Conditional stages**: Use `sourcePolicy: "partial"` so stages that don't apply can be skipped without blocking the DAG. The gate helper returns a "skip" signal.

3. **Domain specialist routing**: Use a single `dev-executor` stage that internally routes, or a `foreach` over detected phases with dynamic agent selection in the prompt.

4. **Gate validation**: Implement as support helpers that return `{ pass: boolean, errors: [...] }`. Downstream stages have `from` edges to gate helpers and check pass status.

5. **Agent format**: Use pi-workflow style (compact frontmatter with tools list) enriched with super-dev body patterns (XML sections for structure). The pi-workflow engine reads `name`, `description`, `tools`, `readOnly` from frontmatter.

### 10.3 Implementation Priority

1. **Phase 1**: Skeleton — package.json, tsconfig, extension.ts, spec.json with stage IDs
2. **Phase 2**: Core agents — port top-priority agents (requirements-clarifier, bdd-scenario-writer, research-agent, code-assessor, spec-writer, dev-executor, code-reviewer, docs-executor)
3. **Phase 3**: Control schemas — one per stage for structured output validation
4. **Phase 4**: Gate helpers — deterministic pass/fail validation
5. **Phase 5**: Integration testing — `/workflow validate super-dev`, `/workflow run super-dev "..."`

### 10.4 Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Iteration loops not directly expressible in DAG | High | Use fixed-depth stages with early-exit via partial source policy |
| 41 agents too many for initial port | Medium | Port core 15 agents; others can be added incrementally |
| super-dev's imperative state (tracking.json) conflicts with pi-workflow store | Medium | Let pi-workflow engine manage state; remove explicit tracking |
| pi-workflow tools API differs from Claude Code tools | Low | Map tool names in agent frontmatter |
| Gate scripts are shell-based in super-dev | Low | Rewrite as .mjs helpers following pi-workflow pattern |

---

## 11. Files Assessed

| Category | Count | Location |
|---|---|---|
| pi-workflow source files | 42 | `pi-workflow/src/*.ts` |
| pi-workflow workflow specs | 4 | `pi-workflow/workflows/*/spec.json` |
| pi-workflow agents | 2 | `pi-workflow/agents/*.md` |
| pi-workflow helpers | 6 | `pi-workflow/workflows/*/helpers/*.mjs` |
| pi-workflow schemas | 19 | `pi-workflow/workflows/*/schemas/*.json` |
| super-dev agents | 41 | `super-dev-plugin/agents/*.md` |
| super-dev workflow script | 1 | `super-dev-plugin/workflows/super-dev.workflow.js` |
| super-dev schemas | 20 | `super-dev-plugin/schemas/*.json` |
| super-dev skills | 29 | `super-dev-plugin/skills/*/SKILL.md` |
| super-dev gate scripts | 7 | `super-dev-plugin/scripts/gates/*.mjs` |
