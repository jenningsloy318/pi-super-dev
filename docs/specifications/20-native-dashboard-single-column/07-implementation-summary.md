# Implementation Summary: Native Single-Column Dashboard

## Implemented

- Replaced the old two-column dashboard stage grid with single-column grouped sections.
- Added visible section separators for:
  - running
  - completed
  - needs attention
  - skipped
  - pending
- Kept status glyphs and theme colors for every stage row.
- Renamed recent log tail to `recent commands / progress`.
- Styled command/tool-like recent rows separately from ordinary progress rows.
- Preserved header behavior: done/total, elapsed, running stage, and stop hint.

## Tests updated

- `src/render/dashboard.test.ts`
- `src/render/dashboard-widget.test.ts`
- `tests/dashboard.test.ts`

## Validation

Passed:

```bash
npm run typecheck
npm test -- src/render/dashboard.test.ts src/render/dashboard-widget.test.ts tests/dashboard.test.ts
```

Result: 3 test files, 90 tests passed.
