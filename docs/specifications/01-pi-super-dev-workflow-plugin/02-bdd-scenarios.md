# BDD Scenarios: pi-super-dev Workflow Plugin

**Spec Identifier**: 01-pi-super-dev-workflow-plugin  
**Document**: 02-bdd-scenarios.md  
**Created**: 2026-07-03  

---

## Feature Area 1: Plugin Registration and Discovery

### SCENARIO-001: TypeScript type check passes (AC-01)

```gherkin
Given the plugin source code is complete under "src/", "agents/", "workflows/", "skills/"
  And "tsconfig.json" targets ES2022 with NodeNext module resolution and strict mode
When "npm run typecheck" is executed
Then the command exits with code 0
  And zero TypeScript errors are reported
```

### SCENARIO-002: TypeScript type check fails on invalid code (AC-01, edge case)

```gherkin
Given the plugin source contains a type error in "src/extension.ts"
When "npm run typecheck" is executed
Then the command exits with a non-zero code
  And the error output identifies the file and line with the type mismatch
```

### SCENARIO-003: Workflow validation passes (AC-02)

```gherkin
Given the workflow spec "workflows/super-dev/spec.json" exists
  And all 17 control schemas exist under "workflows/super-dev/schemas/"
  And all 10 support helpers exist under "workflows/super-dev/helpers/"
  And all 21 agent markdown files exist under "agents/"
When "/workflow validate super-dev" is executed
Then it reports no blockers
  And it reports no unresolved warnings
```

### SCENARIO-004: Workflow validation reports missing helper (AC-02, edge case)

```gherkin
Given the workflow spec references "helpers/gate-requirements.mjs"
  But the file "workflows/super-dev/helpers/gate-requirements.mjs" does not exist
When "/workflow validate super-dev" is executed
Then it reports a blocker referencing the missing helper file
```

### SCENARIO-005: Workflow validation reports missing agent (AC-02, edge case)

```gherkin
Given the workflow spec references agent "research-agent"
  But the file "agents/research-agent.md" does not exist
When "/workflow validate super-dev" is executed
Then it reports a blocker referencing the unresolved agent definition
```

### SCENARIO-006: Plugin appears in workflow list (AC-03)

```gherkin
Given the plugin is installed with a valid "package.json" declaring pi-workflow extension registration
  And "src/extension.ts" registers the "super-dev" workflow
When "/workflow list" is executed
Then the output includes an entry named "super-dev"
  And the description contains "13-stage development pipeline"
```

### SCENARIO-007: Plugin not listed when extension registration is missing (AC-03, edge case)

```gherkin
Given "package.json" does not declare the pi-workflow extension entry point
When "/workflow list" is executed
Then the output does not include "super-dev"
```

---

## Feature Area 2: Agent Definitions

### SCENARIO-008: All 21 agents load successfully (AC-04)

```gherkin
Given 21 agent markdown files exist under "agents/"
  And each agent file contains valid frontmatter with "name", "tools", and "readOnly" fields
  And no agent file contains Claude Code-specific frontmatter ("model: inherit", "kind: local", "max_turns", "timeout_mins")
When agent discovery runs via "/workflow agents"
Then all 21 agents load without error
  And the listed agents include: orchestrator, requirements-clarifier, bdd-scenario-writer, research-agent, debug-analyzer, code-assessor, architecture-designer, architecture-improver, ui-ux-designer, product-designer, prototype-runner, spec-writer, spec-reviewer, tdd-guide, implementer, qa-agent, code-reviewer, adversarial-reviewer, docs-executor, handoff-writer, build-cleaner
```

### SCENARIO-009: Agent with wildcard tool ceiling rejected (AC-04, edge case)

```gherkin
Given the agent file "agents/orchestrator.md" specifies tools as ["*"]
When "/workflow validate super-dev" is executed
Then it reports a warning or blocker that wildcard tool ceilings are not permitted
```

### SCENARIO-010: Agent with Claude Code-specific frontmatter rejected (AC-04, edge case)

```gherkin
Given the agent file "agents/research-agent.md" contains "model: inherit" in its frontmatter
When "/workflow validate super-dev" is executed
Then it reports a warning about unsupported frontmatter fields
```

### SCENARIO-011: Read-only agent has correct tool ceiling (AC-04)

```gherkin
Given the agent file "agents/code-assessor.md" specifies:
  | Field    | Value                          |
  | tools    | ["read", "grep", "find", "ls"] |
  | readOnly | true                           |
When agent discovery runs
Then "code-assessor" loads with readOnly=true
  And its tool ceiling is exactly ["read", "grep", "find", "ls"]
```

### SCENARIO-012: Implementer agent has write and bash tools (AC-04)

```gherkin
Given the agent file "agents/implementer.md" specifies:
  | Field    | Value                                              |
  | tools    | ["read", "grep", "find", "ls", "write", "edit", "bash"] |
  | readOnly | false                                              |
When agent discovery runs
Then "implementer" loads with readOnly=false
  And its tool ceiling includes "write", "edit", and "bash"
```

---

## Feature Area 3: Control Schemas

### SCENARIO-013: All 17 schemas pass validation (AC-05)

```gherkin
Given 17 control schema JSON files exist under "workflows/super-dev/schemas/"
  And each schema uses only: "type", "required", "properties", "items", "enum", "const", bounds, "additionalProperties"
When each schema is validated against pi-workflow's supported JSON Schema subset
Then all 17 schemas pass validation
```

### SCENARIO-014: Schema using $ref is rejected (AC-05, edge case)

```gherkin
Given "workflows/super-dev/schemas/setup-control.schema.json" contains a "$ref" keyword
When the schema is validated against pi-workflow's supported JSON Schema subset
Then validation fails with an error identifying the unsupported "$ref" keyword
```

### SCENARIO-015: Schema using $defs is rejected (AC-05, edge case)

```gherkin
Given "workflows/super-dev/schemas/spec-control.schema.json" contains a "$defs" keyword
When the schema is validated against pi-workflow's supported JSON Schema subset
Then validation fails with an error identifying the unsupported "$defs" keyword
```

### SCENARIO-016: Schema using pattern is rejected (AC-05, edge case)

```gherkin
Given "workflows/super-dev/schemas/requirements-control.schema.json" contains a "pattern" keyword
When the schema is validated against pi-workflow's supported JSON Schema subset
Then validation fails with an error identifying the unsupported "pattern" keyword
```

### SCENARIO-017: Gate verdict schema structure is correct (AC-05)

```gherkin
Given any gate control schema (e.g., "gate-requirements", "gate-bdd", "gate-spec-trace")
When the schema is inspected
Then it requires properties "pass" (boolean) and "gate" (string)
  And it defines an optional "errors" property as an array of strings
  And "additionalProperties" is false
```

### SCENARIO-018: Schema file is malformed JSON (AC-05, edge case)

```gherkin
Given "workflows/super-dev/schemas/setup-control.schema.json" contains invalid JSON syntax
When "/workflow validate super-dev" is executed
Then it reports a blocker identifying the malformed schema file
```

---

## Feature Area 4: Support Helpers

### SCENARIO-019: All 10 helpers export correct signature (AC-06)

```gherkin
Given 10 support helper ".mjs" files exist under "workflows/super-dev/helpers/"
When each helper module is dynamically imported
Then each exports a default async function
  And each function accepts a single argument with shape { sources, options, context }
  And each function returns an object with shape { schema, digest, value }
```

### SCENARIO-020: Gate helper returns pass on valid input (AC-06)

```gherkin
Given the helper "gate-requirements.mjs" is loaded
  And sources contain "write-requirements" with { docPath: "/path/req.md", acCount: 5, summary: "..." }
When the helper is invoked with those sources
Then it returns { schema: "helper-output-v1", digest: "PASS", value: { pass: true, errors: [], gate: "gate-requirements" } }
```

### SCENARIO-021: Gate helper returns fail on missing acceptance criteria (AC-06, edge case)

```gherkin
Given the helper "gate-requirements.mjs" is loaded
  And sources contain "write-requirements" with { docPath: "/path/req.md", acCount: 0, summary: "..." }
When the helper is invoked with those sources
Then it returns value.pass as false
  And value.errors contains "Missing acceptance criteria"
  And value.gate equals "gate-requirements"
```

### SCENARIO-022: Gate helper returns fail on missing document path (AC-06, edge case)

```gherkin
Given the helper "gate-requirements.mjs" is loaded
  And sources contain "write-requirements" with { docPath: null, acCount: 3, summary: "..." }
When the helper is invoked with those sources
Then it returns value.pass as false
  And value.errors contains "No document path returned"
```

### SCENARIO-023: Routing helper classify-task identifies bug (AC-06)

```gherkin
Given the helper "classify-task.mjs" is loaded
  And sources contain "setup" with { worktreePath: "/tmp/wt", language: "rust", isWebUi: false }
  And options contain { runtimeTask: "fix the crash in auth module" }
When the helper is invoked
Then it returns value.taskType as "bug"
  And value.language as "rust"
```

### SCENARIO-024: Routing helper classify-task identifies feature (AC-06)

```gherkin
Given the helper "classify-task.mjs" is loaded
  And sources contain "setup" with { worktreePath: "/tmp/wt", language: "frontend", isWebUi: true }
  And options contain { runtimeTask: "add a user profile page" }
When the helper is invoked
Then it returns value.taskType as "feature"
  And value.uiScope as "ui+arch"
```

### SCENARIO-025: Routing helper classify-task identifies refactor (AC-06)

```gherkin
Given the helper "classify-task.mjs" is loaded
  And sources contain "setup" with { worktreePath: "/tmp/wt", language: "go", isWebUi: false }
  And options contain { runtimeTask: "refactor the database layer" }
When the helper is invoked
Then it returns value.taskType as "refactor"
```

### SCENARIO-026: Route-designer selects architecture-designer for new feature (AC-06)

```gherkin
Given the helper "route-designer.mjs" is loaded
  And sources contain "classify-task" with { taskType: "feature", uiScope: "none" }
When the helper is invoked
Then it returns value.designerAgent as "architecture-designer"
  And value.reason contains "New feature"
```

### SCENARIO-027: Route-designer returns null for bug fix (AC-06)

```gherkin
Given the helper "route-designer.mjs" is loaded
  And sources contain "classify-task" with { taskType: "bug", uiScope: "none" }
When the helper is invoked
Then it returns value.designerAgent as null
  And value.reason contains "Bug fixes"
```

### SCENARIO-028: Route-specialist selects rust-developer (AC-06)

```gherkin
Given the helper "route-specialist.mjs" is loaded
  And sources contain "classify-task" with { language: "rust" }
When the helper is invoked
Then it returns value.specialistAgent as "rust-developer"
```

### SCENARIO-029: Route-specialist selects frontend-developer (AC-06)

```gherkin
Given the helper "route-specialist.mjs" is loaded
  And sources contain "classify-task" with { language: "frontend" }
When the helper is invoked
Then it returns value.specialistAgent as "frontend-developer"
```

### SCENARIO-030: Check-prototype-needed detects numeric constants (AC-06)

```gherkin
Given the helper "check-prototype-needed.mjs" is loaded
  And sources contain "design" with { hasNumericConstants: true, modules: [...] }
When the helper is invoked
Then it returns value.needed as true
```

### SCENARIO-031: Check-prototype-needed returns false when no constants (AC-06)

```gherkin
Given the helper "check-prototype-needed.mjs" is loaded
  And sources contain "design" with { hasNumericConstants: false, modules: [...] }
When the helper is invoked
Then it returns value.needed as false
```

### SCENARIO-032: Helper with missing source data (AC-06, edge case)

```gherkin
Given the helper "gate-bdd.mjs" is loaded
  And sources is an empty object {}
When the helper is invoked
Then it returns value.pass as false
  And value.errors is non-empty (indicating missing upstream data)
```

---

## Feature Area 5: Skill Dispatch

### SCENARIO-033: Skill triggers on "implement X" (AC-07)

```gherkin
Given the plugin is installed and active
  And "skills/super-dev/SKILL.md" defines trigger keywords
When a user says "implement a REST API for user profiles"
Then the skill triggers
  And dispatches to workflow_run({ workflow: "super-dev", task: "implement a REST API for user profiles" })
```

### SCENARIO-034: Skill triggers on "fix bug" (AC-07)

```gherkin
Given the plugin is installed and active
When a user says "fix bug in the authentication flow"
Then the skill triggers
  And dispatches to workflow_run({ workflow: "super-dev", task: "fix bug in the authentication flow" })
```

### SCENARIO-035: Skill triggers on "refactor" (AC-07)

```gherkin
Given the plugin is installed and active
When a user says "refactor the database connection pool"
Then the skill triggers
  And dispatches to workflow_run({ workflow: "super-dev", task: "refactor the database connection pool" })
```

### SCENARIO-036: Skill preserves user language and file references (AC-07)

```gherkin
Given the plugin is installed and active
When a user says "implement caching in src/api/users.ts with Redis"
Then the skill dispatches with task containing "src/api/users.ts" and "Redis"
  And no user constraints are stripped from the task string
```

### SCENARIO-037: Skill does NOT trigger on simple question (AC-07, negative)

```gherkin
Given the plugin is installed and active
When a user says "what does this function do?"
Then the skill does NOT trigger
  And no workflow_run is dispatched
```

### SCENARIO-038: Skill does NOT trigger on file search (AC-07, negative)

```gherkin
Given the plugin is installed and active
When a user says "find all usages of the Logger class"
Then the skill does NOT trigger
```

### SCENARIO-039: Skill does NOT trigger on quick edit (AC-07, negative)

```gherkin
Given the plugin is installed and active
When a user says "rename this variable to userCount"
Then the skill does NOT trigger
```

---

## Feature Area 6: End-to-End Pipeline Execution

### SCENARIO-040: Smoke test progresses through stages 1-3 (AC-08)

```gherkin
Given a fresh project directory exists
  And the plugin is installed and validated
When "/workflow run super-dev 'add a hello world endpoint'" is executed
Then Stage 1 (setup) completes successfully producing a control.json with worktreePath and specDirectory
  And Stage 2A (classify-task) completes identifying taskType as "feature"
  And Stage 2B (requirements) begins execution without schema or scheduling errors
```

### SCENARIO-041: Smoke test handles empty project directory (AC-08, edge case)

```gherkin
Given a fresh empty project directory with no source files
  And the plugin is installed
When "/workflow run super-dev 'add a hello world endpoint'" is executed
Then Stage 1 (setup) completes and detects language as "mixed" or a sensible default
  And the run does not crash due to missing project files
```

### SCENARIO-042: Pipeline respects DAG ordering (AC-08)

```gherkin
Given a workflow run is in progress
When the DAG scheduler evaluates stage readiness
Then "classify-task" does not start before "setup" completes
  And "requirements" does not start before "classify-task" completes
  And "bdd" does not start before "requirements" completes
  And "research" does not start before "bdd" completes
```

---

## Feature Area 7: Loop Stage Behavior

### SCENARIO-043: Loop terminates on gate pass (AC-09)

```gherkin
Given the "requirements" loop stage is executing (maxRounds: 3)
  And this is round 1
When the "write-requirements" child stage completes
  And the "gate-requirements" helper returns { pass: true, errors: [] }
Then the loop terminates immediately
  And round 2 is not executed
  And the stage is marked as completed (not failed)
```

### SCENARIO-044: Loop terminates on maxRounds exhaustion (AC-09)

```gherkin
Given the "bdd" loop stage is executing (maxRounds: 3)
  And the gate returns { pass: false } on rounds 1, 2, and 3
When round 3 completes with gate returning { pass: false }
Then the loop terminates
  And the stage is marked with a failure or warning state
  And no round 4 is attempted
```

### SCENARIO-045: Loop passes on second round (AC-09)

```gherkin
Given the "spec" loop stage is executing (maxRounds: 3)
  And gate returns { pass: false } on round 1
  And gate returns { pass: true } on round 2
When round 2's "gate-spec-trace" helper returns pass: true
Then the loop terminates after round 2
  And round 3 is not executed
  And the stage is marked as completed
```

### SCENARIO-046: Research loop terminates on zero open issues (AC-09)

```gherkin
Given the "research" loop stage is executing
  And the until condition is "$.openIssues.length === 0"
When the "check-issues" support helper returns { openIssues: [] }
Then the loop terminates immediately
```

### SCENARIO-047: Code-review loop terminates on approved verdict (AC-09)

```gherkin
Given the "code-review-loop" stage is executing
  And the until condition checks for verdict "Approved" or "Approved with Comments"
When the "merge-verdicts" helper returns { verdict: "Approved" }
Then the loop terminates
  And the "fix-issues" child stage is NOT spawned
```

### SCENARIO-048: Code-review loop spawns fix-issues on rejection (AC-09)

```gherkin
Given the "code-review-loop" stage is executing round 1
When the "merge-verdicts" helper returns { verdict: "Changes Requested" }
Then the "fix-issues" child stage IS spawned with the implementer agent
  And round 2 begins (reviewers re-evaluate after fixes)
```

### SCENARIO-049: All loop stages respect maxRounds: 3 (AC-09, NFR-08)

```gherkin
Given any loop stage (requirements, bdd, research, prototype, spec, spec-review, code-review-loop)
When its spec.json definition is inspected
Then maxRounds equals 3
  And no infinite loop is possible
```

---

## Feature Area 8: Dynamic Stage and Specialist Routing

### SCENARIO-050: Dynamic stage spawns rust-developer for Rust project (AC-10)

```gherkin
Given Stage 9 (implementation) is executing
  And classify-task.control.language is "rust"
  And spec.control.phases contains [{ name: "phase-1", description: "..." }]
When the implementation-controller processes phase-1
Then it spawns "tdd-guide" to write failing tests
  And then spawns "rust-developer" as the implementation specialist
  And then spawns "qa-agent" to verify tests pass
```

### SCENARIO-051: Dynamic stage spawns frontend-developer for frontend project (AC-10)

```gherkin
Given Stage 9 (implementation) is executing
  And classify-task.control.language is "frontend"
  And spec.control.phases contains [{ name: "phase-1", description: "..." }]
When the implementation-controller processes phase-1
Then it spawns "tdd-guide" to write failing tests
  And then spawns "frontend-developer" as the implementation specialist
  And then spawns "qa-agent" to verify tests pass
```

### SCENARIO-052: Dynamic stage spawns golang-developer for Go project (AC-10)

```gherkin
Given Stage 9 (implementation) is executing
  And classify-task.control.language is "go"
When the implementation-controller processes a phase
Then it spawns "golang-developer" as the implementation specialist
```

### SCENARIO-053: Dynamic stage spawns backend-developer for backend project (AC-10)

```gherkin
Given Stage 9 (implementation) is executing
  And classify-task.control.language is "backend"
When the implementation-controller processes a phase
Then it spawns "backend-developer" as the implementation specialist
```

### SCENARIO-054: Dynamic stage iterates all phases sequentially (AC-10)

```gherkin
Given Stage 9 (implementation) is executing
  And spec.control.phases contains 3 phases
When the implementation-controller runs
Then phase-1 completes before phase-2 starts
  And phase-2 completes before phase-3 starts
  And each phase produces a git commit on success
```

### SCENARIO-055: Dynamic stage retries failed phase (AC-10, edge case)

```gherkin
Given Stage 9 (implementation) is executing phase-2
  And the gate-build helper returns { pass: false } on the first attempt
When the implementation-controller evaluates the failure
Then it retries phase-2 (up to 3 attempts total)
  And if retry succeeds, proceeds to phase-3
```

### SCENARIO-056: Dynamic stage terminates early after max retries (AC-10, edge case)

```gherkin
Given Stage 9 (implementation) is executing phase-2
  And the gate-build helper returns { pass: false } on all 3 attempts
When the third retry fails
Then the dynamic stage terminates early
  And the stage reports which phase failed and the error details
```

### SCENARIO-057: Dynamic stage respects budget constraints (AC-10, NFR-08)

```gherkin
Given Stage 9 (implementation) is configured with budget { maxAgents: 100, maxConcurrency: 2 }
When the implementation-controller spawns agents
Then no more than 2 agents run concurrently at any point
  And total agent spawns across all phases do not exceed 100
```

---

## Feature Area 9: Conditional Stage Skipping

### SCENARIO-058: Debug stage skipped for feature task (AC-11)

```gherkin
Given classify-task.control.taskType is "feature"
When the DAG scheduler evaluates Stage 4 (debug)
  And the "when" condition is "classify-task.control.taskType === 'bug'"
Then Stage 4 is skipped (not scheduled)
  And its run state is marked as "skipped" (not "errored")
  And Stage 5 (assessment) proceeds normally with debug source as empty/partial
```

### SCENARIO-059: Debug stage executes for bug task (AC-11)

```gherkin
Given classify-task.control.taskType is "bug"
When the DAG scheduler evaluates Stage 4 (debug)
Then Stage 4 executes with the debug-analyzer agent
  And produces a control.json with hypotheses and rootCause
```

### SCENARIO-060: Design stage skipped when designerAgent is null (AC-11)

```gherkin
Given route-designer.control.designerAgent is null (bug fix scenario)
When the DAG scheduler evaluates Stage 6B (design)
  And the "when" condition is "route-designer.control.designerAgent !== null"
Then Stage 6B is skipped
  And its run state is marked as "skipped"
  And downstream stages (check-prototype, spec) proceed using sourcePolicy: "partial"
```

### SCENARIO-061: Design stage executes for feature with architecture (AC-11)

```gherkin
Given route-designer.control.designerAgent is "architecture-designer"
When the DAG scheduler evaluates Stage 6B (design)
Then Stage 6B executes with the architecture-designer agent
  And produces a control.json with design documentation
```

### SCENARIO-062: Prototype stage skipped when not needed (AC-11)

```gherkin
Given check-prototype.control.needed is false
When the DAG scheduler evaluates Stage 6.5B (prototype)
  And the "when" condition is "check-prototype.control.needed === true"
Then Stage 6.5B is skipped
  And its run state is marked as "skipped"
  And Stage 7 (spec) proceeds normally
```

### SCENARIO-063: Prototype stage executes when numeric constants present (AC-11)

```gherkin
Given check-prototype.control.needed is true
  And check-prototype.control.constants contains measurement thresholds
When the DAG scheduler evaluates Stage 6.5B (prototype)
Then Stage 6.5B executes as a loop (maxRounds: 3) with prototype-runner agent
```

### SCENARIO-064: Merge stage skipped when cleanup reports blocked (AC-11)

```gherkin
Given cleanup.control.blocked is true (sensitive data found)
When the DAG scheduler evaluates Stage 13 (merge)
  And the "when" condition is "cleanup.control.blocked === false"
Then Stage 13 is skipped
  And the run completes without merging
  And the stage is marked as "skipped" (not "errored")
```

### SCENARIO-065: Merge stage executes when cleanup passes (AC-11)

```gherkin
Given cleanup.control.blocked is false
When the DAG scheduler evaluates Stage 13 (merge)
Then Stage 13 executes with the orchestrator agent
  And attempts to merge or outputs merge instructions
```

### SCENARIO-066: Skipped stage does not propagate error to downstream (AC-11, edge case)

```gherkin
Given Stage 4 (debug) is skipped because taskType is "feature"
  And Stage 5 (assessment) declares debug as a dependency with sourcePolicy: "partial"
When Stage 5 begins execution
Then it receives an empty/null source for "debug"
  And it does NOT fail due to missing debug output
  And it proceeds with its assessment using only the "research" source
```

---

## Feature Area 10: Artifact Bundle Production

### SCENARIO-067: Stage produces control.json and analysis.md (AC-12)

```gherkin
Given any stage (e.g., "setup") completes successfully
When the run directory is inspected at ".pi/workflows/<run-id>/setup/"
Then a "control.json" file exists with the stage's structured output
  And an "analysis.md" file exists with the stage's reasoning narrative
```

### SCENARIO-068: All stages produce artifact bundles (AC-12)

```gherkin
Given a complete workflow run finishes (all non-skipped stages complete)
When the run directory ".pi/workflows/<run-id>/" is listed
Then every non-skipped stage has a subdirectory
  And each subdirectory contains at minimum "control.json" and "analysis.md"
```

### SCENARIO-069: Skipped stages do NOT produce artifacts (AC-12, edge case)

```gherkin
Given Stage 4 (debug) was skipped
When the run directory is inspected
Then no "debug/" subdirectory exists (or it contains only a skip marker)
  And no "control.json" is produced for the skipped stage
```

### SCENARIO-070: Loop stage produces final-round artifacts (AC-12)

```gherkin
Given the "requirements" loop stage completes after 2 rounds
When the run directory is inspected
Then the "requirements/" subdirectory contains the control.json from the final passing round
  And the analysis.md reflects the cumulative iteration history
```

---

## Feature Area 11: Data Flow Between Stages

### SCENARIO-071: Setup worktreePath flows to all downstream stages (FR-10)

```gherkin
Given Stage 1 (setup) completes with control.worktreePath = "/tmp/wt-abc123"
When any downstream stage (e.g., requirements, research, implementation) begins
Then the agent receives worktreePath "/tmp/wt-abc123" in its prompt context
  And all file paths in the agent's instructions are absolute within that worktree
```

### SCENARIO-072: Classify-task output flows to conditional stages (FR-10)

```gherkin
Given Stage 2A (classify-task) completes with control.taskType = "bug"
When the DAG scheduler evaluates Stage 4 (debug)
Then it reads classify-task.control.taskType and evaluates the "when" condition as true
  And Stage 4 is scheduled for execution
```

### SCENARIO-073: Spec phases flow to implementation controller (FR-10)

```gherkin
Given Stage 7 (spec) completes with control.phases = [{ name: "p1" }, { name: "p2" }, { name: "p3" }]
When Stage 9 (implementation) dynamic controller initializes
Then it reads spec.control.phases
  And iterates over 3 phases sequentially
```

### SCENARIO-074: Spec specificationPath flows to review and implementation (FR-10)

```gherkin
Given Stage 7 (spec) completes with control.specificationPath = "/tmp/wt/docs/spec/04-specification.md"
When Stage 8 (spec-review) begins
Then the spec-reviewer agent receives the specificationPath to review
When Stage 9 (implementation) begins
Then the implementation agents can read the specification at that path
```

---

## Feature Area 12: Source Policy (Partial Dependencies)

### SCENARIO-075: Assessment stage handles missing debug source (FR-13)

```gherkin
Given Stage 4 (debug) was skipped (taskType is "feature")
  And Stage 5 (assessment) declares sourcePolicy: "partial" for the debug dependency
When Stage 5 begins execution
Then the source manifest provides null/empty for "debug"
  And the code-assessor agent proceeds without error
  And no scheduling error occurs
```

### SCENARIO-076: Spec stage handles multiple optional upstream stages (FR-13)

```gherkin
Given Stage 6B (design) was skipped (designerAgent is null)
  And Stage 6.5B (prototype) was skipped (needed is false)
  And Stage 7 (spec) declares sourcePolicy: "partial" for optional upstreams
When Stage 7 begins execution
Then it receives sources from requirements, bdd, research, and assessment
  And missing sources (design, prototype) are null/empty
  And the spec-writer proceeds without error
```

### SCENARIO-077: Partial source does not block scheduling (FR-13, edge case)

```gherkin
Given Stage 5 (assessment) depends on [research, debug]
  And debug is marked as skipped in the run state
When the DAG scheduler checks if assessment's dependencies are satisfied
Then it treats the skipped debug stage as satisfied (due to partial source policy)
  And schedules assessment for execution
```

---

## Feature Area 13: Parallel Execution in Code Review

### SCENARIO-078: Code-reviewer and adversarial-reviewer run in parallel (FR-09)

```gherkin
Given Stage 10 (code-review-loop) begins a round
When the loop's child stages are evaluated
Then "code-review" and "adversarial-review" are scheduled concurrently (not sequentially)
  And both complete before "merge-verdicts" executes
```

### SCENARIO-079: Merge-review-verdicts combines both review outputs (FR-09)

```gherkin
Given code-reviewer returns { verdict: "Approved with Comments", findings: [...] }
  And adversarial-reviewer returns { verdict: "Changes Requested", findings: [...] }
When the "merge-review-verdicts" helper processes both
Then it produces a merged verdict (the stricter of the two: "Changes Requested")
  And findings from both reviewers are combined
```

### SCENARIO-080: Fix-issues spawns only on non-approved verdict (FR-09)

```gherkin
Given merge-verdicts returns { verdict: "Approved" }
When the loop evaluates whether to spawn fix-issues
Then fix-issues is NOT spawned
  And the loop terminates as approved
```

### SCENARIO-081: Fix-issues spawns on changes-requested verdict (FR-09)

```gherkin
Given merge-verdicts returns { verdict: "Changes Requested", findings: ["issue1", "issue2"] }
When the loop evaluates whether to spawn fix-issues
Then fix-issues IS spawned with the implementer agent
  And the agent receives the findings to address
```

---

## Feature Area 14: Resume Capability

### SCENARIO-082: Interrupted run resumes from last completed stage (NFR-07)

```gherkin
Given a workflow run completed stages 1-5 and was then interrupted
  And stage state is persisted in ".pi/workflows/<run-id>/"
When "/workflow resume" is executed for that run
Then stages 1-5 are NOT re-executed
  And execution resumes from Stage 6A (route-designer)
```

### SCENARIO-083: Completed stages retain their artifacts on resume (NFR-07)

```gherkin
Given a workflow run was interrupted after Stage 3 (research) completed
When "/workflow resume" is executed
Then Stage 3's control.json and analysis.md remain unchanged
  And downstream stages receive Stage 3's original output
```

### SCENARIO-084: Resume after loop stage mid-execution (NFR-07, edge case)

```gherkin
Given the "spec" loop stage completed round 1 (gate failed) and was interrupted before round 2
When "/workflow resume" is executed
Then the loop resumes at round 2 (not from the beginning)
  And round 1's results are still available
```

---

## Feature Area 15: No Imperative Orchestration

### SCENARIO-085: Plugin does not contain agentWithRetry pattern (NFR-03)

```gherkin
Given the complete plugin source code
When a search is performed for "agentWithRetry" or manual retry loops
Then zero matches are found
  And retry handling is delegated to the pi-workflow engine
```

### SCENARIO-086: Plugin does not maintain tracking JSON (NFR-03)

```gherkin
Given the complete plugin source code
When a search is performed for "tracking.json" or manual state tracking files
Then zero matches are found
  And run state management is delegated to the pi-workflow engine
```

### SCENARIO-087: Plugin does not use TeamCreate or TeamDelete (NFR-03)

```gherkin
Given the complete plugin source code
When a search is performed for "TeamCreate" or "TeamDelete"
Then zero matches are found
```

---

## Feature Area 16: Deterministic Helpers

### SCENARIO-088: Gate helper produces same output for same input (NFR-06)

```gherkin
Given the helper "gate-bdd.mjs" is loaded
  And sources contain a fixed input { scenarioCount: 10, edgeCasesCovered: true, coverageScore: 0.85 }
When the helper is invoked 3 times with identical inputs
Then all 3 invocations return the exact same output
  And no LLM invocation occurs during validation
```

### SCENARIO-089: Routing helper deterministically selects agent (NFR-06)

```gherkin
Given the helper "route-designer.mjs" is loaded
  And sources contain { taskType: "refactor", uiScope: "none" }
When the helper is invoked multiple times
Then it always returns designerAgent: "architecture-improver"
  And the decision does not vary between invocations
```

### SCENARIO-090: Gate helper does not call external LLM (NFR-06)

```gherkin
Given any gate helper is executed
When it processes validation logic
Then it uses only programmatic checks (string presence, numeric comparisons, array length)
  And no external API calls are made
  And no LLM inference is invoked
```

---

## Feature Area 17: Pipeline Architecture Completeness

### SCENARIO-091: Spec defines exactly 13 stages in DAG (FR-02)

```gherkin
Given the workflow spec "workflows/super-dev/spec.json" is loaded
When the stage definitions are counted
Then exactly 13 top-level stages exist (accounting for sub-stage groupings):
  | setup | classify-task | requirements | bdd | research | debug | assessment | route-designer | design | check-prototype | prototype | spec | spec-review | implementation | code-review-loop | docs | cleanup | merge |
  And the DAG has no cycles
```

### SCENARIO-092: Loop stages are correctly identified (FR-06)

```gherkin
Given the workflow spec is loaded
When loop-type stages are filtered
Then the following stages have type "loop": requirements, bdd, research, prototype, spec, spec-review, code-review-loop
  And each has maxRounds: 3
  And each has an "until" condition defined
```

### SCENARIO-093: Conditional stages have "when" clauses (FR-07)

```gherkin
Given the workflow spec is loaded
When conditional stages are inspected
Then Stage 4 (debug) has when: "classify-task.control.taskType === 'bug'"
  And Stage 6B (design) has when: "route-designer.control.designerAgent !== null"
  And Stage 6.5B (prototype) has when: "check-prototype.control.needed === true"
  And Stage 13 (merge) has when: "cleanup.control.blocked === false"
```

### SCENARIO-094: Dynamic stage has controller and budget (FR-08)

```gherkin
Given the workflow spec is loaded
When Stage 9 (implementation) is inspected
Then it has type "dynamic"
  And it references controller "./helpers/implementation-controller.mjs"
  And it has budget { maxAgents: 100, maxConcurrency: 2 }
```

---

## Feature Area 18: Agent Isolation

### SCENARIO-095: Agents do not see each other's full context (NFR-05)

```gherkin
Given Stage 2B (requirements) completes with a full analysis context
When Stage 2C (bdd) agent begins execution
Then the bdd-scenario-writer receives only the spec_directory path and its own inputs
  And it does NOT receive the raw internal reasoning from the requirements-clarifier agent
```

### SCENARIO-096: Agent file paths are absolute (NFR-05)

```gherkin
Given any agent is spawned with a worktreePath of "/tmp/wt-abc123"
When the agent's prompt is constructed
Then all file paths referenced in the prompt are absolute (start with "/")
  And no relative paths (e.g., "./src/") appear in agent instructions
```

---

## Traceability Matrix

| AC | Scenarios |
|---|---|
| AC-01 | SCENARIO-001, SCENARIO-002 |
| AC-02 | SCENARIO-003, SCENARIO-004, SCENARIO-005 |
| AC-03 | SCENARIO-006, SCENARIO-007 |
| AC-04 | SCENARIO-008, SCENARIO-009, SCENARIO-010, SCENARIO-011, SCENARIO-012 |
| AC-05 | SCENARIO-013, SCENARIO-014, SCENARIO-015, SCENARIO-016, SCENARIO-017, SCENARIO-018 |
| AC-06 | SCENARIO-019 through SCENARIO-032 |
| AC-07 | SCENARIO-033 through SCENARIO-039 |
| AC-08 | SCENARIO-040, SCENARIO-041, SCENARIO-042 |
| AC-09 | SCENARIO-043 through SCENARIO-049 |
| AC-10 | SCENARIO-050 through SCENARIO-057 |
| AC-11 | SCENARIO-058 through SCENARIO-066 |
| AC-12 | SCENARIO-067 through SCENARIO-070 |
| FR-09 | SCENARIO-078 through SCENARIO-081 |
| FR-10 | SCENARIO-071 through SCENARIO-074 |
| FR-13 | SCENARIO-075 through SCENARIO-077 |
| NFR-03 | SCENARIO-085 through SCENARIO-087 |
| NFR-05 | SCENARIO-095, SCENARIO-096 |
| NFR-06 | SCENARIO-088 through SCENARIO-090 |
| NFR-07 | SCENARIO-082 through SCENARIO-084 |
| NFR-08 | SCENARIO-049, SCENARIO-057 |
