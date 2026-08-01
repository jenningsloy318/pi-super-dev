# Requirements: Freeform Runtime Instructions

## Problem

When `super_dev` runs in background, the user should be able to type/paste normal text and attach images/content in the Pi TUI, and the active workflow should accept those inputs as live runtime instructions without requiring new slash commands.

## Acceptance Criteria

- **AC-01 Natural input capture**: During an active foreground or background `super_dev` run, non-slash interactive input is captured as runtime guidance instead of being sent to the parent agent.
- **AC-02 Image/content capture**: Attached images from Pi input events are accepted with the text instruction and preserved for downstream specialists.
- **AC-03 Durable delivery**: Runtime instructions are persisted under the spec directory so resumed/crashed runs can still incorporate them.
- **AC-04 Specialist prompt injection**: Accumulated runtime instructions are injected into subsequent specialist prompts at workflow checkpoints/agent boundaries.
- **AC-05 Native TUI acknowledgement**: Pi immediately acknowledges captured input via status/transcript/durable entry surfaces so the user knows the instruction was accepted.
- **AC-06 Backward compatibility**: Existing text-only `ActiveRun.drain()` behavior remains available for tests/downstream consumers.
- **AC-07 Slash command passthrough**: Slash commands still pass through to Pi while a run is active.
- **AC-08 Safe bounds**: The in-memory pending instruction queue remains bounded to prevent prompt bombing.

## Non-goals

- Do not require new slash commands for the primary UX.
- Do not attempt guaranteed live steering of already-running subprocess specialists. Checkpoint delivery is the guaranteed path.
- Do not inline binary image data into prompts; persist images as files and reference paths.
