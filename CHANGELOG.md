# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-07-05

### Added
- Render pipeline: typed TS template engine + TypeBox schemas + Jinja-subset templates for all 15 stages. Agent returns structured data; doc is rendered deterministically. Format is solved — agent focuses on content.
- Unified verify-loop: review-gated bringup → api/ui test → teardown, converging on approved ∧ testsGreen.
- Service lifecycle (bringup/teardown/withServiceDeps): concurrent multi-service start, .env loading, readiness poll, try/final teardown.
- api-tester + ui-tester agents: HTTP CRUD/edge testing (CDP/Playwright for UI).
- Feedback-driven gate retries; non-fatal exhaustion; tolerant sequences.
- Doc-content gates (validate the real .md file, not self-report).
- Delivery-discipline preamble (bounds exploration; prevents timeouts).
- Super-dev-debug traces (SUPER_DEV_DEBUG=1).

### Fixed
- Stage 9 crash on malformed spec.phases (normalizePhases coercion).
- Service lifecycle .env loading (startService now loads .env).
- Agent output truncation (rolling-tail display + full log on disk).
- Dead template references removed from all 22 agents.
- Vacuous-pass gates fixed (researchComplete, notBlocked).


## [0.1.2] - 2026-07-05

### Fixed
- Removed dead "Read Format Template" / "following the template structure" references from the remaining 10 agents (adversarial-reviewer, code-reviewer, debug-analyzer, architecture-designer, architecture-improver, product-designer, ui-ux-designer, prototype-runner, qa-agent, orchestrator). These pointed at `templates/*.md.j2` + `workflow-tracking-template.json` from the original plugin that were never ported, causing each agent to burn a turn hunting for non-existent files. The earlier 0.1.0 cleanup only covered the 5 writer agents.
- Broadened the structure regression guard to scan every agent file (was 6 named writers).

## [0.1.1] - 2026-07-05

### Changed
- Package renamed to unscoped `pi-super-dev` (cleaner `pi install npm:pi-super-dev`).
- Added repository/homepage/bugs metadata (GitHub: jenningsloy318/pi-super-dev).

## [0.1.0] - 2026-07-03

### Added

- Initial implementation of the pi-super-dev workflow plugin
- 13-stage development pipeline with quality gates and retry loops
- 21 specialized agent definitions in `agents/`:
  - orchestrator, requirements-clarifier, bdd-scenario-writer, research-agent,
    debug-analyzer, code-assessor, architecture-designer, architecture-improver,
    ui-ux-designer, product-designer, prototype-runner, spec-writer, spec-reviewer,
    tdd-guide, implementer, qa-agent, code-reviewer, adversarial-reviewer,
    docs-executor, handoff-writer, build-cleaner
- 17 JSON control schemas in `workflows/super-dev/schemas/`
- 13 pipeline helper modules in `workflows/super-dev/helpers/`:
  - implementation-controller.mjs (dynamic pipeline orchestrator)
  - classify-task.mjs, route-designer.mjs, route-specialist.mjs
  - gate-requirements.mjs, gate-bdd.mjs, gate-build.mjs, gate-review.mjs,
    gate-spec-review.mjs, gate-spec-trace.mjs
  - check-prototype-needed.mjs, cleanup.mjs, merge-review-verdicts.mjs
- Workflow spec (`workflows/super-dev/spec.json`) with hybrid setup + dynamic architecture
- Skill definition (`skills/super-dev/SKILL.md`) with natural language triggers
- Extension entry point (`src/extension.ts`)
- 216 tests across 2 test suites (30 foundation + 186 integration)
- Full documentation: README.md, docs/usage.md
- TypeScript configuration targeting ES2022 with NodeNext modules
- Budget control: max 200 agent spawns, 3 concurrent, 4-hour timeout
- Conditional stage routing: debug analysis for bugs, prototype for numeric constants
- Resumable workflow execution via pi-workflow engine
