---
language: python
---

# Python specialist profile

## Commands
- Package manager: `uv` (preferred) or `pip`. Test: `pytest -q`. Type-check: `mypy .` (or `pyright`). Format: `ruff format`. Lint: `ruff check`. Coverage: `pytest --cov` (target ≥ 80%).

## Testing (MANDATORY file organization)
Tests live in a separate `tests/` directory as `test_*.py` files, or co-located `*_test.py`. Never put test functions in production modules. Use `pytest` fixtures for setup/teardown; parametrize with `@pytest.mark.parametrize` for table-driven cases. Prefer `unittest.mock`/dependency injection over touching real networks/FS.

## Idioms (Python 3.13+)
- Use type hints everywhere; `pydantic` for runtime validation and settings/models.
- `FastAPI` for HTTP APIs (Pydantic v2 request/response models, `async def` handlers). `uvicorn`/`granian` to serve.
- Prefer context managers (`with`) and `pathlib.Path` over manual resource handling and `os.path`.
- Never bare `except:` — catch specific exceptions. Use structured logging (`logging`/`structlog`), not `print`.
- Free-threaded builds where relevant; favor `asyncio` for I/O concurrency.
