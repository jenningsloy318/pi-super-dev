# Workflow Resume — feasibility research

**Date:** 2026-07-06
**Question:** Can a `super_dev` workflow that was stopped (crash, abort, timeout,
API error, closed terminal) be **resumed from where it left off**, instead of
re-running from scratch?
**Method:** audit what pi-super-dev already persists to disk + assess what the
node algebra can rehydrate/skip. No implementation yet.

## TL;DR — yes, feasible, medium effort

A **stage-level fast-forward resume** is achievable by reusing persistence that
**already exists today**: `.knowledge.json` (per-stage control objects), the
rendered stage docs, and the git worktree (which survives a crash). The node
algebra already has skip infrastructure (`task()` records `skipped`). No
fundamental blocker. The only thing lost on resume is **transient loop/gate
control state** (verify-loop iteration count, gate attempt count) — which
acceptably restarts fresh against the on-disk code.

## What is already persisted (the resume substrate)

| Artifact | Location | Contains | Resume use |
|----------|----------|----------|------------|
| `.knowledge.json` | `<specDir>/.knowledge.json` | `{ stages: { [id]: { timestamp, agent, data } } }` — the **control object** each content stage returned | Rehydrate `PipelineState[stageId]` for completed content stages |
| Stage docs | `<specDir>/*.md` | Rendered requirements/bdd/research/design/spec/reviews/… | Authoritative content; also a fallback if `.knowledge` is partial |
| Git worktree | `<cwd>/.worktree/<specId>` | The actual code + per-phase commits (implementation commits on green) | Survives crash; reuse for resumed run |
| Audit trail | `~/.pi/agent/super-dev/runs/<ts>/audit.jsonl` | Per-stage `durationMs`, `control`, `error`, gate verdicts | Diagnostics; secondary rehydrate source |

`.knowledge.json` is the key: it's a near-complete dump of `PipelineState` for
every stage that calls `renderAndWrite` (requirements, bdd, research, debug,
assessment, design, prototype, spec, specReview, the reviews, api/ui tests,
implementation summary, docs).

## What is NOT persisted (and how resume handles it)

| Not on disk | Resume behavior |
|-------------|-----------------|
| `state.setup` (worktreePath, specDirectory, language, …) | **Reconstruct** — the worktree + spec dir exist on disk; re-detect language; reuse the spec id (don't allocate a new one) |
| `state.classify` | **Re-run** the deterministic `classify-task` helper (pure, cheap, no agent) |
| `state.implementation` (per-phase progress) | **Infer** from worktree git state (commits) + `implementationSummary` in `.knowledge`; treat implementation as "done" → verify runs against existing code |
| Verify-loop iteration / gate attempt counts / `__reviewSignatures` | **Restart fresh** (re-review the existing code) — acceptable; the convergence signal is real post-Gap-A |
| In-flight agent partial work | The interrupted stage simply **re-runs** (idempotent: docs render from control; code commits are additive) |
| cleanup / merge (terminal) | **Re-run fresh** |

## The design — stage-level fast-forward re-run

1. **Resume trigger** — invoke `super_dev` again with a `resume` option
   (`/super-dev --resume` for the most-recent incomplete spec, or
   `--resume <specId>` for a specific one). The tool detects an existing spec dir
   with a `.knowledge.json`.
2. **Rehydrate** — `runPipelineTask` loads `.knowledge.json`, rebuilds
   `PipelineState[stageId]` for every stage present, and reconstructs `setup`
   (reuse the existing `.worktree/<specId>` + spec dir; re-detect language) and
   `classify` (re-run the helper).
3. **Resume-skip in `task()`** — add a `resume` mode: if `state[stage.id]` is
   already populated (rehydrated) AND the stage is a content stage, record
   `resumed` and return without spawning. (The existing `enabled(state)` /
   budget skip path is the template.)
4. **Run** — completed content stages fast-forward; the first *missing* stage
   runs fresh, and the pipeline continues normally from there. Loops/terminal
   stages re-run as above.

```
resume run:  load .knowledge → state{requirements✓,bdd✓,…,spec✓, implementation✓, review✗}
             → skip requirements..spec, skip implementation(infer from git),
               RUN verify-loop fresh → docs → cleanup → merge
```

## Edge cases / robustness

- **Partial `.knowledge` entry** (stage crashed mid-write): validate the
  rehydrated control has its expected keys; if not, treat the stage as
  incomplete → it re-runs. (The per-stage TypeBox schemas already define the
  expected shape — reuse for validation.)
- **Worktree missing** (user ran `git worktree remove`): fall back to
  in-place mode in the original cwd, or error with guidance.
- **`.knowledge.json` corrupted**: JSON.parse fails → can't resume → start a
  fresh run (don't silently half-resume).
- **Spec dir exists but no `.knowledge`**: nothing to resume → fresh run.
- **Resume after a successful merge**: the spec is "complete" → resume is a
  no-op / tells the user it already finished.

## Effort

**Medium (~1–2 days):**
- `setup.ts`: resume path (reuse worktree + spec id; don't `nextSpecNumber` /
  `git worktree add`).
- `pipeline.ts` / a new `resume.ts`: load `.knowledge`, rehydrate state,
  reconstruct setup/classify, validate.
- `nodes.ts task()`: resume-skip branch.
- tool/command: `resume` option + most-recent-incomplete detection.
- Tests (rehydration, skip, edge cases above).

## Decision points (before implementing)

1. **Trigger** — auto-detect most-recent incomplete run + prompt, vs explicit
   `--resume <specId>` only, vs both. (Lean: both — auto-detect with a confirm.)
2. **Skip-completeness check** — "stage present in `.knowledge`" (simple proxy)
   vs schema-validate the rehydrated control before skipping. (Lean:
   schema-validate — reuses existing TypeBox schemas, avoids half-baked skip.)
3. **Implementation-stage resume** — "done if commits exist + summary present"
   (simple) vs phase-level resume (re-implement only incomplete phases). (Lean:
   stage-level first; phase-level is a later refinement.)
4. **Loops on resume** — restart fresh (simple) vs checkpoint iteration counts
   (complex, low value). (Lean: restart fresh.)

## Prior art

- The **original super-dev-plugin** had only a crude `auto-checkpoint` (`git
  stash create` on Stop) — a manual recovery stash, not pipeline resume.
- **Pi's** `SessionManager.continueRecent` / `/resume` resumes the
  *conversation* session, not the pipeline's internal state — replaying the
  `super_dev` tool call would re-run it from scratch. So Pi-level resume does
  NOT give mid-pipeline resume; the pipeline must own it (this design).

## Recommendation

**Worth doing** as a v0.3.0 feature: it directly addresses the "long pipeline
dies halfway, lose everything" failure mode, and the substrate (`.knowledge` +
worktree + docs) already exists — so it's incremental, not a redesign. Start
with stage-level fast-forward + schema-validated skip + restart-fresh loops,
per the leans above. Mid-loop / phase-level resume can follow if real usage
shows the stage level isn't enough.
