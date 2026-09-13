# Foreground Pi TUI Behavior

Status: reference — TUI research note

## Decision

`pi-super-dev` is foreground-only. The `super_dev` tool blocks until the
pipeline finishes, streams progress through the tool `onUpdate` callback, keeps
the Pi dashboard widget active while the run is in progress, and writes the full
run log under `~/.super-dev/runs/`.

Detached/background execution was removed after the foreground default proved to
be the desired behavior. The extension no longer registers `/super-dev-bg`, no
longer accepts `background` as a tool option, and no longer registers
`/super-dev-stop` or a background abort shortcut.

## Current Behavior

- `/super-dev <task>` sends a foreground-only `super_dev` tool instruction with
  the task verbatim.
- `/super-dev --bg <task>` and `/super-dev --background <task>` are rejected with
  a short notification instead of dispatching a malformed task.
- Direct `super_dev({ task })` calls run foreground in every Pi mode.
- Stale direct tool calls that still include `background: true` are ignored by
  the runner and use the normal foreground signal.
- Runtime user input typed during an active run is queued as mid-run guidance;
  slash commands still pass through to Pi.
- The TUI dashboard shows the short runtime label, stage progress, elapsed time,
  pending runtime instructions, and the run log path. It does not show the
  version policy.

## Required Surfaces

- Tool schema: `task`, `skipWorktree`, `skipStages`, `model`, `maxAgents`,
  `resume`, and `resumeSpecId` only.
- Slash command: `/super-dev <task description>` only.
- Cancellation: use the active foreground tool/command signal, including Pi's
  normal Escape/abort behavior.
- Durable entries: keep `super-dev-run` and `super-dev-instruction` renderers.
- Removed durable entries: no detached run summary card is produced.

## Acceptance Checks

1. Running `/super-dev fix X` emits a tool instruction containing only
   `{ "task": "fix X" }`.
2. Running `/super-dev --bg fix X` does not send a tool instruction.
3. The registered command list does not include `/super-dev-bg` or
   `/super-dev-stop`.
4. The `super_dev` tool schema does not advertise a `background` parameter.
5. A stale direct call with `background: true` still waits for the foreground
   pipeline and passes the caller's signal into `runPipelineTask`.
6. The dashboard header displays `super-dev v<version>` only, with no version
   policy text.
