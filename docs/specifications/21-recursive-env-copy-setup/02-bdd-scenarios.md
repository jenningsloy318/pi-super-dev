# BDD Scenarios: Recursive .env Copy During Setup

## SCENARIO-001 — Root .env copied

Given the source checkout contains `.env`
When setup creates a worktree
Then the worktree contains `.env` with the same content.

## SCENARIO-002 — Nested .env.local copied

Given the source checkout contains `apps/web/.env.local`
When setup creates a worktree
Then the worktree contains `apps/web/.env.local` with the same content.

## SCENARIO-003 — Example env is not copied

Given the source checkout contains `apps/web/.env.example`
When setup creates a worktree
Then the worktree does not contain `apps/web/.env.example` from this copy routine.

## SCENARIO-004 — Generated directories are pruned

Given the source checkout contains `node_modules/pkg/.env`
When setup creates a worktree
Then the worktree does not contain `node_modules/pkg/.env`.

## SCENARIO-005 — Skip worktree is in-place

Given setup runs with `skipWorktree=true`
When setup completes
Then no recursive env copy is attempted because source and destination are the same checkout.
