# @jenningsloy318/pi-super-dev

A pi-workflow plugin that implements a structured 13-stage development pipeline. It orchestrates requirements gathering, research, design, specification, TDD implementation, code review, documentation, and merge through 21 specialized AI agents coordinated by the pi-workflow engine.

## Features

- **13-stage pipeline** with quality gates, retry loops, and conditional routing
- **21 specialized agents** with role-specific tool ceilings
- **17 JSON schemas** for structured stage control outputs
- **13 helper modules** implementing gates, routing, and pipeline orchestration
- **Hybrid architecture**: declarative setup stage + dynamic pipeline controller
- **Automatic task classification**: bug fix, feature, or refactor
- **Conditional routing**: debug analysis for bugs, prototype validation for numeric constants, UI/UX design for web tasks
- **Budget control**: max 200 agent spawns, 3 concurrent, 4-hour timeout
- **Resumable**: interrupted workflows resume from the last completed stage
- **216 tests** across 2 test suites (foundation + integration)

## Installation

```bash
pi install @jenningsloy318/pi-super-dev
```

### Requirements

- Node.js >= 22.19.0
- Pi Coding Agent runtime (`@earendil-works/pi-coding-agent`) — peer dependency
- pi-workflow engine (`@agwab/pi-workflow`) — runtime dependency

## Quick Start

Describe your task in natural language:

```
"implement user authentication with OAuth2"
"fix the crash when uploading large files"
"refactor the database layer to use connection pooling"
```

Or invoke explicitly:

```
/workflow run super-dev "add a hello world endpoint"
```

Resume an interrupted workflow:

```
/workflow resume
```

See [docs/usage.md](docs/usage.md) for the full usage guide including configuration options and skip flags.

## Architecture

The plugin uses a two-stage spec architecture:

1. **Setup stage** (declarative) — creates a git worktree, detects the project language/framework, and bootstraps the spec directory.
2. **Dynamic pipeline** (programmatic) — the `implementation-controller.mjs` helper drives all remaining stages with conditional logic, iteration loops, and agent routing.

This design works around pi-workflow v1 limitations (no native `when` fields or nested helpers in loop stages) by delegating all conditional execution to the dynamic controller.

```
Setup → Classify → Requirements → BDD → Research → [Debug] →
Assessment → Design → [Prototype] → Spec → Spec Review →
Implementation (per-phase TDD) → Code Review → Docs → Cleanup → Merge
```

## Directory Structure

```
├── agents/                          # 21 agent markdown definitions
│   ├── orchestrator.md
│   ├── requirements-clarifier.md
│   ├── implementer.md
│   └── ...
├── workflows/
│   └── super-dev/
│       ├── spec.json                # Workflow specification
│       ├── schemas/                 # 17 JSON control schemas
│       │   ├── super-dev-setup-control.schema.json
│       │   ├── super-dev-gate-verdict.schema.json
│       │   └── ...
│       └── helpers/                 # 13 pipeline helpers
│           ├── implementation-controller.mjs
│           ├── classify-task.mjs
│           ├── route-designer.mjs
│           └── ...
├── skills/
│   └── super-dev/
│       └── SKILL.md                 # Skill trigger definition
├── src/
│   └── extension.ts                 # Pi extension entry point
├── tests/
│   ├── phase1-foundation.test.ts    # 30 unit tests
│   └── phase7-integration.test.ts   # 186 integration tests
├── docs/
│   ├── usage.md                     # Full usage guide
│   └── specifications/              # Per-run spec artifacts
├── package.json
├── tsconfig.json
└── CHANGELOG.md
```

## Development

### Build

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
```

### Test

```bash
npm test             # Run all 216 tests via Vitest
```

### Validate Workflow

```bash
/workflow validate super-dev
```

## The 13 Stages

| # | Stage | Description |
|---|-------|-------------|
| 1 | Setup | Creates git worktree, spec directory, detects project language/framework |
| 2A | Classify Task | Determines task type (bug/feature/refactor) and UI scope |
| 2B | Requirements | Gathers requirements with acceptance criteria (max 3 rounds) |
| 2C | BDD Scenarios | Writes Given/When/Then behavior scenarios (max 3 rounds) |
| 3 | Research | Investigates best practices, libraries, patterns (max 3 rounds) |
| 4 | Debug Analysis | Root-cause analysis (bug fixes only, skipped otherwise) |
| 5 | Code Assessment | Discovers existing patterns, architecture smells |
| 6 | Design | Routes to appropriate designer agent based on task type |
| 6.5 | Prototype | Validates numeric design constants empirically (conditional) |
| 7 | Specification | Writes implementation spec with phased plan (max 3 rounds) |
| 8 | Spec Review | Multi-dimensional spec review for quality (max 3 rounds) |
| 9 | Implementation | Per-phase TDD: write tests, implement, verify, commit |
| 10 | Code Review | Parallel code review + adversarial review (max 3 rounds) |
| 11 | Documentation | Updates docs, READMEs, and spec deviations |
| 12 | Cleanup | Scans for build artifacts and sensitive data |
| 13 | Merge | Final commit and merge to default branch |

## License

MIT
