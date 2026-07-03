# Task List: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 08-task-list.md  
**Created**: 2026-07-03  
**Status**: Final  

---

## Phase 1: Foundation [S]

### Task 1.1: Create package.json [S]

**Description**: Create the npm package manifest with pi extension registration, dependencies, scripts, and metadata.

**Files to create**:
- `package.json`

**Acceptance test**:
- `npm install` succeeds
- `"pi": { "extensions": ["./src/extension.ts"], "skills": ["./skills/super-dev"] }` exists
- `"keywords"` includes `"pi-package"`, `"pi-extension"`, `"workflow"`, `"pi"`
- `peerDependencies` declares `@earendil-works/pi-coding-agent`
- `dependencies` declares `@agwab/pi-workflow`
- `type` is `"module"`

---

### Task 1.2: Create tsconfig.json [S]

**Description**: Create TypeScript configuration targeting ES2022 with NodeNext module resolution and strict mode.

**Files to create**:
- `tsconfig.json`

**Acceptance test**:
- `target` is `"ES2022"`
- `module` is `"NodeNext"`
- `moduleResolution` is `"NodeNext"`
- `strict` is `true`
- `noEmit` is `true`

---

### Task 1.3: Create extension.ts [S]

**Description**: Create the minimal pi extension entry point. pi-workflow auto-discovers workflows and agents from the package layout — no explicit registration needed.

**Files to create**:
- `src/extension.ts`

**Acceptance test**:
- `npm run typecheck` exits 0
- File exports a default function accepting `ExtensionAPI`
- Function body is empty or contains only comments (auto-discovery handles registration)

---

### Task 1.4: Create directory structure and README [S]

**Description**: Create all required directories and the README.md + LICENSE files.

**Files to create**:
- `README.md`
- `LICENSE`
- `agents/.gitkeep` (placeholder)
- `workflows/super-dev/schemas/.gitkeep` (placeholder)
- `workflows/super-dev/helpers/.gitkeep` (placeholder)
- `skills/super-dev/.gitkeep` (placeholder)
- `docs/.gitkeep` (placeholder)

**Acceptance test**:
- All directories exist
- README contains project name, description, installation, and usage overview
- LICENSE is MIT

---

## Phase 2: Agent Definitions [M]

### Task 2.1: Port orchestrator agent [S]

**Description**: Create a new orchestrator agent that handles setup (worktree creation, project detection) and merge (final commit) operations.

**Files to create**:
- `agents/orchestrator.md`

**Acceptance test**:
- Frontmatter: `name: orchestrator`, `tools: read, grep, find, ls, write, edit, bash`, `readOnly: false`
- No `model`, `kind`, `max_turns`, `timeout_mins` in frontmatter
- System prompt covers worktree creation, project detection, git merge operations

---

### Task 2.2: Port requirements-clarifier agent [S]

**Description**: Port from `super-dev-plugin/agents/requirements-clarifier.md`. Adapt frontmatter, preserve system prompt.

**Files to create**:
- `agents/requirements-clarifier.md`

**Acceptance test**:
- Frontmatter: `name: requirements-clarifier`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt preserved (purpose, principles, process sections)
- No references to `plugin_root`, `Skill(...)`, or team management

---

### Task 2.3: Port bdd-scenario-writer agent [S]

**Description**: Port from `super-dev-plugin/agents/bdd-scenario-writer.md`.

**Files to create**:
- `agents/bdd-scenario-writer.md`

**Acceptance test**:
- Frontmatter: `name: bdd-scenario-writer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers Given/When/Then scenario writing from requirements

---

### Task 2.4: Port research-agent [S]

**Description**: Port from `super-dev-plugin/agents/research-agent.md`. Include web research tools.

**Files to create**:
- `agents/research-agent.md`

**Acceptance test**:
- Frontmatter: `name: research-agent`, `tools: read, grep, find, ls, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read`, `readOnly: true`
- System prompt covers research methodology and citation practices

---

### Task 2.5: Port debug-analyzer agent [S]

**Description**: Port from `super-dev-plugin/agents/debug-analyzer.md`.

**Files to create**:
- `agents/debug-analyzer.md`

**Acceptance test**:
- Frontmatter: `name: debug-analyzer`, `tools: read, grep, find, ls, bash`, `readOnly: true`
- System prompt covers hypothesis-driven root cause analysis

---

### Task 2.6: Port code-assessor agent [S]

**Description**: Port from `super-dev-plugin/agents/code-assessor.md`.

**Files to create**:
- `agents/code-assessor.md`

**Acceptance test**:
- Frontmatter: `name: code-assessor`, `tools: read, grep, find, ls`, `readOnly: true`
- System prompt covers pattern discovery, architecture smell detection

---

### Task 2.7: Port architecture-designer agent [S]

**Description**: Port from `super-dev-plugin/agents/architecture-designer.md`.

**Files to create**:
- `agents/architecture-designer.md`

**Acceptance test**:
- Frontmatter: `name: architecture-designer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers new module architecture design

---

### Task 2.8: Port architecture-improver agent [S]

**Description**: Port from `super-dev-plugin/agents/architecture-improver.md`.

**Files to create**:
- `agents/architecture-improver.md`

**Acceptance test**:
- Frontmatter: `name: architecture-improver`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers refactoring/deepening existing architecture

---

### Task 2.9: Port ui-ux-designer agent [S]

**Description**: Port from `super-dev-plugin/agents/ui-ux-designer.md`.

**Files to create**:
- `agents/ui-ux-designer.md`

**Acceptance test**:
- Frontmatter: `name: ui-ux-designer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers UI/UX specification with wireframes and tokens

---

### Task 2.10: Port product-designer agent [S]

**Description**: Port from `super-dev-plugin/agents/product-designer.md`.

**Files to create**:
- `agents/product-designer.md`

**Acceptance test**:
- Frontmatter: `name: product-designer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers composite architecture + UI design orchestration

---

### Task 2.11: Port prototype-runner agent [S]

**Description**: Port from `super-dev-plugin/agents/prototype-runner.md`.

**Files to create**:
- `agents/prototype-runner.md`

**Acceptance test**:
- Frontmatter: `name: prototype-runner`, `tools: read, grep, find, ls, write, edit, bash`, `readOnly: false`
- System prompt covers empirical validation of numeric design constants

---

### Task 2.12: Port spec-writer agent [S]

**Description**: Port from `super-dev-plugin/agents/spec-writer.md`.

**Files to create**:
- `agents/spec-writer.md`

**Acceptance test**:
- Frontmatter: `name: spec-writer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers specification + implementation plan + task list creation

---

### Task 2.13: Port spec-reviewer agent [S]

**Description**: Port from `super-dev-plugin/agents/spec-reviewer.md`.

**Files to create**:
- `agents/spec-reviewer.md`

**Acceptance test**:
- Frontmatter: `name: spec-reviewer`, `tools: read, grep, find, ls`, `readOnly: true`
- System prompt covers multi-dimensional spec review

---

### Task 2.14: Port tdd-guide agent [S]

**Description**: Port from `super-dev-plugin/agents/tdd-guide.md`.

**Files to create**:
- `agents/tdd-guide.md`

**Acceptance test**:
- Frontmatter: `name: tdd-guide`, `tools: read, grep, find, ls, write, edit, bash`, `readOnly: false`
- System prompt covers write-tests-first methodology

---

### Task 2.15: Port implementer agent [S]

**Description**: Port from `super-dev-plugin/agents/dev-executor.md`. Rename to `implementer`. This is the generic implementation agent that receives language-specific instructions via prompt.

**Files to create**:
- `agents/implementer.md`

**Acceptance test**:
- Frontmatter: `name: implementer`, `tools: read, grep, find, ls, write, edit, bash`, `readOnly: false`
- System prompt covers making tests pass, code quality, following existing patterns

---

### Task 2.16: Port qa-agent [S]

**Description**: Port from `super-dev-plugin/agents/qa-agent.md`.

**Files to create**:
- `agents/qa-agent.md`

**Acceptance test**:
- Frontmatter: `name: qa-agent`, `tools: read, grep, find, ls, bash`, `readOnly: true`
- System prompt covers test execution, coverage verification, build validation

---

### Task 2.17: Port code-reviewer agent [S]

**Description**: Port from `super-dev-plugin/agents/code-reviewer.md`.

**Files to create**:
- `agents/code-reviewer.md`

**Acceptance test**:
- Frontmatter: `name: code-reviewer`, `tools: read, grep, find, ls`, `readOnly: true`
- System prompt covers specification-first code review across quality dimensions

---

### Task 2.18: Port adversarial-reviewer agent [S]

**Description**: Port from `super-dev-plugin/agents/adversarial-reviewer.md`.

**Files to create**:
- `agents/adversarial-reviewer.md`

**Acceptance test**:
- Frontmatter: `name: adversarial-reviewer`, `tools: read, grep, find, ls`, `readOnly: true`
- System prompt covers skeptic/architect/minimalist review lenses

---

### Task 2.19: Port docs-executor agent [S]

**Description**: Port from `super-dev-plugin/agents/docs-executor.md`.

**Files to create**:
- `agents/docs-executor.md`

**Acceptance test**:
- Frontmatter: `name: docs-executor`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers documentation updates post-implementation

---

### Task 2.20: Port handoff-writer agent [S]

**Description**: Port from `super-dev-plugin/agents/handoff-writer.md`.

**Files to create**:
- `agents/handoff-writer.md`

**Acceptance test**:
- Frontmatter: `name: handoff-writer`, `tools: read, grep, find, ls, write, edit`, `readOnly: false`
- System prompt covers session handoff document generation

---

### Task 2.21: Port build-cleaner agent [S]

**Description**: Port from `super-dev-plugin/agents/build-cleaner.md`.

**Files to create**:
- `agents/build-cleaner.md`

**Acceptance test**:
- Frontmatter: `name: build-cleaner`, `tools: read, grep, find, ls, bash`, `readOnly: true`
- System prompt covers build artifact cleanup and sensitive data scanning

---

## Phase 3: Control Schemas + Spec Skeleton [M]

### Task 3.1: Create setup control schema [S]

**Description**: Define the JSON Schema for the setup stage control output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-setup-control.schema.json`

**Acceptance test**:
- Valid JSON, no `$ref`/`$defs`/`definitions`/`pattern`
- Required fields: `worktreePath`, `specDirectory`, `language`, `specIdentifier`
- `language` uses `enum`: `["rust", "go", "frontend", "backend", "mixed"]`

---

### Task 3.2: Create classify-task control schema [S]

**Description**: Define the JSON Schema for classify-task helper output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-classify-task-control.schema.json`

**Acceptance test**:
- Required: `taskType`, `uiScope`, `language`
- `taskType` enum: `["bug", "feature", "refactor"]`
- `uiScope` enum: `["none", "ui-only", "ui+arch"]`

---

### Task 3.3: Create requirements control schema [S]

**Description**: Define the JSON Schema for requirements-clarifier agent output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-requirements-control.schema.json`

**Acceptance test**:
- Required: `docPath`, `featureName`, `acCount`
- `acCount` has `minimum: 1`

---

### Task 3.4: Create gate verdict schema (shared) [S]

**Description**: Define the shared gate verdict schema used by all 6 gate helpers.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-gate-verdict.schema.json`

**Acceptance test**:
- Required: `pass`, `gate`
- `pass` is boolean, `gate` is string, `errors` is optional array of strings
- `additionalProperties: false`

---

### Task 3.5: Create BDD control schema [S]

**Description**: Define the JSON Schema for bdd-scenario-writer output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-bdd-control.schema.json`

**Acceptance test**:
- Required: `docPath`, `scenarioCount`
- `scenarioCount` has `minimum: 1`

---

### Task 3.6: Create research control schema [S]

**Description**: Define the JSON Schema for research-agent output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-research-control.schema.json`

**Acceptance test**:
- Required: `docPath`
- `openIssues` is array of strings

---

### Task 3.7: Create debug control schema [S]

**Description**: Define the JSON Schema for debug-analyzer output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-debug-control.schema.json`

**Acceptance test**:
- Required: `docPath`, `hypotheses`
- `hypotheses` has `minItems: 1`

---

### Task 3.8: Create assessment control schema [S]

**Description**: Define the JSON Schema for code-assessor output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-assessment-control.schema.json`

**Acceptance test**:
- Required: `docPath`, `patterns`
- `patterns` has `minItems: 1`

---

### Task 3.9: Create route-designer control schema [S]

**Description**: Define the JSON Schema for route-designer helper output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-route-designer-control.schema.json`

**Acceptance test**:
- Required: `designerAgent`, `reason`
- `designerAgent` type is `["string", "null"]` (nullable)

---

### Task 3.10: Create design control schema [S]

**Description**: Define the JSON Schema for design agent output (shared by all 4 designer agents).

**Files to create**:
- `workflows/super-dev/schemas/super-dev-design-control.schema.json`

**Acceptance test**:
- Required: `designer`, `modules`
- `modules` has `minItems: 1`
- `hasNumericConstants` is boolean

---

### Task 3.11: Create check-prototype control schema [S]

**Description**: Define the JSON Schema for check-prototype-needed helper output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-check-prototype-control.schema.json`

**Acceptance test**:
- Required: `needed`
- `needed` is boolean
- `constants` is optional array of strings

---

### Task 3.12: Create spec control schema [S]

**Description**: Define the JSON Schema for spec-writer output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-spec-control.schema.json`

**Acceptance test**:
- Required: `specificationPath`, `phaseCount`, `phases`
- `phaseCount` has `minimum: 1`
- `phases` has `minItems: 1`

---

### Task 3.13: Create spec-review control schema [S]

**Description**: Define the JSON Schema for spec-reviewer output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-spec-review-control.schema.json`

**Acceptance test**:
- Required: `verdict`
- `verdict` enum: `["Approved", "Approved with Comments", "Changes Requested"]`

---

### Task 3.14: Create implementation control schema [S]

**Description**: Define the JSON Schema for the implementation dynamic stage final output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-implementation-control.schema.json`

**Acceptance test**:
- Required: `phasesCompleted`, `totalPhases`, `allGreen`
- `allGreen` is boolean

---

### Task 3.15: Create code-review control schema [S]

**Description**: Define the JSON Schema for code-reviewer/adversarial-reviewer output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-code-review-control.schema.json`

**Acceptance test**:
- Required: `verdict`
- `verdict` enum: `["Approved", "Approved with Comments", "Changes Requested"]`

---

### Task 3.16: Create docs control schema [S]

**Description**: Define the JSON Schema for docs-executor output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-docs-control.schema.json`

**Acceptance test**:
- Required: `docsUpdated`
- `docsUpdated` is boolean

---

### Task 3.17: Create cleanup control schema [S]

**Description**: Define the JSON Schema for cleanup helper output.

**Files to create**:
- `workflows/super-dev/schemas/super-dev-cleanup-control.schema.json`

**Acceptance test**:
- Required: `blocked`
- `blocked` is boolean
- `sensitiveDataFindings` is array of strings

---

### Task 3.18: Create spec.json skeleton [M]

**Description**: Create the workflow spec with two stages: declarative `setup` + dynamic `pipeline`. The dynamic controller reference points to `./helpers/implementation-controller.mjs` (created in Phase 5).

**Files to create**:
- `workflows/super-dev/spec.json`

**Acceptance test**:
- `schemaVersion` is `1`
- `name` is `"super-dev"`
- `artifactGraph.stages` has 2 entries: `setup` (single) + `pipeline` (dynamic)
- Setup stage references `./schemas/super-dev-setup-control.schema.json`
- Pipeline stage references `./helpers/implementation-controller.mjs`
- Budget: `maxAgents: 200`, `maxConcurrency: 3`
- `/workflow validate super-dev` reports no schema blockers (controller file may warn until Phase 5)

---

## Phase 4: Gate + Routing Helpers [M]

### Task 4.1: Implement classify-task.mjs [S]

**Description**: Routing helper that determines task type (bug/feature/refactor) and UI scope from keyword analysis.

**Files to create**:
- `workflows/super-dev/helpers/classify-task.mjs`

**Acceptance test**:
- "fix the crash" → `taskType: "bug"`
- "add a user profile page" → `taskType: "feature"`
- "refactor the database layer" → `taskType: "refactor"`
- Returns `{ schema: "helper-output-v1", digest, value: { taskType, uiScope, language, isWebUi, skipStages } }`

---

### Task 4.2: Implement route-designer.mjs [S]

**Description**: Routing helper that selects the appropriate design agent based on task type and UI scope.

**Files to create**:
- `workflows/super-dev/helpers/route-designer.mjs`

**Acceptance test**:
- `bug` → `designerAgent: null`
- `feature` + `none` → `designerAgent: "architecture-designer"`
- `feature` + `ui+arch` → `designerAgent: "product-designer"`
- `feature` + `ui-only` → `designerAgent: "ui-ux-designer"`
- `refactor` → `designerAgent: "architecture-improver"`

---

### Task 4.3: Implement route-specialist.mjs [S]

**Description**: Routing helper that determines implementation specialist based on detected language. Always returns "implementer" with language-specific prompt instructions.

**Files to create**:
- `workflows/super-dev/helpers/route-specialist.mjs`

**Acceptance test**:
- `language: "rust"` → `specialistAgent: "implementer"`, includes rust-specific instructions
- `language: "frontend"` → `specialistAgent: "implementer"`, includes frontend-specific instructions
- Returns `{ schema: "helper-output-v1", digest, value: { specialistAgent, languageInstructions, reason } }`

---

### Task 4.4: Implement check-prototype-needed.mjs [S]

**Description**: Utility helper that checks if the design contains numeric constants requiring empirical validation.

**Files to create**:
- `workflows/super-dev/helpers/check-prototype-needed.mjs`

**Acceptance test**:
- `design.hasNumericConstants: true` → `needed: true`
- `design.hasNumericConstants: false` → `needed: false`
- Missing design source → `needed: false`

---

### Task 4.5: Implement gate-requirements.mjs [S]

**Description**: Gate helper validating requirements document output.

**Files to create**:
- `workflows/super-dev/helpers/gate-requirements.mjs`

**Acceptance test**:
- Valid input (docPath, acCount >= 1, summary) → `pass: true, errors: []`
- Missing acCount → `pass: false, errors: ["Missing acceptance criteria"]`
- Missing docPath → `pass: false, errors: ["No document path returned"]`
- Empty sources → `pass: false, errors: [...]`

---

### Task 4.6: Implement gate-bdd.mjs [S]

**Description**: Gate helper validating BDD scenarios output.

**Files to create**:
- `workflows/super-dev/helpers/gate-bdd.mjs`

**Acceptance test**:
- Valid input (docPath, scenarioCount >= 1) → `pass: true`
- Missing docPath → `pass: false`
- `scenarioCount: 0` → `pass: false, errors: ["No scenarios written"]`

---

### Task 4.7: Implement gate-spec-trace.mjs [S]

**Description**: Gate helper validating specification output (traceability to requirements).

**Files to create**:
- `workflows/super-dev/helpers/gate-spec-trace.mjs`

**Acceptance test**:
- Valid spec (specificationPath, phaseCount >= 1, phases non-empty) → `pass: true`
- Missing specificationPath → `pass: false`
- Empty phases → `pass: false, errors: ["No implementation phases defined"]`

---

### Task 4.8: Implement gate-spec-review.mjs [S]

**Description**: Gate helper validating spec review verdict.

**Files to create**:
- `workflows/super-dev/helpers/gate-spec-review.mjs`

**Acceptance test**:
- `verdict: "Approved"` → `pass: true`
- `verdict: "Approved with Comments"` → `pass: true`
- `verdict: "Changes Requested"` → `pass: false`

---

### Task 4.9: Implement gate-build.mjs [S]

**Description**: Gate helper validating build and test results.

**Files to create**:
- `workflows/super-dev/helpers/gate-build.mjs`

**Acceptance test**:
- `allTestsPass: true, buildSuccess: true` → `pass: true`
- `allTestsPass: false` → `pass: false, errors: ["Tests failing"]`
- `buildSuccess: false` → `pass: false, errors: ["Build failed"]`

---

### Task 4.10: Implement gate-review.mjs [S]

**Description**: Gate helper validating merged code review verdict.

**Files to create**:
- `workflows/super-dev/helpers/gate-review.mjs`

**Acceptance test**:
- `verdict: "Approved"` → `pass: true`
- `verdict: "Changes Requested"` → `pass: false`

---

### Task 4.11: Implement merge-review-verdicts.mjs [S]

**Description**: Utility helper that merges code-reviewer and adversarial-reviewer verdicts, taking the stricter result.

**Files to create**:
- `workflows/super-dev/helpers/merge-review-verdicts.mjs`

**Acceptance test**:
- Both "Approved" → merged: "Approved"
- "Approved" + "Changes Requested" → merged: "Changes Requested"
- "Approved with Comments" + "Changes Requested" → merged: "Changes Requested"
- Findings from both are concatenated

---

### Task 4.12: Implement cleanup.mjs [M]

**Description**: Utility helper that scans the worktree for build artifacts, temporary files, and sensitive data. Returns whether the merge should be blocked.

**Files to create**:
- `workflows/super-dev/helpers/cleanup.mjs`

**Acceptance test**:
- Detects common build directories (node_modules, target, dist, __pycache__)
- Scans for `.env` files, API keys, private keys
- Returns `blocked: true` if sensitive data found
- Returns `blocked: false` if clean

---

## Phase 5: Dynamic Controller [L]

### Task 5.1: Implement controller scaffold with utility functions [M]

**Description**: Create `implementation-controller.mjs` with the core structure: utility functions (`runLoop`, `buildPrompt`, `padRound`), import statements, and the main controller function shell.

**Files to create**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- File is valid ESM with `export default async function controller(ctx)`
- `runLoop(ctx, { phase, agent, gate, promptBuilder, maxRounds })` utility implemented
- `buildPrompt(template, vars)` utility implemented
- File loads without import errors

---

### Task 5.2: Implement classify + requirements + BDD + research phases [M]

**Description**: Add pipeline phases 2A (classify), 2B (requirements loop), 2C (BDD loop), and 3 (research loop) to the controller.

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- Classify-task calls `ctx.helper("classify-task", ...)`
- Requirements loop: max 3 rounds, calls requirements-clarifier agent then gate-requirements helper
- BDD loop: same pattern with bdd-scenario-writer + gate-bdd
- Research loop: same pattern with research-agent + openIssues check
- All use stable task IDs: `pipeline.<phase>.r<round>.<op>`

---

### Task 5.3: Implement debug + assessment + design + prototype phases [M]

**Description**: Add pipeline phases 4 (conditional debug), 5 (assessment), 6 (routed design), and 6.5 (conditional prototype loop).

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- Debug skipped when `taskType !== "bug"`
- Assessment always runs
- Route-designer called; design agent spawned only when `designerAgent !== null`
- Check-prototype called; prototype loop runs only when `needed === true`
- All conditional branches produce null/empty results when skipped

---

### Task 5.4: Implement spec + spec-review phases [S]

**Description**: Add pipeline phases 7 (spec loop) and 8 (spec-review loop).

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- Spec loop: max 3, spec-writer + gate-spec-trace
- Spec-review loop: max 3, spec-reviewer + gate-spec-review
- Both use stable task IDs

---

### Task 5.5: Implement per-phase TDD implementation [L]

**Description**: Add pipeline phase 9 — the per-phase TDD implementation loop with specialist routing, QA verification, gate checking, retry logic, and git commits.

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- Iterates over `spec.phases` sequentially
- Per phase: tdd-guide → route-specialist → implementer → qa-agent → gate-build
- Retries failed phases up to 3 times
- Terminates early if a phase cannot pass after 3 attempts
- Git commit via orchestrator agent after each green phase
- Budget check before each agent spawn

---

### Task 5.6: Implement code-review loop [M]

**Description**: Add pipeline phase 10 — parallel code-reviewer + adversarial-reviewer, merged verdict, conditional fix-issues.

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- `ctx.parallel()` used for code-reviewer + adversarial-reviewer
- `merge-review-verdicts` helper called on both outputs
- Loop terminates on "Approved" or "Approved with Comments"
- fix-issues agent spawned on "Changes Requested" (if rounds remaining)
- Max 3 rounds

---

### Task 5.7: Implement docs + cleanup + merge phases [S]

**Description**: Add pipeline phases 11 (docs), 12 (cleanup), and 13 (conditional merge).

**Files to modify**:
- `workflows/super-dev/helpers/implementation-controller.mjs`

**Acceptance test**:
- Docs: spawns docs-executor agent
- Cleanup: calls cleanup helper
- Merge: conditional on `cleanup.blocked === false`; spawns orchestrator for merge if not blocked
- Pipeline ends cleanly whether merge executes or is skipped

---

## Phase 6: Skill + Integration [S]

### Task 6.1: Create SKILL.md [S]

**Description**: Create the skill trigger definition that dispatches to `workflow_run`.

**Files to create**:
- `skills/super-dev/SKILL.md`

**Acceptance test**:
- Triggers on: "implement", "build", "fix bug", "refactor", "add feature", "develop this", "help me build", "optimize performance", "resolve deprecation"
- Does NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits
- Action: `workflow_run({ workflow: "super-dev", task: "<user's full request>" })`
- User's language, file references, and constraints preserved in task

---

### Task 6.2: Create usage.md [S]

**Description**: Write user-facing documentation covering installation, triggering the workflow, stage descriptions, and customization options.

**Files to create**:
- `docs/usage.md`

**Acceptance test**:
- Covers: installation (`pi install`), invocation methods (skill trigger, direct `/workflow run`)
- Lists all 13 stages with brief descriptions
- Documents `input.skipWorktree` and `input.skipStages` options
- Documents agent list and tool ceilings

---

### Task 6.3: Finalize spec.json [S]

**Description**: Ensure spec.json correctly references the controller, has proper budget settings, and all paths resolve.

**Files to modify**:
- `workflows/super-dev/spec.json`

**Acceptance test**:
- `dynamic.uses` points to existing `./helpers/implementation-controller.mjs`
- Setup stage `output.controlSchema` points to existing schema file
- `/workflow validate super-dev` passes with no blockers

---

## Phase 7: Validation + Smoke Test [M]

### Task 7.1: Run typecheck [S]

**Description**: Execute `npm run typecheck` and fix any TypeScript errors.

**Files to modify**: Any files with type errors (expected: none if Phase 1 was done correctly)

**Acceptance test**:
- `npm run typecheck` exits 0 with zero errors

---

### Task 7.2: Run workflow validation [S]

**Description**: Execute `/workflow validate super-dev` and resolve all blockers and warnings.

**Files to modify**: Any files flagged by validation

**Acceptance test**:
- Zero blockers
- Zero unresolved warnings
- All agent references resolve
- All schema references resolve
- All helper references resolve

---

### Task 7.3: Verify agent discovery [S]

**Description**: Confirm all 21 agents are discoverable by the pi-workflow engine.

**Files to modify**: Any agent files with frontmatter issues

**Acceptance test**:
- `/workflow agents` lists all 21 agents
- No loading errors
- Each agent has name, description, tools displayed correctly

---

### Task 7.4: Run prohibition audit [S]

**Description**: Grep the codebase for prohibited patterns to ensure NFR-03 compliance.

**Files to modify**: Any files containing prohibited patterns

**Acceptance test**:
- `grep -r "agentWithRetry" .` → 0 results
- `grep -r "tracking.json" .` → 0 results (except docs/specs)
- `grep -r "TeamCreate\|TeamDelete" .` → 0 results
- `grep -r '"\$ref"\|"\$defs"\|"definitions"\|"pattern"' workflows/` → 0 results in schema files
- `grep -r '"*"' agents/` → 0 results (no wildcard tools)
- `grep -r "model: inherit\|kind:\|max_turns:\|timeout_mins:" agents/` → 0 results

---

### Task 7.5: Execute smoke test [M]

**Description**: Run `/workflow run super-dev "add a hello world endpoint"` in a test project directory and verify progression through at least Stages 1-3.

**Files to modify**: Any files causing runtime failures

**Acceptance test**:
- Setup stage completes: produces control.json with worktreePath and specDirectory
- Classify-task helper completes: identifies taskType as "feature"
- Requirements loop begins: requirements-clarifier agent is spawned
- No schema validation errors
- No scheduling errors
- No unresolved agent references at runtime

---

### Task 7.6: Final documentation sync [S]

**Description**: Ensure README.md reflects the final implementation state and all documentation is consistent.

**Files to modify**:
- `README.md`

**Acceptance test**:
- README mentions all 21 agents, 17 schemas, 12 helpers
- Installation instructions are accurate
- No references to unimplemented features
