# Specification: Freeform Runtime Instructions

## Design

### RuntimeInstruction

Add structured runtime instructions to `src/types.ts`:

```ts
interface RuntimeInstruction {
  id: string;
  createdAt: string;
  text: string;
  source?: string;
  streamingBehavior?: "steer" | "followUp";
  images?: RuntimeInstructionImage[];
}
```

### ActiveRun

`ActiveRun` stores a bounded `RuntimeInstruction[]` queue.

- `push(text, images, meta)` queues a structured instruction.
- `drain()` remains text-only for compatibility.
- `drainInstructions()` returns structured instructions for the workflow.

### Input capture

The extension input handler captures:

- non-slash interactive text,
- image attachments,
- source/streaming metadata.

It returns `{ action: "handled" }` after successful capture.

### Durable storage

`appendUserNotes(specDir, instructions)` stores instructions in `.user-notes.json` and writes image attachments to:

```text
<specDir>/user-input/<instruction-id>-image-N.<ext>
```

### Prompt injection

`userNotesForAgent(specDir)` formats text and attachment references for specialist prompts.

### UI acknowledgement

On capture:

- footer/status shows `📥 accepted: <preview>`;
- live transcript gets a `user-input` line with instruction id;
- `pi.appendEntry("super-dev-instruction", ...)` records a durable TUI-only card.

## Acceptance mapping

- AC-01: extension input handler + `ActiveRun.push()`.
- AC-02: `event.images` normalization + `RuntimeInstruction.images`.
- AC-03: `.user-notes.json` + `user-input/` files.
- AC-04: `workflow.ts` uses `drainInstructions()` via `userSteerProvider` and prompt injection.
- AC-05: status/transcript/entry renderer.
- AC-06: text-only `drain()` compatibility.
- AC-07: slash command passthrough remains.
- AC-08: `MAX_QUEUED_INPUTS` remains enforced.
