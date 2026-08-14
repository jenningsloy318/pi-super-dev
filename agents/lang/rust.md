---
language: rust
---

# Rust specialist profile

## Commands
- Build: `cargo build` (CI: `cargo build --release`). Lint: `cargo clippy --all-targets -- -D warnings`. Format: `cargo fmt`. Test: `cargo test`. Coverage: `cargo tarpaulin` (target ≥ 80%).

## Testing (MANDATORY file organization)
Tests live in SEPARATE files, never inline with production code. Unit tests: `src/<module>/tests/*.rs` referenced via `#[cfg(test)] mod tests;` in the parent module. Integration tests: top-level `tests/` directory. Use `#[tokio::test]` for async. Prefer table-driven tests with arrays of cases.

### RED-phase placement (when authoring failing tests FIRST)
During the RED phase you may ONLY create test files — never production files. The unit-test placement above requires declaring `#[cfg(test)] mod tests;` inside a PRODUCTION module, which is forbidden in RED. So during RED, put ALL tests in top-level `tests/<name>.rs` integration files (they compile as separate crates and need zero production edits); a test that fails to compile because the crate or module under test does not exist yet is a VALID greenfield RED. Migrate tests into `src/<module>/tests/` only if needed during GREEN, when production edits are allowed.

## Idioms (Edition 2024 / Rust 1.85+)
- Errors: `thiserror` for libraries, `anyhow` for applications. Never `unwrap()`/`expect()` in production paths — propagate with `?`.
- Async: `tokio` runtime, `JoinSet` for concurrent tasks, `signal::ctrl_c()` for graceful shutdown.
- Use `serde` for (de)serialization, `tracing` (not `println!`) for observability.
- Embrace ownership/borrowing; prefer `&str`/`&[T]` for arguments, return owned types. Avoid `.clone()` to silence the borrow checker — restructure instead.
