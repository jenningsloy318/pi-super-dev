# Dashboard v2 — research conclusion

**Date:** 2026-07-06
**Question:** How do we deliver the Claude-Code-style interactive workflow
dashboard (two-panel + `x stop` / `p pause` / `s save` keybindings) in Pi?
**Method:** read Pi's `tui.md`, `extensions.md`, `keybindings.md`, and the
canonical `plan-mode` + `todo.ts` examples.

## TL;DR

**The `setWidget` dashboard we shipped (v1.5) is already the idiomatic Pi
solution for the *visual* dashboard.** Mid-run panel keybindings (select /
pause / save à la Claude Code) are **not idiomatic in Pi** — they would require
`ctx.ui.custom()` input-takeover for the whole tool run, which is the one
genuinely risky/unverified path, for marginal value. Stop is already covered by
the built-in `Esc` (`app.interrupt`). **Recommendation: declare the dashboard
complete; do not pursue `custom()` for the run-duration UI.**

## Evidence

### 1. `setWidget` is THE idiomatic "persistent UI during a run"

`extensions.md:2670` calls out **`plan-mode`** as the canonical reference for
"All event types, `registerCommand`, `registerShortcut`, `registerFlag`,
`setStatus`, `setWidget`." Reading `examples/extensions/plan-mode/index.ts`:
its persistent todo panel during a session is rendered with
**`ctx.ui.setWidget("plan-todos", lines)`** (line 80), updated from event
handlers — exactly the pattern our v1.5 dashboard uses. It does **not** use
`ctx.ui.custom()` for the persistent panel.

### 2. `ctx.ui.custom()` is for *transient interactive dialogs*, not run UI

`tui.md` and `todo.ts`: `custom()` mounts a component that **owns terminal
input** until `close()`. The only `todo.ts` use is the interactive `/todos`
**command** view (a short, user-driven dialog). Mounting an input-owning
component for the *duration of a long tool run* is a different, undocumented
pattern whose interaction with the tool's `onUpdate` streaming is uncertain and
can't be verified without a live TUI. This is the risk I flagged earlier — and
the research shows it's the **wrong tool for the job**: Pi's idiomatic run UI is
`setWidget`, not `custom()`.

### 3. Stop is already covered — `Esc` = `app.interrupt`

`keybindings.md:85`: `app.interrupt | escape | Cancel / abort`. This is the
built-in, app-wide abort; it fires during streaming/tool runs (that's how you
abort any turn). So **a dedicated `x stop` keybinding is redundant** — Esc
already aborts the running `super_dev` pipeline (which respects `ctx.signal`).
The dashboard now shows `esc to abort` as a discoverable hint.

### 4. `registerShortcut` exists but mid-run firing is uncertain

`pi.registerShortcut(...)` (extensions.md:1529) registers global shortcuts.
plan-mode uses it for a toggle. But there is **no documented guarantee** that a
custom shortcut fires while a tool is actively executing (the agent is "busy");
only the special `app.interrupt` (Esc) is documented as working mid-run. So a
custom "stop super-dev" shortcut *might* not fire mid-run — and even if it did,
Esc already covers stop.

## Resolution by feature

| v2 feature | Status | Mechanism |
|------------|--------|-----------|
| Two-panel visual (stages + live activity) | ✅ **Done** | `setWidget` (v1.5) — idiomatic, plan-mode pattern |
| `x stop` | ✅ **Covered** | Built-in `Esc` (`app.interrupt`); hint shown in widget |
| `↑↓ select` | ❌ **Not idiomatic** | Would need `custom()` input-takeover — wrong tool for run UI |
| `s save` (mid-run snapshot) | ⏸ **Deferred** | Needs mid-run input (uncertain); not worth the `custom()` risk |
| `p pause` | ⏸ **Deferred** | Needs a new control-flow pause gate + mid-run input |

## Why not build the `custom()` version anyway

- It fights Pi's model: persistent run UI is `setWidget`; `custom()` is for
  dialogs. Going against the grain risks a fragile mount/unmount lifecycle
  around a long, abortable, streaming tool execution.
- It can't be verified without a live TUI run (same caveat category as the
  safety hook) — and the payoff is a dedicated save/pause key, not the visual
  dashboard (which `setWidget` already delivers).
- The original ask ("like Claude Code's workflow UI") was primarily about
  **global visibility of a long pipeline** — which the `setWidget` dashboard
  delivers. The mid-run keybindings were a secondary Claude-Code parity detail,
  and Pi's interaction model differs by design (Esc, not panel keys).

## What changed in code

- `renderDashboard` now appends an `esc to abort` footer line (TUI only), so
  the idiomatic stop mechanism is discoverable. No `custom()` introduced.

## Recommendation

**Declare Dashboard complete at the `setWidget` level.** Revisit `custom()` /
pause / mid-run save only if real usage shows the `setWidget` dashboard + Esc is
insufficient — and only then, behind a live-TUI-verified experiment.
