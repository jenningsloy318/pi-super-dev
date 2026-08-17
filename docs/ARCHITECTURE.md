# Architecture (generated)

> Generated from `src/graph/edges.ts` + `src/team/raci.ts` at v0.1.99 — do not edit by hand; run `npm run arch:doc`.

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
| `verify` | `docs` | composition: docs runs only after positive Stage 10 verification (hasVerifiedImplementation branch) |
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

## Where the semantics live

- Loop vocabulary + degradation ladder: `docs/requirements/postmortem-0001-verify-loop-dead-state.md`
- Named defensive rules: `docs/requirements/defensive-patterns.md`
- Event ledger + invariants: `src/runlog.ts` (INV-L1..L6)
- Replan circuit: `src/replan/` (requests, owner classification, R5 budget)
- Deterministic gates: `src/build-runner/`
