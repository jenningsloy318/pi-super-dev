# pi-super-dev — Rewrite Review vs `super-dev-plugin`

**Date:** 2026-07-06
**Scope:** Full-history review of `pi-super-dev` (68 commits, first commit
`17e9223d` → current `HEAD`) as a rewrite of `../super-dev-plugin` (v2.5.47)
into the Pi coding-agent ecosystem.
**Reviewer:** code assistant
**Method:** codebase diff, architecture comparison, evolution reading via
`git log`, and inspection of both plugin manifests, agents, workflows, tests,
and runtime scaffolding.

---

## TL;DR

`pi-super-dev` is a **first-principles rewrite** of the 14-stage super-dev
workflow onto Pi's coding-agent runtime. It faithfully ports the domain
model (stages, gates, agents, schemas) while replacing the plugin substrate
— Claude Code's Skill/Agent/Workflow tools, hooks, and multi-platform
manifests — with a **self-contained TypeScript control-flow engine** and
Pi's SDK.

- **Achieved:** all 13 stages runnable end-to-end, 24 specialist agents,
  17 typed schemas, dual (session/subprocess) agent backend, feedback-
  driven gates, unified verify-loop, deterministic render pipeline,
  cross-run learning (`~/.pi/agent/super-dev/`), zero external workflow
  dependency, ~2 000 LOC of unit/integration tests.
- **Better:** typed algebra of control nodes; render pipeline (content vs.
  format); feedback that converges instead of resampling; deterministic
  setup; single tool + single command surface; in-process SDK execution
  path; audit + reflection loop.
- **Gaps:** 18 fewer specialist agents (language/platform developers
  missing); no PreTool/PostTool/Stop hooks (safety net, auto-fix, auto-
  checkpoint, test runners); no reference/templates/lessons-learned
  corpus; no multi-platform manifests (Claude/Codex/Antigravity); some
  gates from v2 (implementation-completeness, spec-review as gate, pivot
  protocol) are relaxed or absent by design.

Verdict: **the rewrite is architecturally superior, functionally
narrower, and operationally leaner.** The gaps are almost all opinionated
subtractions or Pi-runtime-native replacements, not regressions.

---

## 1. What both projects are

| Aspect | `super-dev-plugin` (v2.5.47) | `pi-super-dev` (HEAD, v0.1.3) |
| --- | --- | --- |
| Host runtime | Claude Code / Codex CLI / Antigravity | Pi coding-agent |
| Distribution | Claude plugin (`plugin.json` × 3) | npm + `pi install` extension |
| Entry | `super-dev:super-dev` Skill (SKILL.md, 561 lines) or `super-dev:workflow` Skill invoking `Workflow(...)` | `super_dev` tool + `/super-dev` command registered by `src/extension.ts` |
| Execution engine | Two paths: (a) team-lead narration inside a single context window spawning agents via harness `Agent` tool; (b) Claude Code Dynamic Workflow (`workflows/super-dev.workflow.js`, 3 748 LOC) using `agent()/pipeline()/parallel()` globals | Self-contained TypeScript **control-flow node algebra** (`src/nodes.ts`, 565 LOC) evaluated by a 100-line runner (`src/workflow.ts`); no external workflow engine |
| Sub-agent invocation | `Agent({ subagent_type: "super-dev:<name>", … })` provided by the harness | `spawnAgent()` = `pi --mode json -p --no-session --no-skills` subprocess **or** in-process `createAgentSession(...)` from `@earendil-works/pi-coding-agent`, selected per-call |
| Stages | 14 (with sub-stages 2.5, 3.5, 5.3, 5.5, 6.5, 10.5) | 13 declarative nodes in `src/stages/index.ts` |
| Structured outputs | 21 JSON schemas inlined + `schemas/*.json` on disk | TypeBox schemas in `src/render/schemas.ts` (17 stage models) doubling as (a) TS types, (b) validator input, (c) tool-schema for `structured_output` |
| Documents | Agents write markdown via templates in `templates/` and `reference/` | Agents return structured **content**; a Jinja-subset engine renders the doc from the content + TypeBox schema |
| Runtime data | Tracking JSON, per-run logs, `.claude/…` | `~/.pi/agent/super-dev/` (config, `runs/<ts>/`, `learned.md`, `learned-index.json`, `stats.json`, `traces/`) |
| Hooks | 5 hook scripts wired via `hooks.json` (usage-tracker, block-dangerous, auto-fix, run-tests, auto-checkpoint) | None (Pi has different lifecycle primitives) |
| LoC & code weight | ~4 800 LoC in one workflow script + `scripts/` + `reference/` | 4 769 LoC across 29 modular TS files + 2 017 LoC of tests |

---

## 2. What has been achieved

### 2.1 Full pipeline parity at the stage level

The 13-stage flow expressed in `src/stages/index.ts` mirrors the original's
Stage 1 → Stage 14 map (Stage 11 Integration Testing is now inside a
unified verify-loop, not a separate stage):

```
setup ─► classify ─► gate(requirements) ─► gate(bdd) ─► gate(research) ─►
branch[bug]→debug ─► assessment ─► design ─► prototype ─►
gate(spec) ─► spec-review ─► implementation ─►
branch[hasImpl]→verify-loop{ parallel[code-review, adversarial] → bringup → api-test → ui-test → teardown → fix } ─►
docs ─► cleanup ─► branch[!blocked]→merge
```

Concretely:

- Deterministic setup (language detection, worktree, spec dir, git bootstrap
  for empty repos) — see `src/setup.ts`.
- Stage-2 gates (requirements, BDD) as *feedback-driven* retry loops with
  `attempts: 4`, non-fatal exhaustion.
- Stage-3 research gate that keeps iterating until every open issue is
  resolved (`researchComplete` in `src/stages/index.ts:44-59`).
- Conditional debug analysis via `branch(isBug, …)`.
- Design routing (product / architecture / architecture-improver / ui-ux) via
  `route-designer` helper in `src/helpers.ts`.
- Conditional prototype via `check-prototype-needed` (numeric-constants gate).
- Stage-9 per-phase TDD loop (tdd → specialist implementer → qa → gate-build,
  ≤3 attempts, commit-on-green) in `src/stages/implementation.ts`.
- Stage-10 unified verify-loop (`src/stages/verify.ts`) that runs both
  reviewers in parallel, merges verdicts, brings services up, runs api-tester
  + ui-tester, tears services down, and fixes — iterating until
  `reviewApproved && testsGreen`.
- Docs (`docs-executor`) + cleanup + conditional merge.

### 2.2 21+ specialist agents ported

All Stage-owning specialists from `super-dev-plugin/agents/*.md` are present
under `pi-super-dev/agents/*.md` (24 files):

`orchestrator, requirements-clarifier, bdd-scenario-writer, research-agent,
debug-analyzer, code-assessor, architecture-designer, architecture-improver,
ui-ux-designer, product-designer, prototype-runner, spec-writer, spec-reviewer,
tdd-guide, implementer, qa-agent, code-reviewer, adversarial-reviewer,
docs-executor, handoff-writer, build-cleaner, api-tester, ui-tester,
reflection`

`reflection` is new (dreaming/learning, §3.6). `api-tester` and `ui-tester`
are new agents that replace the plugin's Stage-11 (`e2e-runner`,
`visual-verifier`), driving `browser_execute` via CDP.

### 2.3 Typed contract for every stage

`src/render/schemas.ts` defines TypeBox models for all 17 doc-producing
stages (`requirements, bdd, research, debug, codeAssessment, design,
prototype, spec, task-list, implementationPlan, specReview,
implementationSummary, codeReview, adversarialReview, docs, apiTest,
uiTest`). Each schema drives:

1. compile-time `Static<>` type for the pipeline code,
2. runtime `Value.Errors` validation of the agent's structured output,
3. Jinja-subset rendering of the markdown doc (`src/render/templates/`).

The plugin held JSON schemas as strings + `.j2` templates and left validation
to a Node script (`scripts/lib/schema-validator.mjs`); the rewrite fuses
all three uses into one artifact.

### 2.4 Composable control-flow algebra

`src/nodes.ts` is the substantive design win. Every construct the plugin
implemented ad hoc in the workflow JS is now a first-class node:

| Node | ASL / Pattern lineage | Plugin equivalent |
| --- | --- | --- |
| `task(stage)` | ASL Task | in-line `agent(...)` calls |
| `sequence([...], {tolerant})` | Sequence (WCP1) | JS control flow |
| `branch / choose` | Exclusive / Multi Choice (WCP4) | `if/else`, `switch` |
| `parallel([...], {into, join})` | Split + Sync (WCP2+3) | `parallel([...])` from Workflow runtime |
| `loop({while/until/times})` | Arbitrary Cycles (WCP10) | `while (iter < MAX_…)` |
| `retry({attempts, backoff})` | ASL Retry | manual retry blocks |
| `gate({validate, feedbackKey, attempts})` | domain quality-gate | `gatedStage2WriterLoop`, `_gatedLoop`, `gatedSpecTraceLoop` (three separate helpers) |
| `map({over, as, concurrency})` | Multi-Instance (WCP12-14) | none |
| `wait` / `waitForEvent` | ASL Wait / Deferred Choice (WCP16) | none |
| `tryCatch(body, {catch, finally})` | ASL Catch | `try/finally` scattered |
| `noop` | ASL Pass | — |

The runner is `await root.run(state, ctx)` — 15 lines. Adding a construct
means writing one builder in `nodes.ts`, not touching the runner or
migrating a Workflow-runtime version.

### 2.5 Self-containment

Explicit non-goal of the rewrite, and it's met:

- `peerDependencies` only: `@earendil-works/pi-coding-agent`, `typebox`.
  No `dependencies`. `pi install` needs no `npm install` step.
- No `@agwab/pi-workflow` or any external workflow engine (README:
  "Fully self-contained: no dependency on @agwab/pi-workflow or any other
  workflow engine.").
- `src/pi-spawn.ts` shells out to `pi` directly; `src/session-agent.ts`
  drives `createAgentSession()` in-process. Either backend satisfies the
  same `SpawnResult` contract, selected by extension flag or
  `SUPER_DEV_BACKEND` env.

### 2.6 Test coverage

`tests/*.ts` = 16 files, 2 017 LoC, covering: control-flow nodes,
helpers, doc-validators, render pipeline (435 LoC — the largest suite),
lifecycle, pi-spawn, session-agent, prompts, predicates, setup,
structure regression, verify-loop, workflow-feedback, workflow. The
original had 2 test files (216 tests). Rewrite has broader, thinner
per-module coverage; original had heavier integration tests.

### 2.7 UX: single entry point

The plugin exposes **two skills** the user has to know about:
`super-dev:super-dev` (team-lead) vs `super-dev:workflow` (dynamic-
workflow). The rewrite exposes one tool + one command with identical
semantics on every run, discovered automatically by Pi's tool-list. No
`--workflow` flag, no version-gated Skill selection.

---

## 3. Where the rewrite is materially better

### 3.1 Feedback-driven gate convergence (fixes the "gate failed 3×" root cause)

`super-dev-plugin` retries a failed gate by re-spawning the writer with a
canned "Prior attempt(s) returned no result" retry banner (`MAX_RETRIES =
10`, see `workflows/super-dev.workflow.js:528-541`). The agent
resamples from the same distribution and often produces the same failure.

`pi-super-dev` stores the *validator's structured errors* under
`state.__feedback[stageKey]` and prepends them to the next attempt's
prompt (`src/workflow.ts:64-75`):

```ts
const feedback = fb?.[stageKey];
const prompt = feedback?.length
  ? `${call.prompt}\n\n## Previous attempt rejected — fix these\n`
    + `The validator rejected the prior attempt for these specific reasons:\n`
    + feedback.map((e) => `- ${e}`).join("\n")
    + `\nAddress every point and re-produce the complete artifact...`
  : call.prompt;
```

This converts a retry from "roll the dice again" into "fix this specific
list." The same mechanic backs the session backend's corrective re-prompt
when a structured_output is missing declared keys (`session-agent.ts`,
`missingKeys()`). Research basis cited in comments: the SWE-bench agent /
SWE-agent convergence pattern — test/validator feedback is the signal.

### 3.2 Content vs format — the render pipeline

Plugin model: agent writes markdown by hand following a `.j2` template
loaded from `templates/`; a `doc-validator` agent then re-reads the doc
and checks structure via `scripts/gates/runner.mjs`. Failure modes the
rewrite removes:

- agents that forgot the template and produced free-form prose
  (documented in CHANGELOG 0.1.2 — "agents burned a turn hunting for
  non-existent files");
- gate validators chasing format drift instead of content;
- per-stage `template-path` config that drifted from on-disk templates.

Rewrite model (`src/render/render.ts`): the agent returns **content**
conforming to a TypeBox schema. `renderStage()` validates it, augments
computed fields (`totalScenarios`, `totalACs`, `phaseCount` — values the
model would otherwise miscount), and renders the doc via a Jinja-subset
engine. `renderAndWrite()` writes the doc, renders `additionalDocs`
(e.g. spec → 3 docs), and auto-accumulates the raw content to
`.knowledge.json`. **Format is solved; the agent focuses on content.**

### 3.3 Deterministic setup (no LLM round-trip)

The plugin used a `setup-agent` to detect language/framework. The rewrite
makes this a pure function in `src/setup.ts:detectLanguage()`: manifest
file checks (Cargo.toml → rust, go.mod → go, pyproject → python,
package.json deps → backend/frontend), with greenfield inference from
task text. One model round-trip removed before Stage 1 even runs; zero
risk of "setup agent hallucinated 'clojure'".

Also: deterministic spec-id numbering, `slugifyTask()` stopword stripping,
empty-repo bootstrap (`git init` + `--allow-empty` commit so worktree
add doesn't fall over — fixes a silent-fallback bug class).

### 3.4 Declarative knowledge injection (Option C)

`src/render/knowledge.ts` declares, per agent, exactly which fields from
which prior stages' content it needs:

```ts
"spec-writer": [ {stage:"requirements", path:"acceptanceCriteria", label:"ACs"},
                  {stage:"bdd",         path:"features",        label:"Scenarios"},
                  {stage:"code-assessment", path:"patterns",    label:"Patterns"},
                  {stage:"code-assessment", path:"services",    label:"Services"} ],
```

The pipeline extracts those fields from `.knowledge.json` and injects
them into the agent's prompt (`workflow.ts:knowledgeForAgent`). The
agent never reads the file, never reads unrelated prior output. The
plugin's equivalent was ad-hoc prompt construction in the workflow JS
that re-read whole documents, costing context.

### 3.5 Cross-run learning and reflection (the dreaming loop)

`~/.pi/agent/super-dev/` is a first-class runtime store:

- `learned.md` — lessons-learned, append-only, scored.
- `learned-index.json` — fast lookup index rebuilt after each run.
- `learned-archive.md` — overflow archive past `maxLearnedEntries`.
- `runs/<ts>/{run.log, audit.jsonl, reflection.md}` — per-run audit trail.
- `stats.json` — aggregate stats (success rate, stage timings).
- `traces/` — super-dev debug traces (`SUPER_DEV_DEBUG=1`).

After each run, `runReflectionAsync()` (`src/render/reflection.ts`)
spawns a `reflection` agent that reads the audit trail, identifies
patterns (retries, errors, timing), scores them, and updates
`learned.md` + `learned-index.json`. **The next run's agents wake up
smarter.** Fire-and-forget (non-blocking); best-effort on failure.

The plugin kept `lessons-learned/` as static reference docs a human wrote;
the rewrite closes the loop automatically. This is the rewrite's most
ambitious net-new capability.

### 3.6 Unified verify-loop with service lifecycle

`src/stages/verify.ts` expresses the entire Stage-10 hardening loop as
one `loop({until: approvedAndGreen, times: 4}, sequence([reviewStep,
branch(reviewApproved, testBlock), fixStep]))`. Inside:

- `reviewStep` = `parallel([codeReview, adversarialReview], {into:"review",
  join: merge-review-verdicts})` — both reviewers converge into one
  verdict under `state.review`.
- `testBlock` = `tryCatch(sequence([bringup, apiTest, uiTest]),
  {finally: teardown})` — services come up only after review approves;
  `apiTestStep`/`uiTestStep` self-skip without ready services (no
  phantom connection-refused failures); teardown always runs.
- `fixStep` = `branch(needsFix, fix | noop)` — implementer addresses
  review findings AND test failures.

Service lifecycle (`src/stages/lifecycle.ts`): concurrent multi-service
start, `.env` loading, readiness poll, try/finally teardown.
`withServiceDeps(["api"])` wraps a node so it self-skips (with a log)
if its service didn't come up — graceful degradation instead of failure.

The plugin ran Stage-10 and Stage-11 as separate, sequential stages with
manual gate interlocks; the rewrite collapses them into one converging
loop driven by observable test results.

### 3.7 Tolerant sequences and non-fatal budget exhaustion

`sequence(..., {tolerant: true})` lets a failed node log and continue
rather than abort the pipeline (used for prototype, docs, cleanup,
non-critical gates). Budget exhaustion returns partial results instead
of throwing. The plugin's `MAX_RETRIES = 10` exhaustion threw `Error` and
escalated; the rewrite degrades gracefully.

### 3.8 Type safety end-to-end

TypeBox gives compile-time types from the same schema object that
validates at runtime and renders the doc. The plugin's JSON schemas were
strings the TS couldn't see. Pipelines that referenced a renamed field
failed at compile time in the rewrite; in the plugin they failed at
runtime, mid-workflow.

---

## 4. Gaps vs `super-dev-plugin`

These are real deficits measured against v2.5.47. They fall into three
buckets: (A) intentionally omitted Pi-runtime mismatches, (B) opinionated
subtractions, (C) honest coverage gaps.

### 4.1 Specialist agent roster (bucket C — honest gap)

| Plugin agent | pi-super-dev | Notes |
| --- | --- | --- |
| `frontend-developer` `backend-developer` `golang-developer` `rust-developer` | **absent** | The rewrite routes via `route-specialist` helper but lands on a single generic `implementer` agent. Plugin's per-language developers carried language-specific best-practices prompts (build commands, test runners, lint). |
| `android-developer` `ios-developer` `macos-app-developer` `windows-app-developer` | **absent** | Mobile/desktop platform specialists. Setup detection in pi-super-dev has no mobile/desktop branches (only rust/go/python/backend/frontend/mixed). |
| `security-reviewer` | **absent** | Dedicated security review. `adversarial-reviewer` covers correctness, not threat modeling. |
| `visual-verifier` | folded into `ui-tester` | Visual regression moved into the CDP-driven ui-tester. |
| `e2e-runner` | folded into `api-tester` + `ui-tester` | HTTP CRUD + CDP UI testing replace the generic e2e agent. |
| `search-agent` | **absent** | Web-search specialist used by research stage. |
| `planner` `team-lead` `investigator` | **absent** | Coordination/analysis roles the plugin used in its team-lead execution path. The rewrite has no team-lead path (single execution model). |
| `doc-updater` `doc-validator` | **absent as agents** | Doc validation moved into deterministic helpers (`doc-validators.ts`) — arguably better, but loses the LLM-driven doc-update agent. |
| `dev-executor` `refactor-cleaner` `build-error-resolver` `impl-summary-writer` | folded into `implementer` / `orchestrator` | Consolidated. |

**Net:** 24 agents vs 42. The 18 missing are mostly language/platform
specialists and coordination roles. For polyglot or mobile projects this
is a coverage regression; for typical web/backend work the generic
`implementer` + per-phase `route-specialist` routing is adequate.

### 4.2 Skill library (bucket C — honest gap)

Plugin ships **30 skills** (adversarial-review, architecture-design,
autoresearch, build-fix, careful, code-assessment, code-review,
debug-analysis, documentation, e2e, execute, freeze, golang, improve-
architecture, learn, plan, refactor-clean, research, security-review,
super-dev, super-dev-workflow, tdd, tdd-workflow, test-coverage, ui-ux-
design, update-codemaps, update-docs, usage-report, verify). pi-super-dev
ships **1** (`super-dev`). The plugin's skills let a user invoke a
single capability (e.g. `/tdd`) outside the full pipeline; the rewrite
requires running the whole 13-stage flow or calling the tool with
`skipStages`.

### 4.3 Hooks system (bucket A — Pi-runtime mismatch)

Plugin `hooks.json` wires lifecycle hooks the harness calls:

- `PreToolUse`: `usage-tracker` (budget accounting), `block-dangerous`
  (refuses `rm -rf /`, force-push to main, secret exfiltration).
- `PostToolUse`: `auto-fix` (re-runs linters on Edit/Write), `run-tests`
  (runs affected tests on Write|Edit).
- `Stop`: `auto-checkpoint` (snapshot progress when the agent stops).

pi-super-dev has **no equivalent**. Pi has a different extension model
(no PreToolUse/PostToolUse/Stop hook surface in the same shape). The
safety net (`block-dangerous`) and the auto-test-on-edit behavior are
absent. Mitigations exist (budget cap in `makeBudget`, worktree
isolation, gate-build after QA) but they're coarser.

**This is the most operationally significant gap.** A `block-dangerous`
equivalent for spawned subprocesses would be a high-value addition.

### 4.4 Reference corpus (bucket B — opinionated subtraction)

Plugin `reference/` ships:
- `templates/` — document templates (now superseded by render pipeline).
- `document-naming.md`, `pivot-protocol.md`, `iteration-loops.md`,
  `verification-gates.md`, workflow docs.
- `lessons-learned/` — static human-curated lessons.

pi-super-dev has none of this as shipped reference. The render pipeline
absorbs the templates; reflection (§3.5) generates lessons dynamically.
But the *protocol* docs (pivot-protocol, iteration-loop semantics,
verification-gate definitions) are not ported as user-readable reference.
They live implicitly in the stage code.

### 4.5 Multi-platform manifests (bucket A — by design)

Plugin ships `.claude-plugin/`, `.codex-plugin/`, `.antigravitycli/`,
`plugin.json` — installable on three harnesses. pi-super-dev targets Pi
only. Not a regression for Pi users; a scope reduction.

### 4.6 Pivot protocol and implementation-completeness gate (bucket B)

The plugin's Stage-10 has two escalation paths the rewrite omits:

- **Pivot protocol:** when `adversarial-reviewer.spec_faithful_but_wrong
  === true` at iteration ≥ 2, the plugin throws `PIVOT_REQUIRED` and
  re-runs from Stage 6 with a revised design. The rewrite's verify-loop
  has no such signal — it fixes in place until attempts exhaust
  (non-fatal) or converges.
- **Implementation-completeness gate:** `gate-implementation-complete`
  verifies every implementation-plan phase shows `status='complete'`
  before review. The rewrite trusts Stage-9's per-phase green/gate-build.
- **Signature-stagnation detection:** if the same files+severities
  repeat across iterations, the plugin detects non-convergence and
  pivots. The rewrite's loop just runs `times: 4`.

These are recoverable: the node algebra can express them (a `branch`
on a stagnation predicate inside the loop), but they aren't wired today.

### 4.7 Team-lead execution path (bucket B)

Plugin offers `super-dev:super-dev` (team-lead narrates, spawns agents
in-context, lower latency, shared context) vs `super-dev:workflow`
(deterministic, isolated contexts). pi-super-dev has only the
deterministic isolated-context path (each specialist is a fresh `pi`
subprocess / session). Trade-off: stronger isolation and reproducibility,
higher per-stage latency, no shared long context.

### 4.8 Statistics / usage reporting (bucket B)

Plugin `scripts/utils/usage-tracker.mjs` + `usage-report` skill produce
detailed usage reports. pi-super-dev has `stats.json` (aggregate,
updated by reflection) but no user-facing report skill.

---

## 5. Evolution summary (commit history)

68 commits across roughly six phases:

1. **Foundation** (`17e9223d` →) — scaffold, tsconfig, package, README,
   usage docs. Extension skeleton.
2. **Port** — agents (21 → 24 MD files), schemas (JSON → TS), helpers
   (`.mjs` → `.ts`), gate definitions, classify/route/gate helpers.
3. **Controller** — initial monolithic controller (~901 lines), then
   refactored into the node algebra + declarative stages.
4. **v0.1.0** (`c58a0510`) — 13-stage pipeline runnable, 216 tests,
   budget control, conditional routing, worktree lifecycle.
5. **Self-contained refactor** — drop `@agwab/pi-workflow` dependency;
   control-flow node engine; runner = `await root.run()`.
6. **v0.1.1–0.1.3** — render pipeline (typed templates + schemas);
   verify-loop + service lifecycle; api/ui testers; feedback-driven
   gate retries; doc-content gates; reflection/knowledge accumulation;
   debug traces; bug fixes (Stage-9 phases crash, .env loading, agent
   output truncation, dead template references, vacuous-pass gates).

The trajectory is consistently toward *determinism* (setup, gates,
render, feedback) and *self-containment* (no workflow dep, in-process
backend, single tool/command).

---

## 6. Recommendations

Ordered by leverage.

1. **Port the safety hook equivalent.** A `block-dangerous`-style guard
   on spawned subprocess tool calls is the highest-value missing piece.
   Even a static denylist (rm -rf /, force-push main, `>` on
   `.git/config`) wrapped around `spawnAgent` would close the biggest
   operational risk. Pi's extension API may offer a PreTool surface to
   hook; otherwise inject a system-preamble into specialist prompts.
2. **Add language specialists incrementally.** Start with
   `golang-developer` and `rust-developer` (the plugin's prompts are
   reusable); wire `route-specialist` to dispatch on `setup.language`.
   Mobile/desktop can wait until setup detection learns those stacks.
3. **Wire the pivot protocol.** Add `spec_faithful_but_wrong` to the
   adversarial-review schema; add a `branch` inside `verifyNode` that,
   on iteration ≥ 2 with that flag set, throws a `PIVOT_REQUIRED`-
   style control signal caught by a `tryCatch` that re-enters at the
   design stage. The node algebra already supports this.
4. **Port the protocol reference docs.** Move `pivot-protocol.md`,
   `iteration-loops.md`, `verification-gates.md` semantics into
   `docs/` as user-readable reference (the logic already lives in code;
   documenting it aids contributors and the reflection agent).
5. **Expose granular skills.** Consider shipping `tdd`, `code-review`,
   `research` as standalone Pi skills that call into individual stages,
   so users can invoke capabilities without the full 13-stage run.
6. **Signature-stagnation detection in verify-loop.** Track the
   review-findings signature across loop iterations; if stable across
   2 iterations, pivot instead of fix.
7. **Per-stage latency / cost report.** `stats.json` already collects
   timings; surface a `/super-dev report` command or skill.

---

## 7. Verdict

`pi-super-dev` succeeds at its stated goal: a self-contained, typed,
deterministic rewrite of the super-dev workflow for Pi. It is
**architecturally superior** (composable node algebra, render pipeline,
feedback-driven gates, reflection loop), **operationally leaner** (zero
runtime deps, single entry point, in-process execution), and **more
reproducible** (deterministic setup, typed contracts, audit trail) than
`super-dev-plugin` v2.5.47.

It is **functionally narrower**: 18 fewer agents, 29 fewer skills, no
hooks safety net, no multi-platform manifests, no shipped reference
corpus, and a relaxed pivot/escalation model. For web/backend work on
Pi these gaps are manageable; for polyglot, mobile, or security-critical
work, the plugin's broader roster still wins.

The highest-leverage next steps are (1) a safety-hook equivalent, (2)
incremental language specialists, and (3) wiring the pivot protocol —
all expressible in the existing architecture without new primitives.