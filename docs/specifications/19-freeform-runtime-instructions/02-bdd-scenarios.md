# BDD Scenarios: Freeform Runtime Instructions

## SCENARIO-001 — Text instruction accepted during background run

Given a `super_dev` run is active in TUI background mode
When the user types `also handle empty CSV files`
Then the input event is handled by the extension
And a runtime instruction is queued
And the parent Pi agent does not receive it as a normal prompt
And the UI shows an acknowledgement.

## SCENARIO-002 — Slash commands continue to Pi

Given a `super_dev` run is active
When the user types `/model`
Then the extension returns `continue`
And Pi handles the slash command normally.

## SCENARIO-003 — Image attachment persisted

Given a `super_dev` run is active
And the user submits text with a PNG image attachment
When the next specialist checkpoint runs
Then `.user-notes.json` contains the instruction
And `user-input/<instruction-id>-image-1.png` exists
And the specialist prompt references the attachment path.

## SCENARIO-004 — Image-only input is valid

Given a `super_dev` run is active
When the user attaches an image with no text
Then the instruction is still queued
And the prompt describes it as an image/content attachment.

## SCENARIO-005 — Backward-compatible drain

Given an `ActiveRun` has queued text instructions
When a legacy caller invokes `drain()`
Then it receives a `string[]` of instruction texts.

## SCENARIO-006 — Structured drain for workflow

Given an `ActiveRun` has queued text and images
When the workflow invokes `drainInstructions()`
Then it receives structured instruction objects including image metadata.

## SCENARIO-007 — Bounded queue

Given more than the maximum pending instructions are submitted
Then the oldest pending instructions are dropped first.

## SCENARIO-008 — Resume durability

Given instructions were persisted to `.user-notes.json`
When a later specialist prompt is built after resume
Then `userNotesForAgent()` includes the accumulated text and attachment references.
