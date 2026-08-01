# Code Assessment: Setup Env Copy

## Files assessed

- `src/setup.ts`
- `tests/setup.test.ts`

## Current setup flow

1. Ensure git repo and initial commit.
2. Detect language/default branch.
3. Create worktree unless skipped/resuming.
4. Load `.env` from worktree.
5. Create spec directory and clear fresh-run state.

## Gap

Step 4 assumes `.env` already exists in the worktree. This is false for ignored env files, which are the common case.

## Implementation seam

Add a pure filesystem helper in `src/setup.ts`:

```ts
copyEnvFilesToWorktree(sourceRoot, worktreeRoot): string[]
```

Call it only when `worktreeCreated` is true, before `loadDotEnv(worktreePath)`.

## Risk

Copying secrets into a worktree is intentional because the worktree is the execution environment. Avoid copying into generated/vendor dirs and avoid examples/templates. Do not overwrite existing destination files.
