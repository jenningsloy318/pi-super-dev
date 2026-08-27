---
language: backend
---

# Backend specialist profile (Node 22+ / TypeScript strict / Python / FastAPI)

## Commands
- Node: package manager `pnpm`/`npm`. Build: `pnpm build`. Lint: `pnpm lint`. Test: `pnpm test` (vitest/jest). TypeScript strict. Python: `uv` (`uv run pytest -q`, `uv run ruff check .`, `mypy`/`ty`).
- Coverage target ≥ 80%, with integration tests alongside unit tests.

## Version discipline
Detect the Node/TypeScript baseline from `package.json` (`engines.node`, installed `typescript` version) before using newer syntax; never upgrade dependencies or bump engines unless the task asks. ESM by default in new code.

## Testing (MANDATORY file organization)
Tests in SEPARATE files from production code: `*.test.ts` co-located (Node/TS), `test_*.py` in a `tests/` directory (Python). Never put test functions in production modules. Deterministic tests only — mock/stub external services, the network, and the clock. Assert observable behavior (status codes, emitted events, persisted state), never re-derive expected values from the code under test.

## Idioms (TypeScript 5.x)
- `strict: true`. Prefer discriminated unions over optional-flag soup; model impossible states out of existence. `Error` causes: `new Error("context", { cause: err })` — never stringly-concatenate errors.
- Type-level: `satisfies T` (check without widening), `as const`, const type parameters (`fn<T const>(...)`), `satisfies` on config objects; avoid `any`/`as` except at verified boundaries (`unknown` + narrowing).
- Modern runtime: `structuredClone` (not JSON round-trips), `Array.prototype.at(-1)`, `Object.groupBy`/`Map.groupBy`, `Array.fromAsync`, iterator helpers (`map`/`filter`/`take` on iterators), `AbortController`/`AbortSignal` for cancellation (first-class in `fetch`), `Promise.allSettled` for fan-out where partial failure is tolerable. `import.meta`/top-level await in ESM.
- Validate and encode all input at the boundary (zod / pydantic / drizzle schemas); reject early with structured errors.
- Dependency injection for services/repositories so logic is unit-testable without a live DB/HTTP. Prefer `fn(deps)` or class injection over globals/singleton imports.
- Structure errors: consistent `{ code, message, details? }` (or FastAPI exception handlers); never leak stack traces or secrets in responses.
- Persistence: `drizzle`/`sqlx`/`sqlalchemy` with explicit migrations; transactions for multi-write operations. Connection pools for DB/HTTP clients. `using`/`await using` disposal (TS 5.2+/explicit-resource-management) where supported.
- Structured logging (`pino`/`structlog`), graceful shutdown on SIGTERM (close servers + pools; abort in-flight work via AbortSignal).
