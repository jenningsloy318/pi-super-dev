# Implementation Plan: Native Single-Column Dashboard

1. Replace the two-column stage packing in `packDashboardLines()` with grouped single-column sections.
2. Keep all stage rows visible and preserve status glyphs.
3. Rename the recent section to `recent commands / progress`.
4. Style command-like recent rows differently from ordinary log/progress rows.
5. Update dashboard unit tests that asserted two-column counts.
6. Run typecheck and dashboard-focused tests.
