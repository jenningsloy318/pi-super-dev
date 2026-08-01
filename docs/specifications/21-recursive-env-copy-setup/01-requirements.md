# Requirements: Recursive .env Copy During Setup

## Problem

Git worktrees do not copy ignored local environment files. Many applications require `.env`, `.env.local`, `.env.test`, or nested app/service env files to start during build, QA, or integration testing.

## Acceptance Criteria

- **AC-01 Recursive copy**: After setup creates an isolated worktree, recursively copy `.env` and `.env.*` files from the source checkout into the matching relative paths in the worktree.
- **AC-02 Nested apps**: Nested env files such as `apps/web/.env.local` and `services/api/.env` are copied.
- **AC-03 Skip examples/templates**: `.env.example`, `.env.template`, and sample files are not copied.
- **AC-04 Prune generated/vendor dirs**: Do not scan/copy env files from `.git`, `.worktree`, `node_modules`, `target`, `dist`, `build`, `.next`, vendor/venv/cache directories.
- **AC-05 No overwrite**: Do not overwrite an env file that already exists in the worktree.
- **AC-06 In-place safety**: When setup is running in-place (`skipWorktree`), do not copy env files onto themselves.
- **AC-07 Best effort**: Env copy failures must not abort setup.
