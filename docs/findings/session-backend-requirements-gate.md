# Findings: why the requirements gate fails (verified, live-model evidence)

**Date:** 2026-07-04 · **Status:** root cause VERIFIED via instrumented repro.
**Repro artifact:** `/tmp/sd-repro/requirements-writer-trace.txt` (repro script: `/tmp/sd-repro/repro.mjs`).

## The failure

`/super-dev` aborts at the requirements gate after 3 attempts on **both** backends.
The spec dir is created but `01-requirements.md` is never produced (or the control
object is incomplete), so `gateRequirements` fails on missing `docPath`/`acCount`/`featureName`.

## Previous (WRONG) hypothesis

I claimed the *session* backend couldn't run agents in the host pi runtime and
reverted the default to subprocess (commit `d4ca72a0`). That was unverified.
Evidence that disproved it: the failed run still produced the LLM slug
`05-ytd-rainfall-summary`, and `summarizeSlug` uses the *same*
`createAgentSession` + `SettingsManager.create` path — so session agents DO run
in-host with the real model (`glm-5.1` via `zai-coding-cn`, thinking `high`).

## Verified root cause

Ran the requirements writer (`requirements-clarifier` agent + `buildRequirementsPrompt`)
through `runAgentViaSession` against a real worktree, subscribing to every event and
dumping the full message trace. What `glm-5.1` actually did:

1. ✅ Explored the worktree (3 `bash` calls).
2. ✅ **Wrote the doc** — `write` → `01-requirements.md` (14827 bytes, correct path).
3. ✅ **Called `structured_output`**.
4. ❌ But the value was **`{"summary": "<big JSON string of open questions>"}`** —
   **missing `docPath`, `featureName`, `acCount`.**

So the agent did the work. The gate fails purely because the **control object is
incomplete**. The model is NOT stuck in interactive-interview mode (my earlier guess);
it correctly recognized "I can't interview in single-shot" and wrote the doc.

### Why the control object is incomplete

`src/session-agent.ts` defines the `structured_output` tool schema as:

```ts
const CONTROL_SCHEMA = Type.Object(
  { summary: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
```

**The schema declares only `summary`.** GLM treats the tool *schema* as the real
contract and ignores the prose instruction ("include docPath/featureName/acCount").
With only `summary` declared, it shoved everything into that one field. Models follow
schemas over prose — a permissive schema with one field silently rewrites the task.

For the **subprocess** backend the same incompleteness appears via the `<control>` text
contract (no schema to anchor on, so GLM emits whatever it pleases) — consistent with
the gate failing on the current subprocess default too. The bug is backend-independent.

## The fix (plan, not yet implemented)

Make the writer emit **all** required fields, robustly, regardless of backend.

1. **Per-stage schema (primary).** `runAgentViaSession` must accept the stage's required
   keys and build a `structured_output` tool whose schema DECLARES them as required
   (e.g. requirements → `{ docPath: string, featureName: string, acCount: number,
   openQuestions: array, summary: string }`). GLM will then fill them. Stage→keys map
   already exists implicitly in `prompts.ts` (each `Output <control> JSON with: …` line);
   promote it into a real schema. `writerTask` passes the keys down via `ctx.agent`.
   - Other backends unaffected; subprocess keeps `<control>` text but the same key list
     drives a stricter prompt.

2. **Tighten the prompt.** Replace "Output <control> JSON with: a, b, c" with an explicit
   REQUIRED-fields block, and for the session path state the schema mirror.

3. **Honest-validate, don't silently re-run 3×.** In `writerTask` (or the gate's `validate`),
   if required keys are absent, do ONE corrective re-prompt ("you returned only `summary`;
   call structured_output again with docPath/featureName/acCount filled") before counting
   a gate failure. This converts the opaque "failed after 3 attempts" into a self-healing
   step and bounds cost.

4. **Observability.** `runAgentViaSession` uses `SessionManager.inMemory` → zero persisted
   logs, which is why this took a repro to diagnose. Add a debug mode (env
   `SUPER_DEV_DEBUG=1`) that writes the full message trace per agent to a temp file, so
   future failures are inspectable.

## Verify step (reproduce the fix)

Re-run `/tmp/sd-repro/repro.mjs` after the fix: expect `structured_output` value to
contain `docPath`, `featureName`, `acCount` (non-empty) → gate passes. Then run a real
`/super-dev` end-to-end and confirm the requirements stage produces a doc and proceeds.

## Note on the revert

Commit `d4ca72a0` reverted the default to `subprocess` "because session doesn't work
in-host." That rationale is disproven — session DOES run agents in-host (this repro is a
real session call). The revert can stand for now (subprocess is the proven path) but the
real defect is the incomplete control object, present on both backends. Re-enabling
session as default is safe **after** fix #1 lands and a real `/super-dev` run completes a
writer stage on the session backend.
