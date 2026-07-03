# @jenningsloy318/pi-super-dev

Pi workflow plugin for super-dev orchestration. Provides a structured 13-stage development workflow with specialized agents for requirements, design, implementation, review, and documentation.

## Installation

```bash
npm install @jenningsloy318/pi-super-dev
```

Requires `@earendil-works/pi-coding-agent` as a peer dependency and `@agwab/pi-workflow` for workflow execution.

## Usage

The plugin registers itself via the `pi.extensions` field in `package.json`. Once installed, the super-dev workflow becomes available through the Pi workflow system.

```bash
/workflow run super-dev "implement feature X"
```

## Structure

- `agents/` — Agent definitions for workflow roles
- `workflows/super-dev/` — Workflow specification and helpers
- `skills/super-dev/` — Skill definitions for the super-dev workflow
- `docs/` — Documentation

## License

MIT
