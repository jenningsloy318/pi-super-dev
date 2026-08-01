# Specification: Native Single-Column Dashboard

## Layout

`packDashboardLines()` returns:

1. Header: `super-dev · done/total · elapsed · running-stage (stop hint)`
2. Optional current activity row: `▶ ...`
3. Optional runtime instruction row: `📥 N runtime instruction(s) · latest: ...`
4. Stage sections:
   - `── running ──`
   - `── completed ──`
   - `── needs attention ──`
   - `── skipped ──`
   - `── pending ──`
5. Optional recent section:
   - `── recent commands / progress ──`
   - command rows prefixed `›`
   - progress rows prefixed `·`

## Theming

- Running section header: accent.
- Completed section header: success.
- Needs attention section header: error.
- Skipped section header: warning.
- Pending and non-command progress: dim.
- Command-like recent rows: accent.

## Compatibility

- Public helper signatures remain compatible except `opts` supports `latestInputPreview` already.
- Widget factory remains a Pi component factory.
- No runtime engine changes.
