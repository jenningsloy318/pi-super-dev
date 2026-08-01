# Specification: Recursive .env Copy During Setup

## Function

Add:

```ts
copyEnvFilesToWorktree(sourceRoot: string, worktreeRoot: string): string[]
```

Behavior:

- return copied relative paths;
- no-op when source and destination resolve to same path;
- recursively visit source root;
- prune: `.git`, `.worktree`, `node_modules`, `target`, `dist`, `build`, `.next`, `.nuxt`, `vendor`, `.venv`, `venv`, `__pycache__`;
- copy files whose basename starts with `.env`;
- skip names containing `example` or `template` and names ending `.sample`;
- create destination parent directories;
- do not overwrite existing destination files;
- swallow per-file and traversal errors.

## Integration

In `runSetup()` after worktree path is resolved:

```ts
if (worktreeCreated) copyEnvFilesToWorktree(cwd, worktreePath);
loadDotEnv(worktreePath);
```

This ensures root `.env` is copied before being loaded into `process.env`.
