# Architecture (generated)

> Generated from `src/graph/edges.ts` + `src/team/raci.ts` at v0.4.88 — do not edit by hand; run `npm run arch:doc`.

## Stage table (RACI over the skeleton)

| Stage | Responsible (produces) | Accountable (owns acceptance) | Consulted (gate) | Informed (downstream) |
|---|---|---|---|---|
| `setup` | `orchestrator` | `setup` | — | 16 (`assessment`, `bdd`, `classify`, `cleanup`, …) |
| `classify` | `task-classifier` | `classify` | — | 15 (`assessment`, `bdd`, `cleanup`, `debug`, …) |
| `requirements` | `requirements-clarifier` | `requirements` | `requirements-reviewer` | 14 (`assessment`, `bdd`, `cleanup`, `debug`, …) |
| `bdd` | `bdd-scenario-writer` | `bdd` | `bdd-reviewer` | 13 (`assessment`, `cleanup`, `debug`, `design`, …) |
| `research` | `research-agent` | `research` | — | 12 (`assessment`, `cleanup`, `debug`, `design`, …) |
| `debug` | `debug-analyzer` | `debug` | — | 11 (`assessment`, `cleanup`, `design`, `docs`, …) |
| `assessment` | `code-assessor` | `assessment` | — | 10 (`cleanup`, `design`, `docs`, `implementation`, …) |
| `design` | `architecture-designer` | `design` | `design-reviewer` | 9 (`cleanup`, `docs`, `implementation`, `merge`, …) |
| `prototype` | `prototype-runner` | `prototype` | — | 8 (`cleanup`, `docs`, `implementation`, `merge`, …) |
| `spec` | `spec-writer` | `spec` | `spec-reviewer` | 7 (`cleanup`, `docs`, `implementation`, `merge`, …) |
| `implementation` | `implementer` | `implementation` | `tdd-guide`, `red-boundary-classifier`, `tdd-coverage-classifier` | 6 (`cleanup`, `docs`, `merge`, `merge-verify`, …) |
| `verify` | `code-reviewer` | `verify` | `adversarial-reviewer`, `judge` | 5 (`cleanup`, `docs`, `merge`, `merge-verify`, …) |
| `docs` | `docs-executor` | `docs` | — | 4 (`cleanup`, `merge`, `merge-verify`, `preMergeBuild`) |
| `preMergeBuild` | `orchestrator` | `preMergeBuild` | — | 3 (`cleanup`, `merge`, `merge-verify`) |
| `cleanup` | `orchestrator` | `cleanup` | — | 2 (`merge`, `merge-verify`) |
| `merge` | `orchestrator` | `merge-verify` | — | 1 (`merge-verify`) |
| `merge-verify` | `orchestrator` | `merge-verify` | — | 0 (terminal) |

## Dependency edges (verified prompt reads + composition adjacencies)

| Upstream | Downstream | Why the edge is real |
|---|---|---|
| `setup` | `classify` | classification reads the detected language/isWebUi from state.setup |
| `classify` | `requirements` | buildRequirementsPrompt(s, c, task) reads the classification |
| `requirements` | `bdd` | buildBddPrompt(…, requirements) — BDD scenarios cover requirements ACs |
| `requirements` | `research` | buildResearchPrompt(…, requirements, …) reads the requirements |
| `bdd` | `research` | buildResearchPrompt(…, bdd, …) — research derives questions after reading the BDD scenarios |
| `requirements` | `debug` | buildDebugPrompt(…, requirements, …) reads the requirements (bug path only) |
| `research` | `debug` | buildDebugPrompt(…, research) reads the research report |
| `research` | `assessment` | buildAssessmentPrompt(…, research, …) reads the research report |
| `debug` | `assessment` | buildAssessmentPrompt(…, debug) reads the debug analysis when present |
| `requirements` | `design` | buildDesignPrompt(…, requirements, …) reads the requirements |
| `research` | `design` | buildDesignPrompt(…, research, …) reads the research report |
| `assessment` | `design` | buildDesignPrompt(…, assessment) reads the code assessment |
| `design` | `prototype` | buildPrototypePrompt(…, design, …) prototypes the chosen design |
| `requirements` | `spec` | buildSpecPrompt(…, requirements, …) cites requirements ACs |
| `bdd` | `spec` | buildSpecPrompt(…, bdd, …) binds scenarios into phases |
| `research` | `spec` | buildSpecPrompt(…, research, …) carries research constraints |
| `assessment` | `spec` | buildSpecPrompt(…, assessment, …) carries code-assessment findings |
| `design` | `spec` | buildSpecPrompt(…, design, …) instantiates the design modules |
| `prototype` | `spec` | buildSpecPrompt(…, prototype) folds validated prototype constants |
| `spec` | `implementation` | buildImplementPrompt/buildTddPrompt read the spec control (phases, deliverables) |
| `bdd` | `implementation` | buildTddPrompt(…, bddControl) — TDD scenarios come from the BDD artifact |
| `spec` | `verify` | reviewers read specControl (buildCodeReviewPrompt/buildAdversarialPrompt/buildTestsReviewPrompt take specControl) |
| `implementation` | `verify` | reviewers read implControl; verification gates the implementation's phases |
| `spec` | `docs` | buildDocsPrompt(…, specControl) documents the spec's deliverables |
| `verify` | `docs` | composition: docs runs only after positive verification convergence (hasVerifiedImplementation branch) |
| `docs` | `preMergeBuild` | composition: sequence(docs → preMergeBuild → cleanup → merge) |
| `preMergeBuild` | `cleanup` | composition: cleanup runs after the pre-merge build gate |
| `cleanup` | `merge` | composition: merge is gated on cleanup's sensitive-scan (canMerge branch) |
| `merge` | `merge-verify` | composition: mergeVerifyTask runs immediately after mergeWriter |

## Invalidation sets (D3 — downstreamOf, full reachability)

- `setup` → `assessment` `bdd` `classify` `cleanup` `debug` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `requirements` `research` `spec` `verify`
- `classify` → `assessment` `bdd` `cleanup` `debug` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `requirements` `research` `spec` `verify`
- `requirements` → `assessment` `bdd` `cleanup` `debug` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `research` `spec` `verify`
- `bdd` → `assessment` `cleanup` `debug` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `research` `spec` `verify`
- `research` → `assessment` `cleanup` `debug` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `spec` `verify`
- `debug` → `assessment` `cleanup` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `spec` `verify`
- `assessment` → `cleanup` `design` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `spec` `verify`
- `design` → `cleanup` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `prototype` `spec` `verify`
- `prototype` → `cleanup` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `spec` `verify`
- `spec` → `cleanup` `docs` `implementation` `merge` `merge-verify` `preMergeBuild` `verify`
- `implementation` → `cleanup` `docs` `merge` `merge-verify` `preMergeBuild` `verify`
- `verify` → `cleanup` `docs` `merge` `merge-verify` `preMergeBuild`
- `docs` → `cleanup` `merge` `merge-verify` `preMergeBuild`
- `preMergeBuild` → `cleanup` `merge` `merge-verify`
- `cleanup` → `merge` `merge-verify`
- `merge` → `merge-verify`
- `merge-verify` → _(terminal)_

## Code architecture (the v0.4.34-v0.4.55 split — module map)

> The five former giants were decomposed under the AGENTS.md granularity standard
> (one reason to change per module; loop skeletons and wiring cores kept where the
> wrong-seam signals applied). Every extraction was byte-faithful with dual gates.

| Former giant | Now | Composition kept |
|---|---|---|
| `stages/implementation/stage.ts` (3,038 → 1,375) | 28 single-reason modules under `src/stages/implementation/` — dispatchers (implementer-prompt, implementer-dispatch, red-tdd-dispatch), record builders (red-oracle-cycle, gate-suite, phase-entry), adjudicators (protection-gate, inherited-red-ladder, env-blocker-regate/judge, no-progress-valve, green-boundary, red-retry-ladder, red-acceptance), boundary closers (phase-tail, stage-close-reverify, phase-entry) | the attempt-loop skeleton, P3 run-state guards, the let-cascade, outcome interpretation |
| `workflow.ts` (1,522 → 942) | `src/workflow/` — source-boundary, usage-accounting, run-status, agent-retry, pre-call-fuses, agent-call-assembly | makeContext/realAgent dispatch + terminal try/catch, runWorkflow (closure-dense by design) |
| `extension.ts` (1,237 → 658) | `src/extension/` — escalation, run-presentation, run-state, tool-args, event-handlers | doRun execute core, pi registrations, renderers/panel |
| `setup.ts` (1,042 → 326) | `src/setup/` — env-files, spec-identity, run-lock, worktree-git, bootstrap | runSetup + SetupOptions + detectLanguage |
| `red-evidence.ts` (1,060 → 667) | `red-snapshot.ts` (snapshot/ratchet/restore) + `red-boundary.ts` (the two RED-gate agent adjudications) | the signatures/citations/porcelain/reasons/caps flat library core |

Cross-cutting foundations (each a leaf or choke point, unchanged by the splits):

- `src/nodes.ts` — the control-flow node algebra (task/sequence/branch/parallel/loop/retry/gate/map/wait/tryCatch); `FatalAbort` + `RouteBackSignal` propagation contracts
- `src/tracking.ts` — the change tracker (never-throw, conservative parse, the false-green killer cross-check) + `rollbackWorktreeTo`
- `src/harness-paths.ts` — the SINGLE canonical registry of harness-file roles (red-boundary / advisory-noise / claim-exempt / neverGitTracked / stateExternal); consumers derive sets, never declare literals
- `src/state/state-root.ts` — the external-state funnel `stateFileFor` (fail-closed, realpath-canonicalized project keys) + one-time migration + orphan sweep
- `src/runlog.ts` — the append-only events ledger (INV-L1..L6, torn-line healing, payload bounds)
- `src/convergence-ledger.ts` — findings lifecycle (writer claims vs reviewer verification, duty downgrades with provenance gating, superseded orphaned anchors)
- `src/control.ts` — `<control>` extraction (decoy guards, unescaped-quote repair, depth-aware key parsing)
- `src/resume.ts` — durable-execution replay (structural cache keys, poisoned-row recovery, error rows never replayed)
- `src/agent-errors.ts` — non-retryable classification incl. the persisted model-exclusion store diagnosis (TZ-validated quota hints) + the host-SDK resolution remedy
- `src/fault-classification.ts` — the deterministic fault floor (environmental vs product vs unclassified) + the never-destructive dirt quarantine
- `src/wall-fuse.ts` — the per-run-pass wall budget (first-trip-wins marker, trailing-median wind-down)
- `src/agent-budget-fuse.ts` — the spawn-budget terminal marker (partial (agent-budget), first-trip-wins, fresh budget per resumed pass)
- `src/routing/router.ts` — the ONE routing vocabulary (continue/retry/route-back/escalate/accept-limitation/abort) every decision mechanism maps onto

## Where the semantics live

- Loop vocabulary + degradation ladder: `docs/requirements/027-postmortem-0001-verify-loop-dead-state.md`
- Named defensive rules: `docs/requirements/026-defensive-patterns.md`
- Event ledger + invariants: `src/runlog.ts` (INV-L1..L6)
- Replan circuit: `src/replan/` (requests, owner classification, R5 budget)
- Deterministic gates: `src/build-runner/`
