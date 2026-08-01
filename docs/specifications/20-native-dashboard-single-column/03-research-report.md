# Research Report: Native Single-Column Dashboard

## Inputs

- User screenshots showing the two-column grid mixing completed and running jobs.
- Existing `src/render/dashboard.ts` widget rendering code.
- Pi native rendering examples where command/tool outputs use distinct boxed/background sections.

## Findings

- The two-column grid saves vertical space but harms scanability during long runs because completed and active stages are displayed side by side with weak separation.
- A single-column grouped layout is more native to Pi's transcript model: header, current/progress row, section separator, rows.
- Recent logs should not all be dimmed equally. Tool/command lines (`→ web_search`, `$ ...`, `read`, `edit`, etc.) should be visually distinct from ordinary progress narration.

## Decision

Replace the stage grid with status-grouped single-column sections:

1. running
2. completed
3. needs attention
4. skipped
5. pending

Render recent tail as `recent commands / progress`, with command-like rows using accent styling and progress rows using dim styling.
