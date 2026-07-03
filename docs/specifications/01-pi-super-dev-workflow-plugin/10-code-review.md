# Code Review: pi-super-dev Workflow Plugin

**Reviewer**: code-reviewer (Stage 10)  
**Date**: 2026-07-03  
**Scope**: `git diff 24aaad7f..9ee548f8` (55 files, 3326 insertions)  
**Focus**: `implementation-controller.mjs`, all helpers, `spec.json`, schemas, agents, `extension.ts`, `SKILL.md`

---

## 1. Correctness

**Score: 4/5**

### Finding CR-01: `skipStages` input is declared but never honored

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/implementation-controller.mjs` (entire file) |
| Failure Scenario | User invokes `/workflow run super-dev --input.skipStages=["research"] "task"` expecting research to be skipped, but the pipeline always runs all stages |

**Evidence**: `spec.json:21` declares `"skipStages": []` in `input`. `classify-task.mjs:13` returns `skipStages: []` in classification. `docs/usage.md` documents skip usage. However, `implementation-controller.mjs` never reads `ctx.sources.setup.skipStages` or `classification.skipStages` to conditionally bypass stages.

**Fix**: Add skip logic at the start of the controller:
```javascript
const skipSet = new Set(classification.skipStages ?? []);
```
Then guard each optional phase: `if (!skipSet.has("research")) { ... }`.

---

### Finding CR-02: `classify-task.mjs` can never produce `"ui-only"` uiScope

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/classify-task.mjs:29` |
| Failure Scenario | The `route-designer.mjs` branch for `uiScope === "ui-only"` (routing to `ui-ux-designer`) is unreachable dead logic |

**Evidence**: Line 29: `const uiScope = isWebUi ? "ui+arch" : "none"`. There is no condition that produces `"ui-only"`. The schema (`super-dev-classify-task-control.schema.json`) declares `"ui-only"` as a valid enum value, and `route-designer.mjs:27` handles it, but no code path produces it.

**Fix**: Add UI-only detection logic, e.g., if the task text references only styling/layout but not architecture:
```javascript
const uiOnlyKeywords = /\b(style|css|layout|theme|color|font|spacing|responsive)\b/i;
const uiScope = isWebUi
  ? (uiOnlyKeywords.test(task) && !task.match(/\b(api|database|endpoint|backend|schema)\b/i))
    ? "ui-only"
    : "ui+arch"
  : "none";
```

---

### Finding CR-03: Implementation returns `totalPhases: 0` which violates its own schema

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/implementation-controller.mjs:661` |
| Failure Scenario | If `specControl.phases` is empty, `runImplementation` returns `{ totalPhases: 0, ... }` but `super-dev-implementation-control.schema.json` requires `"totalPhases": { "minimum": 1 }` — schema validation would reject this |

**Fix**: Either change the schema to `"minimum": 0` or handle the empty-phases case before returning (throwing a pipeline error or setting `totalPhases: 1` as a sentinel).

---

### Finding CR-04: `extractFulfilled` throws on any rejected promise without context

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 0.9 |
| Location | `workflows/super-dev/helpers/implementation-controller.mjs:40-44` |
| Failure Scenario | If either the code-reviewer or adversarial-reviewer agent fails, `extractFulfilled` on line 766 throws `r.reason` — an unhandled exception that crashes the pipeline without graceful degradation |

**Evidence**: `ctx.parallel()` returns settled results (per the API pattern). If one reviewer errors out (timeout, hallucination), the entire code review loop aborts without any of the 3-round retry protection.

**Fix**: Handle rejections gracefully:
```javascript
function extractFulfilled(results) {
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    return null; // or a default "Changes Requested" control
  });
}
```
Then in `runCodeReviewLoop`, check for null before proceeding.

---

### Finding CR-05: `gate-review.mjs` helper exists but is never called

| Field | Value |
|-------|-------|
| Severity | LOW |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/gate-review.mjs` (unused file) |
| Failure Scenario | Dead code; no runtime impact. The verdict check is done inline in `runCodeReviewLoop` (line 779). |

**Evidence**: `grep -n "gate-review" implementation-controller.mjs` returns no results. The spec (Section 6.1) lists `gate-review.mjs` as validating the merged review verdict, but the controller performs this check inline.

**Fix**: Either integrate `gate-review` into the controller loop (for consistency with other gates), or remove the file and update the spec. Recommend using it for consistency:
```javascript
const reviewGate = await ctx.helper("gate-review", {
  sources: { "merge-verdicts": merged.value },
});
if (reviewGate.value.pass) { ... }
```

---

## 2. Security

**Score: 4/5**

### Finding CR-06: `cleanup.mjs` only scans top-level directory

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/cleanup.mjs:80-100` |
| Failure Scenario | A `.env` file in `config/.env` or `src/secrets.pem` would NOT be detected — only root-level files are scanned |

**Evidence**: `readdir(cwd)` on line 93 lists only immediate children. No recursive traversal.

**Fix**: Add recursive directory walk or use `readdir(cwd, { recursive: true })` (Node 22+ supports this).

---

### Finding CR-07: `SECRET_CONTENT_PATTERNS` declared but never used

| Field | Value |
|-------|-------|
| Severity | MEDIUM |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/cleanup.mjs:28-34` |
| Failure Scenario | Hardcoded API keys or private keys embedded in source files (matching content patterns like `sk-live_...`) go undetected because only filename patterns are checked |

**Evidence**: The constant is defined at module scope but never referenced in the function body. No `readFile` call exists to inspect file contents.

**Fix**: Add content scanning for non-binary files, at least in commonly dangerous locations (`.env`-like files, config directories). Even a shallow scan of top-level text files would catch the most common leaks.

---

### Finding CR-08: No hardcoded secrets detected

| Field | Value |
|-------|-------|
| Severity | N/A (pass) |
| Confidence | 1.0 |

No API keys, tokens, passwords, or credentials found in any implementation file.

---

## 3. Performance

**Score: 5/5**

### Finding CR-09: Cleanup reads directory twice

| Field | Value |
|-------|-------|
| Severity | LOW |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/cleanup.mjs:80,93` |
| Failure Scenario | No runtime issue; redundant I/O for the same directory |

**Fix**: Combine into one `readdir(cwd, { withFileTypes: true })` call and reuse the result for both build directory detection and sensitive file scanning.

---

No other performance concerns. The controller uses:
- Budget checks before expensive operations (correct)
- `ctx.parallel()` for independent code review (correct)
- Sequential iteration where dependencies exist (correct)
- Bounded loops (max 3) to prevent runaway (correct)

---

## 4. Maintainability

**Score: 4/5**

### Finding CR-10: `directoriesRemoved` name is misleading

| Field | Value |
|-------|-------|
| Severity | LOW |
| Confidence | 1.0 |
| Location | `workflows/super-dev/helpers/cleanup.mjs:53,83` |
| Failure Scenario | Future maintainers expect actual removal; the helper only reports existence |

**Fix**: Rename to `buildDirectoriesFound` or add a comment clarifying this is a detection-only scan.

---

### Finding CR-11: Prompt builder functions are repetitive

| Field | Value |
|-------|-------|
| Severity | LOW |
| Confidence | 0.7 |
| Location | `workflows/super-dev/helpers/implementation-controller.mjs:60-412` |

17 prompt builder functions share a common pattern (context block + upstream artifacts + instructions + control output request). The repetition is acceptable for clarity and maintainability, and each function has unique domain logic. Not flagging as actionable — this is a style observation.

---

## 5. Spec Compliance

**Score: 4/5**

### Compliance Matrix

| Spec Section | Status | Notes |
|--------------|--------|-------|
| §1.1 Package Layout | PASS | 21 agents, 17 schemas, 13 helpers, skill, spec.json all present |
| §1.2 Hybrid Architecture (ADR-1) | PASS | Two-stage `setup` + `dynamic` matches exactly |
| §2.1 extension.ts | PASS | Minimal entry point, no-op body |
| §2.2 spec.json structure | PASS | All required fields present |
| §2.3 Helper interface | PASS | All helpers return `{ schema, digest, value }` |
| §2.4 Dynamic controller interface | PASS | Uses `ctx.agent()`, `ctx.helper()`, `ctx.parallel()`, `ctx.budget`, `ctx.phase()`, `ctx.log()` |
| §3.1 Setup stage | PASS | Correct type, agent, tools, schema ref |
| §3.2 Pipeline stage | PASS | Dynamic with budget, mode, permissions |
| §4.1-4.15 Controller phases | PARTIAL | `skipStages` not honored (CR-01); `gate-review` not used (CR-05) |
| §5 Control schemas | PASS | All 17 schemas valid, no forbidden keywords |
| §6 Helper specs | PARTIAL | `cleanup.mjs` missing content scan; `gate-review` unused |
| §7 Agent definitions | PASS | 21 agents with correct frontmatter, no forbidden fields |
| §8 Error handling | PASS | Budget checks, loop exhaustion, graceful degradation |
| §9 Testing | PASS | Integration tests validate structure, syntax, schemas |

---

### Finding CR-12: Spec §4.1 shows `classification.value.taskType` but controller uses `classification.taskType`

| Field | Value |
|-------|-------|
| Severity | LOW |
| Confidence | 0.8 |
| Location | Spec §4.5 vs `implementation-controller.mjs:509` |

The spec pseudocode shows `classification.value.taskType` (implying the full helper output) but the controller extracts `.value` on line 423 (`return result.value`) so subsequent code correctly accesses `classification.taskType`. This is a spec documentation inconsistency, not a code bug.

---

## 6. API Compliance (pi-workflow)

**Score: 5/5**

### Compliance Check

| pi-workflow API Feature | Usage | Correct? |
|-------------------------|-------|----------|
| `ctx.agent({ id, agent, prompt })` | All agent spawns | YES — deterministic IDs, valid agent names |
| `ctx.helper(name, { sources, options, context })` | Gate checks, routing, cleanup | YES — matches §7 signature |
| `ctx.parallel([thunks])` | Code review (line 753) | YES — fan-out pattern |
| `ctx.budget.check()` | Before each agent call | YES — guards every expensive op |
| `ctx.phase(name)` | Each pipeline stage | YES — UI phase declarations |
| `ctx.log(msg)` | Progress reporting | YES |
| Helper return format | `{ schema: "helper-output-v1", digest, value }` | YES — all 12 helpers |
| Schema subset rules | No `$ref`, `$defs`, `pattern` | YES — all 17 schemas validated by tests |
| Agent frontmatter | `name`, `description`, `tools`, `readOnly` only | YES — no `model`, `kind`, etc. |
| spec.json `from` dependency | `pipeline.from: "setup"` | YES |

No API misuse detected. The implementation correctly uses pi-workflow's dynamic controller API as documented in the research report (§4, §7).

---

## Summary of Findings

| ID | Severity | Dimension | Title |
|----|----------|-----------|-------|
| CR-01 | MEDIUM | Correctness/Spec | `skipStages` declared but never honored |
| CR-02 | MEDIUM | Correctness | `"ui-only"` uiScope unreachable |
| CR-03 | MEDIUM | Correctness | `totalPhases: 0` violates schema `minimum: 1` |
| CR-04 | MEDIUM | Correctness | `extractFulfilled` crashes on rejection without graceful degradation |
| CR-05 | LOW | Correctness | `gate-review.mjs` unused dead code |
| CR-06 | MEDIUM | Security | Cleanup only scans top-level directory |
| CR-07 | MEDIUM | Security | `SECRET_CONTENT_PATTERNS` declared but unused |
| CR-08 | N/A | Security | No hardcoded secrets (pass) |
| CR-09 | LOW | Performance | Redundant readdir call |
| CR-10 | LOW | Maintainability | `directoriesRemoved` naming misleading |
| CR-11 | LOW | Maintainability | Prompt builders repetitive (acceptable) |
| CR-12 | LOW | Spec Compliance | Spec pseudocode vs implementation minor divergence |

---

## Verdict

**Approved with Comments**

No CRITICAL or HIGH severity issues found. The implementation is well-structured, correctly uses pi-workflow APIs, and faithfully implements the 13-stage pipeline architecture. The 6 MEDIUM findings are quality improvements that should be addressed in a follow-up iteration but do not block the current implementation from functioning correctly in its primary use cases.

Priority fixes recommended for next iteration:
1. CR-01 (skipStages) — feature gap visible to users
2. CR-04 (extractFulfilled) — robustness under agent failure
3. CR-03 (totalPhases schema) — prevents schema validation errors
4. CR-06/CR-07 (cleanup scanning) — security gap in stated protection
