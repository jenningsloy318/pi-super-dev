# Spec 14 — Parallelism & resume correctness

> **Status (as shipped on this branch):** Changes 3 (BUG-2/4/5/6) **and** an
> additional FatalAbort/fatal-gates feature (foundational doc gates abort the run
> honestly instead of cascading garbage — the "failed but still go on" fix) are
> implemented. Change 1 (structural cache identity) and Change 2 (parallelize
> api/ui tests) are **deferred** to a follow-up: they are safe today (no new
> parallel sites were added, so the incidentally-deterministic `seq` keying
> still holds), but they remain the keystone for future parallelism. See
> §Follow-ups. An independent code review passed (verdict: ship after the
> FatalAbort-propagation hardening, which is included).

## Problem

A deep review (cross-referenced against `vekexasia/pi-extensible-workflows` and
current multi-agent orchestration research) found several correctness gaps that
block safe parallelism. The most important: **resume cache identity is
order-dependent**, so any future parallel branch that `await`s before its
`ctx.agent` call makes resume non-deterministic (silent wrong-result cache hits).

Today the sole parallel site (`reviewStep`: code-review ∥ adversarial) is safe
*by accident* — both branches call `ctx.agent` before any await, so the monotonic
`seq` counter assigns deterministically. This is a fragile invariant, not a
guarantee, and it is the foundation everything else stands on.

## Goals (this spec)

1. **Make resume deterministic under any parallelism** (structural cache identity).
2. **Parallelize a safe stage pair** (api-test ∥ ui-test) for a free wall-clock win.
3. **Fix four correctness bugs** found in review.

## Non-goals (deferred, tracked in §Follow-ups)

- Per-branch worktrees (`withWorktree`) + `pipeline()` primitive — separate effort.
- Multi-dimensional budget (tokens/cost/duration) — separate effort.
- Change-tracker per-scope isolation (BUG-3) — latent today; the AsyncLocalStorage
  foundation added here makes the future fix straightforward.
- Sibling-cancellation aborting in-flight agents (BUG-7).
- Pipeline-tree validator (duplicate-id detection).

## Design

### Change 1 — Structural cache identity (BUG-1, keystone)

**Root cause:** `createMemoizingAgent` keys cached results as `"<callId>#<++seq>"`
where `seq` is a global monotonic counter incremented at *invocation* time, inside
concurrent workers. Invocation order is scheduler-dependent when a branch awaits
before its `ctx.agent` call.

**Fix:** thread a **structural scope path** through `AsyncLocalStorage`. Each
control-flow node that introduces a concurrent or iterated scope (`parallel`,
`map`) pushes a deterministic marker. The cache key becomes the call's
*structural position*, which is order-independent:

```
key = `${callId}@${scopePath.join("/") || "root"}#${occurrence}`
```

- `scopePath`: list of enclosing scope markers (e.g. `["parallel[0]"]`), set
  synchronously at branch **start** (before any await), so it propagates correctly
  through subsequent awaits (AsyncLocalStorage's purpose).
- `occurrence`: counter scoped to `(callId, scopePath)` — disambiguates repeated
  calls at the same structural position (loop iterations, gate re-runs), which are
  sequential within their scope and thus deterministic.

**New `StageContext` primitive:** `withScope<T>(marker, fn): Promise<T>` — wraps
`fn` in `als.run([...current, marker], fn)`. Implemented in `workflow.ts`;
`parallel`/`map` in `nodes.ts` call it around each branch/iteration body.

**Cache-format change:** key format changes from `id#seq` to `id@path#occ`. This
is an internal format (the `.resume-cache.jsonl` is not a public API). A pre-existing
interrupted run's cache simply misses on resume (correct, less efficient) — no
corruption. `resume.ts`'s `loadResumeCache` is format-agnostic (it stores whatever
key string was written), so no I/O change is needed.

### Change 2 — Parallelize api-test ∥ ui-test

`verify.ts` `testBlock` currently runs `bringup → apiTest → uiTest → teardown`
sequentially. api-test and ui-test hit **independent** running services, are
read-only w.r.t. the source tree, and write distinct state keys (`apiTest`/`uiTest`).
They are safe to run concurrently:

```ts
const testBlock = tryCatch(
  sequence([task(bringupTask), parallel([apiTestStep, uiTestStep], { tolerant: true })]),
  { finally: teardownNode() },
);
```

`tolerant: true` so a failed branch still lets the other land its result (the
integration loop's `testsGreen` already tolerates a missing `apiTest`/`uiTest`).
Resume-safety relies on Change 1.

### Change 3 — Correctness bug fixes

- **BUG-2 (`control.ts`):** the `<control>` tag regex requires *exactly one*
  trailing whitespace (`\s`) before `</control>`, so `<control>{...}</control>`
  (no trailing space) misses the primary path and only parses via the weaker
  fallback. Fix: `\s*` (zero-or-more).
- **BUG-4 (`workflow.ts` budget):** `check()` (read) then `spent()` (post-hoc
  increment) span an await, so concurrent branches can both pass `check()` before
  either `spent()`s, exceeding `maxAgents` by up to `concurrency−1`. Fix: make
  `spent()` the **atomic reservation** — it increments and returns `false` if the
  cap is hit; `realAgent` bails on `false`. `check()` stays a read-only peek for
  stage-body guards.
- **BUG-5 (`nodes.ts` map):** `map` mutates shared `state[as]` per iteration; with
  `concurrency > 1` concurrent iterations race (silent corruption). The API only
  exposes the item via shared state, so `concurrency > 1` is never safe. Fix: throw
  a clear error if `concurrency > 1`, pointing at the future per-item-arg fix.
- **BUG-6 (`nodes.ts` gate):** `state.__feedback[key]` is set on validation failure
  but never cleared on success. Latent today (gated stages run once), but stale
  feedback would re-prepend if a gated stage were ever looped. Fix: `delete` on pass.

## Acceptance criteria

- AC-1: A parallel pair of branches that each `await` a helper *before* `ctx.agent`
  resume to **identical** cached results regardless of scheduling (new test).
- AC-2: `<control>{"a":1}</control>` (no trailing space) parses via the tag path
  (new test); existing control tests unchanged.
- AC-3: `maxAgents` cannot be exceeded by concurrent branches (new test: 2 branches,
  budget 1, exactly one proceeds).
- AC-4: `map({concurrency: 2})` throws (new test); `concurrency: 1` unaffected.
- AC-5: a gate that fails-then-passes leaves `state.__feedback[key]` deleted (new test).
- AC-6: api-test and ui-test run concurrently (new test: ordering proof via timing).
- AC-7: `npm run typecheck` clean; full `npm test` suite green.

## Follow-ups (out of scope, tracked)

- BUG-3: per-scope ChangeTracker isolation (reuse the AsyncLocalStorage added here).
- BUG-7: sibling-cancellation aborts in-flight agents via the sub-signal.
- Pipeline-tree validator: recursive duplicate-`stage.id` detection (stamps `id` +
  `children` on nodes).
- `withWorktree(name, cb)` + `pipeline(name, items, stages)` primitives for safe
  parallel code-writing across isolated worktrees.
- Multi-dimensional budget (tokens/cost/duration) + per-agent accounting.
