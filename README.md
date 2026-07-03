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

### Prerequisites

1. **Pi Coding Agent** — the runtime host (`@earendil-works/pi-coding-agent`)
2. **Node.js >= 22.19.0**

### Install from npm (when published)

```bash
pi install npm:@jenningsloy318/pi-super-dev
```

### Install from local path (for development)

```bash
# Clone the repo
git clone https://github.com/jenningsloy318/pi-super-dev.git
cd pi-super-dev
npm install

# Install as a local Pi package
pi install /absolute/path/to/pi-super-dev
```

### Verify installation

After installation, reload Pi and confirm the plugin is active:

```bash
# The /super-dev command should be available
/super-dev
```

### What gets registered

When installed, the plugin provides:

| Component | Description |
|-----------|-------------|
| **Extension** (`src/extension.ts`) | Registers the plugin with Pi's extension system |
| **Skill** (`skills/super-dev/SKILL.md`) | Natural language trigger — intercepts "implement", "build", "fix bug", etc. and dispatches to `workflow_run` |
| **Workflow** (`workflows/super-dev/spec.json`) | The 13-stage pipeline definition |
| **Agents** (`agents/*.md`) | 21 specialist agent definitions with role-specific tool ceilings |

### How it works

```
User: "implement OAuth2 authentication"
  │
  ▼
SKILL.md detects dev intent (trigger keywords)
  │
  ▼
Calls: workflow_run({ workflow: "super-dev", task: "implement OAuth2 authentication" })
  │
  ▼
pi-workflow engine loads spec.json, runs setup stage,
then hands control to implementation-controller.mjs
  │
  ▼
Controller orchestrates 13 stages with 21 agents
```

> **Note**: The `skills/super-dev/SKILL.md` is required for proactive triggering.
> Pi-workflow's bundled `execution-router` only auto-dispatches to bundled workflows
> (deep-research, deep-review, etc.). Plugin workflows need their own skill to be
> invoked from natural language without the user explicitly saying "use the super-dev workflow."

## Quick Start

Use the `/super-dev` command directly:

```
/super-dev implement user authentication with OAuth2
/super-dev fix the crash when uploading large files
/super-dev refactor the database layer to use connection pooling
```

Or just describe your task naturally — the skill auto-triggers on dev keywords:

```
"implement user authentication with OAuth2"
```

With pi-workflow installed, you can also use:

```
/workflow run super-dev "add a hello world endpoint"
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
