# pi-super-dev Usage Guide

## What It Does

`@jenningsloy318/pi-super-dev` is a pi-workflow plugin that implements a 13-stage development pipeline. It orchestrates requirements gathering, research, design, specification, TDD implementation, code review, documentation, and merge — all through specialized AI agents coordinated by the pi-workflow engine.

The pipeline is fully automated: once triggered, the workflow progresses through each stage with built-in quality gates, retry loops, and conditional routing.

---

## Installation

```bash
pi install @jenningsloy318/pi-super-dev
```

**Requirements**:
- Pi Coding Agent runtime (`@earendil-works/pi-coding-agent`)
- pi-workflow engine (`@agwab/pi-workflow`)

---

## How to Use

### Natural Language Triggers (Skill)

Simply describe what you want to build. The skill triggers automatically on development keywords:

```
"implement user authentication with OAuth2"
"fix the crash when uploading large files"
"refactor the database layer to use connection pooling"
"add a REST endpoint for user profiles"
"optimize the search query performance"
```

### Explicit Invocation

```
/workflow run super-dev "add a hello world endpoint"
```

### Resume a Stopped Workflow

If a workflow is interrupted (context compaction, timeout, manual stop), resume it:

```
/workflow resume
```

The engine replays completed stages and continues from where it left off.

---

## The 13 Stages

| # | Stage | Description |
|---|-------|-------------|
| 1 | **Setup** | Creates git worktree, spec directory, detects project language/framework |
| 2A | **Classify Task** | Determines task type (bug/feature/refactor) and UI scope |
| 2B | **Requirements** | Gathers requirements with acceptance criteria (max 3 rounds) |
| 2C | **BDD Scenarios** | Writes Given/When/Then behavior scenarios (max 3 rounds) |
| 3 | **Research** | Investigates best practices, libraries, patterns (max 3 rounds) |
| 4 | **Debug Analysis** | Root-cause analysis (bug fixes only, skipped otherwise) |
| 5 | **Code Assessment** | Discovers existing patterns, architecture smells |
| 6 | **Design** | Routes to appropriate designer agent based on task type |
| 6.5 | **Prototype** | Validates numeric design constants empirically (conditional) |
| 7 | **Specification** | Writes implementation spec with phased plan (max 3 rounds) |
| 8 | **Spec Review** | Multi-dimensional spec review for quality (max 3 rounds) |
| 9 | **Implementation** | Per-phase TDD: write tests, implement, verify, commit |
| 10 | **Code Review** | Parallel code review + adversarial review (max 3 rounds) |
| 11 | **Documentation** | Updates docs, READMEs, and spec deviations |
| 12 | **Cleanup** | Scans for build artifacts and sensitive data |
| 13 | **Merge** | Final commit and merge to default branch |

---

## Configuration Options

### Skip Worktree Creation

If you are already in the correct working directory and do not want a separate git worktree:

```
/workflow run super-dev --input.skipWorktree=true "your task here"
```

### Skip Stages

Skip specific stages by name:

```
/workflow run super-dev --input.skipStages=["research","prototype"] "your task here"
```

Common skip combinations:
- `["research"]` — Skip web research when you already know the approach
- `["prototype"]` — Skip prototype validation for straightforward implementations
- `["debug"]` — Force-skip debug analysis even for bug-like tasks

---

## Agents

The workflow uses 21 specialized agents, each with a defined tool ceiling:

| Agent | Role | Tools |
|-------|------|-------|
| orchestrator | Setup and merge operations | read, grep, find, ls, write, edit, bash |
| requirements-clarifier | Gather requirements | read, grep, find, ls, write, edit |
| bdd-scenario-writer | Write BDD scenarios | read, grep, find, ls, write, edit |
| research-agent | Research best practices | read, grep, find, ls, web_search, web_fetch |
| debug-analyzer | Root-cause analysis | read, grep, find, ls, bash |
| code-assessor | Pattern discovery | read, grep, find, ls |
| architecture-designer | New feature architecture | read, grep, find, ls, write, edit |
| architecture-improver | Refactor architecture | read, grep, find, ls, write, edit |
| ui-ux-designer | UI/UX specification | read, grep, find, ls, write, edit |
| product-designer | Architecture + UI design | read, grep, find, ls, write, edit |
| prototype-runner | Validate numeric constants | read, grep, find, ls, write, edit, bash |
| spec-writer | Write specifications | read, grep, find, ls, write, edit |
| spec-reviewer | Review specifications | read, grep, find, ls |
| tdd-guide | Write failing tests first | read, grep, find, ls, write, edit, bash |
| implementer | Make tests pass | read, grep, find, ls, write, edit, bash |
| qa-agent | Verify tests and coverage | read, grep, find, ls, bash |
| code-reviewer | Standard code review | read, grep, find, ls |
| adversarial-reviewer | Critical lens review | read, grep, find, ls |
| docs-executor | Update documentation | read, grep, find, ls, write, edit |
| handoff-writer | Session handoff document | read, grep, find, ls, write, edit |
| build-cleaner | Cleanup and sensitive scan | read, grep, find, ls, bash |

---

## Artifacts Produced

Each stage produces structured artifacts stored in `.pi/workflows/<run-id>/`:

- **control.json** — Machine-readable stage output (e.g., `worktreePath`, `taskType`, `verdict`)
- **analysis.md** — Detailed reasoning and documentation
- **refs.json** — File references and dependencies

Additionally, the workflow writes human-readable documents to the spec directory:
- `docs/specifications/<spec-id>/01-requirements.md`
- `docs/specifications/<spec-id>/02-bdd-scenarios.md`
- `docs/specifications/<spec-id>/03-research-report.md`
- `docs/specifications/<spec-id>/04-debug-analysis.md` (bugs only)
- `docs/specifications/<spec-id>/05-architecture.md`
- `docs/specifications/<spec-id>/06-specification.md`
- `docs/specifications/<spec-id>/07-implementation-plan.md`
- `docs/specifications/<spec-id>/08-task-list.md`

---

## Design Decisions

### Hybrid Setup + Dynamic Architecture

The workflow uses a two-stage spec: a declarative `setup` stage followed by a `dynamic` pipeline controller. This is because pi-workflow v1 does not natively support conditional stage execution (`when` fields) or nested support helpers inside loop stages. The dynamic controller (`implementation-controller.mjs`) handles all conditional logic, iteration loops, and agent routing programmatically.

### Quality Gates

Every iterative stage has a gate helper that validates output quality:
- Gates are deterministic (no LLM involved)
- Failed gates trigger another loop round (max 3)
- After 3 failures, the pipeline continues in degraded mode

### Budget Control

The dynamic controller has a budget of 200 agent spawns and 3 concurrent agents. Before each agent call, it checks remaining budget and terminates gracefully if exhausted.

---

## Troubleshooting

### Workflow validation fails

```
/workflow validate super-dev
```

Check that all agent markdown files are in `agents/`, all schemas are in `workflows/super-dev/schemas/`, and all helpers are in `workflows/super-dev/helpers/`.

### Stage loops exhaust without passing

The pipeline continues in degraded mode after 3 failed rounds. Check the run log for gate errors:

```
/workflow log
```

### Implementation phase fails repeatedly

If a single implementation phase cannot pass after 3 attempts, the pipeline terminates that phase early and proceeds to code review with partial implementation. The `allGreen` field in the implementation control output will be `false`.
