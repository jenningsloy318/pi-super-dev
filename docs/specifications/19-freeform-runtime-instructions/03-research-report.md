# Research Report: Pi Native Runtime Instruction Capture

## Sources reviewed

- Installed Pi extension documentation: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Installed Pi SDK documentation: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Installed extension type/source declarations under `node_modules/@earendil-works/pi-coding-agent/dist/`
- Existing pi-super-dev implementation in `src/extension.ts`, `src/workflow.ts`, and `src/render/user-notes.ts`

## Findings

### Input events are the correct primitive

Pi extension `input` events expose raw text, optional `images`, source, and `streamingBehavior`. Returning `{ action: "handled" }` prevents Pi from also submitting the input to the parent agent. This is the correct mechanism for natural freeform instructions during a background run.

### Images should be durable files

Pi prompts can carry images directly, but pi-super-dev specialist calls are mostly string prompts and may use subprocess backends. Persisting images to files under the spec directory is backend-agnostic and resume-safe. It also lets downstream specialists use the normal `read` tool to inspect images.

### Checkpoint delivery is the guaranteed architecture

Live steering of the current specialist is backend-dependent. Session agents may support steering; subprocess/browser agents cannot be guaranteed to. Therefore runtime instructions should be guaranteed at workflow checkpoints / agent boundaries, with future best-effort live steering as an optional enhancement.

### Native UI surfaces already fit the model

The existing extension already uses `setStatus`, live stream transcript lines, `appendEntry`, and entry renderers. Adding a `super-dev-instruction` entry type makes captured instructions durable and visible without requiring slash commands.

## Decision

Implement a structured runtime instruction bus with:

- in-memory bounded queue on `ActiveRun`,
- text/image capture from input events,
- durable `.user-notes.json`,
- attachment persistence under `user-input/`,
- prompt injection through `userNotesForAgent()`,
- TUI acknowledgement through status, transcript, and custom entry.
