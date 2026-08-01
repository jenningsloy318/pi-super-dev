# Implementation Summary: Recursive .env Copy During Setup

## Implemented

- Added `copyEnvFilesToWorktree(sourceRoot, worktreeRoot)` in `src/setup.ts`.
- Setup now copies `.env` / `.env.*` recursively from source checkout into the created worktree before loading root `.env`.
- Copy routine prunes generated/vendor dirs and skips examples/templates/sample files.
- Copy routine does not overwrite existing destination env files and never throws.

## Tests

Added coverage in `tests/setup.test.ts` for:

- root `.env` copy,
- nested `apps/web/.env.local` copy,
- `.env.example` exclusion,
- `node_modules/pkg/.env` pruning,
- existing setup/worktree behavior remains intact.

## Validation

Passed:

```bash
npm run typecheck
npm test -- tests/setup.test.ts
```

Result: 1 test file, 7 tests passed.
