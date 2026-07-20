# pi-super-dev

A **self-contained**, modular development pipeline for the [Pi coding
agent](https://github.com/earendil-works/pi-coding-agent), built on a
composable **control-flow node algebra** (branch / parallel / loop / retry /
gate / map / wait).

Runs the 13-stage super-dev workflow — requirements → BDD → research →
[debug] → assessment → design → [prototype] → spec → spec-review → TDD
implementation → parallel code review → docs → cleanup → merge — by spawning
21 specialist `pi` subagents directly. **No dependency on `@agwab/pi-workflow`
or any other external workflow engine.**

## Install

Install it from **npm** or **GitHub** (your choice):

```bash
# 1) npm — published package
pi install npm:pi-super-dev

# 2) GitHub — latest on the default branch
pi install git:github.com/jenningsloy318/pi-super-dev
#    …or pinned to a release tag:
pi install git:github.com/jenningsloy318/pi-super-dev@v0.1.2
```

Try it without installing (temporary, this run only):

```bash
pi -e npm:pi-super-dev
pi -e git:github.com/jenningsloy318/pi-super-dev
# from a local checkout:
pi -e /path/to/pi-super-dev
```

Project-scoped install (writes `.pi/settings.json` instead of user settings, so
your team shares it):

```bash
pi install -l npm:pi-super-dev
```

Requires the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).
`pi install` runs `npm install`, but this package has only `peerDependencies`
(pi bundles them), so there's nothing extra to download.

## Use

```text
# From the pi TUI:
/super-dev implement user authentication with OAuth2

# Or directly via the tool call the agent will make:
super_dev({ task: "fix the crash on large file upload" })
```

Tool options: `skipWorktree`, `skipStages`, `model`, `maxAgents`.

## Configuration

The deterministic build gate (Stage 9 verify / 9.2 implementation / 11 merge)
runs `build`, `test`, and `typecheck` (and Rust `clippy`) against your
worktree. It is **scope-aware**: on Rust workspaces it can narrow all three
commands to the crates the current branch actually touched and treat
pre-existing out-of-scope failures as ignorable, so it stops false-failing
and false-aborting on messy real-world monorepos. Three **optional
environment variables** tune its timeout and scope **without editing any
stage call site** — the harness resolves them internally, so the three
callers keep passing only `{ signal }`.

**`SUPER_DEV_BUILD_TIMEOUT_MS`** — per-command timeout override in
milliseconds (base-10 integer). The default is 600_000 ms (10 minutes); a
too-short timeout previously caused false FAILs on slow first-time Rust
compiles before the build finished. Falls back to the default when the var is
unset, empty, not-a-number, or `<= 0`. Give every cargo / build / typecheck
command up to 15 minutes:

```bash
SUPER_DEV_BUILD_TIMEOUT_MS=900000 pi super-dev fix ...
```

**`SUPER_DEV_BUILD_TEST_PACKAGES`** — a comma-separated list of Cargo **crate
names** that forces the gate to scope all three commands (`build`, `test`,
`clippy`) to those packages (`-p <pkg> ...`) instead of running
workspace-wide. Crate names are bare package names, **not paths** — e.g.
`api,store`, not `crates/api,crates/store` (a leading `crates/` is passed
verbatim to cargo and produces an invalid package spec). This lets the gate
reach green on a Rust workspace whose other crates carry pre-existing,
unrelated failures — **without mutating the target repo** (no `#[ignore]`,
no quarantine, no file writes). Applied **only when the detected language is
`rust`** and the list is non-empty; go/python/node/mixed stacks ignore it
entirely, and empty/missing falls back to auto-detection (below) or a
workspace-wide build. Scope the gate to two crates, ignoring the rest of the
workspace:

```bash
SUPER_DEV_BUILD_TEST_PACKAGES="api,store" pi super-dev fix ...
```

**`SUPER_DEV_GATE_BASE_REF`** — the git ref the gate diffs against to
**auto-detect touched crates** when neither an explicit package list nor
`SUPER_DEV_BUILD_TEST_PACKAGES` is set. The gate runs
`git -C <worktree> diff --merge-base <baseRef> --name-only`, maps every
`crates/<pkg>/...` path to `<pkg>`, de-dupes (first-seen order), and scopes
all three commands to that set. Defaults to `main`; set it for repos whose
default branch is `develop`, `master`, or `trunk`:

```bash
SUPER_DEV_GATE_BASE_REF=develop pi super-dev fix ...
```

Auto-detection is a safe degradation: on any git error, empty diff, a
non-`crates/<pkg>/` layout (top-level member dirs, `members=["*"]`), or a
base ref that does not resolve, it returns `[]` and the gate falls back to
the byte-identical workspace-wide behavior (no `-p` flags). Note: this means
the feature is silently inactive on repos that don't follow the
`crates/<pkg>/` convention — see the scope-aware build-gate spec for known
limitations and future work (full baseline-diff).

Package-set **precedence** (highest → lowest): explicit `opts` argument →
`SUPER_DEV_BUILD_TEST_PACKAGES` → auto-detected touched crates →
workspace-wide. The git-diff spawn is skipped when a higher-precedence source
supplies a value. All three variables can be combined on a Rust workspace:

```bash
SUPER_DEV_BUILD_TIMEOUT_MS=900000 \
SUPER_DEV_BUILD_TEST_PACKAGES="api,store" \
SUPER_DEV_GATE_BASE_REF=develop \
  pi super-dev fix "add OAuth2 login"
```

Internals: timeout resolution lives in `resolveTimeoutMs()`, package scoping
in `scopedCargoArgs()` / `scopedCargoBuildArgs()` / `scopedCargoTestArgs()` /
`scopedCargoClippyArgs()`, auto-detection in `detectTouchedCargoPackages()`,
and in-scope classification in `classifyOutOfScopeErrors()` (all in
`src/build-runner.ts`). The implementation retry loop (Stage 9.2) treats a
gate result as GREEN when `gate.pass || gate.inScopePass`, logging any ignored
pre-existing out-of-scope failures, and terminates early only on genuine
in-scope failures. See the JSDoc on `DEFAULT_TIMEOUT_MS` for the full timeout
fallback matrix.

## Architecture

```
extension.ts  ──►  registers  super_dev tool + /super-dev command
      │
      ▼
pipeline.ts / workflow.ts  ──►  runs a tree of Nodes
      │
      ▼
stages/index.ts            ──►  the pipeline expressed with control nodes
      │
      ├─ nodes.ts        the control-flow algebra
      ├─ helpers.ts      12 deterministic helpers (classify, gates, routing)
      ├─ prompts.ts      prompt builders for every specialist
      ├─ agents.ts       loads agents/<name>.md (21 specialists)
      ├─ pi-spawn.ts     spawns `pi` subprocesses (self-contained)
      └─ control.ts      tolerant <control> JSON extractor
```

### Control-flow node algebra (`src/nodes.ts`)

| Node                              | Purpose                                                            |
|-----------------------------------|--------------------------------------------------------------------|
| `task(stage)`                     | Leaf — runs a `Stage`, stores return value at `state[stage.id]`    |
| `sequence([...], {tolerant?})`    | Ordered composition — fail-fast by default, tolerant continues     |
| `branch(pred, {yes, no?})`        | Conditional — take one path or skip                                |
| `choose([{when, run}, ...])`      | Multi-way switch — first matching case                             |
| `parallel([...], {into?, join?})` | Fork-join — run branches concurrently, merge results               |
| `loop({while?, until?, times?})`  | Iterate a body until a condition holds                             |
| `retry({attempts, backoff?})`     | Re-run a node on failure (AWS Step Functions "Retry" semantics)    |
| `gate({validate, attempts})`      | Write → validate → re-write (quality-gate loop for LLM outputs)    |
| `map({over, as, concurrency?})`   | Fan out a body over a collection                                   |
| `wait(ms)` / `waitForEvent(name)` | Time or event synchronization                                      |
| `tryCatch(body, {catch, finally})`| Error boundary (catches thrown fatal-task errors)                  |
| `noop()`                          | Identity                                                           |

Grounded in [AWS Step Functions ASL](https://states-language.net/), the [Workflow Control Patterns](http://workflowpatterns.com/) taxonomy (van der Aalst), Temporal workflows, and LangGraph.

### The pipeline (`src/stages/index.ts`)

```ts
sequence([
  task(setupStage),                                // fatal
  task(classifyStage),
  gate({ validate: gateValidator(...), attempts: 3 }, task(requirementsWriter)),
  gate({ validate: gateValidator(...), attempts: 3 }, task(bddWriter)),
  gate({ validate: researchComplete, attempts: 3 }, task(researchWriter)),
  branch(isBug, { yes: task(debugWriter) }),
  task(assessmentWriter),
  task(designStage),
  task(prototypeStage),
  gate({ validate: gateValidator(...), attempts: 3 }, task(specWriter)),
  gate({ validate: gateValidator(...), attempts: 3 }, task(specReviewWriter)),
  task(implementationStage),                       // per-phase TDD loop
  loop({ until: reviewApproved, times: 3 },
    sequence([
      parallel([codeReview, adversarialReview], { into: "review", join: mergeVerdicts }),
      branch(reviewApproved, { no: reviewFix }),
    ])),
  task(docsWriter),
  task(cleanupTask),
  branch(notBlocked, { yes: task(mergeWriter) }),
], { tolerant: true })
```

### Customize

Compose your own pipeline by importing the node builders:

```ts
import { runWorkflow, sequence, task, gate, gateValidator, /* ... */ } from "pi-super-dev/pipeline";
import { requirementsWriter, specWriter, implementationStage } from "pi-super-dev/stages";

const custom = {
  id: "quick",
  root: sequence([
    gate({ validate: gateValidator("gate-requirements", "write-requirements", "requirements"), attempts: 2 },
         task(requirementsWriter)),
    task(specWriter),
    task(implementationStage),
  ]),
};

await runWorkflow(custom, "add a health endpoint", { cwd: process.cwd() });
```

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — LLM-free unit tests
```

The test suite is fully hermetic (no `pi` spawns, no network): control-flow
algebra semantics, deterministic helpers, control-JSON parsing, workflow
composition integrity, package structure.

## License

MIT
