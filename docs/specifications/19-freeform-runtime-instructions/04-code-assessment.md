# Code Assessment: Freeform Runtime Instructions

## Existing architecture

- `src/extension.ts`
  - owns `ActiveRun`, input capture, TUI status/widget/transcript acknowledgement, and background delivery.
  - current input handler captures non-slash interactive text while `activeRun != null`.
- `src/workflow.ts`
  - drains `userSteerProvider()` before each specialist spawn.
  - persists drained input through `appendUserNotes()` and injects `userNotesForAgent()` into prompts.
- `src/render/user-notes.ts`
  - stores text-only `.user-notes.json`.

## Gaps

1. `ActiveRun.queue` is text-only.
2. Input handler ignores `event.images`.
3. `.user-notes.json` cannot persist attachments.
4. Prompt formatting cannot tell specialists where runtime images/content were saved.
5. Durable TUI entries exist for completion summaries but not for accepted runtime instructions.

## Constraints

- Preserve current `drain(): string[]` for existing tests and compatibility.
- Add structured `drainInstructions()` for the workflow path.
- Never inline binary data into specialist prompts.
- Never throw from acknowledgement/persistence paths; user input capture must not abort a run.

## Risk assessment

- Main risk is breaking existing input-handler tests; mitigated by keeping `drain()` text-only.
- Image persistence depends on Pi image shape; implementation supports both `data/mediaType` and `source:{type:"base64",data,mediaType}` shapes.
- If image shape is unrecognized, the instruction text is still persisted; image persistence degrades gracefully.
