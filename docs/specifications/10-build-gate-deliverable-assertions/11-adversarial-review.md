# Adversarial Review: Adversarial Review — Per-Phase Deliverable Assertions (build-gate deliverable contract)

- **Date**: 2026-07-21
- **Reviewer**: super-dev:adversarial-reviewer
- **Verdict**: REJECT

---

The implementation is mostly well-built: the never-throw invariant is genuinely enforced (whole-body try/catch, exhaustive sub-check evaluation, tolerant substring-OR-regex matching), AND-semantics is wired at the single correct site (implementation.ts:184 `(gate.pass || gate.inScopePass) && deliverableCheck.pass`), backward-compat early-returns {pass:true} for absent deliverables, and the schema/normalizer/prompt layer is consistently extended. The primitive unit suite (build-runner-deliverable-check.test.ts) is thorough on the checker in isolation.

However, the review found one HIGH-severity correctness defect that directly defeats the feature's stated purpose and the regression it was built to prevent. The module-level `testListCache` (build-runner.ts:1629) is keyed by absolute `cwd` with NO invalidation. It is seeded on the first `runDeliverableCheck` call for a cwd and never refreshed — while `runDeliverableCheck` is invoked once per implementation ATTEMPT and once per PHASE on the SAME worktreePath. Because the test list is mutated by the implementation itself between those calls, a stale snapshot causes `requireTests` to report a freshly-created test as forever-missing: (a) within a phase, if attempt 1's implementer fails to add test T, the cache is seeded without T, and attempts 2–3 that correctly create T still read the stale list → phase fails despite delivering; (b) across phases, the first requireTests-bearing phase seeds the cache for the whole run, so any LATER phase whose requireTests test is created during that phase is unsatisfiable. requireFiles/requireContains/requireNotContains correctly re-read from disk each attempt, but requireTests is pinned to the first snapshot. This is a deterministic false-NEGATIVE (green-delivered phase reported not-green → early termination, allGreen=false) for exactly the multi-phase "add a named test" specs the feature targets — including the stockfan Phase-6 shape in AC-04/AC-06. SCENARIO-009 only asserts the lister spawns once; it never exercises the retry-then-create-then-pass path, so the bug is latent and uncovered (and the test actively locks in the buggy invariant). Because this will cause production pipeline failures on the feature's primary use case, the verdict is REJECT. Medium/low findings (silent requireNotContains pass on missing file; dead `ran` field never logged; unbounded process-global cache with no reset hook; deliverable-check lister spawn running even when build-gate already failed and seeding a poisoned cache) are documented below but are not REJECT drivers.

### F1: Stale module-level test-list cache makes requireTests false-negative across retries and across phases

- **Severity**: high
- **Lens**: Skeptic
`testListCache` is a process-global `Map<string,TestListResult>` keyed by absolute cwd with no invalidation (grep confirms only .get and two .set sites; no .delete/.clear/reset). `runDeliverableCheck` is called once per implementation attempt (implementation.ts:175) AND once per phase, all on the same `setup.worktreePath`. The first call seeds the cache; every later call returns that snapshot. Since the implementer CREATES tests between calls, the cache is stale by construction. Two failure modes: (a) within-phase retry — attempt 1 fails to add T, lister seeds cache without T; attempt 2 creates T correctly but deliverableCheck returns the stale list → still 'missing test: T' → MAX_ATTEMPTS exhausted → phase fails despite delivering. (b) cross-phase — Phase 1 (requireTests:[T1]) seeds the cache for the whole run; Phase N (requireTests:[TN], TN created in Phase N) reads Phase-1's snapshot → TN forever missing. requireFiles/requireContains/requireNotContains re-read disk each attempt so they recover across retries; requireTests does not. This breaks the stockfan AC-04/AC-06 regression shape (a requireTests entry for a test that must be CREATED) and any multi-phase spec where each phase adds a named test. Fix: invalidate per-attempt (key by cwd+attempt token, clear after each attempt, or re-spawn when a prior call for this cwd reported a missing test) — or simply do not cache across the per-phase retry loop. The SCENARIO-009 test asserts 'spawns at most once per cwd', which is the buggy invariant; it must instead assert per-attempt or post-mutation re-spawn.
### F2: requireNotContains silently PASSES when the target file is missing or unreadable

- **Severity**: medium
- **Lens**: Skeptic
For requireNotContains, when readForDeliverable returns !rd.ok (file missing OR unreadable), the loop emits NO missing entry — the check trivially passes. Under AND-semantics this means: if the implementer DELETES the file that was supposed to have the forbidden pattern removed, the phase goes green. The stockfan pairing masks this (requireContains on the same screen.rs would also fail), but a LONE requireNotContains on a missing/unreadable file is a silent pass with no signal in `missing` or `ran` distinguishing 'forbidden pattern absent because file is healthy' from 'forbidden pattern absent because file vanished'. Recommend either recording a 'not-contains:file-missing:<file>' note in ran, or documenting that requireNotContains MUST be paired with requireFiles/requireContains for soundness.
### F3: `ran` field is dead output — computed on every sub-check, never consumed or logged

- **Severity**: medium
- **Lens**: Minimalist
grep confirms `deliverableCheck.ran` is never read in production code. implementation.ts logs only `deliverableCheck.pass` and `deliverableCheck.missing.join('; ')` — it never logs `.ran`, unlike the sibling build-gate log on line 167 which logs `gate.ran.join(', ')`. Every other gate's `.ran` IS surfaced (verify.ts:88, stages/index.ts:54). So `runDeliverableCheck` allocates ~4+ ran-tokens per call for zero readers. Either add parity logging (`(ran: ${deliverableCheck.ran.join(', ')})`) so the audit trail is actually auditable, or drop the field. As shipped it is spec-mandated but cargo-culted dead data.
### F4: testListCache is unbounded process-global state with no run-boundary reset hook

- **Severity**: low
- **Lens**: Architect
The cache lives at module scope with no exported clear() and no eviction. The comment claims 'vi.resetModules() (or process exit) clears it' — true for the vitest process model, but if super-dev is ever invoked as a library, embedded in a long-lived process, or run in watch mode, stale lists from a PRIOR pipeline run leak into the next run (interacting with F1 to amplify false-negatives across runs). Recommend exporting a `clearDeliverableCaches()` called at run start, or scoping the cache to a per-run object rather than module-global. Low severity for the current one-CLI-process-per-run model but a latent footgun.
### F5: Deliverable-check (and its test-lister spawn) runs even when the build-gate already FAILED, seeding a poisoned cache

- **Severity**: low
- **Lens**: Architect
runDeliverableCheck is invoked unconditionally after runBuildGate, including when gate.pass===false && inScopePass===false. On a broken build the `cargo test --list` / `vitest list` spawn may itself fail or return a partial/empty list, which (per F1) then poisons the cache for all subsequent attempts. Consider gating the requireTests sub-check (or the whole deliverable-check) behind `gate.pass || gate.inScopePass`, or clearing the cache entry when the spawn occurs on a build-broken attempt. Minor cost today, but it is the cache-poisoning on-ramp for F1.
### F6: SCENARIO-009 test asserts the stale-cache behavior as if it were correct

- **Severity**: low
- **Lens**: Minimalist
The cache test asserts the lister 'spawns at most once across two requireTests calls sharing a cwd' and treats that as the desired invariant. That is precisely the behavior that causes F1. The test should be reframed to assert 'at most one spawn per attempt' or 're-spawns after the worktree/test-set changes', and should add a retry-then-create-then-PASS case (call with test absent → cache seeded; create test on disk; call again → pass) which would currently fail and expose the bug. As written, the suite gives false confidence that the caching is sound.
