# Specification — Fault-Classified Actuation, Signature Normalization & Reused-Worktree Isolation (Track 30, ships as v0.2.3)

**Source documents (approved, in dependency order):** `00-principles-and-rules.md` (rules R-S1..R-S6, R-N1..R-N8; Part 6 is follow-up backlog, NOT this cycle) · `01-requirements.md` (AC-01..AC-14, NFR-1..NFR-5, OQ-1..OQ-3 with defaults) · `02-bdd-scenarios.md` (SCENARIO-001..031) · `05-research-report.md` (adopted mechanisms M-1..M-10) · `06-code-assessment.md` (seams 1–9, proposed `src/fault-classification.ts` surface, minimal-diff strategy).
**Repo:** `pi-super-dev` @ v0.2.2 (`SUPER_DEV_EXTENSION_VERSION = "0.2.2"`, src/version.ts). Toolchain: TypeScript, `node --experimental-strip-types` / `tsc --noEmit`, vitest (`npm test`), real-git temp-repo test pattern (tests/setup.test.ts).
**Scope:** one structural defect — Stage 9 is an open-loop retry controller with one actuator on an unpinned shared worktree — fixed by four mechanisms: **PRA** (deterministic fault classification before actuator selection), **PRB** (normalized failure signatures + anti-windup), **PRC** (reuse hygiene at setup), **PRD** (per-track environment-fault ledger). Run under analysis: `~/.super-dev/runs/2026-08-18T01-02-50-093Z`.

---

## Grounding anchors (read-verified on the pre-fix tree)

| Anchor | Location | Fact used |
|---|---|---|
| `normalizeSignatureText` | src/stages/implementation.ts:69-71 | whitespace-collapse + trim + 800-cap ONLY (no volatility stripping) |
| `failureSignature` / `stableUnique` / `repeatedNoProgress` | implementation.ts:73-118 | pure string equality over `ProgressSignature {failure, footprint}`; any-prior-match; needs ZERO changes |
| `redEvidenceSignature` | implementation.ts:120-134 | also routes through `normalizeSignatureText` (RED loop benefits identically) |
| attempt loop / green branch | implementation.ts:1088, 1718-1727 | `(gate.pass \|\| gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0` → `break` |
| fall-through to `failureReasons` | implementation.ts:1730-1737 | insertion point for the classification floor — BEFORE missing-test routing, challenge re-author, and signature/no-progress |
| per-phase hoisted state | implementation.ts:1001-1051 | where the one-re-run budget flag lives |
| `runBuildGate` call | implementation.ts:1562 | `{ gate, signal: ctx.signal, defaultBranch }`; `appendGateChecked(state, "phase-build", gate, "implementation")` at :1563 |
| `runDeliverableCheck` call | implementation.ts:1634 | `(setup.worktreePath, bridgedDeliverables, { signal, skipTests: !buildGreen })`; `resetDeliverableCheckCache()` at :1614 |
| RED-side `fix-environment` offer | implementation.ts:1281-1301 | template for the second offer (`stage9.red-no-progress.<phaseId>`) |
| no-progress judge + HITL mirror | implementation.ts:1782-1900 | wiring shape to mirror (minus `applyRetryDecision`) |
| `BuildGateResult` | src/build-runner/gates.ts:120-175 | `errors`, `outOfScopeErrors`, `inScopePass`, `baselineCheck?: {status, evidence}` |
| synthetic strip | gates.ts:543-551 | literal prefix `` `[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch: ${outcome.evidence}` `` |
| `clearBaselineCache` | src/build-runner/baseline.ts:80-83 | exported test hook; memo key :298 has no worktree-dirt component; memo hit appends `" [cached]"` (:299-300) |
| `JUDGE_ROUTES` / `runJudge` | src/stages/judge.ts:37, 324-345; request :73-86 | `fix-environment` exists; `escalate-now` always unioned (:230); `resetJudgeBudgets` :103; per-signature budget ≤2 |
| `runSetup` branches | src/setup.ts:481-527 | `resumeSpecIdentifier` / referenced-spec (`reusedTrack = true`) / kill-switched fresh / reuse-search |
| `copiedEnvFiles` | setup.ts:545-548, return :594; types.ts:181 | populated when `worktreeCreated` (true on re-entry too); returned on the control; readable as `setup.copiedEnvFiles` in stages |
| insertion region | setup.ts:571-602 | after `acquireRunLock` (:574) + stale-cache truncation (:590-594) + knowledge clearing (:596-601), before `return` (:602); `options.log` is the sink; sync-only |
| `HARNESS_BOOKKEEPING_FILES` / `isHarnessBookkeepingPath` | src/helpers.ts:523-546 | 7 members; same-named-file-inside-spec-dir semantics — imported, NOT modified |
| `trackerOutofScopeEdits` | implementation.ts:225-268 | porcelain parsing scaffolding (C-quote strip, rename `->`, backslash normalize); deliberately keeps self-claims NON-exempt (audit semantics, untouched) |
| test harness patterns | tests/implementation-rc8-rc12.test.ts (:40-160), tests/implementation-red-loop.test.ts (CapturedCalls + `resetJudgeBudgets`), tests/setup.test.ts (real-git temp repos), tests/baseline-verify.test.ts (`clearBaselineCache`, injectable verifiers), tests/version.test.ts (0.2.2 pins) | the patterns the new tests reuse |

---

## Design decisions and drift-resolutions (ACs win on every conflict)

**D-1 — Baseline memo invalidation (research Q4 vs AC-03/SCENARIO-006).** Research observes the baseline verdict is computed in a detached merge-base temp worktree, so it cannot go stale w.r.t. feature-worktree dirt; the observable flip comes from the feature gate run itself. AC-03 nonetheless forbids the re-run inheriting a memoized pre-quarantine verdict. **Resolution (AC wins):** the loop calls the existing exported `clearBaselineCache()` immediately before the single re-run — deterministic, zero new cache machinery; a dirt-digest-in-cache-key is recorded as follow-up, not this cycle. Cost: at most one extra baseline temp-worktree run in the still-blocked case. SCENARIO-006 is pinned at two real levels: (a) unit — after `clearBaselineCache()` the injectable verifier is re-invoked (cache miss) where a second call without clearing hits the memo; (b) real-git — after quarantine, `git status --porcelain` no longer lists the foreign path (the flip's substrate); the in-loop re-run consumes the fresh `gate2` result (T3.3).

**D-2 — No backoff delay (research Q5 vs AC-03/AC-07).** Industrial anti-windup is delay-based (Airflow/Step Functions). **Resolution:** no delay is introduced — attempts cost tens of minutes and the class is either environmental (retrying later without a state change is F-3's pure-cost bet) or product (feedback changes each attempt). Anti-windup = PRB's identical-normalized-signature refusal + PRA's exactly-one state-changing retry. Matches AC-03's budget of 1 and AC-07's refusal rule.

**D-3 — Actuator set, not singular (code-assessment vs SCENARIO-001).** The assessment sketched `FaultClassification { faultClass; actuator }` (singular); SCENARIO-001 requires "legal actuators {quarantine+re-gate, judge}". **Resolution (scenario wins):** `actuators: readonly FaultActuator[]` — `["quarantine+re-gate", "judge"]` for `environmental-blocker`, `["implementer-retry"]` for `product-defect` and `unclassified`.

**D-4 — SCENARIO-016 pinned behaviorally, no new stage exports (minimal-diff vs literal signature pin).** `failureSignature`/`normalizeSignatureText` stay module-local (assessment Seam 1). The 11-replica replay is pinned by observable loop behavior: with 11 noise-varying, otherwise-identical gate failures the phase stops at attempt 2 (the second occurrence trips `repeatedNoProgress` — impossible unless all 11 normalized to ONE signature) and the implementer is dispatched exactly twice. Equality semantics are additionally unit-pinned on `stripVolatileNoise` (SCENARIO-018/019, both directions). **Consequence for the replay fixture:** the seeded gate results must NOT classify `environmental-blocker` (PRA would intercept before the signature path) — seed them with `baselineCheck` ABSENT (`unclassified` per SCENARIO-003, today's retry semantics), which is exactly the historical path the no-progress detector guards.

**D-5 — `applyRetryDecision` is NOT called at the env-blocker boundary (assessment risk 4).** The no-progress HITL mirror calls `applyRetryDecision`, whose retry path is `rollbackWorktreeTo` (`git reset --hard` + `git clean -fd`). Stash entries survive it (refs/stash is independent), but rollback-by-copy-paste would be an unconscious destructive choice. **Resolution:** the env-blocker boundary surfaces the soft HITL escalation with both evidence packets, logs the decision, and terminates the phase's attempt loop (`terminalStopReason = "failed"`, distinct log line). No rollback, no implementer re-spawn, no `continue`. The outer convergence loop owns re-entry (a later iteration re-enters the phase with a fresh `envBlockerRegateUsed` budget).

**D-6 — OQ-1 (judge route surface).** `allowedRoutes: ["fix-environment"]` exactly (`escalate-now` is auto-unioned by judge.ts:230 — "implied"). A routed `fix-environment` surfaces as the D-5 soft HITL escalation carrying both evidence packets; the one-gate-re-run budget stays at exactly 1 — no second automatic quarantine. Unoffered/unverified/degraded outcomes fall to the same HITL surface (SCENARIO-012) via existing judge behavior.

**D-7 — OQ-2 (canonical exclusion set, single predicate).** One exported predicate `isExcludedFromQuarantine` + one reader `collectDirtPaths` in `src/fault-classification.ts`, used by BOTH call sites so semantics cannot drift. Excluded from quarantine: (1) the spec-dir prefix (worktree-relative `docs/specifications/<specId>/…`, derived from `specDirectory` with `isHarnessBookkeepingPath`'s final-segment fallback technique); (2) `isHarnessBookkeepingPath(specDirectory, path)`; (3) `.super-dev/` state prefix; (4) `copiedEnvFiles` members (slash-normalized exact match); (5) `extraExcluded` — in-loop ONLY: implementer-claimed `filesCreated ∪ filesModified ∪ filesDeleted` ∪ phase `declaredScope` ∪ `testFiles` (unknown at setup time; setup passes none). `trackerOutofScopeEdits` keeps its audit semantics (self-claims NOT exempt) — the two exclusion sets are deliberately different; the drift hazard is documented here and the shared module is the canonical one for quarantine.

**D-8 — OQ-3 (ledger → judge context).** Exactly one appended context line at the env-blocker judge call reading `readEnvironmentFaultCount(setup.specDirectory)` (present iff the ledger exists). Richer judge-context integration is follow-up.

**D-9 — stashRef capture (research ISS-02).** `git rev-parse refs/stash` immediately after a successful push (`git stash push` prints no SHA). Never `drop`/`clear` — `pop`-conflict preserves the entry, so recovery is reversible by construction (R-N6). Quarantine uses `push` (never legacy `save`), always with the literal `--` separator, `-u` (never `-a`), and a non-empty pathspec precondition (empty paths ⇒ `{ok:false, skipped:"empty"}` — the everything-stash footgun is structurally unreachable).

**D-10 — kill-switch (AC-11/NFR-3).** `SUPER_DEV_NO_DIRTY_QUARANTINE=1` disables BOTH quarantines (setup + in-loop). Detection still observes and logs; mutation never runs. No other new mutation of user state is added anywhere in this cycle.

**D-11 — gates.ts surface (NFR-4).** The only gates.ts change is hoisting the :546 literal into `export const BASELINE_VERIFY_ERROR_PREFIX` and interpolating it — byte-identical output (existing baseline-verify tests must stay green unchanged except for the added prefix pin). Classification is a consumer of `BuildGateResult`, not a gate change.

**D-12 — re-run green-through re-verifies deliverables (assessment risk 2).** The original `runDeliverableCheck` ran with `skipTests: true` (build was failing). After a green re-run: `resetDeliverableCheckCache()` then re-run with `skipTests: false` (same arguments as implementation.ts:1634 otherwise) — otherwise `requireTests` was never verified against a build-green state. `changeGate`/`symbolGate` verdicts are REUSED (quarantined paths exclude the claimed set, so those verdicts remain valid post-quarantine).

**D-13 — judge signature keying (assessment risk 6).** The env-blocker judge `signature` is `JSON.stringify({ subjects: sortedUnique(outOfScopeErrors), baseline: baselineCheck.status })` — never `progressSignature.failure` — so the ≤2 per-signature budget is not shared with `stage9.impl-no-progress`. `outputTails` carries the gate tail + baseline evidence so quote verification (INV-2) can pass instead of silently degrading.

**D-14 — `inScopePass` lenient grants are NOT ledger-recorded (01-requirements disposition).** A `baselineCheck=preexisting` evidence-backed pass is healthy, not a fault; only `quarantine` and `judge-environmental` records exist (AC-12).

**D-15 — Part 6 of the rules doc is backlog.** Judge routing-audit question, environment provenance stamp, pre-flight package fingerprint, per-call cost ledger, forbidden-edit prompt contract, AC verification-method field: none are implemented by this cycle.

---

## NFR-4 file budget (hard constraint)

- **Create (1):** `src/fault-classification.ts`.
- **Modify (3):** `src/stages/implementation.ts`, `src/setup.ts`, `src/build-runner/gates.ts` (prefix export only).
- **Version bump (NFR-5):** `src/version.ts`, `package.json`, `package-lock.json` — 0.2.3, same commit as the fix.
- **Test files (don't count):** `tests/fault-classification.test.ts`, `tests/signature-noise.test.ts`, `tests/implementation-env-blocker.test.ts`, `tests/setup-dirty-quarantine.test.ts` (new) + edits to `tests/baseline-verify.test.ts`, `tests/version.test.ts`.
- No other `src/` file may be created or modified. `src/helpers.ts` is imported, never edited.

## Process discipline (applies to every task)

- **RED-first (AC-14/SCENARIO-031):** each task's named tests are written FIRST and verified FAILING on the pre-fix tree (for new-surface tasks: the test file red because the export/module is absent; for behavior edits: red against current behavior), then the change lands, then the same tests pass. No task may land code before its red test exists.
- **Turn-end discipline (writer agents only):** this cycle spawns no writer agents — every task is implementer/test work against this deterministic contract, so the turn-end obligation does not attach. If any future follow-up delegates artifact prose to a writer agent, that agent must end every turn by either emitting the complete artifact or naming exactly which input is missing; implementers executing the tasks below do not carry this obligation.
- Gates: `npm run typecheck` (`tsc --noEmit`) clean and `npm test` (vitest run) green after every phase; both are re-run by the final release task.

---

## Phases

Ordered; each phase's tasks are self-contained instruction blocks. Dependency notes: Phase 1 is the shared foundation for everything; Phase 2 ∥ Phase 5 are parallelizable after Phase 1 (disjoint files); Phase 3 must be authored after Phase 2 (same file, ordered edits — serial by file, not by semantics); Phase 4 requires Phase 3; Phase 6 requires Phases 3-5; Phases 7-8 are last and land in the same commit as the feature work (NFR-5).

### Phase 1 — Shared fault-classification helper module (PRA floor + PRB strip + PRC inventory/quarantine + PRD ledger primitives)

**Description:** Create `src/fault-classification.ts` — the single shared, dependency-light, synchronous, never-throw module both call sites consume — holding the pure classification floor, the volatility stripper, the canonical dirt inventory with the OQ-2 exclusion predicate, the stash-based quarantine primitive with its kill-switch, and the JSONL ledger primitives. Also hoist the synthetic-block prefix in gates.ts into an exported constant (byte-identical behavior). Everything here is pure or real-git unit-testable with no LLM and no stage imports (no cycles).

**T1.1 — Create the classification floor in `src/fault-classification.ts`**
- **Files:** create `src/fault-classification.ts`; create `tests/fault-classification.test.ts`.
- **Exports (exact):**
```ts
export type FaultClass = "environmental-blocker" | "product-defect" | "unclassified";
export type FaultActuator = "quarantine+re-gate" | "judge" | "implementer-retry";
export interface FaultClassificationInput {
    errors: readonly string[];
    outOfScopeErrors: readonly string[];
    baselineCheck?: { status: "preexisting" | "regression" | "unknown"; evidence: string };
    ownScope: { deliverablePass: boolean; changePass: boolean; symbolPass: boolean; tddClean: boolean };
}
export interface FaultClassification { faultClass: FaultClass; actuators: readonly FaultActuator[]; }
export function classifyGateFault(input: FaultClassificationInput): FaultClassification; // pure, no LLM (NFR-1)
export function isBaselineVerifySyntheticError(error: string): boolean; // error.startsWith(BASELINE_VERIFY_ERROR_PREFIX)
```
- **Deterministic truth table (pin all rows in tests):** (1) any `errors[i]` that is neither an `outOfScopeErrors` member (exact-string) nor `isBaselineVerifySyntheticError` ⇒ `product-defect`, actuators `["implementer-retry"]` (genuine in-scope/mixed failure — today's retry semantics). (2) Else, all errors out-of-scope-or-synthetic with `outOfScopeErrors.length > 0`: if `baselineCheck?.status === "regression"` AND all four `ownScope` booleans true ⇒ `environmental-blocker`, actuators `["quarantine+re-gate", "judge"]`; otherwise (absent `baselineCheck`, `preexisting`/`unknown`, or own-scope red) ⇒ `unclassified`, actuators `["implementer-retry"]` — never `environmental-blocker`. (3) Empty `errors` ⇒ `unclassified`.
- **Tests (tests/fault-classification.test.ts, RED first — module absent):** truth-table cases built with the REAL prefix string imported from gates.ts (after T1.2) — golden env-blocker row (out-of-scope block + synthetic block, regression, own-scope green → environmental-blocker, synthetic block NOT counted as a product failure); genuine in-scope error row → product-defect; mixed row → product-defect; absent-baselineCheck row → unclassified; own-scope-red row → unclassified; an in-scope error that merely QUOTES the prefix words mid-string (not `startsWith`) → product-defect (no fuzzy absorption).
- **scenarioRefs:** [SCENARIO-001, SCENARIO-002, SCENARIO-003] · **acceptanceCriteriaRefs:** [AC-01]

**T1.2 — Hoist the synthetic-block prefix in `src/build-runner/gates.ts`**
- **Files:** modify `src/build-runner/gates.ts` (~:546); edit `tests/baseline-verify.test.ts`.
- **Export (exact):** `export const BASELINE_VERIFY_ERROR_PREFIX = "[baseline-verify] regression — the failing out-of-scope subject(s) PASS at the merge-base baseline, so the failure is NEW on this branch:";` and interpolate at :546 as `` `${BASELINE_VERIFY_ERROR_PREFIX} ${outcome.evidence}` `` — output byte-identical to today.
- **Tests (edit tests/baseline-verify.test.ts, RED first):** a case driving the real `resolveInScopePassWithBaseline` with an injectable verifier returning `{status:"regression", evidence:"…"}` asserts (a) the appended error `startsWith(BASELINE_VERIFY_ERROR_PREFIX)` (single-sourced, no drift between classifier and gate) and (b) all pre-existing baseline-verify cases still pass unchanged (backward-compat guard).
- **scenarioRefs:** [SCENARIO-001] · **acceptanceCriteriaRefs:** [AC-01]

**T1.3 — Volatility stripper `stripVolatileNoise` (PRB primitive)**
- **Files:** extend `src/fault-classification.ts`; extend `tests/fault-classification.test.ts`.
- **Export (exact):** `export function stripVolatileNoise(text: string): string;` — strips, in order: ISO-8601 timestamps `/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g` (covers `2026-08-18T10:11:42.496069+08:00`, `…Z`, `2026-08-18 10:11:42`); UUIDs `/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g`; durations `/\b\d+(?:\.\d+)?(?:ms|s)\b/g` (the `\b` anchors keep `0.2.3src`-shaped tokens intact — `3s` followed by `rc` has no word boundary); `(cached)` and `[cached]` markers (`/\(cached\)/g`, `/\[cached\]/g` — also neutralizes baseline.ts:300's memo-hit `" [cached]"` suffix).
- **Tests (RED first):** every noise class from the SCENARIO-014 inventory is removed (one case per class + one combined case using the SCENARIO-016 replica line); **both directions (AC-08):** two texts differing ONLY in noise ⇒ equal outputs; texts differing in failing package (`internal/services/snow` vs `internal/services/auth`) or error class ⇒ different outputs; semver-ish and path tokens (`v1.2.3`, `0.2.3src`, `pkg/sub`) survive verbatim.
- **scenarioRefs:** [SCENARIO-018, SCENARIO-019] · **acceptanceCriteriaRefs:** [AC-06, AC-08]

**T1.4 — Canonical dirt inventory (OQ-2 predicate + porcelain reader)**
- **Files:** extend `src/fault-classification.ts`; extend `tests/fault-classification.test.ts`.
- **Exports (exact):**
```ts
export interface DirtInventoryOptions {
    worktreePath: string;
    specDirectory?: string;
    copiedEnvFiles?: readonly string[];
    extraExcluded?: readonly string[]; // in-loop ONLY (D-7 rule 5)
}
export function isExcludedFromQuarantine(path: string, options: DirtInventoryOptions): boolean;
export function collectDirtPaths(options: DirtInventoryOptions): string[]; // spawnSync porcelain read, 15s timeout, never throws, [] on failure
```
  `collectDirtPaths` runs `git -c core.quotepath=false -C <worktreePath> status --porcelain --untracked-files=all` and reuses the `trackerOutofScopeEdits` parsing scaffolding (C-quote strip + unescape, rename `old -> new` → new, backslash normalize) — reimplemented in the helper (do not import the stage); returns sorted unique paths where `!isExcludedFromQuarantine`.
- **Tests (RED first, real-git temp repos per tests/setup.test.ts pattern):** a repo simultaneously carrying a foreign tracked modification `internal/services/snow/enrichment.go`, an untracked root `notes.md`, a modified spec-dir file, each `HARNESS_BOOKKEEPING_FILES` member inside the spec dir, a `copiedEnvFiles` entry, a `.super-dev/` file, and an `extraExcluded` member (claimed file + declared-scope file + test file) ⇒ inventory is EXACTLY `[internal/services/snow/enrichment.go, notes.md]`; an undeclared current-attempt edit (RC12c class: in `gitActual`, outside claimed ∪ declared scope) IS in the inventory; git failure (non-repo dir) ⇒ `[]`, no throw.
- **scenarioRefs:** [SCENARIO-008, SCENARIO-009] · **acceptanceCriteriaRefs:** [AC-03]

**T1.5 — Quarantine primitive + kill-switch (never-destructive contract)**
- **Files:** extend `src/fault-classification.ts`; extend `tests/fault-classification.test.ts`.
- **Exports (exact):**
```ts
export const DIRTY_QUARANTINE_KILL_SWITCH = "SUPER_DEV_NO_DIRTY_QUARANTINE";
export function dirtyQuarantineEnabled(): boolean; // process.env[DIRTY_QUARANTINE_KILL_SWITCH] !== "1"
export interface QuarantineOutcome { ok: boolean; skipped?: "kill-switch" | "empty"; stashRef: string | null; paths: string[]; error?: string; }
export function quarantineDirt(options: { worktreePath: string; paths: readonly string[]; reason: string; log?: (m: string) => void }): QuarantineOutcome;
```
  Contract (D-9): kill-switch set ⇒ `{ok:false, skipped:"kill-switch", stashRef:null}` with NO mutation; empty/blank pathspec ⇒ `{ok:false, skipped:"empty", …}`; otherwise the ONLY worktree mutation is `git stash push -u -m <reason> -- <paths…>` (30 s timeout, `cwd: worktreePath`, array argv — no shell), then `git rev-parse refs/stash` captured as `stashRef`; any non-zero exit ⇒ `{ok:false, stashRef:null, error: <stderr tail>}` — never throws, never `checkout`/`reset`/`clean`/`drop`/`clear`.
- **Tests (RED first, real-git temp repos + a child_process argv recorder):** happy path creates exactly one stash entry containing the foreign paths (tracked mod AND untracked file both recoverable via `git stash show`), returns a non-null `stashRef` matching `git rev-parse refs/stash`; argv recorder asserts the only mutating argv ever issued is `stash push` (no checkout/reset/clean anywhere); kill-switch set (env saved/restored in beforeEach/afterEach) ⇒ no stash entry exists and the worktree is untouched; empty paths ⇒ skipped, no git call; forced git failure (pathspec matching nothing, via a fabricated path) ⇒ `{ok:false, error}` and no throw. These are the primitive-level halves of the pathspec-safety assertions; the end-to-end ownership of SCENARIO-028 is T5.5.
- **scenarioRefs:** [] (supports SCENARIO-028, owned end-to-end by T5.5) · **acceptanceCriteriaRefs:** [AC-13]

**T1.6 — PRD ledger primitives**
- **Files:** extend `src/fault-classification.ts`; extend `tests/fault-classification.test.ts`.
- **Exports (exact):**
```ts
export type EnvironmentFaultKind = "quarantine" | "judge-environmental";
export interface EnvironmentFaultRecord { kind: EnvironmentFaultKind; paths: string[] | null; stashRef: string | null; reason: string; }
export function environmentFaultLedgerPath(specDir: string): string; // join(specDir, ".environment-faults.jsonl")
export function appendEnvironmentFault(specDir: string | undefined, record: EnvironmentFaultRecord, log?: (m: string) => void): void; // never throws
export function readEnvironmentFaultCount(specDir: string | undefined): number | null; // null iff file absent; never throws
```
  Append = one `JSON.stringify(record) + "\n"` line via `appendFileSync`, try/catch → on failure a warning through `log` (`environment-fault ledger append failed (continuing; never fatal): <msg>`), never a throw. Key order is exactly `{kind, paths, stashRef, reason}` (SCENARIO-025's exact key-set pin).
- **Tests (RED first):** two appends ⇒ file has exactly 2 lines, each parsed key set EXACTLY `{kind, paths, stashRef, reason}` (assert `Object.keys` deep-equal), values preserved; `readEnvironmentFaultCount` on that file ⇒ 2; absent file ⇒ `null`; unwritable target (read-only dir, chmod 0o555, skipped when running as root) ⇒ no throw + warning through the `log` spy (primitive half of SCENARIO-030, end-to-end at T6.3).
- **scenarioRefs:** [SCENARIO-025] · **acceptanceCriteriaRefs:** [AC-12]

**Phase 1 totals:** scenarios {001, 002, 003, 008, 009, 018, 019, 025} = 8; files touched = 4 (`src/fault-classification.ts` create, `tests/fault-classification.test.ts` create, `src/build-runner/gates.ts` edit, `tests/baseline-verify.test.ts` edit).

### Phase 2 — PRB wiring: normalized signatures in the attempt loop (pure, lowest risk)

**Description:** Delegate the stage-local `normalizeSignatureText` to `stripVolatileNoise` BEFORE the existing whitespace-collapse/trim/800-cap, then pin the two behavioral consequences: noise never displaces discriminating content past the cap (SCENARIO-015), and the 11 identical snow failures from run 01-02-50 collapse to one signature so the existing anti-windup engages (SCENARIO-016/017). `repeatedNoProgress` itself is NOT modified — fixing the normalizer's input fixes the detector.

**T2.1 — Strip-before-cap delegation in `normalizeSignatureText`**
- **Files:** modify `src/stages/implementation.ts` (:69-71 + import); create `tests/signature-noise.test.ts`.
- **Change (exact):** `function normalizeSignatureText(value: string): string { return stripVolatileNoise(value).replace(/\s+/g, " ").trim().slice(0, 800); }` with `import { stripVolatileNoise } from "../fault-classification.ts";` — strip → collapse → trim → cap, in that order.
- **Tests (tests/signature-noise.test.ts, RED first — pre-fix normalizer is whitespace-only):** using the tests/implementation-rc8-rc12.test.ts harness (mocked `runBuildGate` with per-call sequenced results, `mkState`/`mkCtx`, agent-dispatch call counting, budget `check` failing after 12 attempts), drive two attempts whose seeded `gate.errors` differ ONLY in >800 chars of leading noise (timestamps/UUIDs/durations/cached markers) while sharing the discriminating tail (`internal/services/snow`, `TestEnrichment_AreaCandidates_ClusterMatch_MatchType`, `[baseline-verify] regression`, `45b865ef`) and `baselineCheck` ABSENT (unclassified per SCENARIO-003 — the retry path): assert the no-progress stop occurs at attempt 2 (log contains `stopped after repeated no-progress`) — pre-fix the first 800 chars differ every attempt so the trip never fires and the loop runs to budget. Also a control case: same noise prefix on both attempts trips identically (guards against a trivial always-trip implementation), and a case where attempt 2 swaps the failing package (`internal/services/auth`) does NOT trip (no over-normalization through the real pipeline path).
- **scenarioRefs:** [SCENARIO-014, SCENARIO-015] · **acceptanceCriteriaRefs:** [AC-06]

**T2.2 — 11-replica snow replay → one signature → anti-windup**
- **Files:** extend `tests/signature-noise.test.ts` (fixture block) — no further src change.
- **Fixture (exact):** `SNOW_REPLICA_FAILURES: string[11]` in the test file — replicas of run 01-02-50 attempts 2-12 (run.log ~851-1697), each varying ONLY the AC-06 noise (timestamps, `trackingID=<uuid>`, `duration=0.000s`, `14.439s`/`3.695s` timings, `(cached)`/`[cached]` markers) while holding fixed `github.com/macotestdashboard/backend-service/internal/services/snow`, `TestEnrichment_AreaCandidates_ClusterMatch_MatchType`, `[baseline-verify] regression`, `45b865ef`; header comment cites the run.log lines as provenance (SCENARIO-016's replica contract).
- **Tests (RED first):** replay all 11 through the harness as sequenced gate results (`baselineCheck` absent per D-4) and assert: the phase stops at attempt 2 (the second occurrence matched the first — only possible if all replays normalized to ONE `ProgressSignature.failure`), the implementer agent is dispatched EXACTLY twice (no third identical spawn absent a judge/HITL continue), and the stop routes through the existing `stage9.impl-no-progress.<phaseId>` judge/HITL machinery (judge agent call captured; `resetJudgeBudgets()` in `beforeEach`). Pre-fix: 11 distinct signatures → no trip → 12 budgeted attempts, 12 implementer dispatches.
- **scenarioRefs:** [SCENARIO-016, SCENARIO-017] · **acceptanceCriteriaRefs:** [AC-07]

**Phase 2 totals:** scenarios {014, 015, 016, 017} = 4; files = 2 (`src/stages/implementation.ts` edit, `tests/signature-noise.test.ts` create).

### Phase 3 — PRA wiring I: classifier insertion + environmental-blocker quarantine/re-gate branch

**Description:** Insert the classification floor at the green-branch fall-through (implementation.ts ~:1730) — after the green predicate (so the own-scope booleans exist) and BEFORE `failureReasons`/missing-test routing/challenge re-author/signature (so an env-blocker can never be misrouted as a challenge or re-spawn the implementer). Wire the quarantine → memo clear → EXACTLY ONE gate re-run → green-predicate re-check path, plus the AC-05 log lines. The branch never `continue`s the attempt loop and never calls `ctx.agent` for the implementer.

**T3.1 — Classification floor insertion + no-respawn guarantee**
- **Files:** modify `src/stages/implementation.ts` (imports + hoisted state ~:1001-1051 + insertion at the :1730 fall-through); create `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** import `classifyGateFault` from `../fault-classification.ts`; add per-phase hoisted `let envBlockerRegateUsed = false;` (resets each convergence iteration of the phase — a later re-entry gets a fresh budget); immediately after the green branch's closing `}` and before `const failureReasons = [`:
```ts
const fault = classifyGateFault({
    errors: gate.errors,
    outOfScopeErrors: gate.outOfScopeErrors,
    baselineCheck: gate.baselineCheck,
    ownScope: { deliverablePass: deliverableCheck.pass, changePass: changeGate.pass, symbolPass: symbolGate.pass, tddClean: tddOracleFailures.length === 0 },
});
if (fault.faultClass === "environmental-blocker") {
    /* blocker branch — T3.2/T3.3/T3.4/T4.x; must break or hand off to judge; never continue; never spawn the implementer */
}
```
- **Tests (tests/implementation-env-blocker.test.ts, RED first — harness per rc8-rc12: mocked `runBuildGate` seeded `{pass:false, ran:["mock"], errors:[<out-of-scope block>, <synthetic block built with the real BASELINE_VERIFY_ERROR_PREFIX>], outOfScopeErrors:[<block>], inScopePass:false, baselineCheck:{status:"regression", evidence:"… PASSES at baseline 45b865ef …"}}`, phase with no deliverables so own-scope booleans are green):** assert the implementer agent's dispatch count is IDENTICAL before and after blocker handling (spawn count asserted equal across the whole run — the blocker adds zero), no `failureReasons`-driven retry log appears for the blocker cause, and the phase does not reach the missing-test/challenge-reauthor edges. Pre-fix: the same seed falls through to `failureReasons` and re-spawns the implementer — count increases — RED.
- **scenarioRefs:** [SCENARIO-004] · **acceptanceCriteriaRefs:** [AC-01, AC-02]

**T3.2 — Dirt inventory → scoped stash → ledger record → memo clear → EXACTLY ONE re-run**
- **Files:** modify `src/stages/implementation.ts` (blocker branch body); edit `tests/baseline-verify.test.ts` (memo-miss pin); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact, in order):** (1) `const dirtPaths = collectDirtPaths({ worktreePath: setup.worktreePath, specDirectory: setup.specDirectory, copiedEnvFiles: setup.copiedEnvFiles ?? [], extraExcluded: [...projectStructured.filesCreated, ...projectStructured.filesModified, ...projectStructured.filesDeleted, ...declaredScope, ...testFiles] });` (2) if `dirtPaths.length > 0 && dirtyQuarantineEnabled() && !envBlockerRegateUsed`: `announceActivity("Environmental blocker", attemptDetail(attempt))`; AC-05 log (T3.4); `const q = quarantineDirt({ worktreePath: setup.worktreePath, paths: dirtPaths, reason: \`stage9 environmental-blocker phase ${phaseId}\`, log: ctx.log });` → on `q.ok`: `appendEnvironmentFault(setup.specDirectory, { kind: "quarantine", paths: dirtPaths, stashRef: q.stashRef, reason: \`environmental-blocker phase ${phaseId}\` }, ctx.log)` + recovery log naming paths/stashRef/`git stash pop`/kill-switch (AC-10 parity) + `envBlockerRegateUsed = true` + `clearBaselineCache()` (import from `../build-runner/baseline.ts`) + `announceActivity("Build gate (post-quarantine re-run)", attemptDetail(attempt))` + `const gate2 = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch: setup.defaultBranch });` + `appendGateChecked(state, "phase-build:env-blocker-regate", gate2, "implementation")` + re-run result log. On `!q.ok && q.error`: warning log + judge route (T4.4). (3) `changeGate`/`symbolGate` verdicts are REUSED, not recomputed (D-12).
- **Tests (RED first):** (a) harness with a REAL temp git worktree (mkdtemp repo wired into `mkState`'s `setup.worktreePath`/`specDirectory`, `runBuildGate` still mocked; worktree pre-dirtied with a foreign tracked mod `internal/services/snow/enrichment.go` outside scope/claims): `runBuildGate` call count increases by EXACTLY 1 for the blocker (never more, across repeated blocker occurrences in one phase), `git stash list` in the worktree has exactly one entry after the run, the ledger file `<specDir>/.environment-faults.jsonl` has one `kind:"quarantine"` line whose `paths` exclude spec-dir/bookkeeping/claimed/scope/test files (canonical inventory inherited), and the implementer dispatch count is unchanged (with T3.1). (b) Memo pin in tests/baseline-verify.test.ts (D-1a): real `verifyUntouchedFailuresAgainstBaseline` with an injectable counting runner on a real-git temp repo — call once (runner 1×, memo populated), call again (runner still 1× — memo hit), `clearBaselineCache()`, call again (runner 2× — miss). (c) Harness-level: `vi.mock("../src/build-runner/baseline.ts")` partial-mocking `clearBaselineCache` with a spy (actual for `verifyUntouchedFailuresAgainstBaseline`) — assert it was called ≥1 during blocker handling with dirt, 0 on the no-dirt path.
- **scenarioRefs:** [SCENARIO-005, SCENARIO-006, SCENARIO-008, SCENARIO-009] · **acceptanceCriteriaRefs:** [AC-03]

**T3.3 — Green-through on the re-run result (fresh deliverable check, existing branch/logs)**
- **Files:** modify `src/stages/implementation.ts` (re-run evaluation); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** if `(gate2.pass || gate2.inScopePass)`: `resetDeliverableCheckCache();` then `const deliverableCheck2 = runDeliverableCheck(setup.worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: false });` (D-12 — `requireTests` verified against a build-green state); re-check `(gate2.pass || gate2.inScopePass) && deliverableCheck2.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0` → on true: `green = true; phaseStatusUpsert(phaseStatus, phaseId, "green"); emitPhaseStatus("ok");` clear the phase from `lastFailures` (mirror the existing green branch), log the EXISTING `Implementation ${phaseId} GREEN on attempt ${attempt}` / `IN-SCOPE GREEN on attempt ${attempt}` line, set `attemptErrors = gate2.errors`, `break`. On false: judge route (T4.1's still-blocked path).
- **Tests (RED first):** sequenced stubs — call 1 = env-blocker seed, call 2 = `{pass:true, ran:["mock"], errors:[], outOfScopeErrors:[], inScopePass:false}`: assert the phase ends GREEN via the re-run (existing `GREEN on attempt` log present, phase status green), `runDeliverableCheck` re-invoked with `skipTests:false` after the cache reset (spy/counting via the real gates module import), and ZERO further implementer spawns after the blocker; variant where call 2 grants an evidence-backed `inScopePass` (`baselineCheck:{status:"preexisting"}`) → `IN-SCOPE GREEN on attempt` log, same no-spawn assertion. The "observable flip" of SCENARIO-006 is pinned by the real-git case in T3.2(a) (porcelain no longer lists the stashed path) plus this consumption of the fresh `gate2`.
- **scenarioRefs:** [SCENARIO-007] · **acceptanceCriteriaRefs:** [AC-03]

**T3.4 — AC-05 log lines (class + next action)**
- **Files:** modify `src/stages/implementation.ts` (log literals); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact literals, asserted by substring):** dirt non-empty + switch unset: `Implementation ${phaseId} environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>`; no-dirt, still-blocked-after-re-run, kill-switch-set, or degrade paths: the same prefix ending `— class=environment; next=<judge: fix-environment/escalate>` (NFR-2: every new line names class and next action; the quarantine-success and warning lines from T3.2 follow the same pattern and name the recovery command + kill-switch).
- **Tests (RED first):** substring assertions on the `ctx.log` sink for both variants (dirt case from T3.2(a)'s real-git harness; no-dirt case from the plain mock harness).
- **scenarioRefs:** [SCENARIO-013] · **acceptanceCriteriaRefs:** [AC-05]

**Phase 3 totals:** scenarios {004, 005, 006, 007, 008, 009, 013} = 7; files = 3 (`src/stages/implementation.ts` edit, `tests/implementation-env-blocker.test.ts` create, `tests/baseline-verify.test.ts` edit).

### Phase 4 — PRA wiring II: judge routing at the blocker boundary + kill-switch and degrade fallbacks

**Description:** Complete the blocker branch's hand-offs: `runJudge` at FIRST occurrence with both evidence packets and `allowedRoutes: ["fix-environment"]` (D-6/D-13), the no-dirt / still-blocked-after-one-re-run / kill-switch / mechanism-failure entries into that route, and the degrade ladder (unoffered/unverified/disabled judge → soft HITL with both packets → terminal stop; never a second identical implementer spawn, never a second automatic quarantine, never fatal).

**T4.1 — Judge at first occurrence with both evidence packets + prior-fault line**
- **Files:** modify `src/stages/implementation.ts`; extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** a single judge hand-off reached when (dirt empty) OR (kill-switch set) OR (`envBlockerRegateUsed`) OR (re-run still blocked) OR (quarantine failed): `const envSubjects = [...new Set((gate2 ?? gate).outOfScopeErrors)].sort();` `const envSignature = JSON.stringify({ subjects: envSubjects, baseline: (gate2 ?? gate).baselineCheck?.status ?? "regression" });` (D-13 — NOT `progressSignature.failure`); `const priorFaults = readEnvironmentFaultCount(setup.specDirectory);` then `await runJudge(ctx, { scope: \`stage9.impl-env-blocker.${phaseId}\`, signature: envSignature, worktreePath: setup.worktreePath, specDirectory: setup.specDirectory, context: [ "## Environmental blocker — out-of-scope-only failures, baseline=regression, own-scope evidence green", ...(<latest gate errors>.slice(0, 12)), "## Baseline verification", \`status=${status}\`, <baselineCheck.evidence>, "## Dirt inventory (foreign uncommitted state, canonical exclusions applied)", (dirtPaths.length ? dirtPaths.join("\n") : "(empty)"), ...(priorFaults !== null ? [\`## Prior environmental faults on this track: ${priorFaults} (from .environment-faults.jsonl)\`] : []) ].join("\n"), allowedRoutes: ["fix-environment"], outputTails: [<latest gate errors joined, tail-sliced 2000>, <baselineCheck.evidence>, <gate2 errors joined if present>] });` — escalate-now implied by judge.ts:230.
- **Tests (RED first):** no-dirt harness (plain mock, empty inventory): assert the judge agent call is captured with scope `stage9.impl-env-blocker.<phaseId>`, `allowedRoutes` exactly `["fix-environment"]`, context containing the gate failure tail, the baseline status/evidence, the dirt inventory (`(empty)`), and — with a pre-seeded ledger file in the temp specDir — the prior-fault count line (OQ-3/D-8; absent ledger ⇒ no such line); `resetJudgeBudgets()` in `beforeEach`. Still-blocked variant: sequenced stubs (blocker → re-run blocker) with real-git dirt: judge fires ONCE, `runBuildGate` called exactly 2× total (budget stays at 1 — no second quarantine, no second re-run), implementer count unchanged. Routed `fix-environment` (verdict evidence quoting an `outputTails` fragment so INV-2 verification passes): soft HITL escalation surfaced with both packets (findings ≤ 12) and the phase terminates (`terminalStopReason = "failed"`, distinct stop log) — `applyRetryDecision` is NOT called (D-5; assert no rollback: the worktree HEAD is unchanged and no `reset`/`clean` argv recorded).
- **scenarioRefs:** [SCENARIO-010, SCENARIO-011] · **acceptanceCriteriaRefs:** [AC-04]

**T4.2 — Unoffered/unverified route degrades to escalate; HITL carries both packets**
- **Files:** modify `src/stages/implementation.ts` (outcome handling); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** on `judgeOut.status === "routed" && verdict.route === "fix-environment"` → log + soft HITL (T4.1) + terminal stop; on `escalate`/`discarded`/`degraded` (including `SUPER_DEV_DISABLE_JUDGE=1` and budget exhaustion) → the SAME soft HITL surface (kind `"stagnation"`, severity `"soft"`, stage `"implementation"`, findings = gate tail + baseline + inventory sliced to 12) then terminal stop; headless (no `escalate` callback) → log the surfaced packets and stop. No `continue`, no implementer spawn on any arm.
- **Tests (RED first):** judge scripted to return an unoffered route (e.g. `re-author-tests`) or evidence that fails quote verification → outcome degrades per existing judge behavior → assert the HITL escalation failure object carries both evidence packets (or, headless, the log does), the stop log is emitted, and the implementer dispatch count never increases across the whole interaction.
- **scenarioRefs:** [SCENARIO-012] · **acceptanceCriteriaRefs:** [AC-04]

**T4.3 — Kill-switch disables the in-loop quarantine → detection warning + judge**
- **Files:** modify `src/stages/implementation.ts` (guard ordering inside the blocker branch); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** when `!dirtyQuarantineEnabled()` and `dirtPaths.length > 0`: emit `Implementation ${phaseId} dirty-quarantine kill-switch SUPER_DEV_NO_DIRTY_QUARANTINE=1 set — detection only, worktree untouched — class=environment; next=<judge: fix-environment/escalate>` and route to the T4.1 judge hand-off; NO stash mutation occurs (the `quarantineDirt` short-circuit in T1.5 enforces it structurally; the branch additionally never calls it).
- **Tests (RED first):** env var set (saved/restored) + real-git dirt harness: `git stash list` EMPTY after the run, the foreign file still modified in the worktree, the detection-warning substring present, judge invoked at the blocker scope, implementer count unchanged.
- **scenarioRefs:** [SCENARIO-024] · **acceptanceCriteriaRefs:** [AC-11, AC-04]

**T4.4 — Quarantine mechanism failure degrades to warning + judge, never fatal**
- **Files:** modify `src/stages/implementation.ts` (failure arm); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** on `!q.ok && q.error`: `ctx.log(\`Implementation ${phaseId} quarantine FAILED (nothing stashed — degrading to judge route) — class=environment; next=<judge: fix-environment/escalate>: ${q.error.slice(0, 300)}\`)` then the T4.1 judge hand-off; the attempt loop never throws (never-throwing contract preserved); nothing was stashed so no recovery is owed; `envBlockerRegateUsed` is NOT consumed on failure (the budget counts a completed state change, not an attempted one).
- **Tests (RED first):** force a git failure (fabricated pathspec via a dirtied harness stubbing `spawnSync` git to exit non-zero on `stash push`, or a repo state where the stash cannot be created): assert the warning substring, the judge call at the blocker scope, no throw (the stage completes), no stash entry, implementer count unchanged. Ledger-write failure inside the branch is covered by T6.3.
- **scenarioRefs:** [SCENARIO-029] · **acceptanceCriteriaRefs:** [AC-13]

**Phase 4 totals:** scenarios {010, 011, 012, 024, 029} = 5; files = 2 (`src/stages/implementation.ts` edit, `tests/implementation-env-blocker.test.ts` edit).

### Phase 5 — PRC wiring: reused/resumed-track quarantine in `runSetup`

**Description:** Insert the reuse-hygiene block in `runSetup` between the knowledge-clearing block (:596-601) and the `return` (:602) — after `acquireRunLock` (no same-track race) and after stale-cache truncation. Guard: `(reusedTrack || options.resumeSpecIdentifier) && resolve(worktreePath) !== resolve(cwd)` (re-entry only; never the user's main checkout; `skipWorktree` implies worktreePath===cwd and is excluded; fresh tracks skip detection entirely). Synchronous `spawnSync` only; `options.log` is the only sink; nothing in the return shape changes.

**T5.1 — Detect + quarantine foreign state on re-entry; worktree left clean**
- **Files:** modify `src/setup.ts`; create `tests/setup-dirty-quarantine.test.ts`.
- **Changes (exact):** inside the guard: `const setupDirt = collectDirtPaths({ worktreePath, specDirectory, copiedEnvFiles });` → if `!dirtyQuarantineEnabled()` → T5.4 warning; else if `setupDirt.length` → `const q = quarantineDirt({ worktreePath, paths: setupDirt, reason: \`setup reuse hygiene track ${specIdentifier}\`, log: options.log });` → on `q.ok && q.stashRef`: `appendEnvironmentFault(specDirectory, { kind: "quarantine", paths: setupDirt, stashRef: q.stashRef, reason: \`setup re-entry track ${specIdentifier}\` }, options.log)` + the T5.3 log; on failure: warning log (mirroring the `bootstrapDependencies` degrade style) and plain proceed.
- **Tests (tests/setup-dirty-quarantine.test.ts, RED first — real-git temp repos per tests/setup.test.ts: `git()` helper via `execFileSync`, `try/finally rmSync`):** two-step re-entry — first `runSetup` creates the track+worktree (task referencing `@docs/specifications/<id>/` so `reusedTrack === true`), then write a foreign tracked modification `internal/services/snow/enrichment.go` and an untracked `scratch.txt` into the worktree, then `runSetup` again on the same track: assert `git status --porcelain` in the worktree reports NO foreign tracked modifications, `git stash list` has exactly one entry, `scratch.txt` is recoverable from the stash (untracked captured by `-u`), and `<specDir>/.environment-faults.jsonl` has one `kind:"quarantine"` line whose `paths` are exactly the two foreign paths. Repeat the shape with `options.resumeSpecIdentifier` (the resumed-track parameterization of SCENARIO-020). Pre-fix: no quarantine exists — worktree still dirty — RED.
- **scenarioRefs:** [SCENARIO-020] · **acceptanceCriteriaRefs:** [AC-09]

**T5.2 — Exclusions preserved; fresh tracks and the main checkout untouched**
- **Files:** extend `tests/setup-dirty-quarantine.test.ts` (no further src change beyond T5.1).
- **Tests (RED first):** (a) re-entry whose ONLY uncommitted state is a modified spec-dir file + `HARNESS_BOOKKEEPING_FILES` members inside the spec dir + a `copiedEnvFiles` entry ⇒ no stash is created, every one of those paths is still present/modified as-is after `runSetup` (state preserved, not quarantined); (b) `SUPER_DEV_NO_SPEC_REUSE=1` fresh track ⇒ no stash, no quarantine log line at all (detection scoped to re-entry); (c) `options.skipWorktree` with a DIRTY main checkout (cwd) ⇒ cwd dirt untouched, no stash anywhere (never quarantine the user's checkout).
- **scenarioRefs:** [SCENARIO-021] · **acceptanceCriteriaRefs:** [AC-09]

**T5.3 — Prominent recovery log (AC-10)**
- **Files:** modify `src/setup.ts` (log literal); extend `tests/setup-dirty-quarantine.test.ts`.
- **Changes (exact):** on quarantine success, one `options.log` line: `Setup quarantined foreign uncommitted state on re-entered track ${specIdentifier} — paths: ${paths.join(", ")}; stash ref: ${stashRef}; recover with: git stash pop; kill-switch: SUPER_DEV_NO_DIRTY_QUARANTINE=1` (the `SUPER_DEV_NO_SPEC_REUSE`/`SUPER_DEV_NO_BOOTSTRAP` logging style, stages/setup.ts:35 convention).
- **Tests (RED first):** captured `options.log` sink contains, in one line: at least one quarantined path, the exact `stashRef` returned, the substring `git stash pop`, and the substring `SUPER_DEV_NO_DIRTY_QUARANTINE=1`.
- **scenarioRefs:** [SCENARIO-022] · **acceptanceCriteriaRefs:** [AC-10]

**T5.4 — Kill-switch at setup: detection warning, worktree untouched**
- **Files:** modify `src/setup.ts` (kill-switch arm); extend `tests/setup-dirty-quarantine.test.ts`.
- **Changes (exact):** when `!dirtyQuarantineEnabled()` and `setupDirt.length > 0`: `Setup detected foreign uncommitted state on re-entered track ${specIdentifier} but SUPER_DEV_NO_DIRTY_QUARANTINE=1 is set — worktree untouched; paths: ${paths.join(", ")}` — detection observes, mutation never runs.
- **Tests (RED first):** env var set (saved/restored) + the T5.1 dirty-re-entry fixture: no stash entry, foreign modification still present in the worktree, warning substring present in the log sink.
- **scenarioRefs:** [SCENARIO-023] · **acceptanceCriteriaRefs:** [AC-11]

**T5.5 — End-to-end pathspec safety (stash-only, never touches in-scope/excluded files)**
- **Files:** extend `tests/setup-dirty-quarantine.test.ts` (no further src change).
- **Tests (RED first):** after the T5.1 quarantine: `git stash show --name-only` (plus the untracked third parent via `git stash show -u` or the recorded `paths`) lists ONLY the foreign paths — spec-dir file, bookkeeping files, copied env file, and (in the in-loop harness twin, using the T3.2 real-git fixture with claimed/scope/test files present) the claimed change set are all still in the worktree, unmodified; a child_process argv recorder spanning the whole setup run (and the env-blocker harness run) asserts the only mutating git argv ever issued is `stash push` (no `checkout`/`reset`/`clean`), and that no quarantine argv is issued at all when the kill-switch is set.
- **scenarioRefs:** [SCENARIO-028] · **acceptanceCriteriaRefs:** [AC-13]

**Phase 5 totals:** scenarios {020, 021, 022, 023, 028} = 5; files = 2 (`src/setup.ts` edit, `tests/setup-dirty-quarantine.test.ts` create). Parallelizable with Phase 2 after Phase 1 (disjoint files).

### Phase 6 — PRD wiring: ledger consumers (setup prior-count, judge-environmental records, never-fatal appends)

**Description:** Wire the two read surfaces and the verdict-record writer onto the primitives from T1.6: setup surfaces the prior-fault count iff the ledger exists (SCENARIO-027), the env-blocker judge outcome appends a `judge-environmental` record (SCENARIO-026), and unwritable-ledger failures degrade to a warning everywhere (SCENARIO-030's end-to-end halves).

**T6.1 — Setup prior-fault count iff the ledger exists**
- **Files:** modify `src/setup.ts` (inside the T5 guard region, after the quarantine arm — runs on every eligible re-entry regardless of dirt); extend `tests/setup-dirty-quarantine.test.ts`.
- **Changes (exact):** `const priorFaults = readEnvironmentFaultCount(specDirectory); if (priorFaults !== null) options.log?.(\`Setup prior environmental faults on track ${specIdentifier}: ${priorFaults} (ledger: .environment-faults.jsonl — class=environment; next=none, informational)\`);` — absent file ⇒ NO line at all.
- **Tests (RED first):** re-entry with a pre-seeded N-line ledger ⇒ the count line with the correct N; re-entry with no ledger ⇒ no line matching `/prior environmental faults/` in the sink; a quarantining re-entry ⇒ count line reflects the just-appended record (ordering: count read after the quarantine arm).
- **scenarioRefs:** [SCENARIO-027] · **acceptanceCriteriaRefs:** [AC-12]

**T6.2 — Judge-environmental verdict records**
- **Files:** modify `src/stages/implementation.ts` (T4 outcome handler); extend `tests/implementation-env-blocker.test.ts`.
- **Changes (exact):** on `judgeOut.status === "routed" || judgeOut.status === "escalate"` at the env-blocker boundary: `appendEnvironmentFault(setup.specDirectory, { kind: "judge-environmental", paths: null, stashRef: null, reason: \`${judgeOut.verdict.route}: ${judgeOut.verdict.diagnosis.slice(0, 200)}\` }, ctx.log);` — key set stays exactly `{kind, paths, stashRef, reason}` with null paths/stashRef for verdict records (D-14: lenient `preexisting` grants never record).
- **Tests (RED first):** env-blocker harness with a temp specDir and a judge scripted to route `fix-environment` with verifiable evidence (quote from `outputTails`): after the run, the ledger has one line with `kind:"judge-environmental"`, `paths === null`, `stashRef === null`, non-empty `reason`; the quarantine variant (T3.2) and this verdict line coexist as two records with the exact key set.
- **scenarioRefs:** [SCENARIO-026] · **acceptanceCriteriaRefs:** [AC-12]

**T6.3 — Unwritable ledger degrades to a warning; flows proceed, never fatal**
- **Files:** extend `tests/fault-classification.test.ts` (primitive, from T1.6), `tests/setup-dirty-quarantine.test.ts`, `tests/implementation-env-blocker.test.ts` (no src change — the degrade lives in the primitives' try/catch and the call sites' `log` pass-through).
- **Tests (RED first):** (a) primitive (already pinned in T1.6 — keep green); (b) setup: re-entry with dirt where `<specDir>/.environment-faults.jsonl`'s directory is made unwritable (chmod 0o555, skipped as root) ⇒ `runSetup` completes normally, the quarantine itself still succeeded (stash exists), a warning substring `/ledger append failed/` is logged; (c) in-loop: env-blocker harness with an unwritable specDir ⇒ the branch still completes through the judge route, no throw, warning logged, implementer count unchanged.
- **scenarioRefs:** [SCENARIO-030] · **acceptanceCriteriaRefs:** [AC-13, AC-12]

**Phase 6 totals:** scenarios {026, 027, 030} = 3; files = 5 (`src/setup.ts`, `src/stages/implementation.ts`, `tests/setup-dirty-quarantine.test.ts`, `tests/implementation-env-blocker.test.ts`, `tests/fault-classification.test.ts` — all edits).

### Phase 7 — Version pin 0.2.3 (NFR-5)

**Description:** Advance the extension version to 0.2.3 across the runtime constant and both package manifests, and re-pin the version tests. Per the repo's versioning policy (`SUPER_DEV_VERSION_POLICY`, src/version.ts docblock), every commit that changes the extension increments the patch; the pin lands staged with the cycle and is committed together with the feature work (one commit, NFR-5).

**T7.1 — Bump SUPER_DEV_EXTENSION_VERSION to 0.2.3 and re-pin tests**
- **Files:** modify `src/version.ts`, `package.json`, `package-lock.json`, `tests/version.test.ts`.
- **Changes (exact):** `src/version.ts`: `export const SUPER_DEV_EXTENSION_VERSION = "0.2.3";` · `package.json`: `"version": "0.2.3"` · `package-lock.json`: both `version` fields (root and `packages[""].version`) → `0.2.3` (regenerate deterministically via `npm install --package-lock-only` if preferred — the pinned fields are what tests read) · `tests/version.test.ts`: update the three `"0.2.2"` literals to `"0.2.3"` and fix the stale first-case name (`"sets the runtime-visible extension version to 0.1.46"` → `"… to 0.2.3"`) so name and assertion agree.
- **Tests (RED first — the pin fails while the tree still says 0.2.2):** `tests/version.test.ts` asserts `SUPER_DEV_EXTENSION_VERSION === "0.2.3"`, `superDevVersionLabel() === "super-dev v0.2.3"`, and package.json/package-lock.json alignment with the runtime constant (existing assertions, new literal). Real behavior: `npm test -- version` red pre-bump, green post-bump; `tests/runlog-wiring.test.ts` (imports the constant) stays green untouched.
- **scenarioRefs:** [SCENARIO-031] · **acceptanceCriteriaRefs:** [AC-14]

**Phase 7 totals:** scenarios {031} = 1; files = 4.

### Phase 8 — Release artifacts and final gates (RELEASE — final task)

**Description:** Close the cycle: CHANGELOG `Unreleased` bullet, regenerated architecture doc, and the full AC-14 gate run. This phase's task is the LAST task of the cycle and is marked **release**.

**T8.1 — CHANGELOG bullet, ARCHITECTURE.md regen, final typecheck + suite (release)**
- **Files:** modify `CHANGELOG.md`, `docs/ARCHITECTURE.md` (generated).
- **Changes (exact):** (1) `CHANGELOG.md` — add ONE bullet under `## [Unreleased]` → `### Fixed` (matching the v0.2.2 entry's format), titled to name the cycle (Stage 9 fault-classified actuation, normalized failure signatures, reused-worktree isolation; run `2026-08-18T01-02-50-093Z`; ships as v0.2.3), covering: PRA classifier + never-respawn + quarantine/one-re-run/first-occurrence judge; PRB noise stripping + anti-windup; PRC setup quarantine with kill-switch; PRD ledger; the new `src/fault-classification.ts` module; and the FINAL test counts/typecheck status filled in from the actual `npm test` / `npm run typecheck` output of this task (no projected numbers). (2) `docs/ARCHITECTURE.md` — regenerate via `npm run arch:doc` (`node src/render/arch-doc.ts`); verify `tests/arch-doc.test.ts` stays green and the rendered doc includes the new module. (3) Final gates: `npm run typecheck` exits clean; `npm test` full suite green — the SCENARIO-031 close-out (every task's RED-first evidence is its own; this task is the aggregate green).
- **Tests:** no new test file; the release verification IS `tests/version.test.ts` (0.2.3 pin from T7.1), `tests/arch-doc.test.ts`, `tsc --noEmit`, and the full vitest suite — all real, all runnable.
- **scenarioRefs:** [SCENARIO-031] · **acceptanceCriteriaRefs:** [AC-14]

**Phase 8 totals:** scenarios {031} = 1; files = 2. **This is the release task — nothing follows it.**

---

## Acceptance criteria references

| AC | Owner task(s) | Coverage note |
|---|---|---|
| AC-01 | T1.1 (floor), T1.2 (prefix single-source), T3.1 (loop insertion) | pure classifier truth table incl. synthetic-block exclusion; absent-baselineCheck ⇒ unclassified |
| AC-02 | T3.1 | implementer dispatch count frozen across blocker handling (stubbed regression gate) |
| AC-03 | T1.4 (canonical inventory), T3.2 (stash + ledger + memo clear + exactly-one re-run), T3.3 (green-through) | canonical exclusion rule pinned once in the helper, inherited by both call sites |
| AC-04 | T4.1 (first-occurrence judge, both packets, prior-fault line), T4.2 (degrade ladder), T4.3 (kill-switch fallback) | `fix-environment` second offer; escalate-now implied; never a second identical spawn |
| AC-05 | T3.4 | `class=environment; next=<…>` substring-pinned literals |
| AC-06 | T1.3 (strip classes + both directions), T2.1 (strip-before-cap through the real normalizer) | ordering pinned behaviorally (trip impossible pre-fix) |
| AC-07 | T2.2 | 11-replica replay → one signature → attempt-2 trip, ≤2 implementer dispatches |
| AC-08 | T1.3 | equal on noise-only; NOT equal on package/error-class (both directions, unit-pinned) |
| AC-09 | T5.1 (reused/resumed quarantine + porcelain-clean), T5.2 (exclusions + fresh-track/main-checkout boundary) | parameterized over reused/resumed per SCENARIO-020 |
| AC-10 | T5.3 | paths + stash ref + `git stash pop` + kill-switch in one prominent line |
| AC-11 | T5.4 (setup), T4.3 (in-loop) | one switch disables BOTH quarantines; detection observes, mutation never runs |
| AC-12 | T1.6 (primitives + exact key set), T6.1 (prior-count iff exists), T6.2 (judge-environmental records) | `{kind, paths, stashRef, reason}` exactly; appends never throw |
| AC-13 | T1.5 (primitive contract), T5.5 (end-to-end pathspec safety), T4.4 (git-failure degrade), T6.3 (unwritable-ledger degrade) | stash-only, kill-switched, degrading — never fatal, never destructive |
| AC-14 | T7.1 + T8.1 (aggregate), plus every task's RED-first clause | RED on pre-fix tree; `tsc --noEmit` clean; full vitest green; v0.2.3 same commit |

## Scenario coverage

| Scenario | Owner task(s) | | Scenario | Owner task(s) |
|---|---|---|---|---|
| SCENARIO-001 | T1.1, T1.2, T3.1 | | SCENARIO-017 | T2.2 |
| SCENARIO-002 | T1.1, T3.1 | | SCENARIO-018 | T1.3 |
| SCENARIO-003 | T1.1, T3.1 | | SCENARIO-019 | T1.3 |
| SCENARIO-004 | T3.1 | | SCENARIO-020 | T5.1 |
| SCENARIO-005 | T3.2 | | SCENARIO-021 | T5.2 |
| SCENARIO-006 | T3.2 | | SCENARIO-022 | T5.3 |
| SCENARIO-007 | T3.3 | | SCENARIO-023 | T5.4 |
| SCENARIO-008 | T1.4, T3.2 | | SCENARIO-024 | T4.3 |
| SCENARIO-009 | T1.4, T3.2 | | SCENARIO-025 | T1.6 (primitive), T3.2/T5.1 (event lines asserted) |
| SCENARIO-010 | T4.1 | | SCENARIO-026 | T6.2 |
| SCENARIO-011 | T4.1 | | SCENARIO-027 | T6.1 |
| SCENARIO-012 | T4.2 | | SCENARIO-028 | T5.5 (end-to-end), T1.5 (primitive argv-safety) |
| SCENARIO-013 | T3.4 | | SCENARIO-029 | T4.4 |
| SCENARIO-014 | T2.1 | | SCENARIO-030 | T6.3 (end-to-end), T1.6 (primitive never-throw) |
| SCENARIO-015 | T2.1 | | SCENARIO-031 | T7.1, T8.1 (+ every task's RED-first clause) |
| SCENARIO-016 | T2.2 | | | |

Every SCENARIO-001..031 is referenced by ≥1 task; every AC-01..AC-14 is owned by ≥1 task. Phase scenario counts: 8 / 4 / 7 / 5 / 5 / 3 / 1 / 1 (all ≤8); phase file counts: 4 / 2 / 3 / 2 / 2 / 5 / 4 / 2 (all ≤5).