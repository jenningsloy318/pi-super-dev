# Code Assessment: Dashboard Rendering

## Files assessed

- `src/render/dashboard.ts`
- `src/render/dashboard.test.ts`
- `src/render/dashboard-widget.test.ts`
- `tests/dashboard.test.ts`

## Existing behavior

`packDashboardLines()` used a column-first two-column layout:

- split entries into two halves,
- render left and right stages on one row,
- show a dim `recent` tail.

## Issues

- Running and completed stages can appear in the same visual band.
- Failed/skipped/pending stages are not sectioned.
- Recent command/progress lines are all dimmed equally.
- In wide terminals, the two-column layout still reads more like a dense table than a Pi-native transcript/status card.

## Implementation target

Keep `packDashboardLines()` pure and update only its layout logic. This avoids changing extension runtime behavior and keeps widget factory compatibility.
