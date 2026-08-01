# Requirements: Native Single-Column Super-Dev Dashboard

## Problem

The live background dashboard used a two-column grid and dim rolling recent logs. In active runs this made finished and running stages visually blend together, with no clear separators between status groups and no clear distinction between commands/progress and ordinary log output.

## Acceptance Criteria

- **AC-01 Single column**: Stage rows render in a single column; no stage row combines two stages.
- **AC-02 Status grouping**: Running, completed, failed, skipped, and pending stages are separated with visible section headers.
- **AC-03 Status signs**: Each stage row keeps a status glyph and theme color.
- **AC-04 Recent command distinction**: Recent command/tool lines are visually distinguished from normal progress/log lines.
- **AC-05 No dropped stages**: All stages still appear, regardless of count or terminal width.
- **AC-06 Existing header behavior**: Header still shows done/total, elapsed time, running stage, and stop hint.
