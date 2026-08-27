---
language: python
---

# Python specialist profile

## Commands (modern toolchain — uv everywhere)
- Package manager: `uv` ONLY. Add/remove deps with `uv add <pkg>` / `uv remove <pkg>` — never edit `pyproject.toml` dependency lists by hand, never `pip install` into the env. Sync with `uv sync`.
- NEVER create/activate virtualenvs manually (`source .venv/bin/activate` is forbidden) — run everything through `uv run <cmd>` (`uv run pytest`, `uv run ruff check .`).
- Test: `uv run pytest -q`. Type-check: `uv run ty check src/` (Astral `ty`) or `mypy`/`pyright` if already configured. Format: `uv run ruff format .`. Lint: `uv run ruff check .` (ruff replaces flake8+black+isort — no other formatters/linters). Coverage: `pytest --cov` (target ≥ 80%).
- Dev tooling lives in `[dependency-groups]` (PEP 735): `uv add --group dev pytest ruff ty`. NOT `[project.optional-dependencies]`.
- Standalone scripts with deps use PEP 723 inline metadata (`# /// script` block) + `uv run script.py`, not requirements.txt.
- New packages: `uv init --package`, `uv_build` backend (or `hatchling` if already present — don't churn existing build backends).

## Testing (MANDATORY file organization)
Tests live in a separate `tests/` directory as `test_*.py` files, or co-located `*_test.py`. Never put test functions in production modules. Use `pytest` fixtures for setup/teardown; parametrize with `@pytest.mark.parametrize` for table-driven cases. Prefer `unittest.mock`/dependency injection over touching real networks/FS. Test behavior, not implementation: never assert a value by re-deriving it with the same logic under test (tautological tests are noise).

## Idioms (Python 3.11+; check `requires-python` in pyproject.toml before using newer syntax)
- Type hints everywhere (and keep them checkable); `pydantic` for runtime validation, settings, and API models.
- `FastAPI` for HTTP APIs (Pydantic v2 request/response models, `async def` handlers), `uvicorn`/`granian` to serve.
- Modern syntax per version: 3.10+ `match` statements and `X | Y` unions (never `Optional[X]`/`Union`); 3.11+ `ExceptionGroup`/`except*`; 3.12+ f-string nesting and `type` alias statements; 3.13+ `@override` decorator.
- Prefer context managers (`with`) and `pathlib.Path` over manual resource handling and `os.path`; `from __future__ import annotations` is unnecessary on 3.10+.
- Never bare `except:` — catch specific exceptions; use `err` from `except X as err` with `raise NewError(...) from err` to preserve causes.
- Dataclasses (or `pydantic` models) over dict-passing at boundaries; `dataclasses.Kw_only`/`slots=True` where useful.
- Structured logging (`logging`/`structlog`), not `print`. `asyncio` for I/O concurrency; `asyncio.TaskGroup` (3.11+) for structured concurrency instead of bare `create_task`.
- `os.environ` reads only at startup into settings (`pydantic-settings`); inject from there.
