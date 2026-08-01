# Implementation Summary: Recursive Dependency Bootstrap Before Build Gates

## Implemented

- Added dependency bootstrap before `runBuildGate` executes build/test/typecheck commands.
- Bootstrap discovers manifests recursively while pruning generated/vendor/cache directories.
- Supported bootstraps:
  - Node package managers: `pnpm`, `npm`, `yarn`, `bun`
  - Go: `go mod download`
  - Python: `poetry install --no-interaction`, `pipenv install --deploy`, or local `.venv/bin/pip install -r requirements.txt`
- Node modules are installed only when a package dir is missing `node_modules`.
- Pnpm workspaces install once at the workspace root.
- Independent nested modules with their own lockfile/package manager are bootstrapped in their own directory with their own manager instead of being swallowed by a root lockfile/workspace.
- Bootstrap is skipped entirely when no build/test/typecheck command is detected, preserving greenfield/no-command semantics.
- Bootstrap errors are blocking only for the root/primary gate install; unrelated nested module bootstrap failures do not block the gate.
- Bootstrap is cached by manifest/lockfile fingerprint to avoid repeated installs unless dependency manifests change.

## Tests

Updated/added:

- `src/build-runner.test.ts`
  - pnpm workspace bootstrap happens once before build/test;
  - nested independent pnpm module is honored even when root has `package-lock.json`;
  - nested optional bootstrap failure does not block the root gate;
  - no detected commands means no bootstrap.
- `tests/build-runner-nonregression.test.ts`
  - updated expected command accounting for dependency bootstrap.

## Validation

Passed:

```bash
npm run typecheck
npm test -- src/build-runner.test.ts tests/build-runner-nonregression.test.ts tests/npm-inscope.test.ts
```

Result: 3 test files, 84 tests passed.
