# Adversarial Review — pi-super-dev Workflow Plugin

**Reviewer**: adversarial-reviewer  
**Date**: 2026-07-03  
**Diff**: `24aaad7f..9ee548f8` (+3326 lines, 55 files)  
**Focus**: `workflows/super-dev/helpers/implementation-controller.mjs`

---

## Lens 1: The Skeptic

> "Will this actually work in production?"

### Finding 1.1 — `extractFulfilled` throws on first rejection, losing sibling results

**Severity**: IMPORTANT  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:39-44`

```js
function extractFulfilled(results) {
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    throw r.reason;
  });
}
```

`ctx.parallel()` returns settled results (fulfilled/rejected). If the adversarial-reviewer agent throws but the code-reviewer succeeds, this function discards the successful result entirely by throwing on the first rejected entry encountered. The pipeline would crash at Stage 10 even though half the work succeeded.

**Recommendation**: Collect errors and surface them in the merged verdict rather than throwing immediately. If both fail, then escalate.

---

### Finding 1.2 — `ctx.agent()` return shape assumed but never validated

**Severity**: IMPORTANT  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:433-438` (pattern repeated ~15 times)

```js
const result = await ctx.agent({ ... });
reqControl = result?.control ?? result;
```

If `ctx.agent()` returns `null` or `undefined` (agent timeout, budget cut, runtime error), `reqControl` becomes `null`. This is passed directly into gate helpers and downstream prompts without null-guard. The gate helpers _do_ check `sources?.["write-requirements"]` but only for the named source key — the pattern of passing `reqControl` directly (e.g., `requirements?.docPath ?? "N/A"`) means the pipeline would continue silently with "N/A" in every prompt, producing garbage downstream rather than surfacing an error.

**Recommendation**: After each `ctx.agent()` call, add a defensive check that at minimum logs a warning or terminates the loop when the result is truly null.

---

### Finding 1.3 — `filesModified` in `runImplementation` is always empty

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:665,734`

```js
const filesModified = [];
// ... never populated ...
return { phasesCompleted, totalPhases, allGreen, filesModified, summary: ... };
```

The array is declared but never pushed to. It will always be `[]` in the returned control, making downstream consumers (code review prompt referencing `implControl`) believe no files were modified.

**Recommendation**: Either remove the field or populate it from the implementer agent's control output.

---

### Finding 1.4 — `input.skipStages` is documented but never consumed

**Severity**: MINOR  
**File**: `workflows/super-dev/spec.json:18`, `docs/usage.md:111-117`

The spec declares `skipStages` in `input` and the usage doc explains how to use it, but the `implementation-controller.mjs` never reads `ctx.input.skipStages` or uses the `classification.skipStages` field (always `[]` from `classify-task.mjs`).

**Recommendation**: Implement the skip logic or remove it from the public API to avoid confusing users.

---

### Finding 1.5 — Cleanup only scans top-level directory

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/cleanup.mjs:97-108`

Sensitive file detection uses `readdir(cwd)` (non-recursive). A `.env` file at `src/.env` or `config/secrets.key` would not be detected. For a merge-blocking security gate, this is insufficient.

**Recommendation**: Use recursive scan (at minimum one level deep) or `find`-equivalent for sensitive patterns.

---

## Lens 2: The Architect

> "Does this structure serve the system well?"

### Finding 2.1 — Controller is 900 lines with all prompt logic inlined

**Severity**: IMPORTANT  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs` (entire file)

The controller mixes three concerns:
1. Pipeline orchestration (sequencing, loops, gates)
2. Prompt construction (16 `build*Prompt` functions, lines 46-412)
3. Routing decisions (delegated to helpers, correctly)

At 900 lines, it's not unmanageable today, but adding a single new stage means touching prompts AND orchestration in one file. The prompt builders could be a separate module (`prompts.mjs`) imported by the controller. This would also make prompts independently testable.

**Recommendation**: Extract `build*Prompt` functions into `helpers/prompts.mjs`. The controller would shrink to ~500 lines of pure flow.

---

### Finding 2.2 — No mechanism for inter-stage data flow beyond function arguments

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:845-901`

All inter-stage data flows through local variables in `controller()`. If the engine crashes and resumes mid-pipeline, there is no serializable state snapshot (the dynamic controller restarts from the top, relying on the engine's `replay` to fast-forward `ctx.agent()` calls). This is fine if the engine guarantees replay semantics, but the code itself has no defensive check (e.g., verifying replayed data is non-null before proceeding).

**Recommendation**: Document that correctness depends on engine-level replay guarantees. Consider a `ctx.checkpoint()` call if the engine supports it to reduce replay cost.

---

### Finding 2.3 — `gate-review.mjs` exists but is never called

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/gate-review.mjs`

This helper validates merged review verdicts using the source key `"merge-verdicts"`, but the controller's Stage 10 inlines the verdict check directly (`if (verdict === "Approved" ...)`). The gate helper is dead code.

**Recommendation**: Either wire it into the controller or delete it to avoid confusion.

---

### Finding 2.4 — Testing is structural only, no behavioral coverage

**Severity**: IMPORTANT  
**File**: `tests/phase7-integration.test.ts`

The tests validate file existence, JSON parsing, and frontmatter structure. No test exercises `implementation-controller.mjs` with a mock `ctx` to verify:
- Loop termination at max rounds
- Budget exhaustion path
- Parallel failure handling (`extractFulfilled`)
- Null agent results

This means there is zero confidence that the orchestration logic works correctly beyond syntax validity.

**Recommendation**: Add a unit test file that stubs `ctx` (agent, helper, parallel, budget, log, phase) and exercises the controller's control flow paths.

---

## Lens 3: The Minimalist

> "Is any of this unnecessary?"

### Finding 3.1 — `gate-review.mjs` is dead code

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/gate-review.mjs` (31 lines)

As noted in 2.3 — this gate is never referenced from the controller or spec.json. It's entirely unreachable.

---

### Finding 3.2 — `padRound` is trivial and used only for string formatting

**Severity**: TRIVIAL  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:27-29`

Not a real issue — just noting that one-digit padding for max 3 rounds (always "01", "02", "03") serves ID uniqueness, which is fine.

---

### Finding 3.3 — Spec review loop returns `null` on exhaustion but other loops return last result

**Severity**: MINOR  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:651`

```js
ctx.log("Spec review: exhausted 3 rounds — continuing");
return null;
```

This inconsistency (all other loops return their `lastControl`) means downstream code cannot inspect why the spec review failed. The returned `null` is never used (the result of `runSpecReviewLoop` is discarded at line 883), but the asymmetry is confusing.

**Recommendation**: Return the last review control for consistency, even if unused today.

---

### Finding 3.4 — Comments in prompt builders are absent; inline strings serve as docs

**Severity**: TRIVIAL  
**File**: `workflows/super-dev/helpers/implementation-controller.mjs:46-412`

The prompt builder functions are self-documenting through their structure. No actionable waste here — just noting they are appropriately lean.

---

## Summary Table

| # | Lens | Severity | Finding |
|---|------|----------|---------|
| 1.1 | Skeptic | IMPORTANT | `extractFulfilled` throws on first rejection, discards sibling results |
| 1.2 | Skeptic | IMPORTANT | Agent results never null-checked; pipeline silently degrades |
| 1.3 | Skeptic | MINOR | `filesModified` always empty |
| 1.4 | Skeptic | MINOR | `skipStages` documented but unimplemented |
| 1.5 | Skeptic | MINOR | Cleanup only scans top-level for sensitive files |
| 2.1 | Architect | IMPORTANT | 900-line file mixes prompts + orchestration |
| 2.2 | Architect | MINOR | No checkpoint mechanism; depends on engine replay |
| 2.3 | Architect | MINOR | `gate-review.mjs` is dead code |
| 2.4 | Architect | IMPORTANT | No behavioral tests for controller logic |
| 3.1 | Minimalist | MINOR | Dead file: `gate-review.mjs` |
| 3.2 | Minimalist | TRIVIAL | `padRound` observation (no action needed) |
| 3.3 | Minimalist | MINOR | Inconsistent null-return on spec review exhaustion |
| 3.4 | Minimalist | TRIVIAL | Prompt builders appropriately lean |

---

## Verdict

**ACCEPT WITH RESERVATIONS**

**Rationale**: Four IMPORTANT findings across two lenses (1.1, 1.2, 2.1, 2.4), but none are CRITICAL blockers for initial deployment:

- Finding 1.1 (extractFulfilled) is the highest-risk — a single agent failure in parallel review will crash the pipeline. However, the engine likely wraps agent calls such that hard throws are rare. Still, this should be addressed before heavy production use.
- Finding 1.2 (null agent results) degrades gracefully rather than crashing — the pipeline produces low-quality artifacts but does not halt.
- Finding 2.1 (file size) is a maintainability concern, not a correctness bug.
- Finding 2.4 (no behavioral tests) is standard for v1 workflow plugins but should be addressed in the next iteration.

No CRITICAL flaws (data loss, security breach, guaranteed crash) were found. The code is structurally sound and idiomatically consistent. The pipeline will function correctly on the happy path and degrade acceptably on most error paths. The reservations above should be addressed before v2.
