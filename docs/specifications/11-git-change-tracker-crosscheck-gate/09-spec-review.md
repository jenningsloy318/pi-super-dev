# Specification Review: Spec-11 Review — Git Change-Tracker with Per-Stage/Per-Phase Bracketing and Claimed-vs-Actual Cross-Check Gate

- **Date**: 2026-07-21
- **Author**: super-dev:spec-reviewer

---

## Verdict: APPROVED WITH REVISIONS

Fagan-style content inspection of spec-11. The specification is exceptionally well-grounded: ~93% of file/line/API references verified against the actual codebase, with near-exact line citations in implementation.ts (phase loop @94, runBuildGate @165, runDeliverableCheck @185, phase-green @194), types.ts (state.setup @112-113), extension.ts (activeRun singleton @68/131/148, finally @442/446), nodes.ts (stage "running" emit @127 → stage.run @129, record() @98), workflow.ts (ctx.events.on stage/phase @163-164), prompts.ts (buildImplementPrompt @117/120, buildFixPrompt @135/140), and build-runner.ts (dedupePreservingOrder @118 module-private, touchedFilePaths @526, requireFiles @1588, resolveTimeoutMs @84). All 11 ACs map to spec sections; all 20 scenarios map to 6 concrete test layers in an explicit coverage matrix; zero uncovered. Architecture fits existing patterns (singleton mirror of activeRun, event-subscription seam for stage bracketing, AND-chain into phase-green, never-throw invariant). No critical defects. Two MEDIUM findings block a clean APPROVED: (1) the "EXACT spawnSync shape from touchedFilePaths" claim is inaccurate — touchedFilePaths' spawns omit the timeout the spec says it copies; (2) the setActiveTracker insertion point inside runPipelineTask is unspecified and the state.setup population locus could not be located in src, leaving the most complex wiring task under-specified. Three additional LOW findings address end-without-begin semantics, git-command divergence from touchedFilePaths, and unbounded jsonl growth. Grounding score ~93% (>90% threshold). Verdict: APPROVED WITH REVISIONS — address the two MEDIUM items before implementation to avoid a wrong insertion point and a misleading canonical-pattern citation.

## Findings

### F1: D6 Grounding — touchedFilePaths spawn omits timeout; "EXACT shape" citation is inaccurate

- **Severity**: medium
Spec §"Git primitives & reuse" states the tracker copies "the EXACT discrete-argv spawnSync shape from touchedFilePaths (build-runner.ts ~538): spawnSync(..., { encoding: 'utf8', timeout: resolveTimeoutMs(...) })". Verified against source: touchedFilePaths' two spawns (build-runner.ts:538 `diff --merge-base` and :541 `ls-files --others`) pass ONLY `{ encoding: "utf8" }` — NO `timeout` field. The timeout envelope actually lives in the OTHER spawnSync call sites (build-runner.ts:1283, 1533, 1768, all using `timeout: timeoutMs` from `resolveTimeoutMs`). So the citation conflates two different shapes. Functional impact is low (adding a timeout to the tracker's spawns is safe and desirable), but the grounding claim is wrong and could mislead the implementer about which call site is the canonical pattern. Recommendation: cite the timeout-bearing spawnSync shape generically (the 1283/1533/1768 family) rather than touchedFilePaths, OR explicitly note that touchedFilePaths is being AUGMENTED with a timeout for the tracker. Lens: D6 Grounding.
### F2: D3/D8 — setActiveTracker insertion point in runPipelineTask is unspecified; state.setup locus unverified

- **Severity**: medium
Spec §"Threading" (AC-05) instructs: "setActiveTracker(new ChangeTracker(specDir, worktreePath)) is called in src/pipeline.ts (runPipelineTask) at the point state.setup is finalized (right after the setup stage populates the worktree + spec dir, before the producing stages run)". runPipelineTask exists at pipeline.ts:16 but builds/executes a node tree; no `state.setup =` assignment is locatable anywhere in src/ via search, and there is no named post-setup hook or line in runPipelineTask. Because setup runs as a node inside the tree, there is no clean synchronous "right after setup" insertion line in runPipelineTask itself — wiring there risks either reading setup before it is populated (undefined worktreePath/specDirectory) or missing the producing stages' brackets. This is the single most under-specified wiring point in the spec and directly affects Phase 2's testability (SCENARIO-010 singleton lifecycle assumes correct placement). Recommendation: name the concrete mechanism — e.g. subscribe to a terminal "setup" stage event, inject inside the setup stage node's return path, or add an explicit post-setup callback — and state whether the setup stage itself is intentionally excluded from bracketing (it will be, since the tracker is not yet active when setup's stage-start event fires). Lens: D3 Feasibility + D8 Ambiguity.
### F3: D1/D8 — end() called without a matching begin() (null beginHead) behavior unspecified

- **Severity**: low
ChangeRecord allows `beginHead: string | null`, and end() computes the delta via `git diff --name-status <beginHead>`. If end() fires for a unit with no prior begin() (null beginHead) — e.g. the setup stage whose stage-start event predates setActiveTracker, or any phase/stage that began before the singleton was wired — `diff --name-status <null>` is an invalid argv. The never-throw catch would swallow this and emit gitUnavailable:true, but that conflates "no baseline captured" with "git broken", producing a misleading verdict and a conservative pass that hides a real bracketing gap. Recommendation: specify end-without-begin explicitly (e.g. short-circuit to a record with gitActual=null, crossCheck=null, verdict="ok", skip the diff spawn) so the jsonl trace distinguishes "untracked" from "git-unavailable". Matters for SCENARIO-008/009 nested-order correctness if any stage escapes bracketing. Lens: D1 Completeness + D8 Ambiguity.
### F4: D6/D2 — tracker git command set diverges from touchedFilePaths; working-tree semantics not reconciled

- **Severity**: low
The tracker uses `rev-parse HEAD` + `status --porcelain` + `diff --name-status <beginHead>`, while the reused touchedFilePaths (build-runner.ts:526) uses `diff --merge-base <ref> --name-only` + `ls-files --others --exclude-standard`. The spec calls this "the committed-diff UNION untracked-files pattern keyed off beginHead instead of a base ref" — a fair justification — but `status --porcelain` is strictly BROADER than `ls-files --others --exclude-standard`: porcelain also surfaces unstaged-modified AND staged-not-committed entries via XY-codes, so gitActual.created∪modified∪deleted will include working-tree state that touchedFilePaths' untracked-only union would not. This affects the crossCheck semantics (claimedNotChanged / changedNotClaimed) and the spec-10 deliverable bridge (claimed.filesCreated UNIONed into requireFiles). Recommendation: explicitly confirm `status --porcelain` is intentional (it is the right choice for per-phase bracketing since begin..end spans working-tree mutations, not just commits), state that classifyPorcelain covers the broader state intentionally, and note the deliberate divergence from touchedFilePaths' untracked-only model so the implementer does not "harmonize" them and silently narrow gitActual. Lens: D6 Grounding + D2 Consistency.
### F5: D7/D1 — append-only change-tracker.jsonl has no growth/rotation/cleanup NFR

- **Severity**: low
The tracker writes an append-only `<specDir>/change-tracker.jsonl` with one record per begin/end event. Across many runs/phases/attempts (MAX_ATTEMPTS=3 × phases × stages × runs) this file grows unboundedly inside specDir, and the spec lists no rotation, truncation-on-new-run, or size NFR. The spec-10/dashboard surfacing section explicitly defers a dedicated panel to "future surfacing", so today the file is write-only. Recommendation: add a one-line NFR — e.g. truncate-on-new-run (the singleton construction point, tied to F2's resolution, is a natural reset point) or a documented cap — so the file does not accumulate indefinitely and so test Layer 1/3 assertions on append-only behavior are scoped to a single run. Lens: D7 Complexity + D1 Completeness.

## Dimension Reviews

### D1 Completeness

- **Status**: Pass (4/5)

All 11 ACs have spec sections; all 20 scenarios mapped to 6 test layers in an explicit coverage matrix (zero uncovered). Error/edge paths specified: never-throw invariant, gitUnavailable→pass, conservative parse, legacy tolerance, no-claim trivial pass, MAX_ATTEMPTS-bound retry. NFRs covered (zero new deps, backward compat, theme parity, no Rust/cargo gate). Gaps: no end-without-begin behavior (F3); no jsonl growth/rotation NFR (F5).
### D2 Consistency

- **Status**: Pass (5/5)

Terminology uniform throughout (StructuredChanges, GitActual, CrossCheck, ChangeRecord, changeGate, claimedNotChanged/changedNotClaimed). API signatures contract-first and stable across sections. Line refs drift within tolerance (setActiveRun actual @131 vs spec ~141; dedupePreservingOrder @118 vs ~112). Git-command divergence from touchedFilePaths is the one consistency seam (F4).
### D3 Feasibility

- **Status**: Pass with notes (4/5)

Architecture fits existing patterns cleanly: singleton mirrors activeRun; stage bracketing via the real ctx.events.on("stage") seam (workflow.ts:164); phase bracketing inside implementation.ts; changeGate AND-ed into the existing phase-green chain (gate.pass||inScopePass && deliverableCheck.pass). Spec-10 bridge explicitly avoids circular double-count. No circular deps. ONE feasibility risk: the setActiveTracker insertion point in runPipelineTask is not concretely specified and state.setup's population locus is unverified (F2).
### D4 Testability

- **Status**: Pass (5/5)

6 hermetic test layers with concrete mocking strategy (vi.mock node:child_process for git; stub runRedCheck/runBuildGate/runDeliverableCheck; mock renderAndWrite). Numeric thresholds explicit (MAX_ATTEMPTS=3, 1120 existing tests baseline). Each scenario has an assertable outcome (changeGate.pass boolean, jsonl line presence/order, no-throw, no-leak). Local gate: npm run typecheck && npm test both exit 0.
### D5 Traceability

- **Status**: Pass (5/5)

Full coverage matrix maps SCENARIO-001..020 → AC-01..011 → test layer → spec section. Phases 1-5 decompose cleanly onto ACs and dependencies are declared (Phase 2 depends on 1; 3 on 1+2; 4 on 3; 5 on 1-4). AC→spec, SCENARIO→task, plan→task-list chains all unbroken.
### D6 Grounding

- **Status**: Pass with notes (4/5)

~93% of references verified against source (above 90% gate). implementation.ts line refs near-exact (phase loop @94, runBuildGate @165, runDeliverableCheck @185, phase-green @194, accumulation @159, decl @92, return @219). types.ts state.setup @112-113 exact. extension.ts singleton @68/131/148, finally @442/446. nodes.ts stage emit @127/run @129/record @98. workflow.ts events @163-164. prompts.ts @117/120/126/135/140. build-runner.ts dedupePreservingOrder @118/touchedFilePaths @526/requireFiles @1588/resolveTimeoutMs @84. Deductions: touchedFilePaths spawn omits timeout so "EXACT shape" claim is wrong (F1); git-command divergence undocumented (F4); state.setup locus unverified (F2).
### D7 Complexity

- **Status**: Pass (4/5)

One new self-contained module + minimal engine touch (event subscription + implementation.ts bracketing + singleton set/clear). Reuses dedupePreservingOrder (single source of truth, no duplication) and the existing gate AND-chain. Simplest viable approach (no new deps, discrete-argv spawnSync under existing timeout envelope). Only complexity concern: unbounded append-only jsonl with no rotation (F5).
### D8 Ambiguity

- **Status**: Pass with notes (3/5)

API schemas fully defined (ChangeRecord, StructuredChanges, GitActual, CrossCheck, computeChangeGate return shape). State transitions explicit (begin→baseline, end→delta+crossCheck, gate→pass/claimedNotChanged). Error responses specified (gitUnavailable→record+pass, never-throw). Ambiguity gaps: setActiveTracker insertion point (F2) and end-without-begin/null-beginHead semantics (F3) are the two under-specified behaviors that could cause implementation drift.
