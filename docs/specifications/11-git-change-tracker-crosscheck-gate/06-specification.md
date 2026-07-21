# Specification: Git Change-Tracker with Per-Stage/Per-Phase Bracketing and a Claimed-vs-Actual Cross-Check Gate (spec-11)

- **Date**: 2026-07-21

---

## Summary

Replace the advisory flat `filesModified: string[]` returned by code-mutating agents with a structured `{filesCreated, filesModified, filesDeleted}` set AND add a new `src/tracking.ts` `ChangeTracker` that brackets EVERY stage (start+end) and EVERY implementation phase (start+end) with a git snapshot, persisting an append-only `<specDir>/change-tracker.jsonl` of begin/end records. Each end record carries a git-derived `gitActual` change set, the agent's claimed set, and a one-directional cross-check (`claimedNotChanged` vs `changedNotClaimed`). A new `changeGate` is AND-ed into phase-green alongside the existing build gate and spec-10 deliverable check, so a phase that CLAIMS to create/modify a file git does NOT show changed hard-fails (the false-green root cause closed a second way), while `changedNotClaimed` (under-reporting) stays advisory. The whole subsystem NEVER throws and degrades when git is unavailable (`gitUnavailable` → record + `changeGate.pass = true`, never block). Tracking and spec-10 deliverable assertions collapse into one enforcement path: `claimed.filesCreated` auto-unions into `deliverables.requireFiles`, and the flat `filesModified` accumulation is derived from the structured set so existing summary/dashboard writers keep working. Pure TypeScript change to this repo (pi-super-dev), zero new runtime deps, discrete-argv `spawnSync` git ops under the existing timeout envelope. Verification: `npm run typecheck` clean and `npm test` all green (existing 1120 + new), with no regression to runRedCheck, runDeliverableCheck, npm in-scope classification, scope-aware cargo gate, themed stream, mid-run input injection, dashboard, or real-theme parity. Covers AC-01..AC-11 and SCENARIO-001..SCENARIO-020.

## Architecture

## System context

pi-super-dev is a self-contained TypeScript (ESM, zero-runtime-deps) pi-extension/CLI driving a 13-stage pipeline. The pipeline is a tree of control-flow nodes (src/nodes.ts) executed by an EventEmitter-powered engine (src/workflow.ts); stages run via the `task()` leaf node which emits `ctx.events` "stage"/"phase" events around `stage.run`. A deterministic oracle layer (src/build-runner.ts) already performs robust, never-throwing git/spawn work using discrete-argv `spawnSync` and a committed-diff UNION untracked-files pattern (`touchedFilePaths`, `dedupePreservingOrder`). Phase-green is already an AND-chain in src/stages/implementation.ts: `(gate.pass || gate.inScopePass) && deliverableCheck.pass`, with retry-prompt injection (`attemptErrors`, `missingDeliverables` → `## ... still missing — create/wire these`) bounded by `MAX_ATTEMPTS = 3`. A canonical per-run module singleton (`activeRun`/`setActiveRun`/`getActiveRun` in src/extension.ts) is set on `execute()` entry and nulled in the `finally`. This spec slots the change-tracker cleanly into those existing patterns with minimal engine touch.

## Core component: `src/tracking.ts` (NEW — AC-01, AC-02, AC-03)

A per-run `ChangeTracker` class constructed with `(specDir: string, worktreePath: string)`. It owns a `Map<unitKey, Baseline>` of pending begin-baselines and writes a single durable append-only file `<specDir>/change-tracker.jsonl` (one record per begin/end event, never overwritten).

**Public API (contract-first signatures):**
```ts
type TrackerUnit = "stage" | "phase";
interface StructuredChanges { filesCreated: string[]; filesModified: string[]; filesDeleted: string[]; }
interface GitActual { created: string[]; modified: string[]; deleted: string[]; }
interface CrossCheck { claimedNotChanged: string[]; changedNotClaimed: string[]; }
interface ChangeRecord {
  unit: TrackerUnit; id: string; event: "start" | "end"; ts: string;
  beginHead: string | null; endHead: string | null;
  gitActual: GitActual | null;
  claimed: StructuredChanges | null;
  crossCheck: CrossCheck | null;
  verdict: "ok" | "claimed-miss" | "git-unavailable";
  gitUnavailable?: boolean;
}
class ChangeTracker {
  constructor(specDir: string, worktreePath: string);
  begin(unit: TrackerUnit, id: string): void;
  end(unit: TrackerUnit, id: string, claimed?: StructuredChanges): ChangeRecord | null;
  getRecord(unit: TrackerUnit, id: string): ChangeRecord | null;  // last end-record (gate reads crossCheck)
}
```

**`begin(unit, id)`**: snapshot baseline = `git -C <wt> rev-parse HEAD` (committed ref) UNION `git -C <wt> status --porcelain` (working-tree state); stash both keyed by `${unit}:${id}`. Emits one `{event:"start", unit, id, ts, beginHead}` jsonl line (complete bracket trace — recommended per the open question).

**`end(unit, id, claimed?)`**: re-snapshot; compute the DELTA as `git -C <wt> diff --name-status <beginHead>` (committed changes since begin, status letters `A`/`M`/`D` map directly to created/modified/deleted) UNION `git -C <wt> status --porcelain` (uncommitted/untracked — `??`→created, `M`/`MM`→modified, `D`/`DM`→deleted). Normalize porcelain XY-codes via an explicit `classifyPorcelain(xy: string)` mapping (no ambiguity: `??`=created, `D*`/`*D`=deleted, else modified). Union both with `dedupePreservingOrder` (exported from build-runner.ts — see §Reuse). Build `gitActual`, then cross-check: `claimedNotChanged = (claimed.filesCreated ∪ claimed.filesModified) \ gitActual.{created∪modified}`, `changedNotClaimed = gitActual.{created∪modified∪deleted} \ claimed.{all three}` (advisory). Append ONE `{event:"end", ...}` jsonl line. Return the `ChangeRecord`.

**Never-throw invariant (AC-02):** the entire `begin`/`end` body and every git op is wrapped in one `try/catch`. On any git failure (ENOENT, non-zero exit, non-string stdout, spawn error, non-git dir) the record carries `{gitUnavailable: true, gitActual: null, crossCheck: null, verdict: "git-unavailable"}` and the method returns that record (never throws, never blocks). Conservative parse (SCENARIO-006): a claimed file is recorded as `claimedNotChanged` ONLY when `gitActual` was successfully computed and the file is absent from `gitActual.created∪modified` — if git was unavailable or the parse ambiguous, `claimedNotChanged` stays empty (no false failure).

## Git primitives & reuse (AC-01 — no new runtime deps)

- **Export `dedupePreservingOrder`** from `src/build-runner.ts` (currently module-private at ~line 112) and import it into `tracking.ts`. Single source of truth, no duplication.
- The tracker's three git spawns (`rev-parse HEAD`, `status --porcelain`, `diff --name-status <beginHead>`) copy the EXACT discrete-argv `spawnSync` shape from `touchedFilePaths` (build-runner.ts ~538): `spawnSync("git", ["-C", worktreePath, ...], { encoding: "utf8", timeout: resolveTimeoutMs(...) })`. Discrete argv (never `shell:true`) keeps agent-supplied file paths out of any shell (security/hygiene). A `gitSpawn(argv)` private helper centralizes the try/catch + the timeout envelope.
- The committed-diff UNION untracked-files pattern is `touchedFilePaths`'s exact approach, but keyed off the stored `beginHead` instead of a base ref.

## Threading: per-run singleton mirroring `activeRun` (AC-05)

Add `let activeTracker: ChangeTracker | null` + `setActiveTracker(t | null)` + `getActiveTracker(): ChangeTracker | null` to `src/tracking.ts` (exported; mirrors extension.ts:68/141/149). **Key design decision:** `state.setup` (which supplies `worktreePath` + `specDirectory`, src/types.ts:112-113) is NOT available at `execute()` entry — it is established inside the pipeline run. Therefore `setActiveTracker(new ChangeTracker(specDir, worktreePath))` is called in `src/pipeline.ts` (runPipelineTask) at the point `state.setup` is finalized (right after the setup stage populates the worktree + spec dir, before the producing stages run), guarded so a stale singleton from an overlapping run is discarded first (same guard activeRun uses). It is nulled in the same `finally` that nulls `activeRun` in `extension.ts` execute() (add `setActiveTracker(null)` adjacent to `setActiveRun(null)`). No leak between runs (SCENARIO-010). Stages/phases read it via `getActiveTracker()` and no-op when null (idle / non-git) — never throw.

## Bracketing EVERY stage and EVERY phase (AC-04)

**Stages — minimal-touch event seam (PREFERRED):** `task()` in `src/nodes.ts` already emits `ctx.events.emit("stage", { id, label, status: "running" })` immediately before `stage.run` and `record(ctx, <terminal status>)` → `ctx.events.emit("stage", {id,label,status})` after. Subscribe the tracker to the "stage" channel in `src/workflow.ts` (where `ctx.events.on("stage"/"phase")` is ALREADY wired per code-assessment): on `status === "running"` → `tracker.begin("stage", id)`; on terminal status (`ok`/`failed`/`skipped`) → `tracker.end("stage", id)` (stages have no structured claim → `claimed = undefined`). This is the surgical seam: NO edit to nodes.ts/workflow.ts internals, only an added subscription block + the begin/end calls. (Fallback only if events lack stage id: a thin wrapper around `stage.run` in nodes.ts:127-129 — explicitly dis-preferred, documented as the contingency.)

**Implementation phases — bracket inside `src/stages/implementation.ts`:** wrap each phase iteration `for (const [idx, phase] of phases.entries())` with `tracker.begin("phase", phaseId)` (before the attempt loop) and `tracker.end("phase", phaseId, claimedFromImplementer)` (after the loop, using the structured changes parsed from the last implementer control). Produces the required nesting: `stage-start → phase1-start → phase1-end → … → stage-end` (SCENARIO-009). `phaseId` already exists (`phase-${pad(idx+1)}`). Tracker calls are guarded by `const tracker = getActiveTracker(); if (tracker) { ... }`.

## Structured change set (AC-06, AC-10)

- **prompts.ts:** `buildImplementPrompt` (~line 120) and `buildFixPrompt` (~line 140) change their trailing contract line from `filesModified (array)` to `filesCreated (array), filesModified (array), filesDeleted (array)` with the one-line instruction: *"Report the exact files you created/modified/deleted — these are git-cross-checked; claiming a file you did not change fails the phase."* `buildImplementationSummaryPrompt` (~line 127) is unchanged but now consumes the derived flat list (AC-10).
- **implementation.ts:** add `parseStructuredChanges(control): StructuredChanges` that reads `filesCreated/filesModified/filesDeleted` when present, and backward-tolerates a legacy flat `filesModified` array (normalize into `filesModified`, leaving created/deleted empty). The per-attempt accumulation (implementation.ts ~line 92/159/219) derives the flat `filesModified[]` shown in the summary by unioning `filesCreated ∪ filesModified` (deleted excluded from the "modified" display) — so the existing summary writer keeps working byte-identically for unchanged agents (AC-10, SCENARIO-019). Add a `📝 N files changed (C/M/D)` evidence line to the summary, e.g. `📝 3 files changed (1C/2M/0D)` from the phase end-record's `gitActual`.

## Git cross-check GATE (AC-07, AC-08) — the false-green killer

In `src/stages/implementation.ts`, after `runBuildGate` (~165) and `runDeliverableCheck` (~185), compute:
```ts
const changeRec = tracker?.getRecord("phase", phaseId) ?? null;
const changeGate = computeChangeGate(changeRec);   // never throws
```
where `computeChangeGate(rec)` returns `{pass: boolean, claimedNotChanged: string[]}`:
- `pass === false` iff `rec != null && !rec.gitUnavailable && (rec.crossCheck?.claimedNotChanged?.length ?? 0) > 0` — a created/modified claim git does NOT show (the false-green killer, AC-08).
- `changedNotClaimed` is advisory-only: logged via `ctx.log(...)`, never affects `pass` (SCENARIO-014 — under-reporting is not a false-green).
- `gitUnavailable` (or no tracker) → `pass = true` (don't block on infrastructure, SCENARIO-017). Never throws.
- No claimed changes → `claimedNotChanged` empty → `pass = true` (SCENARIO-016, trivial pass).

Phase GREEN (implementation.ts ~line 194) becomes:
```ts
if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass) { green = true; ... break; }
```
On a `changeGate` miss, feed `claimedNotChanged` into the next implementer attempt via the EXISTING retry channel — a new `## Claimed changes not present in git — actually create/wire these` block pushed onto `implParts` (mirroring the `missingDeliverables` block at ~line 148), bounded by `MAX_ATTEMPTS`. So a claimed-but-never-created file (`claimed:{filesCreated:[X]}` with no new file in git) → `changeGate.pass === false` → phase NOT green even when build + deliverable both pass → the stockfan Phase-5/6 false-green becomes impossible (SCENARIO-013).

## Spec-10 deliverable bridge (AC-09)

Before calling `runDeliverableCheck`, UNION `claimed.filesCreated` with any spec-declared `phase.deliverables.requireFiles` (build-runner.ts `DeliverableContract.requireFiles` ~line 1588) into the contract actually passed to `runDeliverableCheck`. So a file a phase claims to have created MUST exist — tracking and deliverable assertions reinforce. No circular double-count: if an agent omits a spec-required file, the spec-declared `requireFiles` still catches it independently (confirmed in the requirements open question).

## Surfacing (AC-10)

The phase end-record's `gitActual` is the ground-truth evidence: the `📝 N files changed (C/M/D)` line in the implementation summary, and the flat `filesModified` accumulation is derived from the structured set. The dashboard continues to read the existing summary shape (no dashboard change required this cut; a dedicated change-tracker panel consuming `change-tracker.jsonl` is listed as future surfacing).

## Constraints honored
- NEVER destructure pi `Theme` methods (class with `this.fgColors`); call method-style — `tests/stream-theme-class-theme.test.ts` + `tests/render/real-theme-parity.test.ts` guard this and must stay green.
- NEVER throw from the tracker, git ops, cross-check, or gate — always degrade.
- Backward compatible: legacy flat `filesModified` arrays accepted; non-git worktrees recorded `gitUnavailable` and unblock; phases without claims trivially pass.
- No new runtime deps; git spawns reuse `spawnSync` + `resolveTimeoutMs`; nothing cached across a phase.
- Minimal engine touch: stage bracketing via an event subscription; phase bracketing inside implementation.ts; singleton set/clear in pipeline.ts + the existing finally.

## Testing Strategy

The verification strategy is layered to match the three granularities of the feature (module → wiring → gate), with every test hermetic (fully-mocked git/agent, disk-free where possible), following the repo's vitest conventions (`vi.mock("../src/build-runner.ts")`, stub runRedCheck/runDeliverableCheck, mock renderAndWrite; `.ts` import extensions; one file per concern; naming `build-runner-<feature>.test.ts` / `implementation-<feature>-wiring.test.ts`). Local gate: `npm run typecheck` (tsc --noEmit) clean + `npm test` (vitest run) ALL green. The repo has no Rust, so there is no cargo gate (gate field reflects this).

**Layer 1 — ChangeTracker unit tests (`tests/tracking.test.ts`, AC-01/AC-02/AC-03 → SCENARIO-001..007):** `vi.mock("node:child_process", ...)` to return scripted git outputs. Assert: (a) begin captures a baseline and holds it pending; (b) created/modified/deleted classification from `diff --name-status` (A→created, M→modified, D→deleted) UNION `status --porcelain` (`??`→created, `D`→deleted, `M`→modified); (c) `claimedNotChanged` (claim file `a.ts` created; git shows no `a.ts`) vs `changedNotClaimed` (git shows `b.ts` modified; agent didn't report) split correctly; (d) git-unavailable (mock throws / non-zero exit / non-string stdout) → record `{gitUnavailable:true}`, `verdict:"git-unavailable"`, method returns without throwing, no block; (e) conservative parse — ambiguous/unavailable parse leaves `claimedNotChanged` empty (no false failure, SCENARIO-006); (f) begin/end bracketing emits BOTH a `start` and an `end` jsonl line; (g) append-only — multiple `end` events produce multiple lines, nothing overwritten; (h) `dedupePreservingOrder` reuse collapses a path present in both committed-diff and porcelain to one entry at first-seen position.

**Layer 2 — Parsing + prompt-contract + singleton tests (`tests/structured-changes.test.ts`, AC-05/AC-06 → SCENARIO-010..012):** (a) `parseStructuredChanges` reads `{filesCreated,filesModified,filesDeleted}` and normalizes a legacy flat `filesModified` array (created/deleted empty) without error; (b) snapshot assertions that `buildImplementPrompt` and `buildFixPrompt` end with the structured-set contract line and the cross-check warning text; (c) the flat summary `filesModified[]` derivation unions created+modified and excludes deleted; (d) singleton lifecycle — `setActiveTracker(t)` then `getActiveTracker()===t`; after `setActiveTracker(null)` (the finally path) a second call returns null (no leak, SCENARIO-010), and a stale singleton is discarded when a fresh one is set mid-run.

**Layer 3 — Bracketing wiring test (`tests/tracker-bracketing.test.ts`, AC-04 → SCENARIO-008/009):** run a tiny synthetic pipeline of ≥2 task() stages plus the implementation stage (mocked agents that touch a temp git worktree via the real spawnSync, or assert on emitted jsonl via a tracker pointed at a temp specDir). Assert `change-tracker.jsonl` contains `stage-start`+`stage-end` for EVERY stage AND `phase-start`+`phase-end` for the implementation stage, in correct nested order (`stage-start → phase1-start → phase1-end → phase2-start → phase2-end → stage-end`). This validates the event subscription seam and the implementation.ts bracket placement without depending on a full real run.

**Layer 4 — changeGate regression tests (`tests/implementation-crosscheck-gate.test.ts`, AC-07/AC-08 → SCENARIO-013..017):** mirror `tests/implementation.test.ts` / `build-runner-deliverable-check.test.ts`. `vi.mock` the build-runner (stub `runRedCheck`→"unknown", `runBuildGate`→{pass:true}, `runDeliverableCheck`→{pass:true}) so the ONLY variable is the changeGate. Scenarios: (a) **false-green killer** — phase returns `claimed:{filesCreated:["x.ts"]}` but git shows NO new file → `changeGate.pass === false` → phase NOT green even though build+deliverable pass (SCENARIO-013, AC-08); (b) `changedNotClaimed` only (agent under-reported, git shows extra edits) → `changeGate.pass === true`, advisory logged, phase green (SCENARIO-014); (c) `claimedNotChanged` fed into the next implementer attempt under `## Claimed changes not present in git — actually create/wire these`, respecting `MAX_ATTEMPTS`, and a fix on retry → green (SCENARIO-015); (d) no claimed changes → trivial pass (SCENARIO-016); (e) `gitUnavailable` → `changeGate.pass === true`, no throw, no block (SCENARIO-017).

**Layer 5 — Spec-10 bridge test (`tests/implementation-deliverable-bridge.test.ts` or extend the existing deliverable-wiring test, AC-09 → SCENARIO-018):** assert `claimed.filesCreated` is UNIONed into `requireFiles` before `runDeliverableCheck` is invoked (a created file that does not exist → deliverable miss), and that spec-declared `requireFiles` still independently catch an omitted file (no circular double-count). Add the `📝 N files changed (C/M/D)` summary-line assertion here too (AC-10 → SCENARIO-019).

**Layer 6 — Non-regression (AC-11 → SCENARIO-020):** `npm run typecheck` clean; `npm test` all green with the existing 1120 tests untouched plus the new files above. Specifically confirm no regression to: runRedCheck wiring, runDeliverableCheck + cache reset, npm in-scope classification, scope-aware cargo gate, themed live stream, mid-run input injection (the `activeRun` singleton coexists with `activeTracker`), the dashboard widget, and real-theme parity (`tests/stream-theme-class-theme.test.ts`, `tests/render/real-theme-parity.test.ts` stay green — pi `Theme` called method-style, never destructured). A grep audit that no code added a destructured `Theme` method call closes the theme-parity constraint.

**Coverage matrix:** SCENARIO-001/002/003/004 → Layer 1 (AC-01); SCENARIO-005/006 → Layer 1 git-unavailable + conservative parse (AC-02); SCENARIO-007 → Layer 1 bracketing + append-only (AC-03); SCENARIO-008/009 → Layer 3 (AC-04); SCENARIO-010 → Layer 2 singleton (AC-05); SCENARIO-011/012 → Layer 2 prompts/parse (AC-06); SCENARIO-013 → Layer 4(a) (AC-08); SCENARIO-014/015/016/017 → Layer 4 (AC-07); SCENARIO-018 → Layer 5 (AC-09); SCENARIO-019 → Layer 5 summary (AC-10); SCENARIO-020 → Layer 6 (AC-11). All 20 scenarios and 11 ACs covered; uncovered = 0.

## BDD Scenario References

- SCENARIO-001
- SCENARIO-002
- SCENARIO-003
- SCENARIO-004
- SCENARIO-005
- SCENARIO-006
- SCENARIO-007
- SCENARIO-008
- SCENARIO-009
- SCENARIO-010
- SCENARIO-011
- SCENARIO-012
- SCENARIO-013
- SCENARIO-014
- SCENARIO-015
- SCENARIO-016
- SCENARIO-017
- SCENARIO-018
- SCENARIO-019
- SCENARIO-020

## Deviations from implementation

The implemented behavior matches the spec's enforcement contract (claimedNotChanged hard-fails AND-ed into phase-green; changedNotClaimed advisory; git-unavailable never blocks; never-throws; append-only jsonl; structured-change contract; spec-10 bridge). Two refinements were introduced during the code-review round. Both are conservative, fully test-covered, and do not change the false-green-killing semantics.

### Deviation 1 — Phase end split into `probeEnd` + `commitEnd` (the phase bracket closes once)

- **Original text (spec §Core component API + §Bracketing EVERY phase):** a single `end(unit, id, claimed?)` method, called once after the phase attempt loop with the structured changes parsed from the last implementer control. The phase bracket was `begin("phase", phaseId)` before the loop → `end("phase", phaseId, claimed)` after the loop.
- **Changed text:** phases use a two-call end path: `probeEnd("phase", phaseId, claimed?)` is called at the end of **each attempt** (it computes the freshest cross-check and stashes the record in an internal last-record map but does **not** persist to jsonl), then `commitEnd("phase", phaseId)` is called **once** after the attempt loop to persist exactly the final record. Stages still use the single `end("stage", id)` path unchanged.
- **Reason:** the gate (`computeChangeGate`) must read a cross-check on every attempt to drive the retry loop, but the spec's single-`end` design would either (a) compute the cross-check only on the final attempt — losing the per-attempt false-green signal that feeds `## Claimed changes not present in git` — or (b) persist one jsonl record per attempt, producing duplicate/overlapping phase-end lines that muddle the bracket trace. `probeEnd`/`commitEnd` gives every attempt a fresh cross-check **and** keeps the jsonl trace to exactly one phase-end record per phase (correct nesting: `stage-start → phase1-start → phase1-end → … → stage-end`). Surfaced by code review (finding CR-MED).
- **Impact:** none to the false-green contract or the jsonl record shape (the persisted record is identical to what the spec's single `end` would have produced on the final attempt). New test surface: the synthetic-pipeline bracketing test and the gate regression test assert both the per-attempt probe and the single commit.

### Deviation 2 — `computeCrossCheck` normalizes paths before matching (path-variant claims no longer false-red)

- **Original text (spec §Core component `end()` + SCENARIO-013):** the cross-check used exact string equality — `claimedNotChanged = (claimed.filesCreated ∪ claimed.filesModified) \ gitActual.{created ∪ modified}`.
- **Changed text:** matching now runs both sides through a pure `normalizeTrackerPath(p)` (backslash → POSIX `/`; collapse `//`; strip a leading `./`; strip a leading `/`; strip a trailing `/`; case-preserving) before the set difference, while the **output arrays still carry the original (un-normalized)** claim/git strings so retry prompts stay actionable.
- **Reason:** without normalization an LLM claim like `./src/x.ts`, `src//x.ts`, `src\x.ts`, or `/src/x.ts` would be spuriously flagged `claimedNotChanged` against git's repo-relative `src/x.ts`, producing a false-red `changeGate` FAIL on a legitimate phase (the exact opposite of the conservative posture the spec mandates in SCENARIO-006). Surfaced by code review (finding CR-HIGH).
- **Impact:** none to the clean-path cases (clean POSIX repo-relative paths normalize to themselves — the 33 `tracking.test.ts` cross-check cases are unchanged). Adds robustness against path-variant agent output without weakening the claimed-but-not-done killer.

### Non-deviations (confirmed against code)

- Stage bracketing via the `ctx.events` "stage" subscription seam in `src/workflow.ts` (minimal-touch, no nodes.ts/pipeline.ts internals edited) — exactly as the spec's PREFERRED path.
- `setActiveTracker` wired in `src/pipeline.ts` at the `state.setup`-finalized point with a stale-discard guard; `setActiveTracker(null)` in `src/extension.ts` `execute()` `finally` adjacent to `setActiveRun(null)` — mirrors `activeRun` exactly.
- `computeChangeGate` co-located in `src/build-runner.ts` with the other gates; signature `{pass: boolean; claimedNotChanged: string[]}`, `pass === false` iff `rec && !rec.gitUnavailable && (rec.crossCheck?.claimedNotChanged?.length ?? 0) > 0`, never throws.
- Structured-change contract in `buildImplementPrompt`/`buildFixPrompt` (`filesCreated`/`filesModified`/`filesDeleted` + the cross-check warning); legacy flat `filesModified` arrays tolerated by `parseStructuredChanges`.
- spec-10 bridge: `claimed.filesCreated` UNIONed into `deliverables.requireFiles` before `runDeliverableCheck`; spec-declared `requireFiles` remain independent (no circular double-count).
- Zero new runtime deps; git spawns reuse `spawnSync` + `resolveTimeoutMs` via the `gitSpawn(argv)` helper.
