# Repo-Wide Pipeline Blocker Audit — v0.1.58

**Date:** 2026-08-14
**Audited version:** v0.1.58 (main, clean tree)
**Method:** Three parallel fresh-context senior reviewers (angles: A orchestration/stage machinery, B build-runner/cross-language pipeline, C agent contracts/prompts/structured output), each instructed to first understand the design (AGENTS.md, prior root-cause docs, full source map) and then hunt only for defects with concrete failure scenarios. Every finding below was then **independently re-verified by the parent session** via direct code traces and live toolchain probes (cargo 1.95.0, go 1.26.3, pytest 8.x, typebox 1.1.38 runtime). No source files were changed for this audit.

**Severity scale:** BLOCKER = halts/loops/crashes a plausible run or silently yields a wrong run verdict; HIGH = breaks a language/task class or loses evidence at a decision boundary; MEDIUM = degraded behavior with a workaround.

---

## Executive summary

| ID | Sev | Title | Status |
|----|-----|-------|--------|
| A-1 | BLOCKER | `skipStages:["implementation"]` → unbounded tight loop, run hangs | Verified (code trace) |
| B-1 | BLOCKER | Rust RED oracle: `src/*.rs` targets → `cargo test --test <stem>` → plain `error:` → `unknown` → fail-closed stall | Verified (probe, exit 101) |
| B-2 | HIGH | Rust RED fallback passes raw directory segments as `-p` package names | Verified (probe bytes) |
| B-3 | HIGH | Go RED oracle root branch: multi-directory file targets → usage error → `unknown` → stall | Verified (probe bytes) |
| B-5 | HIGH | npm-workspaces root without scripts → nested build plans suppressed → vacuous green through all gates | Verified (code trace) |
| B-6 | HIGH | npm out-of-scope rule grants `inScopePass` for regressions in untouched pre-existing test files | Verified (code + pinned test) |
| C-1 | HIGH | Research `openIssues: []` compliance → full duplicate subprocess run every round; fabrication path → 8-round FatalAbort | Verified (call site + control.ts) |
| A-2 | HIGH | Final merge is an unverified LLM self-report; wrong/failed merge can be reported as run success | Verified (structural) |
| A-3 | HIGH | Setup copies `.env` into worktree → cleanup flags sensitive → merge silently skipped while run reports `success` | Verified (code trace) |
| B-4 | MEDIUM | Python RED classifier: ANY output containing "error" classifies RED — pytest usage errors masquerade as confirmed RED | Verified (probe, exit 4) |
| A-4 | MEDIUM | `skipStages` on any convergence-stage writer → retries to round cap → `FatalAbort` instead of skipping | Verified (code trace) |
| C-2 | MEDIUM | Session-backend optional-key drift (openQuestions/services/gate/findings/failures/…) → corrective re-prompt invites fabrication | Verified (mechanism) |
| C-3 | MEDIUM | Render-schema type drift (`pass (boolean)` vs `Type.String()`) → api/ui-test/impl-summary/docs reports silently dropped | Verified (runtime probe: 2 errors) |
| C-4 | MEDIUM | ui-test prompt hands the specification doc mislabeled "BDD Scenarios" (`planPath` never set, no fallback) | Verified (code trace) |
| C-5 | MEDIUM | Reviewer's explicit "Changes Requested" downgraded to "Approved with Comments" when no finding is flagged blocking | Verified (mechanism); **design intent needs user decision** |
| C-6 | MEDIUM | docs-executor role contract unsatisfiable: mandates spec-dir edits, stage runs `source-read-only` with no write tools | Verified (role file vs call site) |
| B-7 | MEDIUM | Root vitest RED fallback spawns bare `vitest` (no pm-exec) → ENOENT → `unknown` → stall | Verified (code line) |
| B-8 | MEDIUM | Python symbol-gate pattern lacks assignment forms → constants-only deliverables flagged hollow → unsatisfiable retry | Verified (code line) |
| A-5 | MEDIUM | Knowledge-injection key drift: `"code-assessment"` never matches stored stage id `"assessment"` → Patterns/Services context never injected | Verified (grep) |
| A-6 | MEDIUM | Step-level stage events fed to ChangeTracker → 3 sync git spawns per step + `unit:"stage"` jsonl pollution + end-without-begin rows | Verified (code trace) |
| A-7 | MEDIUM | Resuming a `skipWorktree` run without re-passing the flag diverges spec dir + resume-cache target | Verified (code trace); impact depends on users mixing modes |

---

## Part 1 — BLOCKERS

### A-1 [BLOCKER] `skipStages: ["implementation"]` hangs the run in an unbounded tight loop

- **Files:** `src/stages/index.ts:149-153` (loop predicate), `src/nodes.ts:174-179` (task skip path), `src/nodes.ts:364-383` (`loop`), `src/extension.ts:669` (param threading)
- **Scenario:** User passes the documented parameter `skipStages: ["implementation"]`. When the implementation convergence loop is reached, `task(implementationStage)` hits `shouldSkipStage` and returns `{status:"skipped"}` **without setting `state.implementation` and without consuming budget**. The loop predicate `!implAllGreen(s) && !implConvergenceBlocked(s) && c.budget.check()` stays true forever; `loop` exits only on `cancelled`/`failed`, so `skipped` falls through to the next iteration with `times = Infinity`.
- **Consequence:** Each iteration appends a `StageResult` to `ctx.results`, emits `stage:{skipped}` (→ ChangeTracker `end` + jsonl append per iteration) — unbounded memory/disk growth; the run hangs and must be killed.
- **Evidence:** Full deterministic code trace; `tests/nodes.test.ts:88-95` pins the leaf skip contract but no test composes a skipped task inside `loop`/convergence nodes.
- **Fix direction:** Treat a persistent `skipped` body result as terminal in `loop`, or make the implementation loop predicate require `state.implementation !== undefined` (stage actually ran).

### B-1 [BLOCKER] Rust RED oracle misresolves `src/*.rs` targets — RED can never confirm outside root `tests/`

- **Files:** `src/build-runner/gates.ts:1266-1271` (root branch), `gates.ts:1187-1192` (nested branch), `src/build-runner/detect.ts:316-340` (`resolveIntegrationStems`), `gates.ts:615-619` (build-gate twin)
- **Scenario:** tdd-guide authors a RED test at `src/parser_test.rs` (unit-style placement; exists on disk so `resolveIntegrationStems` converts it to stem `parser_test`). Emitted plan: `cargo test --test parser_test --quiet` — but `src/parser_test.rs` is not a test target (it is not compiled at all unless declared via `mod`, which RED forbids because that edits production files).
- **Probe evidence (cargo 1.95.0):**
  ```
  $ cargo test --test parser_test --quiet
  error: no test target named `parser_test` in default-run packages
  help: available test targets:
      real_it
  exit=101
  ```
  Plain `error:` (no `error[E…]`) matches **none** of the rust classifier's broken markers (`error[E`, `could not compile`, `no tests to run`) nor red markers (`FAILED`, `panicked`) → `classifyRedStatus` → `unknown` → R1 fail-closed re-prompt → identical `unknown` → oscillation/`MAX_RED_RETRIES` → no-progress HITL → phase abandoned. A rust RED phase whose tests are not in a root `tests/` dir can never pass the oracle.
- **Refinement (probe-verified):** at a **virtual workspace root**, `cargo test --test <stem>` DOES discover member-crate test targets (reviewer's workspace sub-claim refuted by probe) — the failing shape is specifically targets that are not test targets (e.g. existing `src/*.rs` files, hallucinated-but-existing paths). `resolveIntegrationStems` is path-position-agnostic and must be restricted to real `tests/` integration targets.
- **Code-vs-contract drift:** `tests/red-oracle.test.ts:20-22` documents the intended contract as "per-stem `cargo test -p <pkg> --test <stem>` … fall back to `cargo test -p <pkg>`" — the `-p <pkg>` half was never implemented. Existing tests only use single-crate `tests/*.rs` targets.
- **Fix direction:** Resolve the owning package (`crates/<seg>` or root) and emit `cargo test -p <pkg> --test <stem>`; restrict stem resolution to targets under a `tests/` directory; fall back to scoped `cargo test -p <pkg>` otherwise (matching the documented contract and closing B-2 simultaneously).

---

## Part 2 — HIGH

### B-2 Rust RED fallback passes raw directory segments as `-p` package names

- **Files:** `src/build-runner/gates.ts:1273-1276`; invariant documented at `src/build-runner/scope.ts:218-224`
- **Probe evidence (cargo 1.95.0):** workspace with `crates/data` → package `stockfan-data`:
  ```
  $ cargo test -p data --quiet
  error: package ID specification `data` did not match any packages
  ```
- `detectTouchedCargoPackages` returns raw directory segments by documented design; `runBuildGate` resolves them via `resolveCargoPackageNames` (gates.ts:524) but `runRedCheck` does not. No classifier marker → `unknown` → same fail-closed stall as B-1.
- **Fix direction:** Wrap with `resolveCargoPackageNames(cwd, detectTouchedCargoPackages(cwd))` exactly as `runBuildGate` does; drop unresolved segments.

### B-3 Go RED oracle root branch: multi-directory file targets error → `unknown` → stall

- **Files:** `src/build-runner/gates.ts:1283-1286` (root branch); contrast the correct nested branch `gates.ts:1195-1199` + `goPackageArg` (`gates.ts:1166-1171`)
- **Probe evidence (go 1.26.3):** RED tests in two packages → plan `go test a/a_test.go b/b_test.go`:
  ```
  named files must all be in one directory; have a and b
  ```
  Matches no broken marker (`build failed|setup failed|no required module provides package`) and no red marker (`--- FAIL:|^FAIL|panic:`) → `unknown` → fail-closed → stall. Tests only cover single-file targets.
- **Fix direction:** Reuse the `goPackageArg` grouping for the root go branch (dedupe package dirs, one `go test <pkgdirs>` per module).

### B-5 npm-workspaces root without scripts → vacuous green through implementation, verify, and pre-merge gates

- **Files:** `src/build-runner/gates.ts:455` (`moduleBuildPlans` guard)
- **Scenario:** Root `package.json` = `{"private":true,"workspaces":["packages/*"]}` with no scripts/tsconfig; member packages have real `test`/`build`. `detectProjectCommands` yields no root commands → `rootPlans=[]`; the guard `!cmds.build && !cmds.test && !cmds.typecheck && hasAnyManifest(root)` returns `[]` before ever considering nested plans; bootstraps likewise skip (`hasRootCommands=false`). `runBuildGate` → `pass:true, ran:[]`, and the same vacuous pass flows into `verify.ts:652` and the pre-merge gate. A regression in any member package is invisible to every deterministic gate up to merge (`runRedCheck` only verifies authored RED targets).
- **Fix direction:** Drop the `hasAnyManifest(root)` clause (or invert to apply only when no nested manifests exist) so touched nested projects contribute plans when the root has nothing to run.

### B-6 npm out-of-scope rule grants `inScopePass` for regressions the implementer caused in untouched test files

- **Files:** `src/build-runner/scope.ts:508-555` (`classifyOutOfScopeNpmErrors`), `gates.ts:658-665` (`inScopePass`), consumed at `implementation.ts:983,1256,1562`
- **Scenario:** Implementer modifies `src/api.ts` (touched); pre-existing `tests/api.test.ts` (untouched) now fails `expect(x).toBe(y)`. Vitest prints `❯ tests/api.test.ts:5:27` with no source frame → block classified out-of-scope → `inScopePass=true` → phase commits despite breaking existing tests. The rule cannot distinguish "pre-existing failure" from "regression caused by in-scope edits breaking an untouched test file".
- **Mitigation already present:** the verify-stage gate uses `r.pass` (not `inScopePass`), so this cannot directly produce a wrong merge — it turns into fix-loop churn and possible run failure instead of a wrong commit. (Still HIGH: wrong phase verdict + evidence lost at the phase boundary.)
- **Fix direction (needs a policy decision):** require a pre-branch baseline (the test also failed before the branch) before granting the pass, or map the touched production set into the failing test's import graph.

### C-1 Research `openIssues: []` compliance → duplicate full subprocess run every round; fabrication path → FatalAbort

- **Files:** `src/control.ts:110-131` (`missingControlKeys`), `src/pi-spawn.ts:328-346,378-397`, `src/prompts.ts:173-182`, `src/stages/writers.ts:41-47`
- **Scenario:** research-agent is forced onto the subprocess backend (`workflow.ts:341-344`). Its prompt explicitly instructs `"openIssues: … (empty if none)"` and `"keep openIssues empty"`. A fully compliant report returns `openIssues: []` — but `missingControlKeys` treats an empty array as missing unless allow-listed, and `researchWriter` passes no `allowEmptyArraysFor`. `spawnAgent` therefore runs a **complete second `pi` subprocess** (another cold web-research run) on every research round. If the retry again correctly returns `[]`, it is stamped `error:"missing required control keys: openIssues"`; if the model instead "fills" the key to satisfy the corrective feedback, it **fabricates an open issue** → `researchComplete` fails the round → up to `MAX_CONVERGENCE_ROUNDS=8` → `FatalAbort` aborts the run.
- **Fix direction:** Pass `allowEmptyArraysFor: ["openIssues","sources"]` at the research call site; same audit for the session-backend keys in C-2. This is the exact class already fixed for `testDefects`/`contradictions` but not applied to the writer stages.

### A-2 Final merge is an unverified LLM self-report; run success can be reported with the feature never merged

- **Files:** `src/stages/writers.ts:147-151` (`mergeWriter` → agent `orchestrator`), `src/prompts.ts:508-510` (`buildMergePrompt`), `src/workflow.ts:528-545`
- **Scenario:** The merge is performed by an LLM agent told only "Merge the feature branch back into the default branch… Output `merged (boolean), commitSha, mergeCommand, summary`" with cwd = the worktree. In a standard worktree run the default branch is checked out in the main checkout, so a naive `git checkout <default>` inside the worktree fails and the agent must improvise. If it reports `merged:true` while the default branch never advanced, `runWorkflow` computes `mergeNotConfirmed=false` → `status="success"` → "✅ super-dev pipeline complete" with the feature unmerged. No code deterministically verifies that the default branch contains the feature head.
- **Confidence:** structural gap high; whether a given agent mis-merges is probabilistic — but this is exactly the vacuous-self-report gate class this repo's own history documents as fixed everywhere else (build gate, deliverable gate, change gate).
- **Fix direction (architecture decision):** deterministic merge helper (`git -C <mainRepo> merge --no-ff <branch>` + `git merge-base --is-ancestor` verification) gating `state.merge.merged`, or post-merge deterministic verification instead of trusting the control object.

### A-3 Setup copies `.env` into the worktree → cleanup flags it sensitive → merge silently skipped while run reports `success`

- **Files:** `src/setup.ts:52-90,262` (`copyEnvFilesToWorktree` unconditional copy), `src/helpers.ts:257,313-315` (`SENSITIVE_RE` includes `/\.env$/`; `blocked=true`), `src/stages/index.ts:92-96` (`notBlocked` gate), `src/workflow.ts:528-545` (`mergeRequired` excludes blocked runs → `mergeNotConfirmed=false` → `success`)
- **Scenario:** Any repo with a root `.env` (very common): setup deliberately copies it into the worktree so integration tests can authenticate; cleanup then scans the worktree root, matches `.env`, sets `blocked:true` → `canMerge` false → merge stage never runs → run classified `success` under a green banner. The two constraints are jointly unsatisfiable by design: the pipeline itself requires the `.env` present and then refuses to merge because of it. Blocking protects nothing — the copied `.env` is untracked and would never be merged.
- **Fix direction:** Restrict the sensitive-file block to files that would actually be merged (tracked / appear in the diff vs base), or exempt env files the pipeline itself copied; report a blocked merge as `partial`, not `success`.

---

## Part 3 — MEDIUM

### B-4 Python RED classifier: any "error" byte classifies RED; pytest usage errors masquerade as confirmed RED

- **Files:** `src/build-runner/gates.ts:972`
- **Probe evidence (pytest 8.x):** missing/misreported test path:
  ```
  ERROR: file or directory not found: tests/test_parser.py
  no tests ran in 0.00s
  exit=4
  ```
  Greenfield check fails (no `ERROR collecting`), broken check fails, then `/\berror\b/i` matches `ERROR:` → `"red"`. The RED boundary accepts a red-behavior-failure for a test that never ran; the implementer (forbidden from creating tests) can never fix it → post-RED `tdd-targets-still-red` → no-progress stall.
- **Fix direction:** Classify `^ERROR:` usage errors (`file or directory not found`, exit 4) as `broken`; require a test-execution summary marker (`N failed`, `N error(s)`, `FAILURES`) for red.

### A-4 `skipStages` on convergence-stage writers aborts the run instead of skipping

- **Files:** `src/nodes.ts:174-179`, `src/stages/artifact-convergence.ts:269-270` (only `cancelled`/`failed` handled), `src/stages/spec-convergence.ts:135-136` (same), `src/stages/verify.ts:431-470`
- **Scenario:** `skipStages:["requirements"]` (or bdd/research/design/spec/specReview/codeReview): writer returns `skipped` without producing state → convergence node treats it as "no artifact produced" and retries → consumes no budget → hits `MAX_CONVERGENCE_ROUNDS=8` → `FatalAbort` ("did not converge") with a misleading error instead of skipping.
- **Fix direction:** Convergence nodes treat a `skipped` writer as intentional skip (converge immediately like `options.skipped`), or disable stage-skipping inside convergence/loop bodies with an explanatory log.

### C-2 Session-backend optional-key drift invites fabrication across stages

- **Files:** `src/session-agent.ts:581-610` (self-heal #2, `emptyArrayOk` default), prompt lines: requirements `prompts.ts:159` ("leave openQuestions empty unless…"), bdd `161-163` ("traceability (optional)"), assessment `188-193` ("services (optional)"), spec `215-228` ("reviewResponses (optional on first attempt…", "gate (optional, Rust/backend only)"), docs/api/ui `493-504`
- **Scenario:** A compliant writer returns `openQuestions: []` (as instructed) → self-heal #2 fires: "previous structured_output was missing required keys: openQuestions … Call structured_output again with all keys filled" — directly contradicting the stage prompt. A model compliant with the feedback **fabricates** a question → `requirementsComplete` fails the round ("requirements left N open question(s)") → 8-round convergence → `FatalAbort`. Same shape for clean-review `findings: []`, passing-test `failures: []`, first-attempt `reviewResponses`/`gate` omissions, `deviationsDocumented: []`.
- **Fix direction:** Thread per-stage `allowEmptyArraysFor` (or derive from the TypeBox schema's Optional/Array keys); reword corrective feedback to "emit the key, empty array allowed".

### C-3 Render-schema type drift silently drops api/ui-test/implementation-summary/documentation reports

- **Files:** `src/render/schemas.ts:186-221` (`pass/cases/flows/allGreen/phasesCompleted/docsUpdated` are `Type.String()`), `src/prompts.ts:493,500-501` (prompts demand `pass (boolean)`, `cases (number)`), `src/prompts.ts:436`, `src/render/render.ts:81-93` (validation errors → `renderAndWrite` returns null)
- **Runtime probe (typebox 1.1.38):** `{pass:true, cases:5}` against the ApiTest schema → **2 "must be string" errors** → the report doc is never written and its data never reaches `.knowledge.md`. ui-tester is a browser agent on the subprocess backend (no tool schema to nudge types), so it follows the prompt's "(boolean)" wording. Run gating is unaffected (`passTrue()` in `verify.ts:346` bridges boolean/string) — the cost is the systematic loss of close-out audit artifacts.
- **Fix direction:** Widen the schemas (`Type.Union([Type.String(), Type.Boolean(), Type.Number()])`) + stringify in templates, or align the prompt annotations with string-typed schemas.

### C-4 ui-test prompt hands the specification doc mislabeled "BDD Scenarios"

- **Files:** `src/prompts.ts:492` (`specControl?.planPath ?? specControl?.specificationPath`), `src/render/render.ts:120-125` (render writes `implementationPlanPath`, never `planPath`; only the spec-review prompt at `prompts.ts:271` carries the `?? implementationPlanPath` fallback), call site `src/stages/verify.ts:870`
- **Scenario:** The "BDD Scenarios:" line always falls through to the specification path; the actual BDD doc (`state.bdd.docPath`) is available but never passed to `buildUiTestPrompt`. The UI tester derives flows from the wrong artifact — scenario-ID-level grounding is lost, BDD error/edge paths may be missed.
- **Fix direction:** Pass `state.bdd` into `buildUiTestPrompt`; print `bddControl?.docPath` under a correct label with the spec as fallback.

### C-5 Reviewer's explicit "Changes Requested" downgraded to "Approved with Comments" — design intent needs a decision

- **Files:** `src/helpers.ts:231-233`
- **Scenario:** code-reviewer emits `Changes Requested` with a High finding marked `blocking:false` — internally consistent with both its role file and the stage prompt ("blocking (true only when it must stop merge)"). The normalizer converts to `Approved with Comments`; `reviewApproved` passes; the fix step is skipped; `canMerge` can proceed — the reviewer's explicit request for changes never reaches the fix loop. The parallel CONTEST branch (`helpers.ts:219`) carries an explicit rationale comment; this branch carries none, so intentionality is unknown.
- **Fix direction (user decision):** either preserve `Changes Requested` when any High/Critical finding exists (severity fallback), or document the downgrade as intended leniency.

### C-6 docs-executor role contract is unsatisfiable under its call site

- **Files:** `agents/docs-executor.md` ("MANDATORY (spec directory): … Update Task List / Implementation Summary / Specification / Implementation Plan / Workflow Tracking JSON", "Signal DOCS_COMPLETE"), `src/stages/writers.ts:143-147` (`accessMode:"source-read-only"`), `src/session-agent.ts:172-179` (no `edit`/`write` tools), `src/prompts.ts:502-504` ("The pipeline may render/update the spec-directory documentation artifact for you")
- **Scenario:** The docs stage runs read-only with no file-write tools, yet its role prompt mandates updating five spec-dir documents and a marker nothing consumes. Realistic outcome: only the rendered `NN-documentation.md` materializes (when C-3 doesn't drop it) while the "mandatory" close-out updates are skipped or awkwardly improvised via bash heredocs.
- **Fix direction:** Rewrite `agents/docs-executor.md` to match the render-pipeline contract (structured data in, pipeline renders), or give the docs stage explicit spec-dir-scoped write tools.

### B-7 Root vitest RED fallback spawns bare `vitest` → ENOENT → `unknown` → stall

- **Files:** `src/build-runner/gates.ts:1150` — `plans.push({ cwd, argv: ["vitest","run",...fallbackTargets] })` while the per-target branch correctly uses `pmExec(pm,"vitest",…)`. Local `node_modules/.bin` is not on PATH for `spawnSync` → `r.error` → `unknown` → fail-closed retry loop for the no-per-package-runner monorepo shape.
- **Fix direction:** `pmExec(detectPmForDir(cwd,pkg), "vitest", ["run", ...fallbackTargets])`.

### B-8 Python symbol-gate flags constants-only deliverables as hollow

- **Files:** `src/build-runner/gates.ts:1888-1889` — `python: /\b(?:def|class|import|from)\b/` is the only pattern lacking declarative/assignment forms (rust has `const/static`, go `var/const`, JS/TS `const/let`). A correct `src/config.py` of assignments → `hollowFiles` → "write the actual implementation" retry → unsatisfiable → no-progress HITL.
- **Fix direction:** Add an assignment probe (e.g. `/^\s*[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*\S/m` or `^\s*@`).

### A-5 Knowledge-injection key drift: `"code-assessment"` never matches stored stage id `"assessment"`

- **Files:** `src/render/knowledge.ts:64,68,71,75,76` vs `src/stages/writers.ts:59` (id `"assessment"`); knowledge is keyed by stage id via `renderAndWrite(setup,…,"assessment",…)`
- **Scenario:** Every run: `stages["code-assessment"]` never exists → Patterns/Services blocks silently omitted from spec-writer, implementer, api-tester, ui-tester, designers prompts. No crash — just the loss of the exact context the mapping was built to thread.
- **Fix direction:** Rename the `AGENT_KNOWLEDGE_NEEDS` entries to `stage:"assessment"`.

### A-6 Step-level stage events feed the ChangeTracker — git-spawn storm + trace pollution

- **Files:** `src/workflow.ts:473-487` (listener filters `kind==="phase"` only), `src/stages/implementation.ts` (`emitStep`, terminal-only `emitPhaseStatus("ok")` at 920/986), `src/tracking.ts:190-216` (`end` appends a record; `computeEndRecord` runs 3 sync git spawns)
- **Scenario:** Every TDD/RED-review/implementation step row → `tracker.begin/end("stage")` → 3 blocking `git` spawns + a jsonl record each; an already-green phase on convergence re-run emits terminal `ok` with no preceding `running` → end-without-begin rows. Gates read in-memory records only, so verdicts are unaffected — this is hot-path performance + trace integrity degradation.
- **Fix direction:** Filter `kind==="step"` in the same guard; emit a `running` event before terminal-only `ok` on the already-green path.

### A-7 Resuming an in-place (`skipWorktree`) run without re-passing the flag diverges the spec dir

- **Files:** `src/setup.ts:231-238`, `src/resume.ts:33-38`, `src/pipeline.ts:23-31`, `src/extension.ts:668-674`
- **Scenario:** A `skipWorktree:true` run writes spec dir + resume cache in-place. A later `resume:true` without the flag (not persisted) makes `specDirFor` prefer/reuse/create a worktree path: cache loads from the in-place dir but subsequent writes/knowledge/clearing target the new dir → divergent artifacts; `.complete` clearing applies to only one.
- **Confidence:** mechanism verified; impact depends on users mixing modes.
- **Fix direction:** Persist `skipWorktree`/`worktreePath` in the spec dir at setup and honor it on resume.

---

## Part 4 — Reviewer claims refuted or refined (kept honest)

1. **B-1 workspace sub-claim REFUTED by probe:** at a virtual workspace root, `cargo test --test <stem>` **does** discover member-crate test targets (probe compiled `crates/data/tests/e2e_x.rs` from the root without `-p`). The failing shape is targets that are not test targets at all (existing `src/*.rs` files) — recorded above in refined form.
2. **Rust greenfield phrasing question RESOLVED — no bug:** with no `src/lib.rs`, `use q::…` emits `error[E0432]: unresolved import` (help text "use of unresolved module or unlinked crate" is the *help*, not the error line); the `error[E0432|E0433|E0583]` gate regex matches the actual error lines, and the leading-segment crate-name discriminator handles it. Verified against cargo 1.95.0 bytes.
3. **C-3 runtime behavior CONFIRMED (was assumed):** typebox `Value.Errors` returns exactly 2 "must be string" errors for `{pass:true,cases:5}` against the string-typed ApiTest schema (runtime probe, typebox 1.1.38).

## Part 5 — Coverage map (verified-sound areas)

- **Node algebra:** sequence fail-fast/FatalAbort re-throw; parallel duplicate-id guard + sibling cancellation; map concurrency; tryCatch finally-teardown.
- **Budget:** atomic `spent()` reservation; convergence loops hard-capped (`MAX_CONVERGENCE_ROUNDS=8`) with honest FatalAbort; escalation bounded (`ESCALATION_RETRY_CAP=2`, kind:stage keys).
- **Implementation stage:** RED retry ceiling + cycle detection; no-progress signature with HITL window reset; per-phase green carry; challenge re-author bounded; RED-test snapshot restore; testDefects channel + RED-review contradictions routing end-to-end (regression-tested).
- **Build-runner never-throw invariants; touched-file diffing; cargo package-name resolution caching; bootstrap pm/lockfile matrix; deliverable checker path-escape guards; npm RED RC-1 recursive-fanout avoidance; greenfield discriminators (npm/python) conservative in the correct direction.**
- **Contracts:** extractControlKeys parsing pinned for all 24 builders; corrective machinery terminates (≤1 corrective per backend) with correct capture-merge semantics; resume cache structural keys + partial-line tolerance; verdict vocabularies handled; language profiles present for all four stacks.
- **Verify:** fresh-evidence ordering; per-finding fingerprint recurrence; write-boundary enforcement; inconclusive services fail closed.

## Part 6 — Recommended remediation order (awaiting approval; no code changed)

1. **Now, low-risk, high-yield:** A-5 (key rename), B-7 (pmExec), B-8 (assignment probe), B-2 (resolveCargoPackageNames wrap), B-4 (usage-error broken), C-4 (bdd docPath), C-1 (research allowEmptyArraysFor), C-3 (schema widening).
2. **Next, structural:** B-1+B-3 (RED plan builders: `-p` + `tests/` restriction + go grouping), B-5 (workspaces guard), A-1+A-4 (skip semantics in loop/convergence), C-2 (optionality threading per stage), A-6 (tracker filter).
3. **Decisions:**
   - **A-2 DECIDED (user, 2026-08-14):** merge only after confirm — the LLM's `merged` self-report is no longer trusted; a deterministic git verification (default branch contains the feature head) gates `state.merge.merged`, and an unverified merge reports `partial` with the reason, never `success`.
   - **C-5 DECIDED (user, 2026-08-14):** preserve "Changes Requested" when any High/Critical finding exists (severity fallback takes precedence over the per-finding `blocking` flag); downgrade to "Approved with Comments" only for lower severities with nothing blocking.
   - **B-6 DECIDED (user, 2026-08-14): ① baseline comparison — CROSS-LANGUAGE (all of nodejs/python/go/rust, per user's standing requirement that the pipeline serves all languages).** When a phase-boundary gate would grant `inScopePass` on "all failures out-of-scope", re-run the same failing targets at the branch baseline (merge-base) and compare: failures that ALSO fail at baseline are genuinely pre-existing → leniency holds; failures that pass at baseline are regressions caused by in-scope edits → in-scope, fed back to the implementer. Implementation requirements: (a) per-language baseline commands (npm/pnpm vitest, pytest, go test per-package-dir, cargo test -p pkg) — each verified with local toolchain probes; (b) the leniency seam is shared: rust routes through `classifyOutOfScopeErrors` (crate granularity) and go/python route through `classifyOutOfScopeNpmErrors` (`gates.ts:658-665` ternary) — marker-extraction coverage per language must be probed and extended so each language's failing-test identity is parsed correctly; (c) baseline results cached per (files+failure-signature+merge-base); (d) baseline run must be isolated from uncommitted worktree changes (stash-free approach: run in a temp checkout/worktree of the merge-base commit); (e) any probe/parse ambiguity degrades to today's behavior or stricter (never a new false green).
   - **A-3 DECIDED (user, 2026-08-14): ① + ③.** Sensitive-file scan switches to a git-tracked view (only content that would actually be committed/merged: tracked added/modified files vs baseline + staged entries; untracked worktree-root `.env` no longer blocks); status honesty — a genuinely blocked merge reports `partial` with the file list, never `success`. The pipeline-copied-env exemption list (②) is implemented as LOGGING ONLY (setup logs which env files it copied, untracked + excluded from scan), not as a rule — under ① it is redundant, and as a rule it would wrongly exempt a repo that TRACKS its `.env`. Cross-language by construction (git view is language-agnostic).
