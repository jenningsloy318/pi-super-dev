# Architecture & Code-Health Audit — pi-super-dev

**Date:** 2026-07-21
**Scope:** Full `src/` review of the pi-super-dev extension (v0.3.0) — the 13-stage SDLC pipeline composed from a homegrown control-flow node algebra.
**Method:** Read every file in `src/` (nodes, stages, build-runner, tracking, extension, render, workflow, pipeline, types, setup, prompts, session-agent, pi-spawn, safety, helpers, control, resume, doc-validators, agents). Ran `npm run typecheck` (clean) and `npm test` (1361/1361 passing across 80 files). Findings are evidence-backed with `file:line` citations and concrete fixes.

---

## Executive Summary

pi-super-dev is an unusually well-engineered agent pipeline. The node algebra (`sequence`/`gate`/`branch`/`loop`/`retry`/`parallel`/`map`/`tryCatch`) is correct, the never-throw / conservative-degrade discipline in the build-oracle layer is exemplary, and the TDD loop's RED-oracle → deliverable-check → change-gate stack is a genuinely strong defense against false-greens (the documented root cause of prior production failures). Test coverage is deep (1361 tests) and typecheck is clean.

The central architectural weakness is a **gate-symmetry hole**: every upstream *document* stage is wrapped in `gate(validate, attempts:4)`, but the *implementation* stage — the only stage that writes the actual deliverable code — has **no completeness gate**. `allGreen` is recorded but never enforced at the pipeline level; the `hasImplementation` predicate keys on `totalPhases > 0` (not `allGreen`), and the merge gate (`canMerge`) checks only build-green and cleanup, not implementation completeness. A partial implementation (2/5 phases done, 3 broken) flows uninterrupted into review → integration-test → merge. The workflow's *final* status derivation is honest (`partial`), but real work (agent spawns, review budget, a possible merge of incomplete code) is spent first.

Secondary findings: one real **dead-code bug** in `gate()` (the pass-case audit trail is unreachable), the `integrationLoopNode` always returning `ok` even on exhaustion, no sibling-cancellation propagation in `parallel`, and a 2010-line `build-runner.ts` god-module. None are blockers for the current design intent; all are addressable with small, focused edits.

---

## Architecture Overview

```
src/
├── nodes.ts            Control-flow node algebra (13 builders). The engine is `await root.run(state, ctx)`.
├── workflow.ts         Runner: builds StageContext, evaluates root node, derives RunSummary.
├── pipeline.ts         Thin entry: resume resolution → runWorkflow(SUPER_DEV_WORKFLOW).
├── stages/
│   ├── index.ts        The pipeline DAG (declarative node tree).
│   ├── implementation.ts   Stage 9: per-phase TDD loop (RED→impl→build→deliverable→change-gate).
│   ├── verify.ts       Stage 10 (review loop) + Stage 11 (integration test loop).
│   ├── writers.ts      Leaf writer/helper stages (requirements, spec, docs, merge, …).
│   ├── design.ts       Stage 6A: routed design.
│   ├── prototype.ts    Stage 6B: conditional prototype loop.
│   ├── lifecycle.ts    Service bringup/teardown for integration testing.
│   └── setup.ts        Stage 1: deterministic language/worktree detection.
├── build-runner.ts     Deterministic gates: runBuildGate, runRedCheck, runDeliverableCheck, computeChangeGate + cargo/git scoping. (2010 lines.)
├── tracking.ts         ChangeTracker: stage/phase git bracketing + cross-check.
├── extension.ts        Pi extension: super_dev tool, dashboard widget, mid-run input, renderResult.
├── render/             TUI: stream-theme, dashboard, stage-grouping, live-stream.
├── types.ts            Core type system (Node, Stage, PipelineState blackboard).
├── prompts.ts          Per-stage prompt builders.
├── session-agent.ts    In-process agent backend (createAgentSession + structured_output).
├── pi-spawn.ts         Subprocess agent backend (raw `pi` spawn + NDJSON parse).
├── safety.ts           Denylist + protected-file hooks.
├── helpers.ts          Pure deterministic helpers (classify, route, gates, merge-verdicts).
├── control.ts          `<control>` JSON extraction from agent text.
├── resume.ts           Memoized agent-call replay (durable-execution pattern).
└── doc-validators.ts   Spec-doc content gates (regex/min-size checks).
```

**Execution model:** A pipeline is a tree of self-evaluating `Node`s over a shared mutable `PipelineState` blackboard. Leaf `task` nodes spawn specialist `pi` subagents (session or subprocess backend) and store results under `state[stage.id]`. Control nodes compose children. The runner is literally `await workflow.root.run(state, ctx)`.

---

## Findings by Focus Area

### 1. Gate Symmetry (CRITICAL design hole)

**The core issue.** Every upstream *document-producing* stage is wrapped in a `gate({ validate, attempts: 4 })` that re-runs the writer with structured error feedback until the doc passes content validation:

```ts
// src/stages/index.ts:86-92
gate({ validate: gateValidator("gate-requirements", …), feedbackKey: "requirements", attempts: 4 }, task(requirementsWriter)),
gate({ validate: gateValidator("gate-bdd", …),             feedbackKey: "bdd",         attempts: 4 }, task(bddWriter)),
gate({ validate: researchComplete,                          feedbackKey: "research",    attempts: 4 }, task(researchWriter)),
…
gate({ validate: gateValidator("gate-spec-trace", …),       feedbackKey: "spec",        attempts: 4 }, task(specWriter)),
```

The **implementation** stage — the only stage that produces the actual deliverable code — has **no such wrapper**:

```ts
// src/stages/index.ts:124
task(implementationStage),
```

`allGreen` is computed inside the stage (`implementation.ts`) but is **never enforced at the pipeline level**. The downstream gate predicates ignore it:

```ts
// src/stages/index.ts:65-66 — keys on totalPhases, NOT allGreen
const hasImplementation = (s: PipelineState) =>
	((s.implementation as { totalPhases?: number } | undefined)?.totalPhases ?? 0) > 0;
```

```ts
// src/stages/index.ts:58-61 — merge gate checks build + cleanup, NOT completeness
const canMerge = (s: PipelineState) => {
	if (!notBlocked(s)) return false;
	const b = s.preMergeBuild as { pass?: boolean } | undefined;
	return b?.pass !== false;
};
```

**Consequence chain (evidence-backed):**
1. Implementation runs phases; phase 3 fails after 3 attempts → `allGreen = false; break` (`implementation.ts`, the 3-strike break). `totalPhases` stays the *full* count (`phases.length`), `phasesCompleted` < `totalPhases`.
2. `hasImplementation` is **true** (totalPhases > 0) → review runs (`index.ts:125`).
3. Review reviews *partial* code; Stage 11 runs integration tests against *partial* code.
4. `canMerge` is true if the build happens to pass and cleanup found nothing → **merge of incomplete code is possible**.

The workflow's *final* status IS honestly derived (`workflow.ts:208-212`: `phases === 0 → failed`, `green && (approved) → success`, else `partial`), so the reported outcome is not faked. But the pipeline has already spent review/test budget and possibly merged before that status is computed.

**Severity:** HIGH (arguably CRITICAL). This is the single most important design asymmetry: the least-gated stage is the most important one.

**Why it exists (charitable reading):** The implementation stage has its *own* internal per-phase gate stack (build-gate ∧ deliverable-check ∧ change-gate, `implementation.ts`), which is genuinely strong *within a phase*. The gap is *between phases* and *between implementation and review*: a phase that exhausts its 3 attempts sets `allGreen=false` and the pipeline treats this identically to "done." The 3-strike `break` is a within-stage abort, but there is no pipeline-level decision point that acts on it.

**Concrete fixes (in order of invasiveness):**

- **Minimal (1 line):** Make `hasImplementation` require green:
  ```ts
  const hasImplementation = (s: PipelineState) => {
    const i = s.implementation as { totalPhases?: number; allGreen?: boolean } | undefined;
    return (i?.totalPhases ?? 0) > 0 && i?.allGreen === true;
  };
  ```
  This skips review/test when implementation is partial (saves budget; prevents merge of incomplete code). Resume is the documented recovery mechanism for partial work.

- **Better:** Gate implementation completeness explicitly so the failure is *named* (not silently skipped), mirroring the upstream pattern:
  ```ts
  branch(
    (s) => ((s.implementation as { allGreen?: boolean })?.allGreen === true),
    { yes: task(implementationStage), no: /* a task that logs "implementation incomplete — skipping review; use resume to continue" */ },
  ),
  ```

- **Best:** Add `allGreen` to `canMerge` as a *second* necessary condition (defense in depth), so even if review runs on partial code, it cannot merge:
  ```ts
  const canMerge = (s: PipelineState) => {
    if (!notBlocked(s)) return false;
    const impl = s.implementation as { allGreen?: boolean } | undefined;
    if (impl?.allGreen === false) return false;          // ← completeness gate
    const b = s.preMergeBuild as { pass?: boolean } | undefined;
    return b?.pass !== false;
  };
  ```

---

### 2. Tolerant Sequence — Where Tolerance Should and Shouldn't Apply (HIGH design tension)

The pipeline root is a **tolerant** sequence:

```ts
// src/stages/index.ts:136
{ tolerant: true }, // best-effort: a non-setup stage failure is logged, not fatal
```

The `sequence` node (`nodes.ts:148-172`) converts both `{status:"failed"}` returns *and* thrown exceptions into `{status:"failed"}` and continues. This is explicitly documented as the fix for a prior bug where a fatal gate threw through a tolerant sequence and discarded every prior stage's artifacts.

**Where tolerance is correct (resilience):**
- Research/spec **gate exhaustion** (non-fatal by design — the pipeline proceeds with the best-available artifact, `nodes.ts` gate docstring). Good.
- A single agent spawn failing transiently. Good.
- Setup is the only truly fatal stage (`stage.fatal` → rethrows, `nodes.ts:138`).

**Where tolerance is questionable (core completeness):**
- **Implementation failure** becomes `{status:"failed"}` and the pipeline proceeds to review/test/merge of partial code (see Finding 1). Tolerance here masks a completeness violation as a transient blip.
- **The pre-merge build gate** (`preMergeBuildStage`, `index.ts:48-56`) runs inside the tolerant sequence. If it *throws* (not just returns failed), the tolerant sequence swallows it and `canMerge` sees `s.preMergeBuild === undefined` → `b?.pass !== false` → **true → merge proceeds**. The comment at `index.ts:56-57` acknowledges this ("a failure here skips merge but does not abort"), but the `canMerge` predicate at `index.ts:60` treats a *missing* result as mergeable (`!== false`), which is the vacuous-pass pattern the codebase explicitly warns against elsewhere (`notBlocked`, `index.ts:39-42`, treats missing cleanup as *not* mergeable — the opposite, correct, choice).

**Severity:** HIGH. The asymmetry between `notBlocked` (missing → block) and `canMerge`'s build check (missing → allow) is a latent merge-of-unverified-code path.

**Concrete fix:** Make `canMerge`'s build check symmetric with `notBlocked` — require the build gate to have *run and passed*, not merely "not failed":
```ts
const canMerge = (s: PipelineState) => {
	if (!notBlocked(s)) return false;
	const impl = s.implementation as { allGreen?: boolean } | undefined;
	if (impl?.allGreen === false) return false;
	const b = s.preMergeBuild as { pass?: boolean } | undefined;
	return b?.pass === true;   // ← require affirmative pass, not "not false"
};
```

---

### 3. Phase-Completeness & Recovery Model (MEDIUM)

**The 3-strike break** (`implementation.ts`): when a phase fails all `MAX_ATTEMPTS` (3), the loop sets `allGreen = false` and `break`s — aborting all *remaining* phases. This is the right within-stage decision (no point continuing sequential phases on a broken foundation), but it leaves the implementation in a partial state with no pipeline-level recovery.

**Recovery via Stage 10c "Address Findings"** (`verify.ts:159-175`, `fixStepReview`): the review fix loop spawns the `implementer` agent to address review findings + build errors. This can *additively* recover (fix a finding, wire a missed call site), but:
- It does **not** re-run the per-phase deliverable/change-gate stack — the review fix is bracketed only at the *stage* level by the workflow's `stage` event listener (`workflow.ts:182-191`), not the per-phase `probeEnd`/`commitEnd` granularity the implementation stage uses.
- It does **not** resume the broken *sequential* phases that the 3-strike break skipped — those phases were never attempted, so review findings won't reference them.
- It addresses *review findings*, not *implementation incompleteness*. A phase that failed the build-gate 3× is "implementation incomplete," which is a different failure class than "review found issues."

**The sound recovery model is `resume`** (`resume.ts`): a durable-execution memoized-replay pattern. An interrupted/partial run is resumable by replaying the workflow with cached agent results, fast-forwarding to the first uncached call (the interrupted phase). This is the correct mechanism for sequential-phase recovery — but it requires a human (or the caller) to invoke `resume: true`, which the pipeline does not do automatically on a partial result.

**Severity:** MEDIUM. The recovery model is *present* (resume) but not *wired* to the partial-implementation outcome. Today, a partial implementation → review/test/merge of partial code (Finding 1) rather than → "stop and offer resume."

**Concrete fix:** Surface partial implementation as a *terminal* decision point rather than letting it flow through review. Either (a) gate `hasImplementation` on `allGreen` (Finding 1's minimal fix — review is skipped, status is `partial`, the caller sees "use resume to continue"), or (b) add a stagnation-style interactive escalation (mirroring `handleStagnation` in `extension.ts`) that offers "resume implementation" on a partial result.

---

### 4. Responsibility Leaks (MEDIUM)

**4a. Stage 10c/11c doing implementation work.** The review (`fixStepReview`, `verify.ts:159`) and integration (`fixStepIntegration`, `verify.ts:283`) fix steps spawn the `implementer` agent directly. This is the *review* stage performing *implementation* work. It is pragmatic (the findings are implementation-level, so the implementer is the right agent), but it blurs the stage-responsibility boundary:
- The implementer's claimed change set (`filesCreated`/`filesModified`/`filesDeleted`) during a review fix is **not** git-cross-checked at per-phase granularity (only stage-level bracketing via the workflow listener).
- The `GIT_CROSSCHECK_WARNING` prompt (`prompts.ts`) is appended, so the agent is *told* its claims are cross-checked, but the cross-check that actually runs is the coarser stage-level one.

**Severity:** LOW–MEDIUM. Pragmatic and not incorrect; the boundary blur is a cohesion observation, not a bug.

**4b. The build-gate is the only merge gate.** See Findings 1 and 2 — `canMerge` checks build-green + cleanup, not implementation completeness or review approval. (Review approval *is* checked by the `reviewApproved` branch at `index.ts:125`, but `canMerge` does not re-check it, so a post-review regression in a later integration fix that flips the verdict to "Changes Requested" would not block merge if the build still passes.)

**Concrete fix:** Add `reviewApproved(s)` to `canMerge` as a defense-in-depth check (the integration loop's own `testsGreen && reviewApproved` exit is the primary gate, but `canMerge` is the *final* merge decision and should be conservative).

---

### 5. Correctness Risks — Agent-Returned Control Shapes (LOW — well-defended)

The codebase has a documented history of crashes from unguarded agent-shape assumptions. The audit confirms these are now **well-defended**:

**5a. The `testFiles.join` crash class — FIXED.** `normalizeStringArray` (`implementation.ts:111-120`) coerces any agent-returned array field into a genuine `string[]` (array → string-filtered; bare string → `[v]`; else `[]`). Used at `implementation.ts:182,189` before every `testFiles.join(",")`. Regression-guarded by `tests/normalize-string-array.test.ts`.

**5b. The `phases.entries` crash class — FIXED.** `normalizePhases` (`doc-validators.ts`) coerces a non-array `phases` field (string/object) into a usable array. Used at `implementation.ts:130`.

**5c. Theme method-detaching (`fgColors`) — FIXED.** The real pi `Theme` is a class whose `fg()` reads `this.fgColors`; destructuring `const fg = theme.fg` loses `this` and throws. All three render modules now call method-style via local wrappers (`stream-theme.ts:143-146`, `dashboard.ts:407-409`, `live-stream.ts:175`). Regression-guarded by `tests/stream-theme-class-theme.test.ts` and `tests/stream-theme-user-input.test.ts`.

**5d. The `parseStructuredChanges` agent-shape defense — sound.** `implementation.ts:112-141` never throws: null/non-object/array → empty; non-array bucket → empty; non-string entries dropped. Back-tolerates the legacy flat `filesModified` array.

**5e. NEW finding — `gate()` dead code (the pass-case audit trail is unreachable).**
```ts
// src/nodes.ts:356-358
if (v.pass) {
    ctx.log(`gate${label}: ✓ validated …`);
    return { status: "ok", attempts: attempt };       // ← returns here
    auditAppend({ stage: …, gate: { pass: true, errors: [] } });  // ← DEAD: unreachable
}
```
The `auditAppend` for a *passing* gate is after the `return` and never executes. Only *failing* gate attempts are recorded in the audit trail (`nodes.ts:361`). This is a real bug (not a style nit): the gate's audit log is asymmetric — it captures every failure but never the success that ended the loop, so the audit trail cannot reconstruct "passed on attempt N."

**Severity:** LOW (audit observability; no functional impact). **Fix:** move `auditAppend` before the `return`:
```ts
if (v.pass) {
    auditAppend({ stage: opts.feedbackKey ?? "gate", attempt, gate: { pass: true, errors: [] } });
    ctx.log(`gate${label}: ✓ validated (attempt ${attempt}…)`);
    return { status: "ok", attempts: attempt };
}
```

---

### 6. Control-Flow Engine Quality (mostly correct; one dead-code bug, one design limitation)

The node algebra is well-designed and largely correct. Per-node assessment:

**`sequence`** (`nodes.ts:147-172`) — **correct.** The tolerant throw-handling (`nodes.ts:158-166`) is the documented fix for the fatal-gate-throws-through-tolerant bug: a thrown exception is converted to `{status:"failed"}` and the sequence continues (tolerant) or rethrows (fail-fast). Cancellation short-circuits correctly (`nodes.ts:156`).

**`gate`** (`nodes.ts:315-373`) — **correct except the dead-code bug (Finding 5e).** The convergence-via-feedback design (validator errors stored under `state.__feedback[feedbackKey]`, fed into the next retry's prompt by `workflow.ts:realAgent`) is sound and is the right answer to blind-resampling on probabilistic agents. Exhaustion is non-fatal (returns `{status:"failed"}`, does not throw) — correct.

**`branch` / `choose`** (`nodes.ts:178-205`) — **correct.** Signal-checked at entry; missing `no`/`otherwise` branch returns `{status:"skipped"}`.

**`parallel`** (`nodes.ts:209-237`) — **correct but has a design limitation.** Two observations:
- *No sibling cancellation propagation.* If branch A is cancelled mid-flight, branch B runs to completion. The cancellation is only detected *after* `runConcurrent` returns (`nodes.ts:219`). There is no mechanism to abort still-running siblings. For a budget-bounded agent pipeline this wastes spawns, but each leaf `task` checks `ctx.signal?.aborted` at entry, so the waste is bounded to in-flight branches.
- *No early-abort on first failure (non-tolerant).* A non-tolerant parallel where branch A fails still waits for branch B before returning `failed`. This is consistent (the join needs all results) but means a fast-failing branch cannot short-circuit slow siblings.

**Severity:** LOW (design tradeoff, documented in the `map` docstring's "concurrent iterations share state" caveat). No fix required unless budget-waste becomes measurable.

**`loop`** (`nodes.ts:241-260`) — **correct.** `while`/`until` checked *before* each body run (pre-test loop). A `failed` body returns immediately (`nodes.ts:255`). Note: if *both* `while` and `until` are supplied, both are checked (break if `while` false OR `until` true) — unusual but documented.

**`retry`** (`nodes.ts:264-287`) — **correct.** `matches` predicate evaluated after the node runs; a non-matching failure returns early with `{...last, attempts}`. Backoff is signal-aware (`nodes.ts:282`).

**`map`** (`nodes.ts:392-413`) — **correct.** Default `concurrency: 1` (safe for shared-state iterations). Signal-checked at entry. Documented caveat: concurrent iterations share `state`.

**`waitForEvent`** (`nodes.ts:419-446`) — **correct.** The `done` guard prevents double-resolve; the timeout and abort listener are cleared in `finish()`. Minor: the abort listener (`{once:true}`) is never explicitly removed if the event fires normally (EventEmitter doesn't auto-clean un-fired once-listeners), but `ctx.events` is per-run and discarded, so the leak is bounded.

**`tryCatch`** (`nodes.ts:450-468`) — **correct.** `finally` runs on both success and catch paths.

**`task`** (`nodes.ts:75-142`) — **correct.** Records every outcome to `ctx.results` (for honest summaries); `stage.fatal` rethrows; budget/signal/enabled guards at entry. The precondition doc-existence check (`nodes.ts:92-98`) logs ✓/✗ but is non-fatal (tolerant pipeline proceeds) — documented.

---

### 7. Determinism & False-Greens (SOUND — the strongest part of the codebase)

The build-gate stack is the codebase's answer to "an agent can report green without delivering anything." The audit confirms it is **sound and well-layered**:

**7a. `runBuildGate`** (`build-runner.ts`) — necessary-not-sufficient by design (compile+test ≠ delivered), but the foundation. Never throws; non-fatal on greenfield (no manifest → `pass:true, ran:[]`). Correctly partitions failures into in-scope vs out-of-scope (`classifyOutOfScopeErrors` / `classifyOutOfScopeNpmErrors`) with the conservative contract: ambiguity → in-scope (never grants a false green). The `inScopePass` flag allows a phase to commit when *only* pre-existing out-of-scope crates fail — correct (pre-existing breakage shouldn't block in-scope work).

**7b. `runDeliverableCheck`** (`build-runner.ts`) — **sound.** AND-ed with build-green so a phase that compiles while delivering nothing fails. Exhaustive (no short-circuit — every sub-check evaluated, `missing` is complete). Never throws (degrades to a fail-with-reason). The run-boundary cache reset (`resetDeliverableCheckCache`, called per-attempt in `implementation.ts`) correctly defeats the stale-test-list false-negative on a retry that adds a test.

**7c. `computeChangeGate`** (`build-runner.ts`) — **sound.** The git cross-check `claimedNotChanged` (claimed-but-not-in-git) is the false-green killer, AND-ed into phase-green (`implementation.ts`). Conservative: `gitUnavailable` → pass (never block on infrastructure); `changedNotClaimed` (under-reporting) is advisory-only. The normalization-aware path matching (`normalizeTrackerPath`, `tracking.ts`) correctly defeats the `./`/backslash/`//` artifact false-reds.

**Gaps (both LOW, by-design tradeoffs):**
- **The RED oracle doesn't verify the failure *reason*.** `runRedCheck` confirms tests fail (`red`) vs pass (`green`) vs don't-compile (`broken`), but a test that fails on an assertion about *unrelated* behavior is still `red`. The prompt nudges the agent (`redRePromptHint`, `implementation.ts`), but there is no deterministic check that the failure is about the phase's target behavior. This is a fundamental limitation (no static way to know *why* a test failed without parsing the assertion) and is acceptably mitigated by the prompt + the `green`/`broken` re-prompt loop.
- **`inScopePass` trusts the classifier.** If `classifyOutOfScopeErrors` mislabels a genuine in-scope failure as out-of-scope, the phase commits on a false green. The classifier is conservative (ambiguity → in-scope, empty-scope → all in-scope), so the risk is low, but it is a trust boundary. Mitigated by the deliverable-check and change-gate which are scope-independent.

---

### 8. Coupling / Cohesion / State Threading (MEDIUM observations)

**8a. `build-runner.ts` is a 2010-line god-module.** It co-locates: project-command detection, cargo metadata resolution, package-name validation, integration-stem resolution, touched-file extraction, in/out-of-scope classification (cargo + npm), RED-status classification, the build gate, the deliverable check, the change gate, and the test-list cache. It is *cohesive* (all "deterministic gates over the worktree"), but its size makes navigation hard and it mixes pure helpers (`parseTestPackages`, `scopedCargoArgs`) with side-effecting spawns (`runBuildGate`, `loadCargoMetadata`). The module is exhaustively tested (15+ test files), so the risk is maintainability, not correctness.

**Concrete fix (low priority):** Split into `build-runner/detect.ts` (command/package detection), `build-runner/scope.ts` (git/cargo scoping + classification), `build-runner/gates.ts` (`runBuildGate`/`runRedCheck`/`runDeliverableCheck`/`computeChangeGate`). Re-export from `build-runner.ts` for backward compat.

**8b. Dunder-key state smuggling.** `PipelineState` uses typed keys for known stages but several control-flow mechanisms smuggle private-by-convention state through the index signature: `state.__feedback` (gate retry errors), `state.__reviewSignatures` / `state.__stagnated` (review stagnation), `state.__lastError` (tryCatch), `state.services` (typed, good). The dunder keys are functional but invisible to the type system and easy to collide with. `__feedback` in particular is read by `workflow.ts:realAgent` (`workflow.ts:140-146`) via a cast — a stage that accidentally wrote `state.feedback` would silently break gate feedback.

**Concrete fix (low priority):** Promote `__feedback` and `__reviewSignatures` to typed optional fields on `PipelineState` (they are cross-cutting control state, not stage artifacts).

**8c. Prompt quality — good.** Every prompt (`prompts.ts`) declares an explicit data contract ("Output `<control>` JSON with: …"), which `extractControlKeys` (`control.ts`) parses to drive the session backend's `structured_output` schema. The "document will be RENDERED FOR YOU — focus on CONTENT" instruction and the "delivery discipline" preamble (`session-agent.ts`) are thoughtful mitigations for the documented "agent explores for 10-27 tool calls then times out" failure mode.

**8d. Stage separation — clean overall.** Writers are thin (`writers.ts`), the TDD loop is self-contained (`implementation.ts`), the verify loops are split (`verify.ts`), and the deterministic gates are isolated from agent logic (`build-runner.ts`). The `Stage` interface (`types.ts`) is minimal and composable. The main cohesion blemish is 4a (review doing implementation).

---

## Additional Findings

### A. `integrationLoopNode` Always Returns `ok` (LOW–MEDIUM)

```ts
// src/stages/verify.ts:264-266
ctx.log("Stage 11: integration testing max retries exhausted (non-fatal)");
return { status: "ok" };   // ← always ok, even on exhaustion
```

The custom integration node (justifiably custom — `testsGreen` is vacuously true before tests run, so a `loop`'s `until` would exit immediately) returns `{status:"ok"}` on *every* exit path, including exhaustion. The workflow's final status is still derived correctly from `reviewApproved(state) && testsGreen(state)` (`workflow.ts:210`), so the reported outcome is honest. But:
- The node-level result never reflects failure, so a future caller branching on the node result would be misled.
- The `failedStages` list (`workflow.ts:222-229`) is derived from `ctx.results`, which is only pushed by `task()` nodes. The integration loop *contains* tasks (`apiTest`, `uiTest`, `testFix`) whose individual failures *do* appear, but the loop-level exhaustion does not.

**Fix:** Return `{status:"failed", error:"integration testing max retries exhausted"}` on exhaustion (the tolerant pipeline will still continue; the status is now honest at the node level and `failedStages` semantics are preserved if the node is later wrapped).

### B. `failedStages` Only Tracks `task()` Outcomes (LOW)

`workflow.ts:222-229` derives `failedStages` from `ctx.results`, appended only by `task()` (`nodes.ts:84`). Custom nodes (`integrationLoopNode`, `reviewLoopNode`, `uiTestStep`) that return `failed` do not appear unless they wrap a `task` that also failed. This is an observability gap, not a correctness bug — most custom nodes *do* wrap tasks — but a custom node failing without a failed child task would be invisible to the summary.

### C. `cleanup` Helper Returns Advisory `directoriesRemoved` Without Removing (LOW)

```ts
// src/helpers.ts (cleanup function)
const directoriesRemoved: string[] = [];
try { for (const e of await readdir(cwd, { withFileTypes: true })) if (e.isDirectory() && BUILD_DIRS.has(e.name)) directoriesRemoved.push(e.name); } catch { /* unreadable */ }
```
The `cleanup` helper *lists* build directories into `directoriesRemoved` but never actually `rm`s them (the `rm` call is absent). The field name (`directoriesRemoved`) and the summary ("Worktree clean") imply removal happened. This is either an intentional "scan-only" design (in which case the field should be `directoriesDetected`) or a missing `rm`. Given the safety module blocks `rm -rf`, this may be deliberate — but the naming is misleading.

**Fix:** Rename to `buildDirectoriesDetected`, or document that cleanup is scan-only (merge-blocking on sensitive data, not actually removing build artifacts).

### D. `.resume-cache.jsonl` at Repo Root (LOW)

`.gitignore` excludes `.resume-cache.jsonl` (root) and `.worktree/`, but a root-level `.resume-cache.jsonl` exists in the working tree (visible in `ls`). This is transient run state; confirm it is not committed. (Not a code issue — a hygiene note.)

---

## Top 10 Architecture Improvements (Prioritized)

| # | Improvement | Severity | Effort | Finding |
|---|-------------|----------|--------|---------|
| 1 | **Gate implementation completeness at the pipeline level** — make `hasImplementation` require `allGreen` (or add an explicit completeness gate), so review/test/merge don't run on partial implementations. | HIGH | S (1 line) | 1 |
| 2 | **Add `allGreen` + `reviewApproved` to `canMerge`** — make the merge gate conservative (require affirmative build pass + completeness + cleanup, not "not failed"). | HIGH | S | 1, 2, 4b |
| 3 | **Fix `gate()` dead code** — move the pass-case `auditAppend` before the `return` so the audit trail captures successes. | LOW | XS | 5e |
| 4 | **Make `integrationLoopNode` return `failed` on exhaustion** — honest node-level status; preserves `failedStages` semantics. | LOW–MED | XS | A |
| 5 | **Surface partial implementation as a terminal decision** — wire the `partial` status to a "resume to continue" escalation (mirroring `handleStagnation`), rather than flowing through review. | MED | M | 3 |
| 6 | **Split `build-runner.ts`** into detect/scope/gates sub-modules (2010 lines → 3 cohesive files, re-exported for compat). | MED | M | 8a |
| 7 | **Promote dunder state keys** (`__feedback`, `__reviewSignatures`, `__stagnated`) to typed `PipelineState` fields. | LOW | S | 8b |
| 8 | **Add sibling-cancellation to `parallel`** (optional) — abort still-running branches when one is cancelled, to bound budget waste. | LOW | M | 6 |
| 9 | **Clarify `cleanup` semantics** — rename `directoriesRemoved` → `directoriesDetected` or implement actual removal (safely). | LOW | XS | C |
| 10 | **Add `failedStages` support for custom nodes** — let custom control nodes record outcomes to `ctx.results` (or derive `failedStages` from a richer event source). | LOW | S | B |

---

## What Is Already Excellent (evidence-backed)

- **The never-throw / conservative-degrade discipline** is applied uniformly and correctly across the entire build-oracle layer (`build-runner.ts`, `tracking.ts`): every spawn/git op is try/caught, ambiguity always degrades toward "no false green," and the invariants are documented per-function. This is the strongest part of the codebase.
- **The TDD false-green defense stack** (build-gate ∧ deliverable-check ∧ change-gate, `implementation.ts`) directly addresses the documented root cause of prior production false-greens and is regression-tested to exhaustion.
- **Gate convergence via structured feedback** (`nodes.ts` gate + `workflow.ts:realAgent` `__feedback` injection) is the right design for probabilistic agents — retries *converge* instead of blind-resampling.
- **The control-flow node algebra** is correct (with the one dead-code exception), composable, and the runner is genuinely just `await root.run(state, ctx)`.
- **Test coverage** (1361 tests, 80 files) is deep and includes regression guards for every documented crash class (`testFiles.join`, `phases.entries`, `fgColors` detachment).
- **The resume mechanism** (`resume.ts`) is a clean durable-execution replay pattern.
- **Safety guardrails** (`safety.ts`) are uniform across both backends (hard hook on session; soft preamble on subprocess).

---

*Audit conducted by reading all `src/` files, running `npm run typecheck` (clean) and `npm test` (1361/1361 passing). All `file:line` citations verified against the current working tree.*
