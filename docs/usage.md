# Usage

## Quick start

Install as a pi extension:

```bash
pi -e /path/to/pi-super-dev
```

Then from the pi TUI:

```text
/super-dev implement OAuth2 login with GitHub
```

Or the agent can call the tool directly:

```text
super_dev({ task: "add a POST /users endpoint with validation", skipWorktree: false })
```

## Tool options

| Option         | Type       | Default | Meaning                                                     |
|----------------|------------|---------|-------------------------------------------------------------|
| `task`         | `string`   | —       | The full development task (required).                       |
| `skipWorktree` | `boolean`  | `false` | Skip git worktree creation; operate in current directory.   |
| `skipStages`   | `string[]` | —       | Stage output keys to skip.                                  |
| `model`        | `string`   | —       | Model override for spawned specialists (`provider/id`).     |
| `maxAgents`    | `number`   | `200`   | Cap total specialist spawns.                                |

## What happens

1. **Setup** creates a git worktree (unless `skipWorktree`) and a spec dir.
2. **Classify** decides task type (feature / bug / refactor) and UI scope.
3. **Requirements → BDD → Research** run inside quality-gate loops (up to 3
   rounds each — the writer re-runs until a deterministic validator passes).
4. **Debug** only runs for bugs (branch).
5. **Assessment → Design → Prototype** — design is routed to the right
   specialist by `route-designer`; prototype only runs when the design
   declares numeric constants worth validating.
6. **Spec → Spec-review** — two more gate loops.
7. **Implementation** — per-phase TDD loop: tests → implement → QA → build
   gate, with up to 3 attempts per phase, commit on green.
8. **Code review** — parallel `code-reviewer` + `adversarial-reviewer`; results
   merged into a single verdict; loop up to 3 times with `implementer` fixes.
9. **Docs → Cleanup** — cleanup blocks the merge if it finds secrets or
   large binaries.
10. **Merge** — only runs when cleanup did not block.

## Composing your own workflow

The 13-stage pipeline is just one composition. Import the node builders and
stage modules to build your own:

```ts
import {
  runWorkflow,
  sequence, task, gate, branch, parallel, loop, retry, gateValidator,
} from "@jenningsloy318/pi-super-dev/pipeline";
import {
  setupStage, classifyStage,
  requirementsWriter, specWriter, implementationStage, docsWriter,
} from "@jenningsloy318/pi-super-dev/stages";

const minimal = {
  id: "minimal",
  description: "Requirements → spec → implement → docs.",
  root: sequence([
    task(setupStage),
    task(classifyStage),
    gate(
      { validate: gateValidator("gate-requirements", "write-requirements", "requirements"), attempts: 3 },
      task(requirementsWriter),
    ),
    task(specWriter),
    task(implementationStage),
    task(docsWriter),
  ], { tolerant: true }),
};

await runWorkflow(minimal, "add /health endpoint", { cwd: process.cwd() });
```

### Writing a new stage

A stage is `{ id, label, fatal?, run(state, ctx) }`. `state[id]` is the slot
its return value lands in. Add a new stage by writing a module in
`src/stages/`, then insert `task(myStage)` at the right place in the tree.

### Adding a new control-flow node

Everything is a `Node = { kind, run(state, ctx) }`. To add e.g. a
`raceAll(nodes)` node, write it in a project of your own and drop it into a
`sequence`. The runner never needs to change.

## Testing

```bash
npm run typecheck
npm test
```

Tests are LLM-free — no `pi` spawns, no network. They exercise the algebra,
the helpers, the parser, and the workflow composition graph.
