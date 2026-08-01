# Analysis: Change Tracker Untracked Directory False Miss

## Run symptom

The `25-agent-team-runtime` super-dev run finished with:

```text
Impl: 0/4 phases completed
Review: skipped
Merged: skipped
```

Stage 9 stopped at Phase 1 after repeated failures.

## Root cause

The final Phase 1 attempts had build, deliverable, and symbol checks passing, but the phase still failed because the change gate saw claimed-created files as not actually changed.

The tracker recorded claims like:

```text
src/team/types.ts
src/team/default-team.ts
src/team/raci.ts
...
```

but git actual changes included only:

```text
src/team/
```

This happens because default `git status --porcelain` can collapse an untracked directory to `?? src/team/` rather than listing every file inside it. The change tracker then compared claimed file paths against a directory path and produced false `claimedNotChanged` entries.

## Research

Git documentation confirms that untracked directory expansion requires:

```bash
git status --porcelain --untracked-files=all
```

or equivalent `-uall`.

## Fix

Update `ChangeTracker` to call:

```ts
git status --porcelain --untracked-files=all
```

This makes git actual created paths file-granular, matching agent claims.

## Validation

Added a regression test ensuring:

- status calls include `--untracked-files=all`;
- expanded untracked files match claimed created files;
- no false `claimedNotChanged` is produced.
