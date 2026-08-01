# Implementation Summary: Freeform Runtime Instructions

## Implemented

- Added structured runtime instruction types in `src/types.ts`.
- Upgraded `ActiveRun` in `src/extension.ts`:
  - queues `RuntimeInstruction` objects with id/time/source/streamingBehavior/images,
  - keeps legacy text-only `drain()` for compatibility,
  - adds `drainInstructions()` for workflow delivery,
  - acknowledges accepted input with Pi-native status and transcript lines.
- Input handler now captures Pi `event.images` together with text while a run is active.
- Added durable `super-dev-instruction` entry renderer so accepted runtime instructions appear as native Pi transcript cards.
- Added durable `super-dev-run` start cards, enhanced the live widget to show latest pending instruction preview alongside the pending count, and added a native overlay panel shortcut (`ctrl+shift+d`) for active run state.
- Reworked `src/render/user-notes.ts`:
  - supports legacy string notes and legacy `.user-notes.json`,
  - persists base64 image attachments under `user-input/`,
  - copies path-backed attachments into `user-input/` instead of injecting original paths,
  - degrades image persistence failures into visible prompt warnings instead of silently dropping image-only input,
  - formats attachment references for downstream specialist prompts.
- Workflow path now drains structured instructions via `drainInstructions()` and persists/injects them at agent boundaries.

## Tests

- Updated existing input-handler ACK/compatibility tests for the structured queue while preserving `drain()` compatibility.
- Added user-notes tests for:
  - legacy `.user-notes.json` compatibility,
  - base64 image persistence,
  - path-backed attachment copying,
  - image-only persistence failure visibility.
- Updated entry-renderer tests for `super-dev-summary`, `super-dev-instruction`, and `super-dev-run` renderers.
- Re-ran dashboard widget tests for the latest-instruction preview path.

## Validation

Passed:

```bash
npm run typecheck
npm test -- tests/user-notes.test.ts tests/input-handler.test.ts tests/input-handler-phase1-coverage.test.ts tests/input-handler-phase2-ack.test.ts tests/workflow-user-steer.test.ts tests/phase5-no-regression-gate.test.ts tests/extension-entry-renderer.test.ts
npm test -- tests/extension-entry-renderer.test.ts tests/user-notes.test.ts src/render/dashboard.test.ts src/render/dashboard-widget.test.ts tests/input-handler-phase2-ack.test.ts
npm test -- tests/user-notes.test.ts tests/input-handler.test.ts tests/input-handler-phase1-coverage.test.ts tests/input-handler-phase2-ack.test.ts tests/workflow-user-steer.test.ts tests/phase5-no-regression-gate.test.ts tests/extension-entry-renderer.test.ts src/render/dashboard.test.ts src/render/dashboard-widget.test.ts
```

Result: core freeform/native UI suite passed (9 test files, 164 tests). Earlier focused suites also passed.

## Follow-up

Best-effort live steering of the currently running in-process session specialist remains a future enhancement. The implemented guarantee is checkpoint/agent-boundary delivery, which works across session, subprocess, browser, and resumed runs.
