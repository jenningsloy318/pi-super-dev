# Repository Instructions

## Engineering methodology (BINDING — read before any fix or feature)

The full methodology lives in `docs/methodology/`: 00-principles.md (constitution),
01-analysis.md (incident protocol + escape-class taxonomy), 02-design.md (contracts,
FMEA, pre-mortem, concurrency checklist), 03-architecture.md (invariants), 04-quality.md
(definition of done, AST contract tests, lanes, review checklist), 05-findings-*.md
(live findings backlog). Read `docs/methodology/00-principles.md` and
`01-analysis.md` before the first fix of any session; consult 02/03/04 before any
design change, concurrency change, or parser change.

Non-negotiables distilled from 415 commits / 20 fix releases in 3 days:
- No fix without: engine-machinery reproduction → root cause (file:line) → escape class → class-level fix + class-level tests (P7).
- No concurrency change without a written failure-path table (promise × reject/abandon × shared-file writers × loop bounds) and per-cell tests (P3).
- External-text parsers ship with an enumerated grammar table (all mainstream forms), not one-form-at-a-time fixes (P2). A third fix to the same grammar = STOP and enumerate.
- Prompts are advisory: anything that must hold has a mechanical enforcement or a fail-open design that is harmless when disobeyed (P4).
- Checker failures (timeout/violation/spawn error) never punish the work under review; only evidence about the work is fail-closed (P5).
- Cross-module contracts get dynamic cross-check tests; shared values live at common-ancestor scope (P6).
- Every retry loop has a proven bound + a test that provokes it (P8).
- Logs are honest: located errors, `(ran: …)`, unknowns stay unknown, discards named (P10).

## Versioning (existing rules)

- After every fix or feature implementation that changes this extension, bump the runtime extension version in `src/version.ts` before committing. Runtime versions use npm-valid semver without leading zeroes. Patch values run from `1` to `99`; after patch `99`, bump minor and reset patch to `1`; after minor `99`, bump major and reset minor and patch to `1`.
- In the same commit, align `package.json` and `package-lock.json` to the exact same version as `src/version.ts`.
- Include all version bumps in the same commit as the fix or feature.
- For deep online research in this repository, try search tools in this order: AnySearch first, then Firecrawl MCP/CLI, then Tavily remote MCP, then Tinyfish.
