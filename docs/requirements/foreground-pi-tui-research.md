# Foreground Pi TUI Requirements Research

Research date: 2026-08-03

Scope: Determine whether `pi-super-dev` can run foreground when invoked from Pi, and whether progress/logs can use Pi-native UI surfaces instead of a separate custom TUI. This research also inventories the currently installed Pi extensions for comparable patterns.

## Summary

`pi-super-dev` is not technically background-only. The `super_dev` tool has a blocking foreground path when `background: false` is passed. The original problem was that interactive TUI mode defaulted `background` to true, and `/super-dev` did not execute the runner directly. Current behavior defaults both the slash command and direct tool calls to foreground; background is an explicit opt-in.

The installed extension most similar to the requested behavior is `pi-web-access`: it keeps its primary tool call foreground, streams progress through the tool `onUpdate` callback, uses `ctx.ui.setWidget` for activity UI, stores durable results with `pi.appendEntry`, and uses background only for secondary long content fetches. `pi-subagents` is also useful: its slash commands run directly from command handlers, default foreground, accept explicit background flags, and update Pi UI/status through `ctx.ui` and `pi.sendMessage`.

Recommendation: make `/super-dev <task>` foreground by default, keep explicit background as `/super-dev --bg <task>` or `/super-dev-bg <task>`, and refactor the current tool `execute` body so both the tool path and direct command path share one runner. Continue using Pi UI APIs (`onUpdate`, `ctx.ui.setWidget`, `ctx.ui.setWorkingMessage`, `pi.appendEntry`, `registerEntryRenderer`). Do not build a raw terminal UI. Some local rendering code will still be necessary because Pi provides primitives, not a complete workflow dashboard component.

## Current `pi-super-dev` Behavior

The local package is registered as a Pi extension and skill in `package.json` via `pi.extensions: ["./src/extension.ts"]` and `pi.skills: ["./skills/super-dev"]`.

Key findings from `src/extension.ts`:

- The `super_dev` tool exposes a `background` boolean. Its description says foreground is the default and `background: true` opts into the detached path.
- The foreground live stream uses the tool `onUpdate` callback through `createLiveStream`, then flushes only when `activeRun.background` is false.
- The dashboard uses Pi-native `ctx.ui.setWidget` with a component factory at placement `aboveEditor`; this is Pi UI, although the dashboard component itself is custom project code.
- The dispatch decision is `runInBackground = hasTuiUi && params.background === true`; otherwise it calls `doRun(signal, false)` and waits.
- The `/super-dev` slash command sends `pi.sendUserMessage(...)` asking the model to call the tool with an explicit `background` value; plain `/super-dev` sends `false`, and `--bg` sends `true`.
- Background completion uses `pi.appendEntry("super-dev-summary", ...)` and `pi.sendMessage(..., { deliverAs: "nextTurn" })`.

Implication: foreground support is now the default path users get from `/super-dev` and direct tool calls. Detached background runs remain available through explicit opt-ins.

## Pi API Surface Relevant To This Change

The public `ExtensionAPI` includes:

- `registerTool`, with `execute(toolCallId, params, signal, onUpdate, ctx)` for LLM-callable tools and streaming progress.
- `registerCommand`, with immediate slash-command handlers.
- `registerShortcut`.
- `registerMessageRenderer` and `registerEntryRenderer`.
- `sendMessage`, `sendUserMessage`, and `appendEntry`.
- `ctx.ui` primitives including `notify`, `setStatus`, `setWorkingMessage`, `setWorkingIndicator`, `setWidget`, `custom`, dialogs, editor helpers, and autocomplete hooks.

There is no public API in the discovered type surface to invoke a registered tool implementation by name from a command handler. `getAllTools()` lists tools and `setActiveTools()` changes activation, but neither executes a tool. Therefore, a direct foreground command should call shared internal runner code, not try to call the registered `super_dev` tool through Pi.

## Installed Extension Inventory

Installed package source: `~/.pi/agent/settings.json` lists 19 installed packages, including 17 npm packages and two Git installs (`pi-paste-image`, `pi-super-dev`). The npm dependency manifest is `~/.pi/agent/npm/package.json`.

| Package | Version | Pi registration | Foreground/UI relevance |
| --- | --- | --- | --- |
| `pi-mcp-adapter` | 2.18.0 | Extension, skills | Commands `mcp`, `mcp-auth`; uses Pi UI for configuration/auth flows, not a long foreground workflow model. |
| `pi-web-access` | 0.17.1 | Extension | Best comparison. Foreground tools use `onUpdate`; `/websearch` command opens curator directly; activity uses `ctx.ui.setWidget`; durable results use `appendEntry`; background only for secondary content fetches. |
| `pi-codex-goal` | 0.1.39 | Extension, prompts | Goal/prompt integration; no useful long-running foreground UI pattern found. |
| `pi-subagents` | 0.40.0 | Extension, skills, prompts | Strong command pattern. `/run`, `/chain`, `/parallel` call extension code directly, default foreground, support `--bg`, update status via `ctx.ui`, and send custom messages/renderers. |
| `pi-cache-graph` | 1.0.2 | Extension | No relevant foreground/progress pattern found. |
| `pi-intercom` | 0.9.1 | Extension, skills | Has tools, commands, shortcut, custom UI, append entries, and cross-session messaging. Useful for message/entry patterns, not primary run mode. |
| `pi-playwright` | 0.1.1 | Skills only | No extension entry; not relevant to Pi UI/run mode. |
| `pi-browser-cdp-extension` | 1.1.0 | Extension | Registers `browser_execute`; uses tool progress, but no slash foreground orchestration pattern. |
| `@ff-labs/pi-fff` | 0.10.1 | Extension | Commands and append entries; not a long-running workflow UI reference. |
| `pi-simplify` | 0.2.3 | Extension | No relevant foreground/progress pattern found. |
| `@narumitw/pi-statusline` | 0.43.0 | Extension | Statusline customization only. |
| `pi-dynamic-workflows` | 1.0.1 | Extension | Useful display abstraction. Workflow tool streams snapshots through `onUpdate`; helper can also target `ctx.ui.setWidget` and `ctx.ui.setStatus`. |
| `pi-powerline-footer` | 0.9.0 | Extension | Heavy use of Pi footer/status/widget customization; useful only as UI primitive reference. |
| `@rezamonangg/pi-worktree` | 0.1.3 | Extension, skills | Uses Pi UI/status/custom prompts around worktree behavior; not a workflow progress model. |
| `pi-lsp` | 0.1.7 | Extension | LSP tools and some UI interactions; not a run-mode model. |
| `@ogulcancelik/pi-herdr` | 0.4.0 | Extension | Registers Herdr tools and uses `onUpdate`; relevant only as tool progress evidence. |
| `pi-paste-image` | 1.0.0 | Extension | Direct command and shortcut; simple status feedback only. |
| `pi-super-dev` | 0.3.0 | Extension, skill | Current extension. Has both foreground and background tool paths, but TUI default and slash command make normal use background. |
| `nowledge-mem-pi` | 0.8.5 | Extension, skills | Memory integration; no relevant foreground/progress pattern found. |

## Comparison Findings

### `pi-web-access`

`pi-web-access` registers foreground tools like `web_search` and streams search phases through `onUpdate` while the tool call remains open. Its `includeContent` branch can start a background fetch, but that is secondary work; the primary search returns a result. When background content finishes, it stores results with `appendEntry` and notifies the session with `sendMessage`.

It also has a direct `/websearch` command. The command opens a curator using the command handler context, calls `ctx.ui.notify`, manages its own abort controller, and sends follow-up results through `pi.sendMessage`. This is the closest model for "Pi command opens foreground UI" behavior.

### `pi-subagents`

`pi-subagents` is the closest model for a long-running agent command. Slash commands parse flags, build params, then call local extension code via `launchSlashSubagent(...)`. It defaults to foreground and only sets async/background when the user passes `--bg`. During foreground execution it updates `ctx.ui.setStatus`, listens for Escape through `ctx.ui.onTerminalInput`, and sends custom message entries for initial/final render state.

This supports the design direction for `pi-super-dev`: command handlers should not need to ask the LLM to call the extension's own tool.

### `pi-dynamic-workflows`

`pi-dynamic-workflows` is a useful display abstraction reference. Its workflow tool keeps a `WorkflowSnapshot`, updates it on phase/agent/log events, then renders either through `onUpdate` or through a Pi widget/status adapter. This is a cleaner shape than scattering UI calls throughout the runner.

## Requirements

### Functional Requirements

1. `/super-dev <task>` must run foreground by default in Pi TUI mode.
2. Foreground runs must keep the tool/command active until the pipeline completes, fails, or is cancelled.
3. Users must still be able to start detached/background runs explicitly, preferably with `/super-dev --bg <task>` and/or `/super-dev-bg <task>`.
4. The `super_dev` tool parameter `background` must remain supported for LLM/tool-call compatibility.
5. Progress must be surfaced through Pi-native APIs only: tool `onUpdate`, `ctx.ui.setWidget`, `ctx.ui.setWorkingMessage`, `ctx.ui.setStatus` where appropriate, `pi.appendEntry`, `pi.sendMessage`, and registered renderers.
6. No raw terminal loop, alternate terminal app, or separate TUI process should be introduced.
7. The full run log must continue to be persisted under `~/.super-dev/runs/`.
8. Foreground cancellation must use the active command/tool signal where possible, with Escape or Pi abort semantics. Background cancellation must keep using `/super-dev-stop` and the stored background `AbortController`.
9. Runtime user input/steering must continue to work for foreground and background runs.
10. Existing print/json/rpc behavior must not regress; foreground-by-default should apply to interactive command usage, not automation modes unless explicitly requested.

### UI Requirements

1. Foreground progress should show in Pi's standard tool result stream when running through the tool path.
2. Command-direct progress should show in a Pi widget and/or custom message renderer, not through repeated status-line spam.
3. The current dashboard component may be retained if it is mounted through `ctx.ui.setWidget`; that is Pi-native UI. If the goal is to remove project-specific dashboard code entirely, accept a simpler string-list widget with less structure.
4. Status/footer use should be conservative because this project already observed prompt/status-line churn in Herdr/Pi shells.
5. Final summaries should be durable through `appendEntry`/`registerEntryRenderer` or a final `sendMessage`, not only ephemeral notifications.

## Recommended Implementation Path

### Phase 1: Low-risk foreground default for slash command

Change `/super-dev` so it requests foreground explicitly:

```text
Use the super_dev tool with { task: <verbatim task>, background: false }.
```

Add `/super-dev-bg` or parse `--bg` to preserve the current detached behavior. This is small and immediately changes the observed user behavior, but it still depends on the LLM making the tool call correctly.

### Phase 2: Shared runner for direct command execution

Extract the internal `doRun(...)` behavior from the `super_dev` tool into a reusable function, for example:

```typescript
runSuperDevWithPiUi({
  pi,
  ctx,
  task,
  options,
  signal,
  background,
  progressSurface,
})
```

Then make both the tool `execute` and the slash command call this runner. The tool adapter can keep using `onUpdate`; the command adapter can use `ctx.ui.setWidget`, `setWorkingMessage`, and final `pi.sendMessage`/`appendEntry`. This removes model indirection and matches the `pi-subagents` command pattern.

### Phase 3: Simplify the progress display abstraction

Introduce a small display adapter similar to `pi-dynamic-workflows`:

- `update(snapshot)`
- `complete(snapshot)`
- `clear()`

Provide two adapters:

- Tool adapter: emits `onUpdate` text/details for foreground tool calls.
- Pi UI adapter: updates `ctx.ui.setWidget` and final durable entries for direct commands/background runs.

This lets the pipeline emit structured progress without knowing where it is rendered.

## Acceptance Criteria

1. Running `/super-dev fix X` in the Pi TUI starts a foreground run by default.
2. Running `/super-dev --bg fix X` starts a detached run and shows the existing background stop instructions.
3. Running the `super_dev` tool with `background: false` still blocks and streams foreground progress.
4. Running the `super_dev` tool with `background: true` still returns immediately and posts a final durable background summary.
5. Foreground progress is visible without custom terminal control or an external TUI process.
6. The dashboard/widget is cleared on success, failure, and abort.
7. The run log path is visible in the final summary.
8. No existing extension shortcut collision is introduced.
9. Unit tests cover slash command flag parsing and foreground/background dispatch.
10. Existing tests for dashboard rendering, live stream behavior, background delivery, and stop command remain green.

## Open Decisions

1. Should `/super-dev` direct command execution replace `sendUserMessage` in a later refactor, or is the explicit tool-instruction bridge acceptable long term?
2. Is the current dashboard acceptable because it is hosted by Pi `ctx.ui.setWidget`, or should it be simplified to a plain Pi string widget to reduce local UI code?

## Evidence Consulted

- Installed package list: `~/.pi/agent/settings.json` lines 2-21, plus `~/.pi/agent/npm/package.json` lines 4-22.
- Local package Pi registration: `package.json` lines 47-53.
- Current `super_dev` tool parameters and foreground/background switch: `src/extension.ts` lines 500-508 and 766-786.
- Current foreground stream/widget surfaces: `src/extension.ts` lines 524-538, 573-602, and 617-637.
- Current `/super-dev` command indirection: `src/extension.ts` lines 814-827.
- Public Pi extension APIs: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` lines 883-917.
- `pi-web-access` foreground progress and background fetch split: `~/.pi/agent/npm/node_modules/pi-web-access/index.ts` lines 806-848, 1482-1506, 1626-1629, 1722-1725, and 2641-2695.
- `pi-subagents` foreground slash-command pattern: `~/.pi/agent/npm/node_modules/pi-subagents/src/slash/slash-commands.ts` lines 580-760 and command registrations around 1181-1286.
- `pi-dynamic-workflows` display adapter pattern: `~/.pi/agent/npm/node_modules/pi-dynamic-workflows/src/display.ts` lines 75-112 and `src/workflow-tool.ts` lines 76-84.

## Conclusion

Yes, this extension can run foreground when invoked from Pi. The shipped safe change makes `/super-dev` and direct `super_dev` calls default to foreground, with explicit background mode through `/super-dev --bg`, `/super-dev-bg`, or `background: true`. A possible later refactor is to move the existing tool runner into a shared runner that the slash command can execute directly, while keeping progress on Pi-native UI surfaces.

The goal should be "no separate/raw TUI" rather than "no local rendering code at all." Pi provides UI primitives and render hooks; extensions still need to provide the workflow-specific lines/components they want Pi to display.
