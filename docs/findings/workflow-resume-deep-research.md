# Workflow Resume — deep research, best solution, plan

**Date:** 2026-07-06
**Predecessor:** `workflow-resume-research.md` (feasibility). This doc goes
deeper: compares two solutions, picks the best, and lays out a concrete plan.
**Status:** research + plan, **IMPLEMENTED 2026-07-06** (awaiting a live run to confirm end-to-end fast-forward; wrapper logic + cache are unit-tested).

## TL;DR — best solution = memoized agent-call replay (Temporal-style)

Run the **same workflow code from the top**, but make `ctx.agent` a memoizing
wrapper: completed agent calls return their cached result; the first uncached
call executes for real; the workflow continues naturally. This is the
industry-standard durable-execution pattern (Temporal / DBOS / Restate:
replay the workflow with memoized activity results), applied at the one choke
point (`workflow.ts: agent()`). It is **more faithful AND cleaner** than
stage-skip: agent-call granularity (resumes mid-verify-loop, mid-phase), zero
changes to the node algebra, and graceful degradation (any determinism slip
just falls back to re-running that call — still correct).

## The two solutions compared

### A. Stage-level fast-forward skip (the feasibility-study design)
Rehydrate `PipelineState[stageId]` from `.knowledge.json`; `task()` skips stages
already populated; loops/gates **restart fresh**.

- **Granularity:** stage (coarse).
- **Cost of a mid-loop die:** the whole loop re-runs from iteration 1
  (re-spawns reviewers/re-implements phases whose code is already in git).
- **Complexity:** low-medium. Reuses `.knowledge` + the existing `task()` skip.
- **Per-stage reasoning:** each stage type needs its rehydration validated.

### B. Memoized agent-call replay (recommended)
Re-run `root.run()`; `ctx.agent` memoizes by `call.id + call-sequence`; the
audit/capture stores `{key → AgentResult}`.

- **Granularity:** agent-call (fine) — resumes at the **exact interrupted call**.
- **Cost of a mid-loop die:** zero re-spawns of completed work; resumes mid-loop.
- **Complexity:** medium. Surgical `agent()` wrapper + capture + sequence key.
- **Workflow code unchanged** — the pipeline is the source of truth; memoization is a transparent wrapper.
- **Graceful degradation:** if replay diverges (non-determinism), the cache
  misses for that call → it re-runs → still correct, just less efficient.

**Why B is best:** the failure modes that actually kill long runs are the
**verify-loop and implementation-loop** — exactly where A restarts expensively
and B resumes precisely. B's extra complexity (capture + wrapper + sequence key)
is bounded and surgical; A's per-stage rehydration logic is arguably more code
in aggregate. B also degrades to A-equivalent if determinism ever breaks.

## Mechanics that make B work (verified in code)

1. **`agent()` is the single choke point** (`src/workflow.ts`). Every LLM spawn
   flows through it; it already has `call.id` and returns `AgentResult`. A
   resume-mode wrapper there covers every stage, loop, and parallel branch
   without touching the node algebra.
2. **`AgentResult` is compact + serializable** — `{ text, control, model?, error? }`
   (`src/types.ts`). Control objects, not prompts → small cache.
3. **Call-ids are deterministic on replay** (same cached state → same branches/
   loops → same invocation order). Implementation-loop ids are already unique
   per attempt (`pipeline.implementation.phase-01.impl.a1`).
4. **Verify-loop id collision handled** — `pipeline.verify.code-review` etc.
   repeat each iteration, so the cache key is `call.id + "#" + seq` where `seq`
   is a monotonic counter incremented at each `agent()` invocation. Invocation
   order is deterministic (`parallel()` shifts from a FIFO queue in
   single-threaded JS), so `seq` matches on replay.
5. **Git worktree is ground truth for code.** The implementer's *edits* persist
   in the worktree (committed per phase). A memoized implementer call returns
   its cached *control* without re-editing — correct, because the edits are
   already on disk. Resume must **reuse the original worktree** (shared requirement with A).
6. **Setup + classify reconstruct, not memoize** — setup is deterministic
   (re-detect language, reuse worktree/spec id); classify re-runs the pure
   helper. Both happen before `root.run`.

## The plan (Solution B)

### New / changed files
- **`src/resume.ts`** (new) — `loadResumeCache(specDir): Map<string, AgentResult>`,
  `saveResumeResult(specDir, key, result)`, cache file = `<specDir>/.resume-cache.json`.
- **`src/workflow.ts`** — `agent()` becomes memoizing in resume mode: maintain a
  monotonic `callSeq`; key = `${call.id}#${callSeq}`; hit → return cached +
  `log("resumed (cached): …")`; miss → run + capture. `makeContext` takes an
  optional `resumeCache: Map`.
- **`src/setup.ts`** — resume path: if resuming, **reuse** the existing
  `.worktree/<specId>` + spec dir (don't `nextSpecNumber` / `git worktree add`);
  re-detect language; recompute the spec identifier from the target.
- **`src/pipeline.ts`** / a `resume.ts` orchestrator — on `resume`:
  reconstruct `setup` + `classify` → build initial `PipelineState` → run
  `runWorkflow(...)` with `resumeCache` loaded from `.resume-cache.json`.
- **`src/extension.ts`** — `super_dev` gains `resume: boolean | string`
  (most-recent incomplete, or a spec id); resolves the target spec dir.
- **Tests** — `tests/resume.test.ts`: capture→memoize round-trip; sequence-key
  disambiguates repeated verify-loop ids; setup-reuse; cache-miss graceful;
  corrupted-cache → fresh run.

### Resume trigger UX
`/super-dev --resume` (auto-pick most-recent incomplete spec, with a confirm) or
`/super-dev --resume <specId>`. A spec is "incomplete" if its spec dir has a
`.resume-cache.json` (or `.knowledge.json`) and no terminal "merge done" marker.

### Edge cases
- **Cache miss on replay** (determinism slip / changed code) → that call re-runs;
  subsequent calls may also miss → correct, less efficient. (B's safety net.)
- **Corrupted `.resume-cache.json`** → can't resume safely → start a fresh run
  (don't half-resume).
- **Missing worktree** (user removed it) → error with guidance; fall back to
  in-place in the original cwd.
- **Already-complete run** (merged) → resume is a no-op + message.
- **Interrupted mid-agent-call** → that call has no cache entry → re-runs fresh
  (the only unavoidable re-spawn).

### What is NOT resumed (acceptable)
- Transient control state (`__reviewSignatures`, `__stagnated`, `__feedback`) —
  recomputed as the workflow replays (gates re-evaluate against cached controls).
- The interrupted agent call itself — re-runs (no result to cache).

### Determinism contract (documented)
The workflow must avoid wall-clock/random in branch predicates. Today it does —
branches read cached state (`isBug`, `notBlocked`, `hasImplementation`, gate
validators). Resume replay will hit the same branches → same call sequence.

## Decision points (please confirm before I implement)

1. **Solution** — **B (memoized replay)** [recommended] vs A (stage-skip) vs a
   hybrid. Lean: **B**.
2. **Resume trigger** — auto-detect most-recent incomplete + confirm, or
   explicit `--resume <specId>` only, or both. Lean: **both**.
3. **Cache location/format** — `<specDir>/.resume-cache.json` (co-located with
   the run, cleared on successful completion) vs inside the audit trail. Lean:
   **`.resume-cache.json`** (simple, self-contained, easy to inspect/delete).
4. **Completion marker** — what marks a spec "done, don't resume"? Lean: the
   merge stage writes a `merge` entry to `.knowledge` (already does) → resume
   checks for it; else a `.complete` marker file.
5. **Scope of v1** — full B (agent-call resume incl. mid-loop) or B-minimal
   (resume at stage boundaries only, loops restart)? Lean: **full B** — the
   loop fidelity is the whole point, and the sequence-key makes it cheap.
6. **Parallel determinism** — confirm we assign the sequence at `agent()`
   *invocation* (FIFO queue order, deterministic) not at completion. Lean: yes.

## Effort
~1.5–2 days: resume.ts (cache) + workflow.ts wrapper + setup.ts reuse + trigger
+ tests. Low risk (graceful degradation; the workflow code is unchanged).

**Implemented (2026-07-06):** `src/resume.ts` (append-only `.resume-cache.jsonl`, last-wins load, `isResumable`/`findResumableSpec`/`specDirFor`, `createMemoizingAgent` with lazy `getSpecDir` + monotonic `callId#seq` key); `workflow.ts` `agent()` wrapped (captures always, memoizes when cache pre-loaded); `setup.ts` resume path reuses worktree + spec id and preserves `.knowledge`; `pipeline.ts` resolves the resume target (auto-pick or named), always sets a cache Map, and clears+marks-`.complete` on success; `extension.ts` gains `resume` + `resumeSpecId` params. 12 unit tests (cache round-trip, last-wins, partial-line, resumability, find, and the seq-disambiguation for repeated verify-loop call.ids). Full suite 288/288, tsc clean. **Caveat:** end-to-end "interrupt + resume + fast-forward" needs a live run to confirm (the wrapper logic is unit-tested); the determinism contract is documented and holds today.

## Prior art / why this pattern
Temporal, DBOS, Restate, Inngest all use **event-sourced replay**: the workflow
code re-executes, and each external "activity" (here: an LLM agent spawn) is
memoized from the event log on resume. Pi's own `/resume` only resumes the
*conversation*, not the pipeline, so the pipeline must own this. The original
super-dev-plugin had only `git stash` auto-checkpoint (manual, not real resume).
