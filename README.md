# @jenningsloy318/pi-super-dev

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

```bash
pi package add @jenningsloy318/pi-super-dev
# or, from a local checkout:
pi -e /path/to/pi-super-dev
```

## Use

```text
# From the pi TUI:
/super-dev implement user authentication with OAuth2

# Or directly via the tool call the agent will make:
super_dev({ task: "fix the crash on large file upload" })
```

Tool options: `skipWorktree`, `skipStages`, `model`, `maxAgents`.

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
import { runWorkflow, sequence, task, gate, gateValidator, /* ... */ } from "@jenningsloy318/pi-super-dev/pipeline";
import { requirementsWriter, specWriter, implementationStage } from "@jenningsloy318/pi-super-dev/stages";

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
