---
name: super-dev
description: 13-stage development pipeline for implementing features, fixing bugs, and refactoring. Orchestrates requirements, research, design, specification, implementation, code review, documentation, and merge through specialized AI agents.
---

# Super Dev

Use this skill when the user asks to implement a feature, fix a bug, refactor code, or do systematic multi-stage development work.

## When to use

Triggers: "implement", "build", "fix bug", "refactor", "add feature", "develop this", "help me build", "optimize performance", "resolve deprecation".

Do NOT trigger on: simple questions, file searches, one-off commands, code explanations, quick edits.

## Action

Use the `workflow_run` tool to start the pipeline:

```text
workflow_run({ workflow: "super-dev", task: "<user's full request>" })
```

Preserve the user's language, file references, and constraints in the task.

The user can also invoke directly via the `/super-dev` command:

```text
/super-dev <task description>
```
