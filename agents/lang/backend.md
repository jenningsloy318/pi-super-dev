---
language: backend
---

# Backend specialist profile (Node 22 / Hono / Python / FastAPI)

## Commands
- Node: package manager `pnpm`/`npm`. Build: `pnpm build`. Lint: `pnpm lint`. Test: `pnpm test` (vitest/jest). TypeScript strict. Python: `uv`/`pip`, `pytest -q`, `mypy`.
- Coverage target ≥ 80%, with integration tests alongside unit tests.

## Testing (MANDATORY file organization)
Tests in SEPARATE files from production code: `*.test.ts` co-located (Node/TS), `test_*.py` in a `tests/` directory (Python). Never put test functions in production modules. Deterministic tests only — mock/stub external services, the network, and the clock.

## Idioms
- Validate and encode all input at the boundary (zod / pydantic / drizzle schemas); reject early with structured errors.
- Use dependency injection for services and repositories so logic is unit-testable without a live DB/HTTP.
- Structure errors: consistent `{ code, message, details? }` (or FastAPI exception handlers); never leak stack traces or secrets in responses.
- Persistence: `drizzle`/`sqlx`/`sqlalchemy` with explicit migrations; transactions for multi-write operations. Connection pools for DB/HTTP clients.
- Structured logging (`pino`/`structlog`), graceful shutdown on SIGTERM.
