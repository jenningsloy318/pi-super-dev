---
name: super-dev
description: Self-contained 13-stage development pipeline built on a composable control-flow node algebra (branch/parallel/loop/retry/gate). Orchestrates requirements, research, design, specification, TDD implementation, code review, documentation, and merge through 21 specialist agents spawned directly as `pi` subprocesses. No external workflow engine required.
---

# Super Dev

Use this skill when the user asks to implement a feature, fix a bug, refactor code, or do systematic multi-stage development work.

## When to use

Triggers: "implement", "build", "fix bug", "refactor", "add feature", "develop this", "help me build", "optimize performance", "resolve deprecation".

Do NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits.

## Action

Use the `super_dev` tool to start the pipeline. It spawns 21 specialist `pi` subagents directly — there is no `workflow_run` tool and no dependency on pi-workflow.

```text
super_dev({ task: "<user's full request>" })
```

Optional flags:
- `skipWorktree: true` — operate in the current directory instead of a git worktree.
- `model: "provider/id"` — override the model used by spawned specialists.
- `maxAgents: 200` — cap total specialist spawns.

Preserve the user's language, file references, and constraints verbatim in the `task`.

The user can also invoke the pipeline via the `/super-dev` command:

```text
/super-dev <task description>
```
