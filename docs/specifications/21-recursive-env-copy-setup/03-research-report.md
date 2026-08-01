# Research Report: Recursive .env Copy During Setup

## Finding

`git worktree add` creates a checkout from tracked files only. Local `.env` files are usually ignored and therefore absent from the worktree. Later super-dev phases start services and run tests inside the worktree, so apps that require local env values can fail before the assertion phase.

## Existing behavior

`runSetup()` loaded only root `.env` from `worktreePath` after worktree creation. If the file was ignored and existed only in the source checkout, it was not available in the worktree. Nested app env files were also never copied.

## Decision

Add a deterministic best-effort copy step after worktree creation and before `loadDotEnv(worktreePath)`. Copy `.env` and `.env.*` recursively into matching relative paths, pruning generated/vendor directories and excluding example/template/sample files.

## Rationale

- Preserves worktree isolation while carrying required local runtime configuration.
- Avoids modifying source checkout.
- Avoids copying examples/templates that are not secrets/config.
- Keeps setup deterministic and non-agentic.
