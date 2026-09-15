# External State Store — decoupling super-dev state from the content tree

Status: draft — grill round 2 (2026-09-15, glm-5.3) verdict NOT-READY(conditional) folded in full (4 HIGH + 6 MED + 5 LOW + 1 DRIFT). Architecture (Option A, pure-function location, class-driven durability) stood; the class audit, migration policy, wave scoping, and geometry guard were corrected. Derived from 062-temporal.md L1 + the 2026-09-15T08-13-05-056Z incident class (v0.4.3) + the $59 orphaned-worktree incident (2026-09-13). Owner decision recorded: **Option A** — external store under `~/.super-dev/state/`, namespaced `<project-key>/<spec-id>/` so two projects sharing a spec id never collide.

Lineage: 062-temporal.md (L1) → this spec. Sibling: 058-cross-phase-contract-architecture (protection/rollback), 059-reviewer-quality-architecture (reviewer surface). This spec touches the **storage layer** those two operate over; it does not change their logic.

---

## 0. The two incidents, one root cause

| Incident | Symptom | Root cause |
|---|---|---|
| 2026-09-15T08-13-05-056Z (v0.4.3) | resume cache truncated; resume replays converged stages live | state files lived **inside the content tree**, so `git add -A` snapshotted them and every `reset --hard` reverted them |
| 2026-09-13, $59 orphaned worktree (observation 4ec574223a96) | a partial run's spec dir existed only inside its unmerged `.worktree/`; `findResumableSpec` scans only the main checkout → fresh run redid the whole chain | state was **bound to a tree that can be deleted** |

Both are the same defect from opposite directions: **durability of state is coupled to the lifetime of a tree whose purpose is to be rewound and deleted.** v0.4.3 made git *ignore* the state; it did not move it out of reach. Temporal's Event History cannot commit this class at all because it lives in an external persistence store. This spec gives super-dev that property.

---

## 1. First-principles decomposition

State files are not uniform. Their **regenerability** determines what external storage must guarantee for them. Audited across all 25 `neverGitTracked` basenames:

### Class R — Regenerable / fail-soft (14 files)
Lose them → the next stage degrades gracefully or rebuilds from artifacts. **Safe to externalize with no durability promise beyond best-effort.**

- `.knowledge.json` — **derived**: rebuilt from stage control objects; the pipeline extracts fields into prompts (agents never read the file; `knowledgeForAgent` returns `""` on missing file = empty slice, run continues)
- `run-metrics.jsonl`, `tool-usage.jsonl`, `usage-calls.jsonl`, `audit.jsonl`, `events.jsonl` — telemetry; sigma-bands/usage-report re-derive
- `change-tracker.jsonl`, `implementation-evidence.jsonl`, `research-assists.jsonl` — derived from git/events
- `routing-epoch.json`, `artifact-revisions.json`, `test-runner.json` — caches over artifacts
- `.inherited-red.jsonl`, `.environment-faults.jsonl` — derived from review outcomes

*(Reclassified out of R by grill round 2, H3: `replan-requests.json` and `routing-journal.jsonl` moved to Class M below — they carry control authority, not derived caches.)*

### Class M — Memoized / control authority, NOT regenerable (6 files) — **the incident class**
Lose them → real money or lost control authority. These are the entire point of the external store.

- `.resume-cache.jsonl` — memoized agent-call results (v0.4.3: 32 rows = the phase-commit snapshot; rows after it destroyed)
- `.convergence-ledger.json` — round-by-round convergence history (judge budgets, route-backs)
- **`replan-requests.json`** (grill H3: was Class R — WRONG) — carries the replan **rounds budget** (`file.rounds >= maxReplanRounds()` gate), fingerprint dedupe with addressed-at suppress-vs-regression semantics, `priorReplanConstraintBlock` (hard constraints for the spec writer), and **`ownerStage:"human"` pending rows** — the HITL deferred list (M10/F-06: "the HITL boundary lost its deferred list" when the write fails). Losing it re-arms replan budgets and destroys the operator's deferred decisions. The human rows are H-grade.
- **`routing-journal.jsonl`** (grill H3: was Class R — WRONG) — persisted **control authority**, not a cache: loop budgets are "read from THIS journal via `budgetFromJournal` — **never** from process-local counters" (journal.ts header, MP1 — exists precisely so "a resume cannot silently re-arm the budget"). Losing it changes loop bounds.
- `.replan.jsonl`, `.judge.jsonl` — append-only audit with **no read path found** (grill H3: `REPLAN_AUDIT_FILE` only ever appended; judge budgets in-memory, reset per run). Retained in M as audit-evidence protection — over-protection is harmless; DEC-3 demands true labels, so the implementation census re-verifies and may demote them to R if no reader materializes.

### Class H — Human input, NOT regenerable (3 registry basenames + the `user-input/` assets directory)
Lose them → the operator's own words are gone. Highest GC protection.

- `.user-notes.json` — the operator's mid-run notes
- **`user-input/` assets stay IN-TREE** (grill M3 ruling): agents receive **relative** attachment paths (`user-input/<note>-image-1.png`), and `persistImage` deliberately keeps prompts free of absolute/host paths (D-4). Moving the directory external orphans every in-flight prompt reference; rewriting to absolute external paths violates that design. Only `.user-notes.json` externalizes; the assets remain in the spec dir, excluded from git. Class-H durability for them = the existing tree, not the external store.
- `messages.jsonl` — role-to-role bus; **double-written** to `events.jsonl`, so partially recoverable, but the bus file is the canonical read path
- `.task` — the task string the run was launched with

### Class E — Ephemeral (2 files)
- `.run-lock` — cross-session lock (externalizing it actually *improves* lock visibility)
- `.complete` — terminal marker

**Rendered `*.md` reports are NOT state** — they stay tracked in the spec dir (they re-render from cached controls on every replay; the evidence trail must ride the commits).

---

## 2. Research grounding

- **Temporal** (062): Event History is an append-only log in an external persistence store, owned by the History service; workflow content lives elsewhere. No single tree, no `git add -A`, no operation that rewinds one and hits the other.
- **Cursor** (062 §7): decouple agent loop / machine state / conversation state; conversation layer is append-only with **retry-rewind** streaming. Externalizing is the same decoupling, one level down.
- **Bazel hermeticity** (058): outputs must not depend on machine-local untracked scratch. External state under `~/.super-dev/` already follows the machine-state convention (`config.json`, `learned.md`, `evals/`, `traces/`, `runs/`).

---

## 3. Architecture

### 3.1 Location — a pure function, no pointer file

```
~/.super-dev/state/<project-key>/<spec-id>/
```

- **`<project-key>`** = `slug(basename(repo-root)) + "-" + shortHash(abs(git-common-dir))`. Derived from `git rev-parse --git-common-dir` **resolved to absolute** (raw output can be relative like `../../.git`), then `dirname`, **then `realpath`-canonicalized** (grill M5: without it, the same repo reached via two textual roots — a symlink, or macOS `/System/Volumes/Data/...` vs `/Users/...` — silently **splits** state into two keys, which is exactly the wrong-but-silent failure §3.1 exists to eliminate). **Git-resolution failure is fail-closed** (grill M5: a fail-open default would merge distinct repos into one key — catastrophic; on failure we refuse to derive a key and fall back to in-spec behavior with a loud error, never guess). Verified: a linked worktree's `--show-toplevel` differs from the main checkout, but its `--git-common-dir` resolves to the **same** `.git` — so all worktrees of one repo share one project key, and two repos with the same basename are split by the hash. This reuses the v0.4.3 common-dir lesson verbatim. *(Known wart, accepted: submodules' `dirname(abs(common-dir))` degenerates to `.git/modules`-shaped roots — slug ≈ "modules", keys ugly but collision-free via the hash.)*
- **`<spec-id>`** = the existing `specIdentifier` (e.g. `26-capability-backend-substrate`).
- **No pointer file in the spec dir.** Location is a pure function of (repo, spec-id) → **no pointer-drift bug class** (the anchor-superseding family 058/059 spent two waves on). The user's collision concern is handled by the two-part key, not by registration.

In-place runs (no worktree): the same derivation from the repo's own common dir — one key, same as the main checkout.

### 3.2 Resolver — one choke point, ALL resolution forms, ~25 sites

**Step 0 — literal consolidation (grill H1/M1, must precede the redirect).** The basename registry is *not yet* the single source of truth: local string literals exist at `resume.ts:16`, `replan/replan.ts:39-41` (`RESUME_CACHE_FILE` etc.), and `setup.ts:777-779` (an **inline** `.resume-cache.jsonl` literal in the M11 stale-cache truncation, bypassing the `resumeCachePath` funnel). D-S-B begins by routing every literal through `harness-paths.ts`; only then is the registry authoritative.

**Step 1 — census grammar (grill M1: the sites are right in count, wrong in form).** A census keyed only on `join(specDir, B)` silently misses real sites → split-brain. The census must enumerate ALL observed forms:
- plain `join(specDir, B)` — the majority
- **string concatenation** — `runlog.ts:103-105` (`${specDir}${RUN_LOG_FILENAME}` on the trailing-slash branch); `convergence-ledger.ts` (`${base}${CONVERGENCE_LEDGER_FILE}` **plus a `.tmp` sibling**, and a `.task` reader via concat — a `.task` reader outside setup.ts)
- **nested directory trees** — `user-notes.ts` `outputImagePath` builds `join(specDir, "user-input", <file>)` (stays in-tree per the M3 ruling, but must be *enumerated* so the census proves it)
- **containment-guarded resolution** — `plan-feasibility.ts:447` `resolveInsideWorktree(...)` (returns `null` on escape — the fail-closed null semantics must survive the redirect)
- **cwd-normalizing joins** — `replan/replan.ts:119-122`, `team/messages.ts:39-41`
- **trailing-slash trims** — `protection-interval.ts:94`

**Step 2 — the choke point matches its call sites (grill M2).** Most sites hold only `specDirectory`, not `(worktreePath, specId)`. The public surface is therefore:

```
src/state/state-root.ts
  projectStateRoot(specDirectory)          → ~/.super-dev/state/<project-key>/   (repo resolved FROM the spec dir)
  stateFileFor(specDirectory, basename)    → single replacement for every resolution form above
```

`(worktreePath, specId)` decomposition stays internal — inverting `worktree/docs/specifications/<id>/` (two layouts, trailing-slash variance at `setup.ts:757`) in *each caller* would recreate the per-site drift class the registry exists to kill.

**Step 3 — reader-sweep gate (grill mandate 4):** a mechanical src-tree grep for every read of each externalized basename (including indirect/variable-built paths) is a D-S-B acceptance gate, pinning the census against future drift.

Test hermeticity: `SUPER_DEV_STATE_DIR` env override (mirrors the existing `SUPER_DEV_NO_CONFIG_ENV` / `/tmp/spec` pinning pattern). Tests that currently build a spec dir in a temp repo redirect the state root to a temp dir.

### 3.3 What stays in the spec dir

Rendered `*.md` reports (`escalation-report.md`, `stagnation-report.md`, `usage-report.md`, `completion-audit.md`, `eval-report.md`) + the actual spec artifacts (requirements/bdd/design/spec docs). These are **content**: they ride phase commits, they re-render from cached controls, and they are the human-readable evidence trail.

**Side benefit — v0.4.3 shrinks.** The committer's exclusion set and the `info/exclude` writes drop from 25 basenames to the ~5 rendered reports that remain in-tree (plus `user-input/` per the M3 ruling). The registry role `neverGitTracked` splits into `stateExternal` (trivially never tracked — they're not in the tree) and `renderedReport` (still needs exclusion). `runtime-state-git.ts` keeps its untrack logic for the residual in-tree set + back-compat with pre-wave worktrees.

**Geometry guard (grill H4 — blocker).** "`stateExternal` … never tracked because they're not in the tree" is **false for repos rooted at (or containing) `$HOME`** (dotfiles repos, `git init ~`): then `~/.super-dev/state/**` sits *inside* the worktree, `git add -A` snapshots it, and `reset --hard` reverts it — the v0.4.3 incident class resurrected **on the new store**, precisely after D-S-C dropped these basenames from the exclusion set. Ruling: setup runs a containment check (`stateRoot` inside repo root ⇒ keep the exclusion covering the state subtree AND emit a loud P10 warning; the external-location benefits that survive — orphan visibility, worktree-death durability — still hold, since exclusion prevents tracking). D-S-E pins this with a dotfiles-repo fixture.

### 3.4 Migration (one-time, at setup) — lock-aware, mtime-aware, crash-safe

On setup, for each external-state basename: if the external path is absent but the in-spec file exists → move it once. Idempotent. **The move is `rename` with an EXDEV fallback** (grill M5: the repo tree and `~/.super-dev` can be on different filesystems — `renameSync` throws `EXDEV` and, in a best-effort culture, migration would silently never complete; the fallback is copy → fsync → verify byte-equality → delete source).

**Both-present conflict: mtime/content decides, NOT external-wins (grill H2 — the original policy re-created the v0.4.3 loss class).** In the version-flip window, an old-code run mid-flight keeps appending to the in-spec file *after* a new-code setup migrated it — the in-spec leftover is then the **newer** file, and "external is authoritative" would discard real memoized money. Ruling: newest-mtime wins (tie → byte-comparison; still tied → refuse with a loud P10 error naming both paths, never silent merge, never silent discard).

**Migration precondition: no live holder in EITHER lock location (grill H2).** Mutual exclusion breaks across the version boundary — the old-code run holds the in-spec `.run-lock` (`acquireRunLock`, `setup.ts`), the new-code run takes the external one; neither blocks the other → two live writers on one store. Migration therefore checks both lock locations and refuses (with a named, actionable error) if either is held.

**Same-repo-same-spec concurrency ruling (grill H2 — deliberate behavior change, stated).** Today two worktrees of one repo running the same spec-id have **isolated** spec dirs; after 063 they **share** `~/.super-dev/state/<project-key>/<spec-id>/`. A fresh non-resume re-entry's `clearKnowledge`/`clearUserNotes` (`setup.ts:788-789`) and stale truncation (`:777-779`) would wipe a concurrently running sibling's state. Ruling: the externalized `.run-lock` serializes same-spec runs — previously-parallel duplicate-spec runs now **hard-fail** with a clear message instead of silently racing. That is the correct trade: silent cross-run destruction is the incident class; refusing parallelism on an identical spec-id is a workflow cost, not a correctness one. (Distinct spec-ids in the same repo remain fully parallel.)

Pre-wave runs: the in-spec files exist; migration moves them; the run continues against the external store.

### 3.5 Reconciliation + GC (orphan detection, not silent loss)

A setup-time sweep over `~/.super-dev/state/*/*`:
- state dir exists, matching spec dir **absent** → **orphan**: log it by name (P10), do not delete. This is the $59 incident made *visible* instead of invisible. An orphaned run can in principle be re-attached to a restored worktree.
- `.complete` older than the retention window (config, default conservative: 30 days) → eligible for archival, never auto-deleted below the floor.
- `.run-lock` with no live session and stale mtime → release.

**Honest limitation (non-goal §6), refined by grill L3:** external state does not make a run resumable after its *content* tree is gone — resume needs both. What it fixes is "state died"; what it gains is "the orphan is named and recoverable" instead of "silently lost." One refinement: when the spec **branch** survived (the worktree dir was deleted but `createOrReuseWorktree` can re-create it), D-S-D's external scan + worktree re-creation makes the orphan **resumable** — slightly more than "visible, not resumable." When neither branch nor tree survived, it is visible-only. Both cases stated; no over-promise in either direction.

**Layout re-check at the external scan (grill M4).** `isResumable(specDir)` reads the cache; once external, it returns true regardless of which layout's spec dir was passed. The N1-CROSS-LAYOUT-REUSE guard (`findReusableSpec`, "only tracks whose recorded layout matches … are eligible") currently holds because the scan is a per-layout tree readdir — but D-S-D's new external scan feeds candidates whose *content* may live in the other layout. D-S-D therefore re-checks layout/content at the external scan (the cached controls' stage keys must exist as artifacts in the candidate spec dir) before surfacing a resume candidate.

---

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1** Option A (external `~/.super-dev/state/`), key `<project-key>/<spec-id>` with the common-dir-derived project key. Rejected: B (worktree-local) — still exclusion-reliant and orphans on worktree death; C (pointer reconciliation) — reintroduces the pointer-drift class for no gain, since location can be a pure function.
- **DEC-2** No pointer file. Location is a pure function of (repo, spec-id). Trade: cannot relocate state without a migration — acceptable, relocation is not a use case.
- **DEC-3** Class-driven durability: Class M and H get durability guarantees and GC protection; Class R is best-effort/fail-soft; Class E is ephemeral. One store, per-class semantics documented in the registry, not two stores.
- **DEC-4** Rendered `*.md` reports stay tracked in the spec dir. They are content/evidence, not state.
- **DEC-5** `.knowledge.json` moves external as Class R. It is derived from stage control objects and the pipeline re-injects from it; a missing file degrades to empty knowledge slices, it does not break the run. (Answer to the open question: externalizing it is safe precisely because agents never read the file — `knowledgeForAgent` returns `""` on missing.) **Correction (2026-09-15):** `knowledgeForAgent` is the sole *agent-facing* reader, but the **engine** also reads the file in two places — `protection-interval.ts:94` (`join(...)` with trailing-slash trim) and `plan-feasibility.ts:447` (`resolveInsideWorktree(...)` — containment-guarded, **returns `null` on escape**; that fail-closed null semantic must survive the redirect, grill L2). Both are state-resolution sites **must be redirected by D-S-B**; they are not a counterexample to externalization, just two more sites the census has to include. **Scope caveat (grill L5):** "fail-soft" is true for prompt slices but not for protection semantics — a lost file zeroes Check-3 `amendmentFamily` exemptions (fail-closed), which over-arms protection: strike-1 would revert owner-approved edits until the family is re-declared. Rebuild-on-replay is real (`appendToKnowledge` after each render) but depends on the Class-M resume cache surviving. Net: losing it costs money and re-armed protection, not correctness — Class R with teeth.
- **DEC-6** Test hermeticity via `SUPER_DEV_STATE_DIR` env override; no test touches the real `~/.super-dev`. (Precedent: `SUPER_DEV_NO_CONFIG_ENV` pinning after the config-broke-tier-tests incident.)
- **DEC-7** GC is detect-and-report first, delete never-below-floor. Orphans are named in the log, never silently cleaned.
- **DEC-8** `runtime-state-git.ts` is retained for the residual in-tree set (rendered reports) and back-compat untracking; it is not deleted by this wave.

---

## 5. Delta requirements

- **D-S-A state-root module** — `src/state/state-root.ts`: `projectStateRoot` / `specStateDir` / `stateFile` with the common-dir-derived project key, `SUPER_DEV_STATE_DIR` override, memoized git resolution (the superDevEnv 1-entry mtime cache precedent).
- **D-S-B resolver migration** — literal consolidation first (§3.2 step 0), then the full census grammar (§3.2 step 1: plain join, string concat, `.tmp` siblings, nested trees, containment-guarded, cwd-normalizing, trailing-slash trims), then the redirect to `stateFileFor(specDirectory, B)` site-by-site, with the mechanical reader-sweep grep as the closing gate (§3.2 step 3).
- **D-S-C registry split** — `harness-paths.ts`: `neverGitTracked` → `stateExternal` ∪ `renderedReport`; the committer exclusion set and `info/exclude` derive from the union (contract unchanged, membership shrinks).
- **D-S-D migration + reconciliation** — setup moves in-spec state once (lock-aware, mtime-aware, EXDEV-safe per §3.4); sweep names orphans; `findResumableSpec` gains an external-state scan **with the layout/content re-check (§3.5)** so a run whose spec dir is only in an unmerged worktree is still discoverable — and correctly so.
- **D-S-E acceptance gates** — deterministic unit/fixture tests only (the 059 convention): pure-function location derivation (linked-worktree key equality, same-basename repos split, relative common-dir, **realpath canonicalization of aliased roots**), migration idempotency **and the mtime/conflict matrix (newer-in-spec wins; ties refuse loudly)**, orphan detection fixture, **the dotfiles-repo geometry fixture (state root inside repo root keeps exclusions + warns, grill H4)**, and a **reproduction of the v0.4.3 incident passing on the new store** (tracked-file-equivalent: a `reset --hard` cannot reach `~/.super-dev` — asserted by attempting it in a real-git fixture; "by construction" holds only outside the H4 geometry, which the same suite covers).

---

## 6. Non-goals

- **Multi-machine sync.** `~/.super-dev` is machine-local; state does not cross machines. Tar-the-worktree portability is explicitly given up (the trade for class elimination).
- **Content-tree resumability.** External state does not rescue a run whose *content* tree is deleted; it makes the orphan visible (DEC-7), not the run resumable.
- **No change to 058/059 logic.** The protection-interval, checkpoint-rollback, contract-inventory, and reviewer-slice machinery operate unchanged over the relocated state.
- **No new infrastructure.** No DB, no server. A directory with per-class semantics — the Temporal *principle*, not the Temporal *machinery* (shards, task queues, sticky execution are irrelevant at single-machine scale; 062 §9).
- **Not moving the node algebra or convergence governor.**

---

## 7. Waves sketch

- **Wave S1 = D-S-A + D-S-C + D-S-E** — the resolver, the registry split, and the gates, with `.resume-cache.jsonl` (the Class M head) as the live proof — **migrating ALL of its touchers atomically (grill H1)**: `resume.ts` (the `resumeCachePath` funnel), `setup.ts:777-779` (the M11 stale-cache truncation's inline literal), `replan/replan.ts` (`RESUME_CACHE_FILE` + `invalidateResumeCache` + `resumeCacheHasRowsFor` through its own `specPath()` resolver), and `pipeline.ts:50` (`clearResumeCache`). Partial migration is unsound: redirecting only `resume.ts` leaves `invalidateResumeCache` reading the absent in-spec path → 0 rows dropped → the B6 guard ("invalidation that dropped 0 rows while matching rows exist is a FAILURE") passes **vacuously** → replan restarts replay a stale judge/downstream suffix from the external cache. Same shape for M11: fresh re-entries would mix occurrence keys with a dead run's rows. S1 therefore = the basename's full toucher set, not "one module." Deterministic tests only.
- **Wave S2 = D-S-B remainder + D-S-D** — the remaining ~24 sites and migration/reconciliation/findResumableSpec. Largest diff, lowest risk per site (pure directory-argument swap).
- **Sizing note:** S1 is spec-sized (like 058 P1); S2 is mechanical but wide. Splitting them keeps the invariant change reviewable separately from the bulk rename, per the 059 R1A/R1B precedent.

---

## 8. Feature ownership & decoupling (2026-09-15)

This doc is the **only SPEC** of the four (060/061/064 are references). It owns
the entire state-relocation feature family. Boundaries:

- **OWNS:** external state location, the `stateFileFor(specDirectory, basename)` choke point, the registry
  split (`stateExternal` ∪ `renderedReport`), migration + orphan reconciliation,
  and the `findResumableSpec` external scan. Deltas D-S-A … D-S-E.
- **Does NOT own:** the two `.knowledge.json` **engine** readers' *semantics*
  (Check-3 amendmentFamily exemption logic stays in `protection-interval.ts` /
  `plan-feasibility.ts`) — 063 only relocates the file they read.
- **Does NOT own:** communication-channel semantics (`messages.jsonl` bus
  protocol, threading, double-write to the event ledger) — that is `060`'s
  reference scope. 063 owns only where the bus file *lives* (Class H).
- **Does NOT own:** reviewer/writer prompt content or the eval layer.

**Sequence slots (see INDEX.md § Feature ownership):** this doc's own waves are
the first two implementable units — S1 (resolver + registry split + gates, with
`.resume-cache.jsonl` and its full toucher set migrated as live proof) then S2
(the remaining resolution sites, including the two `.knowledge.json` engine
reads, + migration + reconciliation + `findResumableSpec`). Per INDEX (the
authority on cross-doc sequencing, per grill M6): nothing in 060/061/064 is
implementable before S2 lands **except the 060-derived guardrail-scope audit,
which is test-only**; the 061/064-derived candidates consume relocated state
and wait for S2.
