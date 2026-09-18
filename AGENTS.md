# Repository Instructions

## Session start — update watch (FIRST thing, every pi session)

Before any other work, run the update watch:
1. **Version-drift check** (the version-skew incident class, see v0.3.63): compare the
   on-disk pi-subagents version (`node -e "console.log(require(process.env.HOME + '/.pi/agent/npm/node_modules/pi-subagents/package.json').version)"`)
   against the version this running pi session loaded in memory. If they differ, tell
   the user to restart pi BEFORE launching any delegated run — an in-memory 0.64 owner
   spawning children against on-disk 0.65+ kills every child (observed three times,
   2026-09-04/05).
2. **Read `docs/upstream-watch.md`**: re-check every open watch item against the
   currently installed versions; strike items upstream has fixed; append newly
   discovered upstream gaps (e.g. the pi 0.85.1 background-children pi-server gap).
3. **New releases**: `npm view pi-subagents version` and the pi changelog — flag any
   release touching the contract surface (C1-C6 in upstream-watch.md).

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
- **Read before edit — grep only locates (P11).** grep/rust-grep finds matching LINES, never the surrounding control flow, the caller's invariants, or the sibling branch the match sits in. Two shipped fixes in this repo were self-defeating purely because a grep-derived conclusion substituted for reading the function ('design never stamps' — false; a full read showed `design.ts:29-30` stamps on every dispatch). Binding discipline in this repo: (1) grep to FIND the file/line, (2) then READ the whole function or module region (offset/limit in segments for large files — never rely on the match alone), (3) read the callers and the referenced modules when the change touches a contract, (4) only then edit. The extension's specialist agents carry the same instruction in their prompts and definitions (see `READING DISCIPLINE` in `src/prompts.ts` and the `## Reading discipline` section in each `agents/*.md`) — prompts are advisory (P4), so this rule is about cutting the bug-introduction rate, not a hard gate.

## Modularization and granularity standard (BINDING — how features land)

Grounding (2026-09-18 research): there is no meaningful universal line-count standard —
the durable rules are the Single Responsibility Principle (a module has one reason to
change), the Common Closure Principle (things that change together live together), and
high cohesion / low coupling between parts. Line count is only a *smell trigger* for
review, never the rule: a 700-line file with one reason to change beats a 200-line file
with three. This repo's own history is the evidence — stage.ts reached 3,038 lines not
by any single bad decision but by control-flow-dense regions accreting behind one
function signature; the 15-increment split (v0.4.29–v0.4.43) exists to undo exactly that.

### The module kinds (the house grammar — match the feature to the kind)

1. **Pure helpers** — stateless functions over data (red-evidence.ts style). Smallest
   granularity; no I/O, no state, trivially testable.
2. **Adjudicators** — one control-flow-dense decision region returning an outcome union
   (protection-gate, inherited-red-ladder, no-progress-valve). The module owns the
   decision and its carriers; it NEVER owns loop counters, run-state guards (P3), or
   caller let-writes.
3. **Record builders** — a sequential block with side effects producing one wide record,
   no exits (gate-suite). When a region has no loop exits, do not invent a union.
4. **Boundary closers** — stage/phase transitions with in-module side effects plus a
   small outcome (phase-tail, green-boundary).
5. **Dispatchers** — agent calls and their interpretation (research-assist-dispatch).

### Granularity rules for a complex feature

- **Decompose by reason to change first** (CCP/SRP): dispatch, adjudication, data prep,
  and interpretation change for different reasons — they are different modules even
  when they land in one PR. The stage/workflow caller keeps only loop counters, P3
  run-state guards, let-writes, and thin outcome interpretation.
- **One control-flow-dense region per module.** If an extraction needs to carry two
  loop-exit surfaces, it is two extractions (the env-blocker split is the precedent).
- **The caller contract is data, not control**: outcome unions carry ONLY the bindings
  each arm owns; loop-counter mutations stay caller-side; shared values live at
  common-ancestor scope (P6).
- **Wrong-seam signals** (re-slice, don't force): the input interface exceeds ~30 fields;
  two reviewers read the same module for unrelated reasons; a second loop-exit surface
  appears mid-extraction; the module needs a paragraph to explain what it owns.
- **Review smells, not caps**: a file >800 lines triggers the question "what are this
  file's reasons to change?" during review — the answer decides, not the number. New
  files should still be explainable in one screen; if not, find the seam.

### Landing discipline (unchanged from the campaign)

Byte-faithful moves; contract tests pinning exit semantics; dual gates (code +
adversarial) before commit; KNOWN_PARTS/source-surface tripwire registration for every
new part; a new feature touching an oversized file lands as a new sibling module the
big file invokes — "just append it" is how stage.ts happened.

## Versioning (existing rules)

- After every fix or feature implementation that changes this extension, bump the runtime extension version in `src/version.ts` before committing. Runtime versions use npm-valid semver without leading zeroes. Patch values run from `1` to `99`; after patch `99`, bump minor and reset patch to `1`; after minor `99`, bump major and reset minor and patch to `1`.
- In the same commit, align `package.json` and `package-lock.json` to the exact same version as `src/version.ts`.
- Include all version bumps in the same commit as the fix or feature.
- For deep online research in this repository, try search tools in this order: AnySearch first, then Firecrawl MCP/CLI, then Tavily remote MCP, then Tinyfish.
