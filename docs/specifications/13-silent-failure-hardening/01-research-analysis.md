# Research & Analysis: Silent-Failure Hardening

## Scope

This work addresses all review findings from the pi-super-dev code review: review false-approval, build/pre-merge false success, tool error signaling, implementation no-op skips, budget enforcement, integration vacuous pass/stale state, and exposed-but-unused `skipStages`.

Explicitly ignored per user instruction: `~/development/Personal/jenningsloy318/super-dev-plugin/workflows/super-dev.workflow.js`.

## Research inputs

1. Pi extension documentation (`docs/extensions.md`): custom tools signal execution failure by throwing from `execute()`. Returning arbitrary `isError` fields is not the documented failure contract.
2. Pi SDK documentation (`docs/sdk.md`): `AgentSession.prompt()` reports accepted runs through event streams; failures after acceptance must be interpreted by caller logic. Therefore specialist wrappers must not collapse failed/missing structured output into valid control data.
3. Ready super-dev plugin protocols:
   - `skills/super-dev/SKILL.md`
   - `agents/team-lead.md`
   - `reference/workflow/implementation-completeness-loop.md`
   - `reference/workflow/implementation-iteration-loop.md`
   - `reference/workflow/verification-gates.md`
4. Local code review evidence in `src/stages/verify.ts`, `src/helpers.ts`, `src/workflow.ts`, `src/stages/implementation.ts`, `src/nodes.ts`, `src/extension.ts`.

## Issue-by-issue analysis

### 1. Review agent failure becoming approval

Root cause: review tasks returned `{}` on missing/failed agent output, and `merge-review-verdicts` defaulted missing verdicts to `Approved`.

Expected behavior from ready plugin: reviewer output is never optional. Invalid/missing reviews must loop or block.

Fix direction: create fail-closed review controls with `verdict: Changes Requested`, synthetic high-severity findings, and merge-helper validation that maps missing/invalid verdicts to non-approved.

### 2. Build/pre-merge failures not affecting success

Root cause: build gates returned `{ pass: false }` as successful node values, and final `RunStatus` ignored build/pre-merge/integration/merge evidence.

Expected behavior from ready plugin: gates are non-negotiable; failed gates must route to fix loops or partial/failed completion.

Fix direction: require build success in review/integration loop exits and include hard-gate failures in final status derivation.

### 3. Pi tool failures returned as normal results

Root cause: `super_dev` returned `isError` fields from tool execution. Pi docs specify throwing to signal tool failure.

Fix direction: throw for empty task, thrown pipeline errors, and final failed summaries.

### 4. Implementation no-op skip not resume-gated

Root cause: a file/pattern check could skip implementation on fresh runs. That bypassed TDD, build, deliverable, change, and phase-status verification.

Expected behavior from ready plugin: every phase goes through TDD + gate-build unless it is explicitly resumed from known-complete state.

Fix direction: only allow no-op skip during explicit resume, and even then verify deterministic build + full deliverable check before marking green.

### 5. Agent budget not hard-enforced

Root cause: `budget.spent()` was called without a central pre-check. Stage-level checks did not cover multiple agent spawns inside one phase/attempt.

Fix direction: enforce maxAgents in `workflow.ts` before every specialist spawn and make task-level budget exhaustion a failed result instead of a skipped result.

### 6. Integration pass vacuous/stale

Root cause: `testsGreen()` returned true when no API/UI test result existed and skipped tests could leave stale previous results.

Expected behavior from ready plugin: Stage 11 is blocking when a backend/frontend surface exists; skip only when no backend and no frontend exist.

Fix direction: track expected API/UI roles from bringup, clear attempt-local test state before each test attempt, and require fresh pass results for every expected role. No expected roles becomes explicit `notApplicable`, not “passed”.

### 7. `skipStages` exposed but unused

Root cause: `RunOptions.skipStages` was passed through but no node checked it.

Fix direction: implement leaf-stage skip support by stage id, stage label, and stage number parsed from labels; preserve Stage 1/setup as never-skippable.

## Residual risks

- Composite nodes such as Stage 10/11 can contain multiple leaf tasks; numeric `skipStages` now skips leaf tasks with matching `Stage N...` labels, but does not remove entire custom composite nodes in one step.
- The ready plugin has additional features not yet ported to pi-super-dev, especially visual verifier artifacts and full tracking JSON as a completion oracle.
- Full test suite includes environment-specific stockfan round-trip tests that fail in this checkout because absolute `/home/jenningsl/...` fixtures are absent.
