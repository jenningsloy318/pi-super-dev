# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-06

**Trustworthy convergence, safety, and UX.** This release closes the highest-leverage gaps from the rewrite review (`docs/findings/rewrite-review-vs-super-dev-plugin.md`): the verify-loop's convergence signal is now real (not self-reported), spawned specialists are guarded against catastrophic commands, stuck loops break early, language-specific guardrails are richer, and long runs get a live phase-tracker. Verified against the Pi SDK in `docs/findings/pi-sdk-architecture-verification.md` (C1–C15).

### Added
- **Deterministic build/test/typecheck gate (Gap A).** New `src/build-runner.ts` actually runs the project's build/test/typecheck commands (cargo/go/pytest/npm+pm with bun/deno detection) with bounded 120s timeouts, replacing trust in the QA agent's self-reported `buildSuccess`/`allTestsPass` (vacuous-pass risk). Wired into three gate points: per-phase in `implementation.ts` (the hard oracle that feeds real errors back into retries), a pre-merge gate in `stages/index.ts` (skips merge when code fails to build), and inside the verify-loop in `verify.ts` (gives non-service apps a real convergence signal alongside the merged review verdict). Non-fatal for greenfield repos (no manifest → no commands → pass). The redundant per-phase QA self-report spawn was removed.
- **Safety guardrails for spawned specialists (Gap 4.3).** New `src/safety.ts` ports the original plugin's `block-dangerous` + `protect-files` hooks as a Pi-native inline `tool_call` ExtensionFactory (hard, uniform interception of every tool the child calls). The session backend now creates each child with a `DefaultResourceLoader({ noExtensions: true, extensionFactories: [safetyFactory] })` — `noExtensions:true` suppresses ambient global-extension discovery (inline factories still load, verified), so children are both guarded AND deterministic. Protected-file logic blocks OVERWRITES of existing secrets only (creates + `.env.example` allowed). The subprocess backend gets a soft `safetyPreamble()` prepended to its system prompt (defense-in-depth).
- **Verify-loop stagnation detection (Gap 4.6).** The verify-loop now tracks the merged review-findings signature (`file|severity|title`, sorted → order-independent, ignores reworded `detail`) across iterations and breaks early (non-fatal, logged) when the SAME non-empty findings recur on two consecutive rounds — instead of burning all 4 iterations re-fixing the same thing. Exact-set equality (v1).
- **Per-language specialist profiles (Gap 4.1).** Replaced the one-line inline `LANG_INSTRUCTIONS` with prose profiles under `agents/lang/{rust,go,python,frontend,backend}.md` (commands, coverage threshold, mandatory test file-organization rule, top idioms — current 2024-2026 stacks, distilled from the original plugin's dedicated agents; no code samples to save tokens). `route-specialist` loads the matching profile and it is now injected into BOTH the implementer and the tdd-guide prompts, so a single generic implementer gets language-specific guardrails. Mobile/desktop specialists deferred until `detectLanguage` learns those stacks.
- **Protocol reference docs (Gap 4.4).** Added `docs/reference/{verification-gates,iteration-loops,pivot-protocol}.md`, adapted from the original plugin's reference: stripped plugin-specific machinery (team-lead/doc-validator/`AskUserQuestion`/`gate-build.sh`/spec-29 postmortem) and mapped each onto pi-super-dev's actual implementation (deterministic helpers, the `gate()` node with feedback-driven retries, `runBuildGate`, the verify-loop, stagnation detection). Each doc carries an honest header distinguishing design intent from current implementation (notably: full pivot protocol is deferred — only stagnation detection + planned escalation are wired).
- **Stagnation escalation UI (Gap 4.6′-lite).** When the verify-loop breaks on stagnation, the run now surfaces it two ways: an always-on `stagnation-report.md` in the spec dir + a diagnostic line in the run summary (baseline, all modes, non-blocking). Opt-in interactive mode (`escalation: "interactive"` in `~/.pi/agent/super-dev/config.json`, TUI/RPC only via `ctx.hasUI`) prompts a 3-option `ctx.ui.select` (revise spec / accept as known limitations / abandon worktree). Headless runs always fall back to the informative baseline. The `escalation` field defaults to `"informative"`. Full pivot/replay remains deferred (Tier-3); in Tier-2 the "revise" choice only surfaces the recommendation.
- **Workflow dashboard v1 (Gap Dashboard).** An always-on phase-tracker widget (`ctx.ui.setWidget`) renders live stage progression in TUI mode (`super-dev · M/N stages` + a ✔/●/⚠/↷ line per stage). `task()` nodes now emit structured `stage` events (running → terminal) on the existing event bus, piped through a new optional `ProgressSink.stage` callback — the same channel v2 will use for per-agent timing/token in a full two-panel interactive component. Headless (`print`/`json`/`rpc`) is a no-op; the widget clears at run end. v2 (two-panel `ctx.ui.custom()` with stop/pause/save keybindings) is deferred.

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
