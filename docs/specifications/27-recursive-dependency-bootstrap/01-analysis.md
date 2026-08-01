# Analysis: Recursive Dependency Bootstrap Before Build Gates

## Problem

Super-dev creates isolated git worktrees. Git worktrees do not include ignored dependency directories such as `node_modules/`, `frontend/node_modules/`, or `auth-service/node_modules/`.

A build gate may then fail before it reaches application code:

```text
auth-service build: sh: tsc: command not found
frontend build: sh: next: command not found
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

This blocks implementation phases even when the actual code changes are correct.

## Root cause

`runBuildGate()` ran detected build/test/typecheck commands but did not ensure dependencies were present in the newly-created worktree.

In polyglot or multi-module repositories, dependency setup can be needed in multiple places:

- Node/Pnpm/Yarn/Npm workspaces
- Go modules
- Poetry/Pipenv/Python requirements with local venvs

## Design

Before the build/test/typecheck commands, run a best-effort dependency bootstrap:

- Node package dirs with missing `node_modules`:
  - `pnpm install --frozen-lockfile` at the workspace root when a pnpm workspace/lock is present
  - `npm ci` when `package-lock.json` exists
  - `npm install` otherwise
  - `yarn install --frozen-lockfile` / `bun install --frozen-lockfile` when detected
- Go modules:
  - `go mod download`
- Python:
  - `poetry install --no-interaction`
  - `pipenv install --deploy`
  - `.venv/bin/pip install -r requirements.txt` when a local venv exists
- Rust:
  - no separate bootstrap; cargo build/test fetches dependencies naturally and separate `cargo fetch` would add noisy command accounting.

## Safeguards

- Prune generated/vendor/cache directories during manifest discovery.
- Do not run global `pip install` without a local venv.
- Cache dependency bootstrap by manifest/lockfile fingerprint to avoid repeating work within a run unless manifests change.
- If bootstrap fails, fail the build gate clearly and skip build/test/typecheck commands that would only produce redundant command-not-found noise.

## Validation

Added tests proving a pnpm workspace is bootstrapped exactly once before build/test when `node_modules` are missing.
