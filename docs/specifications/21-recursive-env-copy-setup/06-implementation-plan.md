# Implementation Plan: Recursive .env Copy During Setup

1. Add recursive env-copy helper to `src/setup.ts`.
2. Call helper only when setup created or reused an isolated worktree.
3. Keep `skipWorktree` in-place behavior unchanged.
4. Add setup regression test with root `.env`, nested `.env.local`, `.env.example`, and `node_modules/pkg/.env`.
5. Run typecheck and setup tests.
