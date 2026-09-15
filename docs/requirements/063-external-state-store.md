# External State Store — decoupling super-dev state from the content tree

Status: draft — awaiting grilling (living artifact). Derived from 062-temporal.md L1 + the 2026-09-15T08-13-05-056Z incident class (v0.4.3) + the $59 orphaned-worktree incident (2026-09-13). Owner decision recorded: **Option A** — external store under `~/.super-dev/state/`, namespaced `<project-key>/<spec-id>/` so two projects sharing a spec id never collide.

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

### Class R — Regenerable / fail-soft (15 files)
Lose them → the next stage degrades gracefully or rebuilds from artifacts. **Safe to externalize with no durability promise beyond best-effort.**

- `.knowledge.json` — **derived**: rebuilt from stage control objects; the pipeline extracts fields into prompts (agents never read the file; `knowledgeForAgent` returns `""` on missing file = empty slice, run continues)
- `run-metrics.jsonl`, `tool-usage.jsonl`, `usage-calls.jsonl`, `audit.jsonl`, `events.jsonl` — telemetry; sigma-bands/usage-report re-derive
- `change-tracker.jsonl`, `implementation-evidence.jsonl`, `research-assists.jsonl` — derived from git/events
- `routing-epoch.json`, `routing-journal.jsonl`, `artifact-revisions.json`, `test-runner.json` — caches over artifacts
- `.inherited-red.jsonl`, `.environment-faults.jsonl`, `replan-requests.json` — derived from review outcomes

### Class M — Memoized, NOT regenerable (4 files) — **the incident class**
Lose them → real money. These are the entire point of the external store.

- `.resume-cache.jsonl` — memoized agent-call results (v0.4.3: 32 rows = the phase-commit snapshot; rows after it destroyed)
- `.convergence-ledger.json` — round-by-round convergence history (judge budgets, route-backs)
- `.replan.jsonl` — replan rounds (owner + invalidated downstream)
- `.judge.jsonl` — judge invocation records

### Class H — Human input, NOT regenerable (4 files)
Lose them → the operator's own words are gone. Highest GC protection.

- `.user-notes.json` + `user-input/` assets — the operator's mid-run notes and pasted images
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

- **`<project-key>`** = `slug(basename(repo-root)) + "-" + shortHash(abs(git-common-dir))`. Derived from `git rev-parse --git-common-dir` **resolved to absolute** (raw output can be relative like `../../.git`), then `dirname`. Verified: a linked worktree's `--show-toplevel` differs from the main checkout, but its `--git-common-dir` resolves to the **same** `.git` — so all worktrees of one repo share one project key, and two repos with the same basename are split by the hash. This reuses the v0.4.3 common-dir lesson verbatim.
- **`<spec-id>`** = the existing `specIdentifier` (e.g. `26-capability-backend-substrate`).
- **No pointer file in the spec dir.** Location is a pure function of (repo, spec-id) → **no pointer-drift bug class** (the anchor-superseding family 058/059 spent two waves on). The user's collision concern is handled by the two-part key, not by registration.

In-place runs (no worktree): the same derivation from the repo's own common dir — one key, same as the main checkout.

### 3.2 Resolver — one choke point, ~25 sites redirect

Today state is resolved by `join(specDir, basename)` at ~25 sites across ~15 modules (resume.ts, routing/journal.ts, runlog.ts, sigma-bands.ts, fault-classification.ts, inherited-red.ts, knowledge.ts, user-notes.ts, …). The new module:

```
src/state/state-root.ts
  projectStateRoot(worktreePath)      → ~/.super-dev/state/<project-key>/
  specStateDir(worktreePath, specId)  → .../<spec-id>/
  stateFile(worktreePath, specId, basename)  → single replacement for join(specDir, B)
```

Migration is mechanical: `join(specDir, B)` → `stateFile(...)`. The **basename registry stays the single source of truth** (`harnessBasenames`); only the directory argument changes.

Test hermeticity: `SUPER_DEV_STATE_DIR` env override (mirrors the existing `SUPER_DEV_NO_CONFIG_ENV` / `/tmp/spec` pinning pattern). Tests that currently build a spec dir in a temp repo redirect the state root to a temp dir.

### 3.3 What stays in the spec dir

Rendered `*.md` reports (`escalation-report.md`, `stagnation-report.md`, `usage-report.md`, `completion-audit.md`, `eval-report.md`) + the actual spec artifacts (requirements/bdd/design/spec docs). These are **content**: they ride phase commits, they re-render from cached controls, and they are the human-readable evidence trail.

**Side benefit — v0.4.3 shrinks.** The committer's exclusion set and the `info/exclude` writes drop from 25 basenames to the ~5 rendered reports that remain in-tree. The registry role `neverGitTracked` splits into `stateExternal` (trivially never tracked — they're not in the tree) and `renderedReport` (still needs exclusion). `runtime-state-git.ts` keeps its untrack logic for the residual in-tree set + back-compat with pre-wave worktrees.

### 3.4 Migration (one-time, at setup)

On setup, for each external-state basename: if the external path is absent but the in-spec file exists → move it once. Idempotent. If both exist (partial migration) → keep external, log the in-spec leftover as a P10 discard (do not silently merge; the timestamps differ and the external one is authoritative by construction).

Pre-wave runs: the in-spec files exist; migration moves them; the run continues against the external store.

### 3.5 Reconciliation + GC (orphan detection, not silent loss)

A setup-time sweep over `~/.super-dev/state/*/*`:
- state dir exists, matching spec dir **absent** → **orphan**: log it by name (P10), do not delete. This is the $59 incident made *visible* instead of invisible. An orphaned run can in principle be re-attached to a restored worktree.
- `.complete` older than the retention window (config, default conservative: 30 days) → eligible for archival, never auto-deleted below the floor.
- `.run-lock` with no live session and stale mtime → release.

**Honest limitation (non-goal §6):** external state does not make a run resumable after its *content* tree is gone — resume needs both. What it fixes is "state died"; what it gains is "the orphan is named and recoverable" instead of "silently lost."

---

## 4. Decisions (DEC — owner-adjudicable at grill)

- **DEC-1** Option A (external `~/.super-dev/state/`), key `<project-key>/<spec-id>` with the common-dir-derived project key. Rejected: B (worktree-local) — still exclusion-reliant and orphans on worktree death; C (pointer reconciliation) — reintroduces the pointer-drift class for no gain, since location can be a pure function.
- **DEC-2** No pointer file. Location is a pure function of (repo, spec-id). Trade: cannot relocate state without a migration — acceptable, relocation is not a use case.
- **DEC-3** Class-driven durability: Class M and H get durability guarantees and GC protection; Class R is best-effort/fail-soft; Class E is ephemeral. One store, per-class semantics documented in the registry, not two stores.
- **DEC-4** Rendered `*.md` reports stay tracked in the spec dir. They are content/evidence, not state.
- **DEC-5** `.knowledge.json` moves external as Class R. It is derived from stage control objects and the pipeline re-injects from it; a missing file degrades to empty knowledge slices, it does not break the run. (Answer to the open question: externalizing it is safe precisely because agents never read the file — `knowledgeForAgent` returns `""` on missing.) **Correction (2026-09-15):** `knowledgeForAgent` is the sole *agent-facing* reader, but the **engine** also reads the file in two places — `protection-interval.ts:94` and `plan-feasibility.ts:448` (both `join(specDirectory, ".knowledge.json")`) for Check-3 `amendmentFamily` exemptions. Those are `stateFile()`-shaped resolution sites and **must be redirected by D-S-B** along with the rest; they are not a counterexample to externalization, just two more sites the ~25 count has to include.
- **DEC-6** Test hermeticity via `SUPER_DEV_STATE_DIR` env override; no test touches the real `~/.super-dev`. (Precedent: `SUPER_DEV_NO_CONFIG_ENV` pinning after the config-broke-tier-tests incident.)
- **DEC-7** GC is detect-and-report first, delete never-below-floor. Orphans are named in the log, never silently cleaned.
- **DEC-8** `runtime-state-git.ts` is retained for the residual in-tree set (rendered reports) and back-compat untracking; it is not deleted by this wave.

---

## 5. Delta requirements

- **D-S-A state-root module** — `src/state/state-root.ts`: `projectStateRoot` / `specStateDir` / `stateFile` with the common-dir-derived project key, `SUPER_DEV_STATE_DIR` override, memoized git resolution (the superDevEnv 1-entry mtime cache precedent).
- **D-S-B resolver migration** — the ~25 `join(specDir, B)` sites redirect to `stateFile(...)`. Mechanical, auditable, one module at a time.
- **D-S-C registry split** — `harness-paths.ts`: `neverGitTracked` → `stateExternal` ∪ `renderedReport`; the committer exclusion set and `info/exclude` derive from the union (contract unchanged, membership shrinks).
- **D-S-D migration + reconciliation** — setup moves in-spec state once; sweep names orphans; `findResumableSpec` gains an external-state scan so a run whose spec dir is only in an unmerged worktree is still discoverable.
- **D-S-E acceptance gates** — deterministic unit/fixture tests only (the 059 convention): pure-function location derivation (linked-worktree key equality, same-basename repos split, relative common-dir), migration idempotency, orphan detection fixture, and a **reproduction of the v0.4.3 incident passing on the new store** (tracked-file-equivalent: a `reset --hard` cannot reach `~/.super-dev` by construction — asserted by attempting it).

---

## 6. Non-goals

- **Multi-machine sync.** `~/.super-dev` is machine-local; state does not cross machines. Tar-the-worktree portability is explicitly given up (the trade for class elimination).
- **Content-tree resumability.** External state does not rescue a run whose *content* tree is deleted; it makes the orphan visible (DEC-7), not the run resumable.
- **No change to 058/059 logic.** The protection-interval, checkpoint-rollback, contract-inventory, and reviewer-slice machinery operate unchanged over the relocated state.
- **No new infrastructure.** No DB, no server. A directory with per-class semantics — the Temporal *principle*, not the Temporal *machinery* (shards, task queues, sticky execution are irrelevant at single-machine scale; 062 §9).
- **Not moving the node algebra or convergence governor.**

---

## 7. Waves sketch

- **Wave S1 = D-S-A + D-S-C + D-S-E** — the resolver, the registry split, and the gates, with exactly one migrated module (`.resume-cache.jsonl`, the Class M head) as the live proof. Deterministic tests only.
- **Wave S2 = D-S-B remainder + D-S-D** — the remaining ~24 sites and migration/reconciliation/findResumableSpec. Largest diff, lowest risk per site (pure directory-argument swap).
- **Sizing note:** S1 is spec-sized (like 058 P1); S2 is mechanical but wide. Splitting them keeps the invariant change reviewable separately from the bulk rename, per the 059 R1A/R1B precedent.

---

## 8. Feature ownership & decoupling (2026-09-15)

This doc is the **only SPEC** of the four (060/061/064 are references). It owns
the entire state-relocation feature family. Boundaries:

- **OWNS:** external state location, the `stateFile()` resolver, the registry
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
`.resume-cache.jsonl` migrated as live proof) then S2 (the remaining resolution
sites, including the two `.knowledge.json` engine reads, + migration +
reconciliation + `findResumableSpec`). Nothing in 060/061/064 is implementable
before S2 lands, because the candidate features they rationalize all consume
relocated state.
