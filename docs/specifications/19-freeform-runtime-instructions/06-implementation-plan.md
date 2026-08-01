# Implementation Plan: Freeform Runtime Instructions

## Phase 1 — Type model

- Add `RuntimeInstruction` and `RuntimeInstructionImage` to `src/types.ts`.
- Change `RunOptions.userSteerProvider` to return structured instructions while allowing legacy strings.

## Phase 2 — ActiveRun queue

- Change `ActiveRun.queue` to `RuntimeInstruction[]`.
- Add `push(text, images, meta)`.
- Keep `drain(): string[]` for backward compatibility.
- Add `drainInstructions(): RuntimeInstruction[]` for workflow use.

## Phase 3 — Input event capture

- Normalize `event.images` in `src/extension.ts`.
- Capture text + images + metadata.
- Append durable `super-dev-instruction` entries.
- Preserve slash command passthrough.

## Phase 4 — Durable note/attachment store

- Rewrite `src/render/user-notes.ts` to store structured notes.
- Persist base64 images to `user-input/`.
- Format text + attachment paths for agent prompts.
- Preserve string input compatibility for existing escalation/workflow tests.

## Phase 5 — Workflow wiring

- Change `userSteerProvider` wiring to call `drainInstructions()`.
- Keep `workflow.ts` persistence/injection path unchanged except for structured input.

## Phase 6 — Tests

- Update user-notes tests for new prompt format.
- Add image persistence test.
- Update acknowledgement tests for new accepted/checkpoint wording.
- Run input-handler and workflow-user-steer suites.

## Phase 7 — Review/integration/doc/merge

- Run typecheck and targeted tests.
- Run code review.
- Document implementation summary and known follow-up for best-effort live steering.
