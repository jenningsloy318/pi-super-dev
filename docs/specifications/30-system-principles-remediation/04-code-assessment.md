# Code Assessment — Fault-Classified Actuation, Signature Normalization & Reused-Worktree Isolation (Track 30)

**Repo:** `pi-super-dev` @ `bb8cb5d` (v0.2.2) · **Cycle:** docs/specifications/30-system-principles-remediation (AC-01..AC-14, SCENARIO-001..031)
**Commands:** `npm run typecheck` (`tsc --noEmit`) · `npm test` (`vitest run`) — no server/health endpoint applies (this is a CLI extension, not a service).
**Relevant modules:** `src/stages/implementation.ts` (1974 ln), `src/build-runner/gates.ts` (2423 ln), `src/build-runner/baseline.ts` (384 ln), `src/setup.ts` (635 ln), `src/stages/judge.ts`, `src/escalation.ts`, `src/helpers.ts`, `src/tracking.ts`. Tests live flat in `tests/` (`implementation-*.test.ts`, `setup-*.test.ts`, `baseline-verify.test.ts`).

---

## Seam 1 — `src/stages/implementation.ts`: signature primitives (lines 60–134)

**Current behavior.**
- `ProgressSignature` is `{ failure: string; footprint: string }` (implementation.ts:64-67).
- `normalizeSignatureText` (implementation.ts:69-71) does **whitespace-collapse + trim + 800-char cap ONLY** — the exact blind spot AC-06 targets: volatile noise (timestamps, UUIDs, durations, `(cached)`/`[cached]`) both differentiates identical failures AND displaces discriminating content past the cap before it is ever seen.
- `stableUnique` (:73-75) and `failureSignature` (:77-80) map over it; `changeFootprint` (:90-103) builds `footprint` from `gitActual` (created/modified/deleted, sorted, JSON-stringified) — already noise-free, so AC-07's "footprint constant" pin is naturally satisfiable once `failure` stabilizes.
- `repeatedNoProgress` (:105-118) is `history.some(h.failure === next.failure && h.footprint === next.footprint)` — any-prior-match (H3 oscillation fix). It is pure string equality; it needs **zero changes** — fixing `failureSignature`'s input fixes the detector (AC-07/SCENARIO-017 ride entirely on the normalizer).
- **Blast radius:** `redEvidenceSignature` (:120-134) also routes `reason`/`diagnostics.outputTail` through `normalizeSignatureText`, so the noise-stripping change propagates into the RED-loop's oscillation detector too (beneficial, same rationale; check `tests/implementation-red-loop*.test.ts` for pinned raw outputs — none found pinning timestamp/UUID-bearing strings, but verify on RED run).

**Insertion point.** Inside `normalizeSignatureText` (implementation.ts:69-71): strip the AC-06 classes **before** `replace(/\s+/g," ").trim().slice(0,800)` (SCENARIO-015's strip-before-cap ordering). Keep the function local; put the regexes in the new shared module (see Proposed module surface) so both are unit-pinnable without importing the 1974-line stage.

**Risks.**
- Over-normalization (AC-08/SCENARIO-019): the duration regex `\d+(\.\d+)?(ms|s)\b` must keep the `\b` so semver-ish tokens (`1.2.3s` paths) aren't eaten; UUID regex must be the canonical 8-4-4-4-12 hex form; ISO-8601 variants must require the `T`/space-date shape (`\d{4}-\d{2}-\d{2}[T ]…`) so bare words survive. Pin both directions with unit tests as the AC demands.
- The synthetic `[baseline-verify] regression — …` block embeds the merge-base SHA and (on a memo hit) a trailing ` [cached]` appended by baseline.ts:300 — stripping `[cached]` also stabilizes fresh-vs-memo-hit evidence text, a free win for AC-07.

---

## Seam 2 — `src/stages/implementation.ts`: attempt loop, green branch, judge/escalation wiring (lines 1088–1900)

**Current behavior.**
- Loop: `for (let attempt = 1; ctx.budget.check(); attempt++)` (:1088). Per-phase hoisted state (`attemptErrors`, `attemptProgressHistory`, `acceptedRed`, `redTestSnapshot`, `challengeReauthors`, …) sits at :1001-1051 — the one-re-run budget flag for AC-03 belongs there.
- Gate run (:1562): `runBuildGate(setup.worktreePath, { gate: state.spec?.gate, signal: ctx.signal, defaultBranch: setup.defaultBranch })` — note it does **not** pass `baselineVerify`; that opt (gates.ts:558) is the injection lever for the memo-bypass on the re-run.
- Own-scope evidence, in evaluation order: `declaredScope` + RC12c advisory via `trackerOutofScopeEdits` (:1571-1600), `resetDeliverableCheckCache()` + `buildGreen` (:1611-1615), `runDeliverableCheck` with `skipTests: !buildGreen` (:1628), `tracker.probeEnd("phase", …)` + `computeChangeGate` (:1656-1660), `computeSymbolGate` (:1667), post-RED oracle → `tddOracleFailures` (:1680-1716).
- **Green branch** (:1718): `if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0)` → logs `GREEN on attempt N` / `IN-SCOPE GREEN on attempt N` (:1723-1727) and `break`s. The env-blocker case (`pass=false`, `inScopePass=false` because "regression" strips it at gates.ts:543-551) **always falls through** to `failureReasons` (:1730-1737) → missing-test routing (:1745) → challenge re-author (`continue`, :1760-1768) → `progressSignature`/`noProgress` (:1770-1775) → judge at `stage9.impl-no-progress.<phaseId>` with `allowedRoutes: ["challenge-test","re-author-tests","continue"]` (:1782-1801) → HITL via dynamically-imported `runEscalation`/`applyRetryDecision` with `kind: "stagnation"`, `severity: "soft"` (:1854-1900).
- The RED-side judge offer (`stage9.red-no-progress.<phaseId>`, `allowedRoutes: ["re-author-tests","fix-environment"]`) is at :1274-1301 — the template for the second `fix-environment` offer.

**Insertion points.**
1. **Classification floor** — immediately after the green-branch closing `}` (:1730, before `const failureReasons = [`): run the pure classifier over `gate` + the four own-scope booleans already computed above. On `environmental-blocker`, take the new branch and **never fall through to `failureReasons`-driven implementer re-spawn** for this cause.
2. **Blocker branch body** (new, ~:1730): classify → log the AC-05 `class=…; next=…` line → compute dirt inventory (Seam 8 helper) → if kill-switch or inventory empty → judge route (mirror :1782-1801's `runJudge` shape with scope `stage9.impl-env-blocker.<phaseId>`, `allowedRoutes: ["fix-environment"]`, both evidence packets in `context`, `outputTails: [gate failure tail, baselineCheck.evidence]`) → soft HITL escalation mirroring :1854-1900 on routed/escalate. If inventory non-empty and kill-switch unset → `quarantineDirt(...)` + ledger append → `clearBaselineCache()` → **one** `runBuildGate` re-run (same opts as :1562; `appendGateChecked(state, "phase-build", gate2, "implementation")` for parity) → if `(gate2.pass || gate2.inScopePass)` re-run `runDeliverableCheck` with `skipTests:false` (after `resetDeliverableCheckCache()`, mirroring the resume-verify path :1060-1070) and re-check the same green predicate → green ⇒ `phaseStatusUpsert`, `emitPhaseStatus("ok")`, existing `GREEN on attempt N` log, `break` (SCENARIO-007). Still blocked ⇒ judge route (SCENARIO-011). Any git/ledger failure ⇒ warning + judge (SCENARIO-029/030).
3. **Env-blocker judge signature key** — do not reuse `progressSignature.failure`; key on sorted out-of-scope subjects + `baselineCheck.status` so the judge's per-signature budget (≤2, judge.ts:42-47) isn't shared with `impl-no-progress`.

**Risks.**
- **Control flow**: the branch must `break` (green) or hand off to judge/HITL — never `continue` the attempt loop, never re-enter RED, never emit an implementer `ctx.agent` call (SCENARIO-004's call-count assertion). The challenge re-author at :1760-1768 sits *above* the signature check — insert the classifier *before* it so an env-blocker can't be misrouted as a challenge.
- `changeGate`/`symbolGate` verdicts were computed from the pre-quarantine probe; since quarantined paths exclude the implementer's claimed set (AC-03 exclusion rule), those verdicts stay valid post-quarantine — reuse them, don't recompute.
- `deliverableCheck` ran with `skipTests:true` (build was failing); after a green re-run the test-listing spawn must be re-done or `requireTests` is silently unverified — mirror resume-verify.
- Abort plumbing: `ctx.signal` (types.ts:279) is already threaded into `runBuildGate`; pass it to the re-run, and give the quarantine's `spawnSync` a hard timeout (30 s, matching `gitOk` in baseline.ts:126) since `execFileSync`-based `gitLines` (:136-143) ignores signals today.

---

## Seam 3 — `src/build-runner/gates.ts`: `BuildGateResult`, synthetic strip, call shape

**Current behavior.**
- `BuildGateResult` (gates.ts:120-175): `pass`, `errors: string[]`, `outOfScopeErrors: string[]` (:133-141, *only* pre-existing-failure blocks outside scope; ambiguous/mixed errors never appear there), `inScopePass` (:143-151), `baselineCheck?: BaselineCheckResult` (:153-158, present ONLY when verification actually ran), `correlation` (observability-only).
- `resolveInScopePassWithBaseline` (:511-553): on `regression` it returns `inScopePass:false` and appends the synthetic block at **:546** — prefix string `` `[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: ${outcome.evidence}` ``. This block is a **verdict annotation, not a product failure** — AC-01's exclusion predicate.
- `runBuildGate` (:556-559) opts: `{ timeoutMs?, testPackages?, gate?, signal?, defaultBranch?, baselineVerify? }` — the loop call at implementation.ts:1562 omits `baselineVerify` (defaults to `verifyUntouchedFailuresAgainstBaseline`).

**Insertion points.**
- **One-line export** (recommended, keeps the prefix single-sourced): hoist the literal prefix at :546 into `export const BASELINE_VERIFY_ERROR_PREFIX = "[baseline-verify] regression — …"` and use it at :546; the classifier imports it. Everything else in gates.ts stays untouched — classification is a *consumer* of the result, not a gate change.
- The memo-bypass needs no gates.ts change: the in-loop re-run simply clears the baseline cache before calling `runBuildGate` (Seam 4), or wraps `baselineVerify`.

**Risks.**
- Membership test for AC-01 must be `errors.every(e => outOfScopeErrors.includes(e) || e.startsWith(BASELINE_VERIFY_ERROR_PREFIX))` — exact-string membership plus prefix match; do not fuzzy-match (an in-scope error quoting the same words must not be absorbed).
- `outOfScopeErrors.length === errors.length` is the historical lenient formula (:531); after a regression strip `errors` is `outOfScopeErrors + 1 synthetic` — the classifier handles exactly this shape, and the absent-`baselineCheck` edge (green gate, partial out-of-scope, no default branch — gates.ts:532-534) must classify `unclassified`, never env-blocker (SCENARIO-003).

---

## Seam 4 — `src/build-runner/baseline.ts`: memoization

**Current behavior.**
- Module-level `baselineCache = new Map<string, BaselineCheckResult>()` (:78), `CACHE_MAX = 100` with clear-on-overflow (:301), **`clearBaselineCache()` exported as the test hook** (:81-83).
- Memo key (baseline.ts:298): `JSON.stringify([input.cwd, mergeBase, input.language, input.pm ?? "", subjects])`. A hit returns `{status, evidence: hit.evidence + " [cached]"}` (:299-300).
- `verifyUntouchedFailuresAgainstBaseline` (:281-384) is never-throw; kill-switch `SUPER_DEV_DISABLE_BASELINE_CHECK` (:290); verification itself runs in an **isolated detached temp worktree at the merge-base** (`git worktree add --detach tmp mergeBase`, :317), removed in `finally` (:367-377).
- `verifyBaselineConsumes` — **not present in the repo** (grep: zero hits). The hermetic seams that do exist: the injectable `baselineVerify` opt (gates.ts:521/546) and the injectable `runner?: BaselineRunner` (baseline.ts:64-66), both exercised by `tests/baseline-verify.test.ts` (call-counting verifiers, :295-320; `clearBaselineCache()` in `beforeEach`, :47).

**Insertion point / staleness nuance.** Because verification runs at the merge-base in a temp worktree, the verdict is *by construction* independent of feature-worktree dirt — the memo key simply has no dirt component. The observable flip SCENARIO-006 pins (snow errors empty → `pass=true` post-quarantine) comes from the **feature worktree's own gate run**, not the baseline memo. Still, AC-03 mandates the re-run "MUST NOT inherit a memoized verdict": the cheapest compliant lever is calling the existing `clearBaselineCache()` immediately before the single re-run (import from `src/build-runner/baseline.ts` in implementation.ts; alternatively pass a `baselineVerify` wrapper on the re-run call that bypasses the cache — more code for the same guarantee). Cost of clearing: at most one extra temp worktree+run when the re-run still fails out-of-scope-only.

**Risks.** The ` [cached]` evidence suffix interacts with signatures — already neutralized by the AC-06 `[cached]` strip (Seam 1). `CACHE_MAX` eviction means a pre-quarantine verdict *might* already be evicted; clearing makes the behavior deterministic either way.

---

## Seam 5 — `src/setup.ts`: reused/resume track, `copiedEnvFiles`, kill-switch style

**Current behavior.**
- `runSetup` (setup.ts:462-602): four spec-selection branches — resume (`options.resumeSpecIdentifier`, :481-489), referenced-spec (`taskSpecIdentifier`, sets `reusedTrack = true`, :490-499), kill-switched fresh (`!specReuseEnabled()`, :500-507), reuse-search (:508-527, may also set `reusedTrack`).
- `copiedEnvFiles` (:551-557) is populated only `if (worktreeCreated)` — but note `createOrReuseWorktree` (:410-415) returns `worktreeCreated: true` even when it merely *reuses* an existing `.worktree/<id>` path (it means "not running in cwd"), so copied-env exclusion data is available on re-entry. `copyEnvFilesToWorktree` (:55-86) skips already-existing destinations and returns repo-relative paths — exactly the exclusion set AC-09/OQ-2 needs.
- `specDirectory` is computed at :571-572 (`join(worktreePath,"docs","specifications",specIdentifier)+"/"`), run lock at :574, `staleResumeCachePath` truncation at :590-594 (the in-spec-dir JSONL precedent for the new `.environment-faults.jsonl`), knowledge clearing :596-601, `return {…, reusedTrack}` :602.
- Never-throw sync `git(args, cwd): string|null` helper at :119; kill-switch convention `specReuseEnabled()` at :241-243 (`SUPER_DEV_NO_SPEC_REUSE !== "1"`), bootstrap kill-switch read at :604; the *logging* style lives in `src/stages/setup.ts:35` ("…set SUPER_DEV_NO_SPEC_REUSE=1 to force a fresh track") wired via `options.log` (setup.ts:458-460 → stages/setup.ts:29).

**Insertion points.**
- PRC quarantine: between :601 and the `return` at :602 — by then `worktreePath`, `specDirectory`, `copiedEnvFiles`, `reusedTrack`, and `options.resumeSpecIdentifier` are all known. Guard: `(reusedTrack || options.resumeSpecIdentifier) && resolve(worktreePath) !== resolve(cwd)` (never quarantine the user's main checkout / skipWorktree runs; fresh tracks skip detection entirely per SCENARIO-021). Log via `options.log`.
- Prior-fault count (AC-12/SCENARIO-027): same region — `readEnvironmentFaultCount(specDirectory)`; emit the count line iff the file exists.

**Risks.**
- `runSetup` is synchronous — the quarantine must be `spawnSync` (matches `git()`), never async.
- Setup runs *before* any stage context exists: no abort signal, no `ctx.log` — bound the git call by timeout only and use `options.log` (falling back silently when absent).
- Ordering: quarantine **after** `acquireRunLock` (:574) to avoid racing a same-track run, and after the stale-cache truncation block so the ledger read reflects the surviving file.

---

## Seam 6 — `src/helpers.ts`: bookkeeping exclusion set

**Current behavior.** `HARNESS_BOOKKEEPING_FILES` = {`events.jsonl`, `change-tracker.jsonl`, `implementation-evidence.jsonl`, `.resume-cache.jsonl`, `.judge.jsonl`, `.knowledge.json`, `.run-lock`} (helpers.ts:523-530); `isHarnessBookkeepingPath(specDirectory, path)` (:533-546) exempts only same-named files **inside the run's spec dir**, with a final-segment fallback for absolute-vs-relative mismatches — already battle-tested against both known false-positive classes (docstring :513-522).

**Insertion point.** No edit needed: the new module *imports* both and layers the canonical OQ-2 exclusion on top (spec-dir prefix + bookkeeping + `copiedEnvFiles` + caller-supplied in-loop extras). Re-export the composite as the single shared predicate so PRA and PRC cannot drift.

**Risk.** The spec-dir prefix must be computed worktree-relative (`docs/specifications/<id>/`) to match porcelain output; `specDirectory` is absolute-with-trailing-slash — derive the relative prefix (the stage already knows `setup.specDirectory`; setup.ts computes the join itself at :571).

---

## Seam 7 — `src/stages/judge.ts` + `src/escalation.ts`: routing and HITL

**Current behavior.**
- `JUDGE_ROUTES = ["re-author-tests","challenge-test","fix-environment","continue","escalate-now"]` (judge.ts:37) — `fix-environment` exists and is already offered at `stage9.red-no-progress` (implementation.ts:1297). `JudgeRequest` (:73-86): `{scope, signature, worktreePath, specDirectory?, context, allowedRoutes: readonly JudgeRoute[], outputTails?}`. `runJudge` (judge.ts:324-345) wraps the inner call with a never-blocking `.judge.jsonl` audit (append at :219, the second in-spec-dir JSONL precedent). `escalate-now` is **always unioned into allowedRoutes** (:230) — OQ-1's "implied escalate-now" is already the contract. `verifyJudgeEvidence` (:135) checks `{file, quote}` byte-occurrence in worktree files or `outputTails` — pass the gate tail and baseline evidence as `outputTails` or judge quotes will fail verification and degrade (INV-2). Budgets: ≤2 calls/signature, ≤12/run (`SUPER_DEV_MAX_JUDGE_CALLS`), kill-switch `SUPER_DEV_DISABLE_JUDGE=1`.
- `runEscalation(state, failure, escalate?)` (escalation.ts:66-80): never-throw, per-blocker budget `ESCALATION_RETRY_CAP = 2` keyed `kind:stage`. `applyRetryDecision(state, decision, {worktreePath, specDirectory})` (:91-107): on `retry-with-guidance` calls `rollbackWorktreeTo` — which is `git reset --hard HEAD` + `git clean -fd` with spec-dir excludes (tracking.ts:200-222).
- `EscalationFailure` (types.ts:357-365) with kinds `"stagnation" | "gate-exhaustion" | "design-conflict"` (types.ts:339).

**Insertion points.** Mirror the no-progress wiring verbatim (implementation.ts:1854-1900): `kind: "stagnation"`, `severity: "soft"`, `stage: "implementation"`, findings = both evidence packets sliced to 12. Ledger write `{kind:"judge-environmental", paths:null, stashRef:null, reason: verdict summary}` on `routed|escalate` outcomes (SCENARIO-026).

**Risks.**
- **`applyRetryDecision`'s rollback is destructive-by-design** (`reset --hard` + `clean -fd`) and runs on any `retry-with-guidance` choice. For the env-blocker boundary, either skip `applyRetryDecision` (surface the decision, let the outer convergence loop re-run) or verify the rollback target can't clobber the just-quarantined stash — a stash entry survives `reset`/`clean` (it lives in refs), so recovery remains possible, but the guidance path should be consciously chosen, not inherited.
- Judge context lines are pre-rendered strings — keep the OQ-3 one-liner (prior-fault count) as a single appended line in the `context` array.

---

## Seam 8 — `src/stages/implementation.ts`: `trackerOutofScopeEdits`, `redCheckOptions`

**Current behavior.** `trackerOutofScopeEdits` (:236-268) is the existing porcelain reader: C-quote stripping, rename (`R … -> new`) handling, backslash normalization, exclusion = `declaredScope ∪ redTestFiles`, and — critically — it **deliberately excludes the implementer's CLAIMED files from the exclusion set** (docstring :225-229, reviewer F-3: self-claims are what's being audited). It is advisory-only (non-blocking convergence finding, :1580-1599). `redCheckOptions` (:772-787) is the ctx-signal-threading + logging options builder for `runRedCheck` — the shape to copy for any new gate-adjacent call's logging.

**Insertion point / divergence.** The AC-03 dirt inventory is **semantically different** from `trackerOutofScopeEdits`: exclusion = CLAIMED (`filesCreated` ∪ `filesModified`) ∪ declared scope (AC-03's canonical rule) ∪ spec-dir/bookkeeping/copiedEnv. Do **not** reuse the function; reuse its *parsing scaffolding* (normalize/rename/quote handling) inside the new shared module. `declaredScope` is already materialized at :1571-1576 — pass it (plus `projectStructured`, plus `testFiles`) into the inventory call right after the classifier fires.

**Risk.** Two subtly different exclusion sets living in one stage is a drift hazard — the shared module's predicate is the canonical one for quarantine; `trackerOutofScopeEdits` keeps its audit semantics untouched (its tests pin them).

---

## Seam 9 — Test scaffolding (`tests/implementation-*.test.ts`, `tests/setup-*.test.ts`)

**Current patterns.**
- **Stage harness** (tests/implementation-rc8-rc12.test.ts): `vi.mock("../src/build-runner.ts")` stubbing `runBuildGate`/`runRedCheck` (:55-68); `cpMock` hoisted `node:child_process.spawnSync` interception for pure-gate tests (:40-53); `mkState()` with `setup:{worktreePath:"/tmp/…", specDirectory:"/tmp/sd", defaultBranch:"main", …}` (paths irrelevant while gates are mocked, :87-105); `mkCtx()` with an `agent()` dispatcher keyed on `call.agent` (`tdd-guide`/`implementer`/`code-reviewer`/`tdd-coverage-classifier`) and a `logs: string[]` sink (:107-160); `budget: {count:0, check:()=>true, …}`. The `judge` agent id is captured the same way in `tests/implementation-red-loop.test.ts` (`CapturedCalls`, ~:130).
- **Gate-result mocking today omits the new fields** — existing stubs return `{pass, ran, errors}` only; env-blocker tests must add `outOfScopeErrors`, `inScopePass:false`, `baselineCheck:{status:"regression", evidence}` (SCENARIO-001/004/005). `tests/baseline-verify.test.ts` already exercises real `resolveInScopePassWithBaseline` with injectable verifiers + `clearBaselineCache()` (:47, :255-320) — extend for the prefix export and memo-invalidation.
- **Real-git temp repos** (tests/setup.test.ts): `mkdtempSync` + local `git()` via `execFileSync` with `stdio:["ignore","pipe","ignore"]`, `try/finally rmSync`, assertions on `.worktree/<id>` layout (:15-17, :77-95) — the template for SCENARIO-020/021/028's `git status --porcelain` + `git stash list` assertions and for ledger-file assertions.
- **Tracker**: `ChangeTracker` + `setActiveTracker` imported from `src/tracking.ts` where change-gate behavior matters (implementation-crosscheck-gate.test.ts pattern).

**Risks for the new tests.**
- The stage's git reads use **both** `execFileSync` (`gitLines`, :136) **and** `spawnSync` (`trackerOutofScopeEdits`, :238) — a hermetic in-loop inventory test must stub both shapes or use real temp repos; the rc8-rc12 `cpMock` covers `spawnSync` only.
- `ctx.agent` call counting is the AC-02/SCENARIO-004 instrument: count `implementer` dispatches before/after the seeded regression gate — cheap and already idiomatic.
- `runJudge`'s budgets are module-level — `resetJudgeBudgets()` (judge.ts:103-106) in `beforeEach` for judge-routing tests, mirroring `clearBaselineCache()` usage.

---

## Proposed module surface — `src/fault-classification.ts` (new)

One shared, dependency-light module (imports only `node:child_process`, `node:fs`, `node:path`, and `isHarnessBookkeepingPath`/`HARNESS_BOOKKEEPING_FILES` from `src/helpers.ts`; `BASELINE_VERIFY_ERROR_PREFIX` from `src/build-runner/gates.ts`). Everything sync, everything never-throw (the loop/setup contracts at implementation.ts / setup.ts are non-negotiable on this).

```ts
// ── PRA: deterministic classification floor (no LLM) ────────────────────────
export type FaultClass = "environmental-blocker" | "product-defect" | "unclassified";
export interface FaultClassificationInput {
  errors: string[]; outOfScopeErrors: string[];
  baselineCheck?: { status: "preexisting" | "regression" | "unknown"; evidence: string };
  ownScope: { deliverablePass: boolean; changePass: boolean; symbolPass: boolean; tddClean: boolean };
}
export interface FaultClassification { faultClass: FaultClass; actuator: "quarantine+re-gate" | "judge" | "implementer-retry" }
export function classifyGateFault(input: FaultClassificationInput): FaultClassification; // pure
export function isBaselineVerifySyntheticError(e: string): boolean; // prefix match on the gates.ts:546 literal

// ── PRB: signature noise normalization (consumed by normalizeSignatureText) ─
export function stripVolatileNoise(text: string): string; // ISO-8601 ×3 shapes, UUIDs, \d+(\.\d+)?(ms|s)\b, (cached)/[cached]

// ── PRC: canonical dirt inventory + recoverable quarantine (shared by both call sites) ──
export const DIRTY_QUARANTINE_KILL_SWITCH = "SUPER_DEV_NO_DIRTY_QUARANTINE";
export function dirtyQuarantineEnabled(): boolean; // !== "1"
export interface DirtInventoryOptions {
  worktreePath: string; specDirectory?: string;          // spec-dir prefix exclusion
  copiedEnvFiles?: string[];                              // setup's copy list
  extraExcluded?: string[];                               // in-loop ONLY: claimed ∪ declaredScope ∪ testFiles
}
export function isExcludedFromQuarantine(path: string, o: DirtInventoryOptions): boolean; // canonical OQ-2 rule
export function collectDirtPaths(o: DirtInventoryOptions): string[];                       // porcelain read, never throws, [] on failure
export interface QuarantineOutcome { ok: boolean; skipped?: "kill-switch" | "empty"; stashRef: string | null; error?: string }
export function quarantineDirt(o: { worktreePath: string; paths: string[]; reason: string }): QuarantineOutcome;
// exactly one mutation: `git stash push -u -m <reason> -- <paths>`; never checkout/reset/clean; never throws

// ── PRD: per-track ledger ───────────────────────────────────────────────────
export type EnvironmentFaultKind = "quarantine" | "judge-environmental";
export interface EnvironmentFaultRecord { kind: EnvironmentFaultKind; paths: string[] | null; stashRef: string | null; reason: string }
export function appendEnvironmentFault(specDir: string | undefined, r: EnvironmentFaultRecord): void; // JSONL append, never throws (SCENARIO-030)
export function readEnvironmentFaultCount(specDir: string | undefined): number | null;                // null iff file absent (SCENARIO-027)
```

Also: `export function envBlockerLogLine(phaseId, next: "quarantine+re-gate" | "judge", detail): string` is optional sugar for the AC-05 substring-stable format — or inline the two literals in implementation.ts.

File budget (NFR-4): **1 new source file** (`src/fault-classification.ts`) + edits to `src/stages/implementation.ts`, `src/setup.ts`, `src/build-runner/gates.ts` (prefix export only) + `src/version.ts`/`package.json`/`package-lock.json` (NFR-5 bump to 0.2.3). Test files (`tests/fault-classification.test.ts`, `tests/implementation-env-blocker.test.ts`, `tests/setup-dirty-quarantine.test.ts`, `tests/signature-noise.test.ts`) don't count.

---

## Risks

1. **Memoization staleness (AC-03/SCENARIO-006).** The baseline memo key (baseline.ts:298) has no worktree-dirt component because verification runs in a detached merge-base worktree (:317) — the *verdict* can't go stale, but the spec forbids inheriting it regardless. Clearing via the existing `clearBaselineCache()` before the single re-run is the minimal, deterministic lever; the alternative (a `baselineVerify` wrapper on the re-run call) adds code for identical behavior. Residual risk: none functional; one extra baseline worktree cost in the still-blocked case.
2. **Control flow reaching the green branch / actuator selection before classification.** The classifier must sit at the :1730 fall-through — *after* the green predicate (so its own-scope booleans exist) and *before* `failureReasons`/challenge-reauthor/prompt assembly (so no implementer spawn or RED re-entry can occur for the blocker cause). The re-run must re-evaluate the full green predicate with a fresh `runDeliverableCheck` (`skipTests:false`, cache reset) — otherwise `requireTests` was verified against a build-red attempt. The one-re-run budget flag must be per-phase (hoisted with the other per-phase state at :1001-1051), so a later convergence iteration on the same phase gets a fresh budget without letting one blocker loop re-gate twice.
3. **Untracked-vs-tracked stash semantics.** `git stash push -u -- <paths>` covers both tracked modifications and untracked files (untracked stored in the stash's third parent; `git stash pop` restores both). Failure modes to handle: (a) a pathspec matching nothing → git exits non-zero ("no local changes to save") → treat as `{ok:false, error}` → warning + judge (SCENARIO-029); (b) `-u` does NOT stash *ignored* files (copied env files are excluded by rule anyway — never use `-a`); (c) staged tracked changes are stashed and the index entry reset — recoverable, but the stash message must be machine-greppable for the ledger's recovery instructions; (d) pathspecs must be worktree-relative, C-quote-unescaped, rename-resolved — reuse the :238-268 parsing; (e) never include the exclusion set (SCENARIO-028's pathspec-safety assertion). Setup-time quarantine additionally must never run when `worktreePath === cwd` or when the kill-switch is set.
4. **Abort signal plumbing.** In-loop: `ctx.signal` reaches `runBuildGate` (re-run included) but not the existing `gitLines`/`spawnSync` git helpers — bound the quarantine spawn by a 30 s timeout and check `ctx.signal.aborted` before starting it. Setup: no signal exists at all (sync, pre-stage) — timeout-only. `runEscalation`'s retry path calling `rollbackWorktreeTo` (`reset --hard` + `clean -fd`, tracking.ts:214-217) is the one destructive edge near the new code: quarantined stashes survive it (stash refs are independent), but a `retry-with-guidance` at the env-blocker boundary should be a conscious wiring choice, not a copy-paste of the no-progress block.
5. **Over/under-normalization (AC-08).** The noise regexes change *every* signature consumer (GREEN no-progress at :1774 and RED `redEvidenceSignature` at :120). Anchor the duration regex with `\b`, require full ISO date shapes, and pin both equality directions (SCENARIO-018/019) plus the 11-text replay (SCENARIO-016) so the 800-char cap order (strip → collapse → trim → cap) is enforced, not accidental.
6. **Judge budget/verification coupling.** Key the env-blocker judge signature on (sorted subjects, baseline status) — sharing `impl-no-progress`'s signature would burn its ≤2 budget; forgetting `outputTails` would fail INV-2 quote verification and silently degrade every verdict to escalate.

---

## Minimal-diff strategy

1. **`src/fault-classification.ts` (new, the only new file).** All pure logic + git reads/writes for classification-floor, inventory, quarantine, kill-switch, and ledger. Never-throw throughout; sync only; no imports from `implementation.ts`/`setup.ts` (no cycles). ~250 lines incl. doc comments.
2. **`src/stages/implementation.ts`.** (a) `normalizeSignatureText` delegates noise-stripping to `stripVolatileNoise` before the existing collapse/trim/cap (:69-71, +1 line). (b) Insert the classifier + blocker branch at the :1730 fall-through: classify → log → inventory (`extraExcluded` = claimed ∪ declaredScope ∪ testFiles) → quarantine (`appendEnvironmentFault`) → `clearBaselineCache()` → one `runBuildGate` re-run → green-predicate re-check (with re-run deliverable check) → break, else judge (`stage9.impl-env-blocker.<phaseId>`, `["fix-environment"]`) + soft HITL mirror of :1854-1900 + `judge-environmental` ledger write. All failure paths degrade to warning+judge, never throw.
3. **`src/setup.ts`.** Insert the PRC block between :601 and :602: guard `(reusedTrack || options.resumeSpecIdentifier) && worktreePath !== cwd` → kill-switch check (detection-warning log in the `SUPER_DEV_NO_*` style of stages/setup.ts:35) → `collectDirtPaths` (no `extraExcluded` — declared scope is unknown at setup, per OQ-2) → `quarantineDirt` + `appendEnvironmentFault` + the AC-10 recovery log (`git stash pop`, stash ref, switch name) → prior-fault count line iff ledger exists. `options.log` only; nothing else in the return shape changes.
4. **`src/build-runner/gates.ts`.** Single change: export `BASELINE_VERIFY_ERROR_PREFIX` and interpolate it at :546 (behavior byte-identical; the existing baseline-verify tests keep passing and gain a prefix pin).
5. **Tests (RED-first, per SCENARIO-031).** `tests/fault-classification.test.ts` (classifier truth table incl. synthetic-block exclusion, noise-strip both directions, inventory exclusions, kill-switch); `tests/implementation-env-blocker.test.ts` (rc8-rc12 harness + seeded regression gate: implementer call-count frozen, `runBuildGate` call-count +1 exactly, log substrings, judge route shape); `tests/setup-dirty-quarantine.test.ts` (setup.test.ts real-git temp-repo pattern: porcelain-clean after quarantine, pathspec exclusions, kill-switch, ledger lines + prior-count iff-exists); `tests/signature-noise.test.ts` (the 11-replica replay + cap-ordering). Land the v0.2.3 bump (`src/version.ts`, package.json, package-lock.json) in the same commit (NFR-5); `npm run typecheck` + `npm test` are the gates (AC-14).
