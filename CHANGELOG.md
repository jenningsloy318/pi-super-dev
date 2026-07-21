# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Per-stage log sections (spec-12).** Each pipeline STAGE now renders as its OWN themed log section instead of all stage logs merging into one flat transcript. (1) Every transcript entry is tagged with its stage at the sink — `TranscriptLine` widens additively to `{ kind; text; stageId; stageLabel }`, a new `LiveStreamSink.stage(info)` method resolves stage identity from the STRUCTURED dashboard `stage` event (not `▶ Stage N` label parsing) and re-tags the most-recent matching phase line to fix the phase-before-stage emit ordering. (2) A new pure, dependency-free `src/render/stage-grouping.ts` `groupByStage(transcript, statusOf?)` partitions tagged entries by FIRST-APPEARANCE order, strips stage tags from emitted lines, coalesces untagged/legacy/string entries into a single `"setup"/"pre-stage"` sentinel fallback (so old tails keep rendering), returns `[]` on empty, and resolves each group's status via an INJECTED `statusOf` lookup. (3) Streaming `flush()` now emits a STACK of per-stage sections — a status-themed header (running→accent+bold+animated braille glyph, ok→success, failed→error, skipped→warning/dim) with a leading `▌` bar, followed by that stage's `themeLine`-themed lines indented two spaces, blank-separated; the running stage shows ≤15 recent lines, completed stages render COMPACT (header + ≤3-line tail or header-only), with per-stage `trim` notices. (4) `buildResultComponent` §1 is rebuilt into a stack of per-stage blocks mirroring pi-native tool-call bubbles — a bold status-glyphed header `Text`, per-kind themed line `Text` children, and a per-stage BACKGROUND via pi-tui `Text`'s 4th `customBgFn` (running→`toolPendingBg`, ok→`toolSuccessBg`, failed→`toolErrorBg`, skipped→none); failed/running blocks expand, completed compact; legacy tails fall back to the single merged section. (5) Stage tags thread end-to-end through `details.transcriptTail` via a single `stream.sink.stage(info)` wiring point in `extension.ts`. A shared `statusFgToken(status)` export dedups the status→color taxonomy across the live header, result header, and result background. Backward compatible: print/RPC/headless stay ZERO-ANSI byte-clean; additive type widening keeps every legacy caller strict-clean. Named caps bound the live stack (`RUNNING_TAIL_LINES=15`, `COMPLETED_TAIL_LINES=3`, `TOTAL_SECTION_CAP=400`, `PARTITION_INPUT_CAP=4000`). No new runtime deps; no control-flow / change-tracker / backend / dashboard-widget changes. New tests: `tests/stage-grouping.test.ts` (23), `tests/live-stream-per-stage.test.ts` (24), `tests/live-stream-flush-sections.test.ts` (23), `tests/render/per-stage-result.test.ts` (19); extended `tests/stream-theme-class-theme.test.ts` and `tests/render/real-theme-parity.test.ts`. `npm test` 1361 passed; `npm run typecheck` strict-clean.

### Added
- **Git change-tracker with claimed-vs-actual cross-check gate (spec-11).** A new `src/tracking.ts` `ChangeTracker` brackets **every stage (start + end)** and **every implementation phase (start + end)** with a git snapshot (`rev-parse HEAD` + `status --porcelain` baseline; `diff --name-status <beginHead>` UNION `status --porcelain` delta), persisting an append-only `<specDir>/change-tracker.jsonl`. Each phase-end record carries a git-derived `gitActual {created, modified, deleted}`, the agent's claimed `{filesCreated, filesModified, filesDeleted}`, and a one-directional cross-check (`claimedNotChanged` vs `changedNotClaimed`). A new `changeGate` is AND-ed into phase-green — `(gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass` — so a phase that **claims** to create/modify a file git does **not** show changed hard-fails (the false-green root cause closed a second way), while `changedNotClaimed` (under-reporting) stays advisory-only. The structured `{filesCreated, filesModified, filesDeleted}` contract replaces the advisory flat `filesModified` array returned by the implementer and fix prompts (legacy flat array still tolerated). `claimed.filesCreated` auto-unions into `deliverables.requireFiles` (spec-10 bridge), and a `📝 N files changed (C/M/D)` evidence line is surfaced in the implementation summary. Never throws: git-unavailable → record + `changeGate.pass = true` (never block). Stage bracketing uses the minimal-touch `ctx.events` subscription seam; the per-run singleton (`activeTracker`/`setActiveTracker`) mirrors `activeRun` and is cleared in `execute()`'s `finally`. New tests: `tests/tracking.test.ts`, `tests/structured-changes.test.ts`, `tests/tracker-bracketing.test.ts`, `tests/compute-change-gate.test.ts`, `tests/implementation-crosscheck-gate.test.ts`, `tests/change-tracker-nonregression.test.ts`. Pure TypeScript change to this repo, zero new runtime deps.

### Fixed
- **Scope-aware build gate now resolves real cargo package names.** `detectTouchedCargoPackages` (`src/build-runner.ts`) previously derived `-p` flags from workspace DIRECTORY names (e.g. `crates/data/` → `data`); on any prefixed-crate workspace (dirs `data/tools/workflows` → packages `stockfan-data/stockfan-tools/stockfan-workflows`) the gate ran `cargo build -p data -p tools`, which cargo rejected with `package ID specification 'data' did not match any packages` (exit 101), false-failing every attempt BEFORE compiling anything — a failure the repair loop cannot fix because the command is framework-derived. Added `resolveCargoPackageNames(cwd, touchedDirs)` (plus private `loadCargoMetadata` + a process-local per-cwd `cargoMetadataCache`) that spawns cached `cargo metadata --format-version 1 --no-deps`, maps each touched directory segment to the workspace package whose `manifest_path` parent matches, and is wired as the final step of `detectTouchedCargoPackages`. Never throws: any failure (missing/non-zero cargo, timeout, bad JSON) degrades to the directory-name identity fallback, so `dir==name` workspaces, non-cargo repos, and non-git dirs are byte-identical. Also augments `classifyOutOfScopeErrors` (`classificationScope`) so cargo's `crates/<dir>/` source-path markers still match in-scope crates under their real names (prevents a false-green regression). New env var `SUPER_DEV_CARGO_METADATA_TIMEOUT_MS` (default 30 000) bounds the single metadata spawn.

### Changed
- **Agent self-verification prompts forbid `--lib`-only green.** `buildImplementPrompt` / `buildQaPrompt` (`src/prompts.ts`) now append a Rust-scoped clause requiring `cargo test -p <pkg>` WITHOUT `--lib` (so `tests/` integration binaries run) plus any spec-mandated e2e/integration target, gated on the setup-detected `language === 'rust'`. Prompt-text only — no control-flow / nodes / workflow / pipeline change.

## [0.3.0] - 2026-07-06

### Added
- **Workflow resume (memoized replay).** An interrupted `super_dev` run (crash, abort, timeout, closed terminal) can now resume from where it left off instead of re-running from scratch. Uses the durable-execution replay pattern (Temporal-style): every run captures its agent-call results to `<specDir>/.resume-cache.jsonl`; on resume (`super_dev({ resume: true })` or `resumeSpecId: "07-foo"`), the cache is loaded and `ctx.agent` memoizes — completed calls return their cached result, the first uncached call re-runs, and the workflow continues. Agent-call granularity (resumes mid-verify-loop / mid-phase) via a deterministic `callId#seq` key. The worktree is reused (it's git ground truth). A fully-successful run clears its cache + writes a `.complete` marker so it isn't re-resumed. Design + decisions in `docs/findings/workflow-resume-deep-research.md`.

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
